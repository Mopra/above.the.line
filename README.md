# Above the line

Holds BTC while the close is above its long moving average, and sits in cash below
it. That single rule is the whole name and the whole strategy.

A weekly, long-or-cash trend follower for BTC-EUR on Bitvavo. Next.js on Vercel:
one daily cron job makes the decisions, and the front page is a dashboard showing
what it did and why.

Built for about DKK 1,000 of play money. Read the next section before you fund it.

## What to expect

Be clear-eyed about this. Three things work against you at this size:

1. **Fees.** Bitvavo charges 0.25% taker, so a round trip costs roughly 0.5% plus
   slippage. Twenty round trips a year is about 10% of your capital gone. This is
   why the strategy is deliberately slow: signals are evaluated once a week.
2. **Danish tax is asymmetric.** Crypto is taxed as *spekulation*. Gains are
   personal income (37–53%, rubrik 20); losses only give a *ligningsmæssigt*
   deduction worth about 26% (rubrik 58); and **you cannot net losses against
   gains in the same year**. A bot that breaks even gross can still owe tax.
   FIFO applies across every wallet and exchange you own. From income year 2026,
   Bitvavo reports your trades to Skattestyrelsen automatically under DAC8.
3. **Trend following usually loses to just holding.** It historically gives up
   return in exchange for smaller drawdowns. The backtest will show you this
   honestly rather than hiding it — that is the point of the buy-and-hold column.

None of this is investment advice. Treat the money as an experiment budget.

## Safety model

The bot cannot move money out of your account, by construction:

- **Create the Bitvavo API key with "View" and "Trade" permission only. Never
  enable "Withdraw."** Bitvavo withdrawals over the API skip 2FA and email
  confirmation, so a leaked key with withdraw rights empties the account silently.
- `TRADING_ENABLED=false` is the default. Everything runs — signals, logging,
  the dashboard, the equity curve — but no order is ever sent. This is real paper
  trading, not a mock.
- `KILL_SWITCH=true` stops all activity immediately, checked before every order.
- `MAX_ALLOCATION_EUR` caps what the bot may ever deploy.
- `ACCOUNT_VALUE_CEILING_EUR` makes the bot refuse to trade at all if the account
  holds more than expected, so it can never touch money you did not mean to expose.
- `MAX_TRADES_PER_MONTH` halts trading if something starts looping.
- The cron endpoint requires `Authorization: Bearer $CRON_SECRET`. Without it,
  nobody can trigger a trade by hitting the URL.
- Long or cash only. No shorting, no margin, no leverage, one position at a time.

## The strategy

- **Universe:** BTC-EUR only.
- **Signal:** once a week (default Monday), on the last *closed* daily candle.
  Close above the `SMA_DAYS` moving average → long. Below → cash.
- **Stop loss:** checked **every** day, not just on the signal day. If price falls
  `STOP_LOSS_PCT` below the entry price, it exits immediately.
- **Sizing:** all in or all out, capped by `MAX_ALLOCATION_EUR`.

The whole thing is one pure function in `src/lib/strategy.ts`. If you want to
change the rules, that is the only file that decides anything.

## Getting started

```bash
npm install
npm test          # 31 correctness checks, no network needed
npm run backtest  # pulls real Bitvavo history and validates the strategy
```

`npm run backtest` is the important one. It:

1. Grid searches the trend length on the **first half** of history.
2. Takes the winner and measures it **once** on the second half, which it has
   never seen. That out-of-sample number is the only one worth believing.
3. Shows every setting on the out-of-sample window too — if only the winner does
   well there, the result was luck rather than signal.
4. Shows what the Danish tax treatment does to the outcome.

Run it before you decide anything. If the out-of-sample result does not convince
you, do not fund the bot.

Local dry runs store state in `.bot-state.json`, so you can run it repeatedly and
watch the paper position develop.

## Deploying

1. Push this folder to a new GitHub repo.
2. Import the repo in Vercel. The `vercel.json` cron is picked up automatically.
3. In the Vercel dashboard, add **Vercel Blob** storage to the project. This sets
   `BLOB_READ_WRITE_TOKEN` for you. Production needs it — Vercel's filesystem is
   ephemeral, so the local JSON fallback will not persist there.
4. Add environment variables from `.env.example`. At minimum: `CRON_SECRET` and
   `STATE_PREFIX` (any long random strings). Leave `TRADING_ENABLED=false`.
5. Deploy, then open the project URL. The dashboard should load in paper mode.
6. Trigger a run by hand to check it works:

   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-APP.vercel.app/api/cron
   ```

7. Let it paper trade for a few weeks. The chart fills in one point per day.

### About the Vercel Hobby plan

Hobby allows **one cron run per day**, and the timing drifts by up to 59 minutes.
That is fine here: signals are weekly and the daily run is only there to check the
stop loss. A more frequent schedule fails at deploy time on Hobby.

## Going live

Only after a backtest you believe and a paper run that behaved:

1. Fund the Bitvavo account with EUR (SEPA deposits are free). DKK 1,000 is about
   EUR 134 — match `MAX_ALLOCATION_EUR` to what you actually deposit.
2. Create the API key with **View + Trade only**. Set `BITVAVO_API_KEY` and
   `BITVAVO_API_SECRET` in Vercel.
3. Set `TRADING_ENABLED=true` and redeploy.

The dashboard badge switches from "Paper trading" to "Live money", and trades stop
being labelled "(paper)".

To stop: set `KILL_SWITCH=true` and redeploy. To stop *and* sell, do the sale
yourself in the Bitvavo app — the bot deliberately has no "panic sell" endpoint
that could be triggered by anything other than its own rules.

## Endpoints

| Route | What it does |
|---|---|
| `/` | The dashboard |
| `/api/cron` | One scheduled run. Requires the `CRON_SECRET` bearer token. |
| `/api/backtest` | Runs the full in-sample/out-of-sample validation on live data |
| `/api/state` | Read-only JSON of the current state. Never returns credentials. |

## Tax reporting

The dashboard shows realised gains (rubrik 20) and losses (rubrik 58) separately
in DKK, because Danish rules treat them differently and forbid netting. `/api/state`
returns the same figures as JSON.

Two caveats. The FIFO ledger only knows about coins **this bot** bought — if you
hold BTC anywhere else, FIFO spans that too and the real figures differ. And the
DKK conversion uses one fixed rate (`DKK_PER_EUR`) rather than the rate on each
transaction date. Treat the output as a starting point for your return, not as
the return itself.

## Layout

```
src/lib/strategy.ts   the rules, as one pure function
src/lib/backtest.ts   simulation engine, walk-forward split, metrics
src/lib/engine.ts     one scheduled run: decide, check limits, execute, persist
src/lib/bitvavo.ts    signed REST client (candles, balance, market orders)
src/lib/tax.ts        FIFO cost basis and the SKAT summary
src/lib/state.ts      persistence: Vercel Blob, or a local file when developing
src/app/page.tsx      the dashboard
scripts/backtest.ts   npm run backtest
scripts/test-strategy.ts  npm test
```
