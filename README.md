[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Kroco365/pumpfun-sprint-1127/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Kroco365/pumpfun-sprint-1127/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Launch Sniper — Pump.fun Replay Sprint

A launch-window sniper for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a replay of pump.fun bonding-curve chain data; nothing is traded for real.

## Strategy

Almost every pump.fun coin's tradable move happens in its first minute, and most coins die
there. The only moment a small bot can buy near the floor is the launch itself, before the
first pump. The bot watches every coin from its CreateEvent and buys only launches that pass
a rug filter in their first few slots:

- **Launch window:** first buy decided within 3 slots of the CreateEvent.
- **Size:** real SOL reserves of 2.5–30 at decision time, so the curve already holds
  meaningful liquidity but has not run away yet.
- **Rug filter:** the creator's own opening buy is at most 2.5 SOL, at most 1 distinct
  non-creator wallet has piled in (a launch bundled by many wallets is the creator's cluster
  waiting to dump), the creator has not sold, no single seller has dumped hard, and the price
  has run up at most 50% from creation (do not chase an already-pumped launch).
- **Exits:** sell everything on +40% take profit, −8% stop loss, a 10-slot time limit, or
  immediately when the creator sells. One buy per coin, no adds.

On the dev window this scores about +0.026 SOL net PnL over 38 coins (38 round trips of at
least 0.01 SOL), max drawdown about 0.5% — guardrails met with margin.

## Determinism

No clock, no randomness, no environment, no network. All money math uses BigInt lamports.
The two grading executions produce byte-identical action logs (verified by the local
grader's L1 regrade).

## Layout

- `main.ts` — the entrypoint (Node 22, runs as `node /bot/main.ts`)
- `strategy.ts` — the bot: parameters plus the launch-sniper strategy
- `vendor/makefun-bot.ts` — the kit's bot shim, byte-identical copy of `sdk/ts/makefun-bot.ts`
