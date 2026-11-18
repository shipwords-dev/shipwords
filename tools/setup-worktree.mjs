#!/usr/bin/env node
// Usage: pnpm setup:worktree
// A new worktree has none of the git-ignored secret files. This script copies ~/.config/shipwords/<site dir>.env
// (outside the repo) to each site's .env and points APP_URL at this worktree's dev port.
// Worktrees created by Claude Code copy .env via .worktreeinclude, but the port still needs this script.
import fs from 'node:fs';
import path from 'node:path';
import { portFor } from './dev-port.mjs';
import { SECRETS_DIR, setVar, siteDirs } from './lib.mjs';

let missing = 0;
for (const site of siteDirs()) {
  const target = path.join(site.dir, '.env');
  const source = path.join(SECRETS_DIR, `${site.name}.env`);
  let text;
  if (fs.existsSync(source)) text = fs.readFileSync(source, 'utf8');
  else if (fs.existsSync(target)) text = fs.readFileSync(target, 'utf8');
  else {
    missing++;
    console.log(
      `- ${site.group}/${site.name}: no secrets file; copy .env.example to ${source} and fill it in`,
    );
    continue;
  }
  fs.writeFileSync(target, setVar(text, 'APP_URL', `http://localhost:${portFor(site.dir)}`));
  console.log(`- ${site.group}/${site.name}: .env ready (http://localhost:${portFor(site.dir)})`);
}
if (missing) process.exitCode = 0;
