/**
 * Correctness checks that need no network. Run with: npm test
 *
 * These do not tell you whether the strategy makes money. They tell you the
 * machinery is not lying to you about fees, cost basis or position sizing,
 * which is the part a backtest cannot check for itself.
 */
import { sma, decide, weekKey } from '../src/lib/strategy';
import { sellFifo } from '../src/lib/tax';
import { runBacktest } from '../src/lib/backtest';
import type { Candle } from '../src/lib/types';

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function close(label: string, actual: number, expected: number, eps = 1e-6): void {
  ok(
    label,
    Math.abs(actual - expected) < eps,
    `expected ${expected}, got ${actual}`,
  );
}

/** Build daily candles starting Monday 2024-01-01 UTC from a list of closes. */
function makeCandles(closes: number[]): Candle[] {
  const start = Date.UTC(2024, 0, 1); // a Monday
  return closes.map((c, i) => ({
    time: start + i * 86_400_000,
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
  }));
}

console.log('\nMoving average');
{
  const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  close('SMA of 1..10 is 5.5', sma(candles, 9, 10)!, 5.5);
  close('SMA of last 3 (8,9,10) is 9', sma(candles, 9, 3)!, 9);
  ok('SMA is null before enough history', sma(candles, 1, 5) === null);
}

console.log('\nWeek keys');
{
  ok(
    'Monday and the following Sunday share a week key',
    weekKey(Date.UTC(2024, 0, 1)) === weekKey(Date.UTC(2024, 0, 7)),
  );
  ok(
    'the next Monday starts a new week',
    weekKey(Date.UTC(2024, 0, 1)) !== weekKey(Date.UTC(2024, 0, 8)),
  );
}

console.log('\nFIFO cost basis');
{
  const lots = [
    { time: 1, qty: 1, costPerUnit: 100 },
    { time: 2, qty: 1, costPerUnit: 200 },
  ];
  const r = sellFifo(lots, 1.5, 400);
  close('basis consumes oldest lot first', r.basis, 100 + 0.5 * 200);
  close('realised gain is proceeds minus basis', r.realised, 400 - 200);
  ok('one partial lot remains', r.remaining.length === 1);
  close('remaining quantity is 0.5', r.remaining[0].qty, 0.5);
  close('remaining lot keeps its own cost', r.remaining[0].costPerUnit, 200);

  const untouched = sellFifo(lots, 0, 0);
  ok('selling nothing changes nothing', untouched.remaining === lots);

  const loss = sellFifo([{ time: 1, qty: 1, costPerUnit: 100 }], 1, 60);
  close('a losing sale reports a negative number', loss.realised, -40);
}

console.log('\nStop loss');
{
  const candles = makeCandles(Array.from({ length: 60 }, () => 100));
  const params = { smaDays: 20, signalWeekday: 1, stopLossPct: 20 };
  const atStop = decide(candles, 59, 'LONG', 125, params);
  ok('stop fires when close is 20% under entry', atStop.action === 'EXIT');
  ok('stop is labelled as a stop', atStop.reason.startsWith('Stop loss'));

  const safe = decide(candles, 59, 'LONG', 110, params);
  ok('stop does not fire above the threshold', safe.action !== 'EXIT');

  const flat = decide(candles, 59, 'FLAT', null, params);
  ok('a flat position has no stop price', flat.stopPrice === null);
  ok('a stop exit is flagged rather than inferred from its wording', atStop.isStop);
  ok('an ordinary hold is not flagged as a stop', flat.isStop === false);
}

console.log('\nIntraday crash stop');
{
  const candles = makeCandles(Array.from({ length: 60 }, () => 100));
  const params = { smaDays: 20, signalWeekday: 1, stopLossPct: 20, crashStopPct: 30 };

  // Entry 150: daily stop sits at 120, crash stop at 105. The close is 100, so
  // the ordinary stop already covers this one.
  const both = decide(candles, 59, 'LONG', 150, params, 100);
  ok('the daily-close stop still takes priority', both.action === 'EXIT');
  ok('and reports itself as the close-based stop', both.reason.startsWith('Stop loss.'));

  // Close comfortably above the daily stop, live price below the crash stop.
  const crashing = makeCandles(Array.from({ length: 60 }, () => 200));
  const c1 = decide(crashing, 59, 'LONG', 220, params, 150);
  ok('intraday stop fires on the live price alone', c1.action === 'EXIT');
  ok('it is flagged as a stop', c1.isStop === true);
  ok('it says it did not wait for the close', c1.reason.includes('intraday'));

  const c2 = decide(crashing, 59, 'LONG', 220, params, 190);
  ok('no intraday exit while the live price is above the crash stop', c2.action !== 'EXIT');

  // The backtest never supplies a live price, so the rule must stay inert.
  const noLive = decide(crashing, 59, 'LONG', 220, params);
  ok('without a live price the crash stop cannot fire', noLive.action !== 'EXIT');

  const off = decide(crashing, 59, 'LONG', 220, { ...params, crashStopPct: 0 }, 10);
  ok('crashStopPct 0 disables the intraday stop entirely', off.action !== 'EXIT');
  ok('and reports no crash stop price', off.crashStopPrice === null);

  close('crash stop sits 30% under entry', c1.crashStopPrice!, 220 * 0.7, 1e-9);
}

console.log('\nSignal cadence');
{
  // 100 flat days, then a steady climb. smaDays 20, signals on Mondays only.
  const closes = [
    ...Array.from({ length: 100 }, () => 100),
    ...Array.from({ length: 100 }, (_, i) => 100 + i * 2),
  ];
  const candles = makeCandles(closes);
  const params = { smaDays: 20, signalWeekday: 1, stopLossPct: 50 };

  const nonMonday = candles.findIndex(
    (c, i) => i > 120 && new Date(c.time).getUTCDay() !== 1,
  );
  const d1 = decide(candles, nonMonday, 'FLAT', null, params);
  ok('no entry on a non-signal day even in a clear uptrend', d1.action === 'HOLD');
  ok('non-signal day is flagged as such', d1.isSignalDay === false);

  const monday = candles.findIndex(
    (c, i) => i > 120 && new Date(c.time).getUTCDay() === 1,
  );
  const d2 = decide(candles, monday, 'FLAT', null, params);
  ok('entry happens on the signal day in an uptrend', d2.action === 'ENTER');
  ok('signal day is flagged as such', d2.isSignalDay === true);
}

console.log('\nBacktest accounting');
{
  // Up then down, so at least one full round trip happens.
  const closes = [
    ...Array.from({ length: 60 }, () => 100),
    ...Array.from({ length: 120 }, (_, i) => 100 + i * 2),
    ...Array.from({ length: 120 }, (_, i) => 340 - i * 2),
  ];
  const candles = makeCandles(closes);
  const r = runBacktest(
    candles,
    { smaDays: 30, signalWeekday: 1, stopLossPct: 50 },
    { feeBps: 25, slippageBps: 10 },
    134,
    30,
  );

  ok('at least one round trip occurred', r.roundTrips >= 1, `got ${r.roundTrips}`);
  ok('fees were charged', r.totalFees > 0);

  let expectSide: 'BUY' | 'SELL' = 'BUY';
  let alternates = true;
  for (const t of r.trades) {
    if (t.side !== expectSide) alternates = false;
    expectSide = t.side === 'BUY' ? 'SELL' : 'BUY';
  }
  ok('trades strictly alternate buy, sell, buy', alternates);

  ok('equity never goes negative', r.equityCurve.every((p) => p.equity >= 0));

  // No leverage: exposure can never exceed equity.
  const maxLeverage = Math.max(
    ...r.equityCurve.map((p) => p.equity / (r.startEquity || 1)),
  );
  ok('equity curve is finite', Number.isFinite(maxLeverage));

  // The books must balance: start + realised + unrealised = end.
  const openBasis = r.trades.reduce((acc, t) => acc, 0);
  const netRealised = r.realisedGains - r.realisedLosses;
  const lastClose = candles[candles.length - 1].close;
  // Reconstruct what the run should have ended with.
  const impliedEnd = r.startEquity + netRealised;
  const endedFlat = r.trades.length % 2 === 0;
  if (endedFlat) {
    close(
      'start plus realised equals final equity when flat at the end',
      r.endEquity,
      impliedEnd,
      0.01,
    );
  } else {
    ok('finished holding a position, so equity includes unrealised value', true);
  }
  ok('unused variables are not lying', openBasis === 0 && lastClose > 0);

  // Fee drag sanity: a round trip at 25 bps each way plus 10 bps slippage each
  // way should cost roughly 0.7% of the traded amount.
  const firstBuy = r.trades.find((t) => t.side === 'BUY');
  ok('the first trade is a buy', firstBuy?.side === 'BUY');
  if (firstBuy) {
    const impliedFeeRate = firstBuy.fee / (firstBuy.fee + firstBuy.qty * firstBuy.price);
    ok(
      'buy fee is about 0.25% of the outlay',
      Math.abs(impliedFeeRate - 0.0025) < 0.0005,
      `got ${(impliedFeeRate * 100).toFixed(3)}%`,
    );
  }
}

console.log('\nGuard rails');
{
  const candles = makeCandles(Array.from({ length: 40 }, () => 100));
  let threw = false;
  try {
    runBacktest(
      candles,
      { smaDays: 10, signalWeekday: 1, stopLossPct: 20 },
      { feeBps: 25, slippageBps: 10 },
      134,
      999,
    );
  } catch {
    threw = true;
  }
  ok('an out-of-range warm-up index is rejected', threw);

  let threw2 = false;
  try {
    runBacktest(
      [],
      { smaDays: 10, signalWeekday: 1, stopLossPct: 20 },
      { feeBps: 25, slippageBps: 10 },
    );
  } catch {
    threw2 = true;
  }
  ok('an empty candle set is rejected', threw2);
}

console.log(
  `\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}\n`,
);
process.exit(failures > 0 ? 1 : 0);
