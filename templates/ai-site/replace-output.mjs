// Replace a delivered output of a job by hand (a redo after a complaint): store the new file under a new key and point the job at it
// (packages/jobs/src/admin.ts). It writes to the database and bucket this site's settings name, so in production run it only after
// the owner said so, inside the site's container:
//
//   docker compose cp redo.mp4 site:/tmp/redo.mp4
//   docker compose exec site node replace-output.mjs <job id> <output index> /tmp/redo.mp4          # shows the plan
//   docker compose exec site node replace-output.mjs <job id> <output index> /tmp/redo.mp4 --yes    # does it
//
// Needs a build (dist/). Locally: pnpm build, then node --env-file-if-exists=.env replace-output.mjs …
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

// This process must never run jobs: the server module would otherwise start a job worker on import.
process.env.JOB_WORKER = '0';

const apply = process.argv.includes('--yes');
const [jobId, indexText, file] = process.argv.slice(2).filter((arg) => arg !== '--yes');
const index = Number(indexText);
if (!jobId || !Number.isInteger(index) || index < 0 || !file) {
  console.error('usage: node replace-output.mjs <job id> <output index> <file> [--yes]');
  process.exit(2);
}
const { admin } = await import('./dist/server/server.js');
try {
  const result = await admin.replaceOutput({
    jobId,
    index,
    body: new Uint8Array(await readFile(file)),
    extension: extname(file).toLowerCase(),
    apply,
  });
  console.log(`${result.jobId} (${result.status}) output ${index} → ${result.key}`);
  console.log(JSON.stringify(result.outputs));
  console.log(result.applied ? 'done' : 'dry run: add --yes to store the file and update the job');
  process.exit(0);
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
