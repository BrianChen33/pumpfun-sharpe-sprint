# CleanSnipe — Pump.fun Sharpe Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/BrianChen33/pumpfun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/BrianChen33/pumpfun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on make.fun. Places are ranked by **hourly Sharpe ratio** on a fresh 6-hour pump.fun replay, so this bot is built to grind many small, controlled wins — not to chase one lucky moonshot.

## Idea

Most new pump.fun coins die within minutes, and a round trip costs ~3% of the stake in curve + transaction fees. The only trades worth taking are the ones where the tape has already proved sustained demand, so the bot waits instead of sniping the launch:

1. **Watch** every coin from its `CreateEvent` for 60–130 seconds.
2. **Confirm** before buying: at least 10 distinct non-creator buyers (same-slot, same-amount bursts count once, so bundled launches don't inflate the count), net SOL inflow positive in each of the last two observation periods, any sell so far followed by fresh buys (the sell was absorbed), the flow still positive after removing the single largest buyer, no substantive unabsorbed creator sell, real SOL reserves of at least 10 SOL (so a 0.05 SOL position is at most 0.5% of reserves and can be sold without moving the curve), and a price run-up of +50% to +200% from creation (momentum that is still going, not a coin that already topped).
3. **Trade small**: 0.05 SOL per coin, at most 2 strict positions, one full exit per trade. Gross take-profit +30%, stop-loss −6% against the fill price, 5-minute max hold, plus exits on stale trading, two straight periods of net selling, or an unabsorbed creator sell. One position per creator, and a drawdown guard that skips entries which would push post-fill cash below 98.2% of peak equity.

## The mint-floor problem, and the filler tier

The guardrail needs round trips of ≥ 0.01 SOL on at least 20 distinct mints in a 6-hour window, but the strict filter only converts ~5–18 coins per 6 hours on the dev window. So the bot has a second tier: when the completed-round-trip pace lags the 20-mint target (24 per 6 h, measured in block time), it tops up with minimum-size 0.01 SOL trades on looser filters (≥ 5 buyers, ≥ 2 SOL reserves, positive recent flow), exiting at +50% / −10%. Each filler is a real trade with the same exit discipline; it exists only to keep the bot above the guardrail while the strict tier does the earning.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`.
- `strategy.ts` — the strategy (pure function of the batches: no clock, no randomness, no I/O).
- `vendor/makefun-bot.ts` — the kit's protocol shim, copied unchanged.

## Dev-window results (local sim, 24 h frozen window split into four 6 h blocks)

| block | Sharpe (hourly) | net PnL (SOL) | round trips | max DD |
|---|---:|---:|---:|---:|
| 0 | +0.17 | +0.02 | 24 | 0.4% |
| 1 | +0.21 | +0.01 | 23 | 0.4% |
| 2 | −0.10 | −0.01 | 23 | 0.4% |
| 3 | −0.05 | −0.00 | 23 | 0.4% |

Full 24 h run via the kit's `grade-local` (process driver): net PnL **+0.044 SOL**, 108 fills over 54 coins, 54 round trips, win rate 31.5%, max drawdown 0.66%, guardrails met; the two executions reproduced byte for byte. Honest caveats: the edge is thin — at 2× fees the same run nets −0.028 SOL, the top 3 coins contribute 30% of the gains, and the per-block Sharpe (+0.06 on average) is far below the dev leaderboard's top-3 bar (~0.57). This entry is a disciplined grinder, not a favourite.

## License

MIT — see [LICENSE](LICENSE).
