import { describe, expect, it } from 'vitest';
import { replaceJobOutput, replacementKey, withReplacedOutput } from '../src/admin';
import { loadJob } from '../src/lifecycle';
import { jobs } from '../src/schema';
import { memoryStore } from '../src/store';
import { db } from './db';

async function deliveredJob() {
  const id = `job_${crypto.randomUUID().replaceAll('-', '')}`;
  await db.insert(jobs).values({
    id,
    userId: 'u',
    modelId: 'm',
    kind: 'video',
    prompt: '',
    inputJson: '{}',
    upstream: 'yir',
    status: 'succeeded',
    outputsJson: JSON.stringify([
      { key: `jobs/${id}/0.mp4`, mediaType: 'video/mp4' },
      { key: `jobs/${id}/1.mp4`, mediaType: 'video/mp4' },
    ]),
  });
  return id;
}

describe('replace a delivered output', () => {
  it('builds a new key per redo and keeps the other outputs and the media type', () => {
    expect(replacementKey('job_abc', 1, '.mp4', 42)).toBe('jobs/job_abc/1-r42.mp4');
    expect(() => replacementKey('../x', 0, '.mp4')).toThrow(/bad job id/);
    expect(() => replacementKey('job_abc', 0, 'mp4')).toThrow(/bad extension/);
    const outputs = withReplacedOutput(
      JSON.stringify([
        { key: 'a', mediaType: 'video/mp4' },
        { key: 'b', mediaType: 'video/mp4' },
      ]),
      1,
      'c',
    );
    expect(outputs).toEqual([
      { key: 'a', mediaType: 'video/mp4' },
      { key: 'c', mediaType: 'video/mp4' },
    ]);
    expect(() => withReplacedOutput(null, 0, 'c')).toThrow(/no output 0/);
  });

  it('writes nothing without apply, then stores the file under the new key and points the job at it', async () => {
    const store = memoryStore();
    const id = await deliveredJob();
    const body = new Uint8Array([1, 2, 3]);
    const plan = await replaceJobOutput(
      { db, store },
      { jobId: id, index: 1, body, extension: '.mp4', apply: false, now: 7 },
    );
    expect(plan).toMatchObject({ applied: false, key: `jobs/${id}/1-r7.mp4` });
    expect(await store.head(`jobs/${id}/1-r7.mp4`)).toBeNull();
    expect(JSON.parse((await loadJob(db, id))!.outputsJson!)[1].key).toBe(`jobs/${id}/1.mp4`);

    await replaceJobOutput(
      { db, store },
      { jobId: id, index: 1, body, extension: '.mp4', apply: true, now: 7 },
    );
    expect(await store.head(`jobs/${id}/1-r7.mp4`)).toMatchObject({ size: 3, contentType: 'video/mp4' });
    expect(JSON.parse((await loadJob(db, id))!.outputsJson!)).toEqual([
      { key: `jobs/${id}/0.mp4`, mediaType: 'video/mp4' },
      { key: `jobs/${id}/1-r7.mp4`, mediaType: 'video/mp4' },
    ]);
  });

  it('refuses a job that does not exist', async () => {
    await expect(
      replaceJobOutput(
        { db, store: memoryStore() },
        { jobId: 'job_missing', index: 0, body: new Uint8Array(), extension: '.mp4', apply: false },
      ),
    ).rejects.toThrow(/no job/);
  });
});
