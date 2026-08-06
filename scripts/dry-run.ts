/**
 * Do one scheduled run from your own machine: npm run dry-run
 *
 * This is the same code path the daily cron job takes in production, so it is
 * the honest way to check the machinery before you deploy anything. State goes
 * to .bot-state.json, so running it on several days builds a real paper
 * position and a real equity curve.
 *
 * Needs internet for the Bitvavo candle and ticker endpoints, both public. API
 * keys are optional: without them the run is always paper. With them, whether
 * real money moves is still decided by TRADING_ENABLED alone.
 */

/** Load .env.local the way `next dev` would, so a local run sees the same settings. */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Absent or unreadable is fine; the defaults in config.ts take over.
    }
  }
}

function eur(n: number): string {
  return `EUR ${n.toFixed(2)}`;
}

async function main(): Promise<void> {
  // Must happen before anything pulls in config.ts, which reads process.env as
  // soon as it is evaluated. Hence the dynamic imports below rather than
  // top-of-file ones.
  loadEnv();
  const { runOnce } = await import('../src/lib/engine');
  const { config, hasCredentials } = await import('../src/lib/config');

  const live = config.tradingEnabled && hasCredentials();
  console.log(
    `Above the line -- one run, ${config.market}, ${live ? 'LIVE MONEY' : 'paper'}.`,
  );
  if (live) {
    console.log('TRADING_ENABLED is true and keys are present: orders are real.');
  } else if (!hasCredentials()) {
    console.log('No API keys set, so nothing could reach the exchange anyway.');
  } else {
    console.log('TRADING_ENABLED is not true, so no order will be sent.');
  }

  const r = await runOnce();

  console.log(`\n  ran at        ${new Date(r.ranAt).toISOString()}`);
  console.log(`  action        ${r.action}`);
  console.log(`  because       ${r.reason}`);
  if (r.blockedBy) console.log(`  blocked by    ${r.blockedBy}`);
  console.log(`  BTC price     ${eur(r.price)}`);
  console.log(
    `  ${config.smaDays}-day avg   ` +
      `${r.sma === null ? 'not enough history yet' : eur(r.sma)}`,
  );
  console.log(`  position      ${r.position}`);
  console.log(`  equity        ${eur(r.equityEur)}`);

  if (r.trade) {
    const t = r.trade;
    console.log(
      `\n  ${t.side} ${t.qty.toFixed(8)} BTC at ${eur(t.price)}, ` +
        `fee ${eur(t.fee)}${t.live ? '' : '  (paper, no money moved)'}`,
    );
    if (t.realisedPnl !== undefined) {
      console.log(
        `  realised      ${t.realisedPnl >= 0 ? '+' : ''}${eur(t.realisedPnl)}`,
      );
    }
  }

  console.log('\nState saved. Run it again tomorrow to add the next point.\n');
}

main().catch((err) => {
  console.error('\nRun failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
