#!/usr/bin/env node
// Replace a delivered output of a job by hand (a redo after a complaint): upload the new file under a new R2 key and point the job's
// outputs_json at it. Outputs are served with a year-long immutable cache, so overwriting the old key would leave anyone who already
// opened it on the old video; a new key is a new URL. The old object stays in R2 (delete it by hand if needed).
//
// Usage (from the repo root, writes to production, so only after the owner said so):
//   node vendor/shipwords/tools/replace-output.mjs <site dir> <job id> <output index> <file> [--yes]
// Without --yes it prints what it would do. Needs wrangler logged in to the site's account.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bucket bound as OUTPUTS and the D1 database name, from a site's wrangler.jsonc text. */
export function siteResources(wranglerText) {
  const bucket = wranglerText.match(/"binding"\s*:\s*"OUTPUTS"\s*,\s*"bucket_name"\s*:\s*"([^"]+)"/)?.[1];
  const database = wranglerText.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1];
  if (!bucket || !database) throw new Error('wrangler.jsonc needs an OUTPUTS bucket and a D1 database_name');
  return { bucket, database };
}

/** The new key for output `index`: next to the old one, with a timestamp so every redo has its own URL. */
export function replacementKey(jobId, index, extension, now = Date.now()) {
  if (!/^job_[a-z0-9]+$/.test(jobId)) throw new Error(`bad job id ${jobId}`);
  if (!/^\.[a-z0-9]+$/.test(extension)) throw new Error(`bad extension ${extension}`);
  return `jobs/${jobId}/${index}-r${now}${extension}`;
}

/** outputs_json with output `index` moved to `key`; the media type stays. */
export function replaceOutput(outputsJson, index, key) {
  const outputs = JSON.parse(outputsJson ?? 'null');
  if (!Array.isArray(outputs) || !outputs[index]) throw new Error(`the job has no output ${index}`);
  return JSON.stringify(outputs.map((output, i) => (i === index ? { ...output, key } : output)));
}

/** A SQL string literal. */
export function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Run the site's own wrangler with node directly: no shell, so SQL with spaces and quotes passes as one argument on every OS. */
function wrangler(cwd, args) {
  let bin = null;
  for (let dir = cwd; !bin; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    if (fs.existsSync(candidate)) bin = candidate;
    else if (path.dirname(dir) === dir) throw new Error('wrangler is not installed for this site');
  }
  return execFileSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', maxBuffer: 16 << 20 });
}

function query(cwd, database, sql) {
  const out = wrangler(cwd, ['d1', 'execute', database, '--remote', '--json', '--command', sql]);
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

function main(argv) {
  const yes = argv.includes('--yes');
  const [siteDir, jobId, indexText, file] = argv.filter((arg) => arg !== '--yes');
  const index = Number(indexText);
  if (!siteDir || !jobId || !Number.isInteger(index) || index < 0 || !file) {
    console.error('usage: replace-output.mjs <site dir> <job id> <output index> <file> [--yes]');
    process.exit(2);
  }
  if (!fs.existsSync(file)) throw new Error(`no file ${file}`);
  const cwd = path.resolve(siteDir);
  const { bucket, database } = siteResources(fs.readFileSync(path.join(cwd, 'wrangler.jsonc'), 'utf8'));
  const [job] = query(cwd, database, `select outputs_json, status from jobs where id = ${sqlString(jobId)}`);
  if (!job) throw new Error(`no job ${jobId}`);
  const key = replacementKey(jobId, index, path.extname(file).toLowerCase());
  const outputs = replaceOutput(job.outputs_json, index, key);
  console.log(`${jobId} (${job.status}) output ${index} → ${key}\n${outputs}`);
  if (!yes) {
    console.log('dry run: add --yes to upload and update the job');
    return;
  }
  const type = JSON.parse(job.outputs_json)[index].mediaType;
  wrangler(cwd, [
    'r2',
    'object',
    'put',
    `${bucket}/${key}`,
    '--file',
    path.resolve(file),
    '--content-type',
    type,
    '--remote',
  ]);
  query(cwd, database, `update jobs set outputs_json = ${sqlString(outputs)} where id = ${sqlString(jobId)}`);
  console.log('done');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
