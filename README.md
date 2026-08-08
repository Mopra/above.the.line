# Above the line

Holds BTC while the close is above its long moving average, and sits in cash below
it. That single rule is the whole name and the whole strategy.

A weekly, long-or-cash trend follower for BTC-EUR on Bitvavo. Next.js on Vercel:
an hourly cron job makes the decisions, and the front page is a dashboard showing
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
- `ACCOUNT_VALUE_CEILING_EUR` makes the bot refuse to *buy* if the account holds
  more than expected, so it can never touch money you did not mean to expose.
- `MAX_TRADES_PER_MONTH` stops it opening new positions if something starts looping.
- Those last two gate entries only. An exit and the stop loss always run, because
  a cap that blocked selling would trap a position: a holding that grew past the
  ceiling, or a month that ran out of trades, would freeze with the stop loss
  switched off. Selling is only possible while long, and going long is capped, so
  letting exits through cannot loop.
- The cron endpoint requires `Authorization: Bearer $CRON_SECRET`. Without it,
  nobody can trigger a trade by hitting the URL.
- Long or cash only. No shorting, no margin, no leverage, one position at a time.

## The strategy

- **Universe:** BTC-EUR only.
- **Signal:** once a week (default Monday), on the last *closed* daily candle.
  Close above the `SMA_DAYS` moving average → long. Below → cash.
- **Stop loss:** checked **every** run, not just on the signal day. Two levels,
  described below.
- **Sizing:** all in or all out, capped by `MAX_ALLOCATION_EUR`.

The whole thing is one pure function in `src/lib/strategy.ts`. If you want to
change the rules, that is the only file that decides anything.

### The two stops

The entry and the trend filter both read closed daily candles, so they cannot
react faster than once a day no matter how often the job runs. The stop is the
only rule where speed buys you anything, so there are two of them:

| Stop | Measured against | Default | Purpose |
|---|---|---|---|
| `STOP_LOSS_PCT` | the last **daily close** | 20% | The stop the backtest models. Unchanged. |
| `CRASH_STOP_PCT` | the **live** ticker price | 30% | Catches a collapse within the hour instead of at the next close. |

Keeping the crash stop wider than the ordinary one is the whole point. A tight
intraday stop fires on wicks the backtest never saw, and for a trend follower
that historically costs return rather than saving it. The wide one only triggers
in the case the daily stop genuinely handles badly: a fast collapse that would
otherwise sit unactioned until the next close.

Set `CRASH_STOP_PCT=0` to switch intraday stopping off entirely and behave
exactly as the backtest models.

**This part is not backtested, and cannot honestly be.** The backtest walks daily
candles and never passes a live price, so `decide()` skips the intraday rule
during a simulation — a simulated run behaves precisely as it always did. That
means the out-of-sample number still describes the daily-close strategy, and says
nothing about the crash stop. Treat the crash stop as insurance you have chosen
to buy, not as a tested edge.

### When a signal actually executes

Entry and exit decisions only ever use *closed* daily candles, so the first run
after midnight UTC reads yesterday's bar. With `SIGNAL_WEEKDAY=1` that means the
Monday close is the signal, and the order goes in during the early hours of
**Tuesday**. The backtest fills at the close of the deciding bar, so reality lags
it by up to an hour now rather than a day. On a 140-day trend filter that gap is
noise either way, but it is real and it is not modelled.

Running hourly does **not** make entries or weekly exits any faster: within a
single UTC day the last closed candle is identical, so the extra runs re-evaluate
the same bar and reach the same verdict. A weekly signal is also guarded by an
ISO week key, so it can only act once per week however often the job fires. The
only rule that genuinely benefits from the cadence is the intraday crash stop.

## Getting started

```bash
npm install
npm test          # 31 correctness checks, no network needed
npm run backtest  # pulls real Bitvavo history and validates the strategy
npm run dry-run   # does one scheduled run locally, exactly as the cron would
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

`npm run dry-run` takes the same code path as the production cron job, reading
`.env.local` if you have one. It stores state in `.bot-state.json`, so you can
run it on successive days and watch the paper position and equity curve develop
before anything is deployed.

### What the paper run records

Every run appends a point holding the time, equity, BTC price, the trend filter
value, what it decided and why. Price alone would only tell you what the run
returned; price against the trend tells you how *close* each call was, which is
what you need months later when asking whether `SMA_DAYS` should have been
shorter. Read it from `/api/state`, or open "Show the numbers" on the dashboard.

One point per calendar day — a second run the same day overwrites rather than
duplicates, so triggering by hand does not distort the record. The last 800
points are kept, about two years.

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
The hourly schedule in `vercel.json` therefore needs a paid plan; on Hobby the
deploy is rejected. If you are on Hobby, set the schedule back to `0 7 * * *` and
`CRASH_STOP_PCT=0`, since an intraday stop that is only checked once a day is
just a worse version of the daily one.

## Going live

Only after a backtest you believe and a paper run that behaved:

1. Fund the Bitvavo account with EUR (SEPA deposits are free). Set
   `MAX_ALLOCATION_EUR` a little *below* what you deposited, so the 0.25% fee
   cannot push an order past your balance — on a EUR 100 deposit, use 95.
2. Create the API key with **View + Trade only**. Set `BITVAVO_API_KEY` and
   `BITVAVO_API_SECRET` in Vercel.
3. Set `BITVAVO_OPERATOR_ID` to any positive whole number. Bitvavo has rejected
   orders without one since 1 June 2025, so a live trade fails without it.
4. Set `TRADING_ENABLED=true` and redeploy.

Set `MAX_ALLOCATION_EUR` before the first run if you can. The paper wallet seeds
itself from that value once and then keeps its own balance, so changing it later
does not retroactively rescale a paper run already in progress.

The dashboard badge switches from "Paper trading" to "Live money", and trades stop
being labelled "(paper)".

To stop: set `KILL_SWITCH=true` and redeploy. To stop *and* sell, do the sale
yourself in the Bitvavo app — the bot deliberately has no "panic sell" endpoint
that could be triggered by anything other than its own rules.

### Switching between paper and live

The two ledgers are never mixed. Going live while a paper position is open would
leave the bot certain it owns BTC it never bought: it would not re-enter, having
recorded itself as long, and could not exit, having nothing to sell. It would
sit inert with the stop loss dead and a dashboard showing a position that does
not exist.

So when `TRADING_ENABLED` changes what the bot actually is, the old ledger is
copied to `<STATE_PREFIX>/archive/<mode>-<timestamp>.json` and the new mode
starts from zero. Nothing is lost — the paper run is the record of how the
strategy behaved, which is the entire point of running one — but it stops being
treated as a position. Flip the switch back and the same thing happens in
reverse.

A state written before this existed has no mode recorded. It is adopted rather
than reset, so upgrading does not throw away a paper run in progress.

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
scripts/dry-run.ts    npm run dry-run, one scheduled run on your own machine
scripts/test-strategy.ts  npm test
```
