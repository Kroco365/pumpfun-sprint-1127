// Launch Sniper — a launch-window sniper for the pump.fun bonding-curve replay.
//
// Idea: almost every pump.fun coin's tradable move happens in its first minute, and most coins
// die there. The only moment a small bot can buy near the floor is the launch itself, before
// the first pump. This bot watches every coin from its CreateEvent and buys only launches that
// pass a rug filter in their first few slots: the creator's own opening buy is modest, only a
// few distinct wallets piled in with it (a launch bundled by many wallets is the creator's
// cluster waiting to dump), the creator has not sold, and no single seller has dumped hard.
// It takes profit fast, cuts losers fast, never holds past a short time limit, and leaves at
// once when the creator sells. Winners may be pyramided once while they keep rising.
//
// A coin is bought at most once (plus optional adds) and only inside its launch window, so the
// bot naturally trades hundreds of coins in small sizes — the 20-coin guardrail is met by the
// strategy itself, with no probe trades needed.
//
// Deterministic by construction: no clock, no randomness, no environment, no network. Iteration
// only over insertion-ordered maps fed by the batch stream, so the two grading executions
// produce byte-identical action logs.

import { LAMPORTS_PER_SOL, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a coin may be bought. */
  minAgeSlots: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAgeSlots: number;
  /** Lamports to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Buys after the first one, each on a later batch, while the coin keeps qualifying. */
  maxAdds: number;
  /** An add waits this many slots after the previous buy was decided. */
  addDelaySlots: number;
  /** An add needs the price at least this far above the previous buy's decision price. */
  addStepUp: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** Creator's own buys in the create slot (SOL): window. */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Distinct (non-creator) buyers seen before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Distinct (non-creator) buyers seen before entry, at least. */
  minBuyers: number;
  /** Trades seen before entry, at least. */
  minTrades: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, at most: do not chase an already-pumped launch. */
  maxRunup: number;
  /** Sell all once the position is worth this much over its cost. */
  takeProfit: number;
  /** Sell all once the position is worth this much under its cost. */
  stopLoss: number;
  /** Trailing stop: once up at least this much, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Skip a coin when the creator sold before entry. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
}

export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 0,
  maxAgeSlots: 3,
  stakeSol: 0.1,
  minBuySol: 0.005,
  maxAdds: 0,
  addDelaySlots: 2,
  addStepUp: 0,
  minRqSol: 2.5,
  maxRqSol: 30,
  minDevBuySol: 0,
  maxDevBuySol: 2.5,
  maxBuyers: 1,
  minBuyers: 0,
  minTrades: 0,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 5_000,
  maxRunup: 1.5,
  takeProfit: 0.4,
  stopLoss: 0.08,
  trailArm: 0.25,
  trail: 0.15,
  maxHoldSlots: 10,
  staleSlots: 200,
  exitOnDevSell: true,
  skipDevSold: true,
  buySlipBps: 10_000,
};

const LAMPORTS = 1_000_000_000; // lamports per SOL, as a number for signal math
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps, the fallback fee on every trade
const BPS = 10_000;
const SELL_SLIP_BPS = 10_000;

interface Coin {
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuySol: number;
  trades: number;
  buyers: Set<Pubkey>;
  boughtSol: number;
  soldByOthersSol: number;
  bigSellBps: number;
  devSold: boolean;
  lastTradeSlot: number;
  buysSent: number;
  spentSol: number;
  lastBuyPrice: number;
  lastBuySlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  peakValue: number;
  devSoldAtOpen: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();

  const coinOf = (mint: Pubkey): Coin | undefined => coins.get(mint);

  /** Current price of a curve in SOL per token, from its virtual reserves. */
  const priceOf = (vq: bigint, vt: bigint): number => {
    if (vt === 0n) return 0;
    return Number(vq) / Number(vt);
  };

  /** What a holding of `tokens` tokens would fetch if sold now (SOL, curve + tx fees deducted). */
  const sellValue = (tokens: bigint, vq: bigint, vt: bigint, txSol: number): number => {
    const n = Number(tokens);
    if (n <= 0 || vt === 0n) return 0;
    const gross = (n * Number(vq)) / (Number(vt) + n) / LAMPORTS;
    return gross * (1 - CURVE_FEE) - txSol;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            createSlot: e.slot,
            creator: e.creator,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuySol: 0,
            trades: 0,
            buyers: new Set(),
            boughtSol: 0,
            soldByOthersSol: 0,
            bigSellBps: 0,
            devSold: false,
            lastTradeSlot: e.slot,
            buysSent: 0,
            spentSol: 0,
            lastBuyPrice: 0,
            lastBuySlot: 0,
            done: false,
            complete: false,
          });
          touched.add(e.mint);
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.trades++;
          c.lastTradeSlot = e.slot;
          touched.add(e.mint);
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.boughtSol += sol;
            if (isDev && e.slot === c.createSlot) c.devBuySol += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthersSol += sol;
            const rqBefore = Number(e.real_quote_reserves) / LAMPORTS + sol;
            if (rqBefore > 0) {
              const bps = (sol * BPS) / rqBefore;
              if (bps > c.bigSellBps) c.bigSellBps = bps;
            }
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingSell = new Set<Pubkey>();
      const pendingBuy = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
        else pendingBuy.add(po.order.mint);
      }
      for (const mint of [...selling]) if (!pendingSell.has(mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !pendingBuy.has(mint)) held.delete(mint);
      }

      // ---- exits first ----
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coinOf(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: now, peakValue: 0, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = sellValue(pos.token_amount, vq, vt, txSol);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let exit = false;
        if (cost > 0) {
          if (value >= cost * (1 + p.takeProfit)) exit = true;
          if (value <= cost * (1 - p.stopLoss)) exit = true;
          if (h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        }
        if (now - h.openedSlot >= p.maxHoldSlots) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (now - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // ---- entries and adds ----
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let open = state.committedPositionCount();
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const c = coins.get(mint);
        if (c === undefined || c.done || c.complete) continue;
        const age = now - c.createSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd && age > p.maxAgeSlots) {
          c.done = true;
          continue;
        }
        if (age < p.minAgeSlots) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && (p.skipDevSold || isAdd)) {
          if (!isAdd) c.done = true;
          continue;
        }
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (isAdd) {
          // A second tranche once the launch has shown it is not an instant dump.
          if (c.buysSent > p.maxAdds) continue;
          if (!state.positions.has(mint) || selling.has(mint) || pendingBuy.has(mint)) continue;
          if (now - c.lastBuySlot < p.addDelaySlots) continue;
          if (price < c.lastBuyPrice * (1 + p.addStepUp)) continue;
          const maxAdd = Number(state.maxBuyLamports(mint)) / LAMPORTS;
          const room = p.stakeSol - c.spentSol;
          const amount = Math.min(room, maxAdd);
          if (amount < p.minBuySol || free < amount + txSol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + txSol;
          c.buysSent++;
          c.spentSol += amount;
          c.lastBuyPrice = price;
          c.lastBuySlot = now;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        // Rug filter.
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        if (c.devBuySol < p.minDevBuySol || c.devBuySol > p.maxDevBuySol) continue;
        if (c.trades < p.minTrades || c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
        if (c.boughtSol > 0 && (c.soldByOthersSol / c.boughtSol) * BPS > p.maxSellRatioBps) continue;
        if (c.bigSellBps > p.maxBigSellBps) continue;
        const runup = (Number(curve.virtual_quote_reserves) * Number(c.vt0)) / (Number(curve.virtual_token_reserves) * Number(c.vq0));
        if (runup > p.maxRunup || runup < 1) continue;
        const maxBuy = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        const amount = Math.min(p.stakeSol - c.spentSol, maxBuy);
        if (amount < p.minBuySol) continue;
        if (free < amount + txSol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        c.buysSent++;
        c.spentSol += amount;
        c.lastBuyPrice = price;
        c.lastBuySlot = now;
        open++;
      }
      return orders;
    },
  };
}
