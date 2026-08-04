import { NextResponse } from 'next/server';
import { fetchDailyCandles } from '@/lib/bitvavo';
import { config } from '@/lib/config';
import {
  runBacktest,
  splitCandles,
  sweepInSample,
  score,
  type BacktestResult,
} from '@/lib/backtest';
import { summariseForSkat } from '@/lib/tax';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SMA_CANDIDATES = [50, 70, 90, 110, 130, 140, 150, 170, 190, 210];

function slim(r: BacktestResult) {
  return {
    smaDays: r.params.smaDays,
    from: new Date(r.from).toISOString().slice(0, 10),
    to: new Date(r.to).toISOString().slice(0, 10),
    bars: r.bars,
    totalReturnPct: Number(r.totalReturnPct.toFixed(1)),
    cagrPct: Number(r.cagrPct.toFixed(1)),
    maxDrawdownPct: Number(r.maxDrawdownPct.toFixed(1)),
    buyHoldReturnPct: Number(r.buyHoldReturnPct.toFixed(1)),
    buyHoldMaxDrawdownPct: Number(r.buyHoldMaxDrawdownPct.toFixed(1)),
    roundTrips: r.roundTrips,
    winRatePct: Number(r.winRatePct.toFixed(0)),
    totalFeesEur: Number(r.totalFees.toFixed(2)),
    exposurePct: Number(r.exposurePct.toFixed(0)),
    endEquityEur: Number(r.endEquity.toFixed(2)),
  };
}

/**
 * Runs the whole validation on live-fetched history: grid search on the first
 * half, then a single honest measurement on the second half.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const candles = await fetchDailyCandles(config.market, 3000);
    if (candles.length < 500) {
      return NextResponse.json(
        { error: `Only ${candles.length} candles available; need at least 500.` },
        { status: 503 },
      );
    }

    const costs = { feeBps: config.takerFeeBps, slippageBps: config.slippageBps };
    const base = {
      signalWeekday: config.signalWeekday,
      stopLossPct: config.stopLossPct,
    };

    const { inSample, outOfSample } = splitCandles(candles, 0.5);
    const sweep = sweepInSample(
      inSample,
      SMA_CANDIDATES,
      base,
      costs,
      config.maxAllocationEur,
    );
    const winner = sweep[0];

    // Out-of-sample: give the average a warm-up prefix from before the split so
    // it is already initialised, but start trading flat at the split point.
    const warmup = Math.max(...SMA_CANDIDATES);
    const oosStart = inSample.length - warmup;
    const oosWithWarmup = candles.slice(oosStart);
    const oos = runBacktest(
      oosWithWarmup,
      { ...base, smaDays: winner.smaDays },
      costs,
      config.maxAllocationEur,
      warmup,
    );

    // The configured setting, measured on the same out-of-sample window.
    const configured = runBacktest(
      oosWithWarmup,
      { ...base, smaDays: config.smaDays },
      costs,
      config.maxAllocationEur,
      warmup,
    );

    const tax = summariseForSkat(oos.realisedGains, oos.realisedLosses, {
      dkkPerEur: config.dkkPerEur,
      gainRatePct: config.taxRateGainPct,
      lossRatePct: config.taxRateLossPct,
    });

    return NextResponse.json({
      ok: true,
      market: config.market,
      dataFrom: new Date(candles[0].time).toISOString().slice(0, 10),
      dataTo: new Date(candles[candles.length - 1].time).toISOString().slice(0, 10),
      totalBars: candles.length,
      costs: { takerFeeBps: costs.feeBps, slippageBps: costs.slippageBps },
      inSampleWinner: slim(winner.inSample),
      inSampleRanking: sweep.map((s) => ({
        smaDays: s.smaDays,
        returnPct: Number(s.inSample.totalReturnPct.toFixed(1)),
        maxDdPct: Number(s.inSample.maxDrawdownPct.toFixed(1)),
        score: Number(score(s.inSample).toFixed(2)),
      })),
      outOfSample: slim(oos),
      configuredOutOfSample: slim(configured),
      taxOnOutOfSample: {
        rubrik20Dkk: Math.round(tax.gainsDkk),
        rubrik58Dkk: Math.round(tax.lossesDkk),
        estimatedTaxDkk: Math.round(tax.taxOnGainsDkk),
        lossReliefDkk: Math.round(tax.reliefOnLossesDkk),
        netTaxDkk: Math.round(tax.netTaxDkk),
      },
      note:
        'Only the outOfSample block is evidence. inSampleWinner was chosen with ' +
        'hindsight and will always look better than reality.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
