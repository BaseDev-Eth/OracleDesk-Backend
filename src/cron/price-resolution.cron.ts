import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { newId, runWithContext } from '../lib/context';
import { recordCronRun } from './registry';
import { revealPriceSpec, runPriceResolutionTick } from '../services/price-resolution.service';
import { captureCloseSnapshot, runPriceFeedMonitor } from '../services/price-feed-monitor.service';
import { sweepUnverifiedPriceResolutions } from '../services/price-resolution-verifier.service';
import { resolverState } from '../services/chain.service';
import type { ResolutionSpecJson } from '../lib/resolution-spec';

let isRunning = false;
let isMonitorRunning = false;

/**
 * Price-mode markets (#90, #309):
 * - Every 5 minutes: reveal unconfigured specs, capture close snapshots and
 *   resolve closed price markets, monitor open price markets inside the close
 *   window, and sweep any resolved price markets missing a verification check.
 * - Every 15 minutes: monitor all open price markets' Reflector feeds.
 */
export function startPriceResolutionCron(): void {
  cron.schedule('*/5 * * * *', () => {
    const cycleId = newId('cyc');
    return runWithContext({ requestId: cycleId, cycleId, kind: 'cron', job: 'price-resolution' }, async () => {
      if (isRunning) {
        logger.warn('Price resolution cron: previous run still active — skipping');
        return;
      }
      isRunning = true;
      const startedAt = new Date();
      try {
        await revealPendingSpecs();
        const candidates = await prisma.market.findMany({
          where: {
            status: { in: ['ACTIVE', 'RESOLVING'] },
            onChainMarketId: { not: null },
            expiryTimestamp: { lte: new Date() },
            resolutionSpec: { path: ['kind'], equals: 'price' },
          },
          select: { id: true, onChainMarketId: true, expiryTimestamp: true, createdAt: true, resolutionSpec: true },
        });
        const { resolved, escalated } = await runPriceResolutionTick({
          markets: candidates,
          captureSnapshot: async (market) => {
            await captureCloseSnapshot({
              id: market.id,
              expiryTimestamp: market.expiryTimestamp,
              resolutionSpec: market.resolutionSpec,
            });
          },
        });
        // Close-window fast-cadence Reflector feed health check (#309)
        const feedSummary = await runPriceFeedMonitor({ onlyCloseWindow: true });
        // Post-resolution verifier sweep for any missed PriceResolution events (#309)
        const swept = await sweepUnverifiedPriceResolutions();
        recordCronRun('price-resolution', 'success', startedAt, new Date());
        if (resolved.length || escalated.length || feedSummary.escalated || swept.length) {
          logger.info(
            {
              resolved: resolved.map(String),
              escalated: escalated.map(String),
              feedCloseWindow: feedSummary,
              verifiedSwept: swept.length,
            },
            'Price resolution cron: tick complete',
          );
        }
      } catch (err) {
        recordCronRun('price-resolution', 'failure', startedAt, new Date(), err);
        logger.error({ err }, 'Price resolution cron: run failed');
      } finally {
        isRunning = false;
      }
    });
  });

  // Full Reflector feed health monitor across all open price markets every 15 minutes (#309)
  cron.schedule('*/15 * * * *', () => {
    const cycleId = newId('cyc');
    return runWithContext({ requestId: cycleId, cycleId, kind: 'cron', job: 'price-feed-monitor' }, async () => {
      if (isMonitorRunning) {
        logger.warn('Price feed monitor cron: previous run still active — skipping');
        return;
      }
      isMonitorRunning = true;
      const startedAt = new Date();
      try {
        const summary = await runPriceFeedMonitor({ onlyCloseWindow: false });
        recordCronRun('price-feed-monitor', 'success', startedAt, new Date());
        if (summary.warnings || summary.critical || summary.escalated) {
          logger.info(summary, 'Price feed monitor cron: run complete');
        }
      } catch (err) {
        recordCronRun('price-feed-monitor', 'failure', startedAt, new Date(), err);
        logger.error({ err }, 'Price feed monitor cron: run failed');
      } finally {
        isMonitorRunning = false;
      }
    });
  });

  logger.info('Price resolution & feed monitor crons scheduled');
}

/** Reveals any live price market whose resolver state is still Unconfigured. */
async function revealPendingSpecs(): Promise<void> {
  const markets = await prisma.market.findMany({
    where: {
      status: 'ACTIVE',
      onChainMarketId: { not: null },
      resolutionSpec: { path: ['kind'], equals: 'price' },
    },
    select: { id: true, onChainMarketId: true, resolutionSpec: true },
  });
  for (const market of markets) {
    if (market.onChainMarketId === null) continue;
    try {
      if ((await resolverState(market.onChainMarketId)).tag !== 'Unconfigured') continue;
      await revealPriceSpec(market.onChainMarketId, market.resolutionSpec as Extract<ResolutionSpecJson, { kind: 'price' }>);
    } catch (err) {
      logger.warn({ marketId: market.id, err }, 'Price resolution cron: reveal failed; will retry next tick');
    }
  }
}
