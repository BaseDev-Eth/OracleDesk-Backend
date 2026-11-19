import cron from 'node-cron';
import { runTraceAudit, runVerdictRecheck } from '../services/trace-audit.service';
import { logger } from '../lib/logger';
import { config } from '../config';

let isRunning = false;

/**
 * Trace Audit Cron (#150, #306).
 * - Full audit (`TRACE_AUDIT_CRON`): walks the reasoning-registry on-chain
 *   index, verifies IPFS content hashes, evaluates `trace_verdict`, detects
 *   discrepancies, and relinks missed records.
 * - Fast lane (`TRACE_VERDICT_CRON`, default every 10 minutes): re-checks
 *   flagged/non-VALID traces and traces of revoked agents only.
 * Both schedules share `isRunning` so they never overlap.
 */
export function startTraceAuditCron(): void {
  if (!config.TRACE_AUDIT_ENABLED) {
    logger.info('Trace audit cron is disabled by config (TRACE_AUDIT_ENABLED=false)');
    return;
  }

  cron.schedule(config.TRACE_AUDIT_CRON, async () => {
    if (isRunning) {
      logger.warn('Trace audit cron: previous run still active — skipping cycle');
      return;
    }

    isRunning = true;
    try {
      logger.info('Trace audit cron: starting trace audit cycle');
      const summary = await runTraceAudit();
      logger.info(
        {
          runId: summary.runId,
          totalAudited: summary.totalAudited,
          relinked: summary.relinked,
          counts: summary.counts,
          rpcCallsByCategory: summary.rpcCallsByCategory,
          verdictsChecked: summary.verdictsChecked,
          verdictsChanged: summary.verdictsChanged,
        },
        'Trace audit cron completed',
      );
    } catch (err) {
      logger.error({ err }, 'Trace audit cron encountered an error');
    } finally {
      isRunning = false;
    }
  });

  cron.schedule(config.TRACE_VERDICT_CRON, async () => {
    if (isRunning) {
      logger.warn('Trace verdict fast-lane cron: audit already active — skipping cycle');
      return;
    }

    isRunning = true;
    try {
      const summary = await runVerdictRecheck({ maxRpc: config.TRACE_VERDICT_MAX_RPC });
      if (summary.checked > 0 || summary.changed > 0) {
        logger.info(summary, 'Trace verdict fast-lane completed');
      }
    } catch (err) {
      logger.error({ err }, 'Trace verdict fast-lane encountered an error');
    } finally {
      isRunning = false;
    }
  });

  logger.info(
    { cronSchedule: config.TRACE_AUDIT_CRON, verdictSchedule: config.TRACE_VERDICT_CRON },
    'Trace audit & verdict crons scheduled',
  );
}
