/**
 * Run the full validation from your own machine: npm run backtest
 *
 * Needs internet, because it pulls the real BTC-EUR daily history from Bitvavo.
 * No API key required, the candle endpoint is public.
 */
import { fetchDailyCandles } from '../src/lib/bitvavo';
import {
  runBacktest,
  splitCandles,
  sweepInSample,
  score,
  type BacktestResult,
} from '../src/lib/backtest';
import { summariseForSkat } from '../src/lib/tax';

const MARKET = process.env.MARKET ?? 'BTC-EUR';
const START_EQUITY = Number(process.env.MAX_ALLOCATION_EUR ?? 134);
const SIGNAL_WEEKDAY = Number(process.env.SIGNAL_WEEKDAY ?? 1);
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT ?? 20);
const SMA_CANDIDATES = [50, 70, 90, 110, 130, 140, 150, 170, 190, 210];
const COSTS = { feeBps: 25, slippageBps: 10 };

function pct(n: number): string {
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(1)}%`;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function report(title: string, r: BacktestResult): void {
  console.log(`\n${title}`);
  console.log(`  window            ${day(r.from)} to ${day(r.to)}  (${r.bars} days)`);
  console.log(`  trend filter      ${r.params.smaDays}-day average`);
  console.log(`  strategy return   ${pct(r.totalReturnPct)}   (CAGR ${pct(r.cagrPct)})`);
  console.log(`  buy and hold      ${pct(r.buyHoldReturnPct)}`);
  console.log(
    `  max drawdown      ${r.maxDrawdownPct.toFixed(1)}%   ` +
      `(buy and hold ${r.buyHoldMaxDrawdownPct.toFixed(1)}%)`,
  );
  console.log(
    `  round trips       ${r.roundTrips}   win rate ${r.winRatePct.toFixed(0)}%   ` +
      `time in market ${r.exposurePct.toFixed(0)}%`,
  );
  console.log(
    `  fees paid         EUR ${r.totalFees.toFixed(2)} ` +
      `(${((r.totalFees / r.startEquity) * 100).toFixed(1)}% of starting capital)`,
  );
  console.log(
    `  ended with        EUR ${r.endEquity.toFixed(2)} from EUR ${r.startEquity.toFixed(2)}`,
  );
}

async function main(): Promise<void> {
  console.log(`Fetching ${MARKET} daily history from Bitvavo...`);
  const candles = await fetchDailyCandles(MARKET, 3000);
  if (candles.length < 500) {
    throw new Error(`Only ${candles.length} candles returned; need at least 500.`);
  }
  console.log(
    `Got ${candles.length} daily bars, ${day(candles[0].time)} to ` +
      `${day(candles[candles.length - 1].time)}.`,
  );
  console.log(
    `Costs assumed: ${COSTS.feeBps / 100}% fee and ${COSTS.slippageBps / 100}% ` +
      'slippage on every fill, both directions.',
  );

  const base = { signalWeekday: SIGNAL_WEEKDAY, stopLossPct: STOP_LOSS_PCT };
  const { inSample } = splitCandles(candles, 0.5);

  console.log('\n--- Step 1: grid search, first half of history only ---');
  const sweep = sweepInSample(inSample, SMA_CANDIDATES, base, COSTS, START_EQUITY);
  console.log('  sma   return    maxDD    return/DD');
  for (const s of sweep) {
    console.log(
      `  ${String(s.smaDays).padStart(3)}   ` +
        `${pct(s.inSample.totalReturnPct).padStart(8)}  ` +
        `${s.inSample.maxDrawdownPct.toFixed(1).padStart(6)}%  ` +
        `${score(s.inSample).toFixed(2).padStart(9)}`,
    );
  }
  const winner = sweep[0].smaDays;
  console.log(`\n  Best on in-sample data: ${winner}-day average.`);
  console.log('  This number is contaminated by hindsight. Ignore it.');

  console.log('\n--- Step 2: the honest test, second half, never optimised on ---');
  const warmup = Math.max(...SMA_CANDIDATES);
  const oosWithWarmup = candles.slice(inSample.length - warmup);
  const oos = runBacktest(
    oosWithWarmup,
    { ...base, smaDays: winner },
    COSTS,
    START_EQUITY,
    warmup,
  );
  report(`Out of sample, ${winner}-day filter (the winner from step 1)`, oos);

  console.log('\n--- Step 3: every setting on the out-of-sample window ---');
  console.log('  If only the winner does well here, the result was luck.');
  console.log('  sma   OOS return   maxDD');
  for (const smaDays of SMA_CANDIDATES) {
    const r = runBacktest(
      oosWithWarmup,
      { ...base, smaDays },
      COSTS,
      START_EQUITY,
      warmup,
    );
    console.log(
      `  ${String(smaDays).padStart(3)}   ` +
        `${pct(r.totalReturnPct).padStart(9)}   ` +
        `${r.maxDrawdownPct.toFixed(1).padStart(5)}%`,
    );
  }

  console.log('\n--- Step 4: what the Danish tax office does to the result ---');
  const tax = summariseForSkat(oos.realisedGains, oos.realisedLosses, {
    dkkPerEur: Number(process.env.DKK_PER_EUR ?? 7.46),
    gainRatePct: Number(process.env.TAX_RATE_GAIN_PCT ?? 42),
    lossRatePct: Number(process.env.TAX_RATE_LOSS_PCT ?? 26),
  });
  console.log(`  rubrik 20, gains        DKK ${tax.gainsDkk.toFixed(0)}`);
  console.log(`  rubrik 58, losses       DKK ${tax.lossesDkk.toFixed(0)}`);
  console.log(`  tax on the gains        DKK ${tax.taxOnGainsDkk.toFixed(0)}`);
  console.log(`  value of loss relief    DKK ${tax.reliefOnLossesDkk.toFixed(0)}`);
  console.log(`  net to the tax office   DKK ${tax.netTaxDkk.toFixed(0)}`);
  console.log(
    '  Gains and losses are taxed at different rates and cannot be netted,\n' +
      '  so this can be positive even when the bot barely broke even.',
  );

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('\nBacktest failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
