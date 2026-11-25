[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/AryFlows/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/AryFlows/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Frost Sharpe — pump.fun paper-trading bot

A Sharpe-first paper bot for the make.fun competition
[Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).
One strategy program, `main.ts` on Node 22, trading paper SOL on a 6-hour
pump.fun forward replay. Places go by hourly Sharpe ratio, so steady controlled
gains beat one lucky moonshot.

## Strategy

Dip-and-bounce mean reversion on bonding curves, written for a smooth hourly
equity curve:

- **Entry:** a curve that fell 25–50% from its recent high (2,000-slot window)
  while buyers are still stepping in (at least 3 buys in the last 6 trades,
  net SOL inflow, last trade a buy) and still holds ≥ 2 SOL of real reserves.
- **Size:** one fixed 0.10 SOL stake per position, at most 5 open, capped at
  97% of the harness's per-reply size cap. Small stakes keep any single coin
  from denting the Sharpe.
- **Exit:** the first of +7% take-profit, −5.5% stop-loss, or a 1,200-slot
  (~4-minute) time limit — then a 600-slot cooldown before the same coin can
  be tried again. Positions are sold whole in a single order to save tx fees.
- **Guardrail pacing:** the run needs round trips on ≥ 20 distinct mints. If
  coin coverage trails the pace (25 coins by ~60k slots), entry thresholds
  relax (15% dip, 2 buys) so coverage catches up.

## Layout

- `main.ts` — the whole strategy (uses only the harness's batches: curve
  state, trade events, own positions/cash).
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's
  `sdk/ts/makefun-bot.ts` shim for the `agent-fun/replay/v2` protocol.
- `LICENSE` — MIT.

## Determinism

No clock, no randomness, no I/O at runtime; iteration only in event order or
over sorted mint lists, so the two graded executions produce byte-identical
action logs.

## Local grading

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```
