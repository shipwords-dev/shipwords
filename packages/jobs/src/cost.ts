import { loadJob, recordUpstreamCost, SKIPPED_UPSTREAM as SKIPPED, upstreamIds } from './lifecycle';
import type { RunnerDeps, StepRunner } from './runner';
import { TERMINAL } from './schema';

/** Billing can settle after the result lands: re-read this many times, this far apart. */
const COST_READS = 4;
const COST_PAUSE_MS = 30_000;

/**
 * Record what the upstream actually charged, summed over every upstream task of the job; failed jobs can cost money too.
 * Every complete read is written, so a later read that fails keeps the amount already seen; still unsettled after the last read is logged.
 * Not counted: prep hedge copies (not in upstream_job_id) and a task the runner cancels right after a user cancel won the race
 * against its submit (never recorded).
 */
export async function recordCost(deps: RunnerDeps, jobId: string, step: StepRunner): Promise<void> {
  for (let attempt = 0; attempt < COST_READS; attempt++) {
    const done = await step.do(`cost:${attempt}`, async () => {
      const job = await loadJob(deps.db, jobId);
      const adapter = job ? deps.adapters[job.upstream] : undefined;
      if (!job || !TERMINAL.includes(job.status) || !adapter?.cost) return true;
      const ids = upstreamIds(job).filter((id) => !id.startsWith(SKIPPED));
      if (ids.length === 0) return true;
      const costs = await Promise.all(ids.map((id) => adapter.cost!(id)));
      await recordUpstreamCost(deps.db, jobId, sumUsd(costs.map((cost) => cost.usd)));
      const settled = costs.every((cost) => cost.settled);
      if (!settled && attempt === COST_READS - 1) deps.log?.('upstream cost not settled', { jobId, costs });
      return settled;
    });
    if (done || attempt === COST_READS - 1) return;
    await step.sleep(`cost-wait:${attempt}`, COST_PAUSE_MS);
  }
}

/** Add USD strings in micro-dollars to avoid float drift; "3.06" + "0.0085" → "3.0685". */
export function sumUsd(amounts: readonly string[]): string {
  const micros = amounts.reduce((sum, amount) => {
    const value = Number(amount);
    if (!Number.isFinite(value)) throw new Error(`bad upstream cost: ${amount}`);
    return sum + Math.round(value * 1e6);
  }, 0);
  return (micros / 1e6).toFixed(6).replace(/\.?0+$/, '');
}
