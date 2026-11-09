#!/usr/bin/env node
// Usage: node ../../tools/check-site.mjs <site dir> (a site's pnpm check runs it after the build)
// Checks that a site has the files, routes and policy pages needed to launch, that the browser bundle has no zh messages, no strings from
// *.server.ts files and no .dev.vars values, and that the site imports no other site.
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_FILES = [
  'README.md',
  'DESIGN.md',
  'site.config.ts',
  'site.models.ts',
  'src/models.server.ts',
  'wrangler.jsonc',
  'src/server.ts',
];
const REQUIRED_ROUTES = [
  'src/routes/sitemap[.]xml.ts',
  'src/routes/robots[.]txt.ts',
  'src/routes/llms[.]txt.ts',
  'src/routes/api/webhooks/stripe.ts',
  'src/routes/api/auth/$.ts',
];
// Policy pages: required by payment providers and for complaints. Text lives in messages/legal; the template has TODO placeholders.
const LEGAL_PAGES = ['privacy', 'terms', 'refunds', 'dmca'];
const LEGAL_FILE = 'src/site/legal.tsx';

function walk(dir, files = [], pattern = /\.(ts|tsx)$/) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files, pattern);
    else if (pattern.test(entry.name)) files.push(full);
  }
  return files;
}

/** Chinese copy from messages/<block>/zh.json. Production ships English only, so none of it should be in the build. */
function zhMessages(dir) {
  const messages = path.join(dir, 'messages');
  if (!fs.existsSync(messages)) return [];
  const texts = [];
  for (const block of fs.readdirSync(messages)) {
    const file = path.join(messages, block, 'zh.json');
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      if (key !== '$schema' && typeof value === 'string' && /\p{Script=Han}{4,}/u.test(value))
        texts.push(value);
    }
  }
  return texts;
}

/**
 * Literal text of every string in a source file, template literals split at ${…} and the code inside scanned too.
 * A small scanner rather than a regex, so apostrophes in comments and // inside URLs are not mistaken for strings or comments.
 */
export function stringLiterals(source) {
  const out = [];
  let i = 0;
  // Code up to the } that closes a ${…} (nested), or to the end of the file (top level).
  const code = (nested) => {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === '/' && source[i + 1] === '/') {
        const end = source.indexOf('\n', i);
        i = end === -1 ? source.length : end;
      } else if (c === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        i = end === -1 ? source.length : end + 2;
      } else if (c === "'" || c === '"' || c === '`') string(c);
      else if (c === '{') {
        depth++;
        i++;
      } else if (c === '}' && nested && depth === 0) return;
      else {
        if (c === '}') depth--;
        i++;
      }
    }
  };
  const string = (quote) => {
    let text = '';
    i++;
    while (i < source.length && source[i] !== quote) {
      // An escape ends the run: the bundler may write it differently.
      if (source[i] === '\\') {
        out.push(text);
        text = '';
        i += 2;
      } else if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
        out.push(text);
        text = '';
        i += 2;
        code(true);
        i++;
      } else text += source[i++];
    }
    out.push(text);
    i++;
  };
  code(false);
  return out;
}

// Long enough that shared words and short keys do not hit, short enough to catch asset paths.
const SERVER_TEXT_MIN = 24;

/**
 * Text that only server code should hold: runs of at least SERVER_TEXT_MIN characters from string literals in src/**\/*.server.ts(x)
 * (prompts, reference clips, internal rules). Import protection already stops pages importing those files; this also catches
 * a string copied into a page. Text both sides need belongs in a shared module that the server file imports.
 * Runs stop at quotes and escapes, since the bundler may re-quote or re-escape a string.
 */
function serverTexts(dir) {
  const src = path.join(dir, 'src');
  if (!fs.existsSync(src)) return [];
  const texts = new Map();
  for (const file of walk(src).filter((f) => /\.server\.tsx?$/.test(f))) {
    for (const literal of stringLiterals(fs.readFileSync(file, 'utf8'))) {
      for (const run of literal.split(/["'`]/)) {
        if (run.trim().length >= SERVER_TEXT_MIN)
          texts.set(run, path.relative(dir, file).replaceAll(path.sep, '/'));
      }
    }
  }
  return [...texts];
}

/**
 * Values from the local .dev.vars (absent in CI), read as dotenv does: optional export prefix, quoted values kept whole,
 * a # after whitespace starts a comment in unquoted ones. Only names are ever printed.
 */
export function devVars(dir, name = '.dev.vars') {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map(([, key, raw]) => {
      const quoted = raw.match(/^(['"`])([\s\S]*?)\1/);
      return [key, quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trim()];
    })
    .filter(([, value]) => value.length >= 8);
}

function checkBuild(dir) {
  // Only the browser bundle is checked: that is what ships to visitors, while the server bundle keeps everything by design.
  const dist = path.join(dir, 'dist', 'client');
  if (!fs.existsSync(dist)) return [];
  const zh = zhMessages(dir);
  const server = serverTexts(dir);
  // A public value (a site key, the app URL) may sit in .dev.vars and in the page; those are not secrets, so public config is allowed.
  const secrets = devVars(dir).filter(
    ([key]) => !/^(APP_URL|EMAIL_FROM|.*_SITE_KEY|.*_CLIENT_ID|.*_PROJECT_ID)$/.test(key),
  );
  const problems = [];
  for (const file of walk(dist, [], /\.(js|mjs|html|css|json|txt|map)$/)) {
    const source = fs.readFileSync(file, 'utf8');
    const where = path.relative(dir, file).replaceAll(path.sep, '/');
    // Match whole strings of at least 4 Han characters, so the dev-only language toggle and short words in shared packages do not hit.
    const hit = zh.find((text) => source.includes(text));
    if (hit)
      problems.push(
        `Build output ${where} contains a zh message (${hit}); production builds should use project.en.inlang only`,
      );
    for (const [text, from] of server.filter(([text]) => source.includes(text)))
      problems.push(
        `Build output ${where} contains server-only text from ${from} ("${text.slice(0, 40)}…"); keep it out of files that pages import`,
      );
    for (const [key] of secrets.filter(([, value]) => source.includes(value)))
      problems.push(`Build output ${where} contains the value of ${key} from .dev.vars`);
  }
  return problems;
}

function checkLegal(dir, isTemplate) {
  const problems = [];
  for (const page of LEGAL_PAGES) {
    if (!fs.existsSync(path.join(dir, `src/routes/${page}.tsx`)))
      problems.push(`Missing policy page src/routes/${page}.tsx`);
  }
  if (!fs.existsSync(path.join(dir, LEGAL_FILE)))
    return [...problems, `Missing ${LEGAL_FILE} (SUPPORT_EMAIL)`];
  if (isTemplate) return problems;
  const email = fs.readFileSync(path.join(dir, LEGAL_FILE), 'utf8').match(/SUPPORT_EMAIL = '([^']*)'/)?.[1];
  if (!email || email.endsWith('example.com'))
    problems.push(`${LEGAL_FILE} SUPPORT_EMAIL is still a placeholder`);
  // Every shipped locale counts, so a site whose base locale is not English is checked too; zh is the dev-only review copy.
  for (const block of ['legal', 'common']) {
    const folder = path.join(dir, 'messages', block);
    if (!fs.existsSync(folder)) continue;
    for (const name of fs.readdirSync(folder).sort()) {
      if (!name.endsWith('.json') || name === 'zh.json') continue;
      if (fs.readFileSync(path.join(folder, name), 'utf8').includes('TODO'))
        problems.push(`messages/${block}/${name} still has TODO placeholders (policy text or update date)`);
    }
  }
  return problems;
}

/** A relative import that resolves outside the site directory: shared code comes from packages by name, never by path. */
function escapesSite(dir, file, source) {
  const root = path.resolve(dir) + path.sep;
  const code = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  for (const match of code.matchAll(/(?:\bfrom|\bimport\s*\(?)\s*['"](\.{1,2}\/[^'"]*)['"]/g)) {
    if (!(path.resolve(path.dirname(file), match[1]) + path.sep).startsWith(root)) return true;
  }
  return false;
}

export function checkSite(dir) {
  const problems = [];
  const isTemplate = path.resolve(dir).split(path.sep).includes('templates');
  for (const file of isTemplate ? REQUIRED_FILES.filter((f) => !f.endsWith('.md')) : REQUIRED_FILES) {
    if (!fs.existsSync(path.join(dir, file))) problems.push(`Missing ${file}`);
  }
  for (const route of REQUIRED_ROUTES) {
    if (!fs.existsSync(path.join(dir, route))) problems.push(`Missing route ${route}`);
  }
  if (!isTemplate && fs.existsSync(path.join(dir, 'wrangler.jsonc'))) {
    const wrangler = fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
    if (wrangler.includes('ai-site-template')) problems.push('wrangler.jsonc still has the template name');
    if (wrangler.includes('<set after wrangler d1 create'))
      problems.push('wrangler.jsonc database_id is not set');
  }
  if (!isTemplate && fs.existsSync(path.join(dir, 'site.config.ts'))) {
    if (fs.readFileSync(path.join(dir, 'site.config.ts'), 'utf8').includes('example.com')) {
      problems.push('site.config.ts url is still example.com');
    }
  }
  problems.push(...checkLegal(dir, isTemplate), ...checkBuild(dir));
  for (const file of fs.existsSync(path.join(dir, 'src')) ? walk(path.join(dir, 'src')) : []) {
    const source = fs.readFileSync(file, 'utf8');
    if (escapesSite(dir, file, source) || /@shipwords\/(site|template)-/.test(source)) {
      problems.push(`${path.relative(dir, file)} imports another site`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dir = path.resolve(process.argv[2] ?? '.');
  const problems = checkSite(dir);
  if (problems.length) {
    console.error(`Site check failed (${dir}):`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log('Site check passed');
}
