import type { Db } from '@shipwords/core/db/client';
import { eq } from 'drizzle-orm';
import type { StoredOutput } from './lifecycle';
import { jobs } from './schema';
import type { ObjectStore } from './store';

// Owner operations on a site's data, run by hand (the site's replace-output.mjs), never from a request.

/** The new key for output `index`: next to the old one, with a timestamp so every redo has its own URL. */
export function replacementKey(jobId: string, index: number, extension: string, now = Date.now()): string {
  if (!/^job_[a-z0-9]+$/.test(jobId)) throw new Error(`bad job id ${jobId}`);
  if (!/^\.[a-z0-9]+$/.test(extension)) throw new Error(`bad extension ${extension}`);
  return `jobs/${jobId}/${index}-r${now}${extension}`;
}

/** outputs_json with output `index` moved to `key`; the media type stays. */
export function withReplacedOutput(outputsJson: string | null, index: number, key: string): StoredOutput[] {
  const outputs = JSON.parse(outputsJson ?? 'null') as StoredOutput[] | null;
  if (!Array.isArray(outputs) || !outputs[index]) throw new Error(`the job has no output ${index}`);
  return outputs.map((output, i) => (i === index ? { ...output, key } : output));
}

export interface ReplaceOutputInput {
  jobId: string;
  index: number;
  /** The new file and its extension (".mp4"). */
  body: Uint8Array;
  extension: string;
  /** Without it nothing is written: the plan is returned for a look first. */
  apply: boolean;
  now?: number;
}

/**
 * Replace a delivered output of a job (a redo after a complaint): store the new file under a new key and point outputs_json at it.
 * Outputs are served with a year-long immutable cache, so overwriting the old key would leave anyone who already opened it on the
 * old file; a new key is a new URL. The old object stays in the store.
 */
export async function replaceJobOutput(deps: { db: Db; store: ObjectStore }, input: ReplaceOutputInput) {
  const [job] = await deps.db
    .select({ status: jobs.status, outputsJson: jobs.outputsJson })
    .from(jobs)
    .where(eq(jobs.id, input.jobId));
  if (!job) throw new Error(`no job ${input.jobId}`);
  const key = replacementKey(input.jobId, input.index, input.extension, input.now);
  const outputs = withReplacedOutput(job.outputsJson, input.index, key);
  const plan = { jobId: input.jobId, status: job.status, key, outputs };
  if (!input.apply) return { ...plan, applied: false };
  await deps.store.put(key, input.body, { contentType: outputs[input.index]!.mediaType });
  await deps.db
    .update(jobs)
    .set({ outputsJson: JSON.stringify(outputs) })
    .where(eq(jobs.id, input.jobId));
  return { ...plan, applied: true };
}
