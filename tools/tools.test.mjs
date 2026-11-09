// Run: pnpm test:tools (node --test, no install needed)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkCrawl, inspectHtml } from './check-crawl.mjs';
import { isScanned, scanText as scanPublic } from './check-public.mjs';
import { checkSite, devVars, stringLiterals } from './check-site.mjs';
import { isWorktree, portFor, sitePort } from './dev-port.mjs';
import { readSiteConfig, readStatus, setVar, TOOLS_ROOT } from './lib.mjs';
import { createSite, nextDevPort, parseArgs, validateSlug } from './new-site.mjs';
import { listenArgs, parseVars } from './stripe-listen.mjs';

const crawlHtml = `<html><head><title>Photo studio</title><meta content="Make a video" name="description"><link href="https://example.com" rel="canonical"></head><body><h1>Photo studio</h1><p>One photo. $9.98.</p><script type="application/ld+json">{"@type":"VideoObject","uploadDate":"2026-10-27T15:02:46Z"}</script></body></html>`;

test('crawl: checks real HTML text, canonical, robot directives and video dates', () => {
  assert.deepEqual(inspectHtml(crawlHtml, 'https://example.com/', new Headers(), ['One photo']), []);
  assert.match(
    inspectHtml(crawlHtml.replace('2026-10-27T15:02:46Z', '2026-10-27'), 'https://example.com/').join(),
    /datetime/,
  );
  assert.match(
    inspectHtml(
      crawlHtml.replace('https://example.com', 'https://template.example'),
      'https://example.com/',
    ).join(),
    /Canonical/,
  );
  assert.match(
    inspectHtml(crawlHtml, 'https://example.com/', new Headers({ 'x-robots-tag': 'noindex' })).join(),
    /blocks indexing/,
  );
  assert.match(
    inspectHtml(
      crawlHtml.replace('</head>', '<meta name="Googlebot" content="none"></head>'),
      'https://example.com/',
    ).join(),
    /blocks indexing/,
  );
  const shell = crawlHtml.replace(
    '<h1>Photo studio</h1><p>One photo. $9.98.</p>',
    '<script>"<h1>Photo studio</h1> One photo"</script>',
  );
  assert.match(
    inspectHtml(shell, 'https://example.com/', new Headers(), ['One photo']).join(),
    /Missing SSR H1.*Missing SSR text/,
  );
  assert.match(
    inspectHtml(crawlHtml.replace('"VideoObject"', 'invalid'), 'https://example.com/').join(),
    /Invalid JSON-LD/,
  );
});

test('crawl: bounded UA matrix detects challenge, redirect and foreign sitemap', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('robots.txt'))
      return new Response('User-agent: *\nDisallow: /api/\nSitemap: https://example.com/sitemap.xml');
    if (url.endsWith('sitemap.xml'))
      return new Response(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://wrong.example/</loc></url></urlset>',
      );
    if (options.headers['user-agent'].includes('Googlebot'))
      return new Response('Challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    return new Response('', { status: 301, headers: { location: 'https://wrong.example/' } });
  };
  const results = await checkCrawl('https://example.com', [], fakeFetch);
  assert.equal(calls.length, 12);
  assert.ok(calls.every((call) => call.options.redirect === 'manual'));
  assert.ok(results.some((r) => r.errors.includes('Cloudflare challenge')));
  assert.ok(results.some((r) => r.errors.includes('HTTP 301')));
  assert.ok(results.some((r) => r.errors.some((e) => e.startsWith('Foreign sitemap'))));
  await assert.rejects(checkCrawl('https://example.com/path', [], fakeFetch), /HTTPS origin/);
});

test('dev port: main checkout uses the site devPort, worktrees add 1-9 by path', () => {
  assert.equal(portFor('/a/sites/x', false, 5110), 5110);
  assert.equal(portFor('/a/wt1/sites/x', true, 5110), portFor('/a/wt1/sites/x', true, 5110));
  const worktreePorts = ['wt1', 'wt2', 'wt3', 'wt4'].map((wt) => portFor(`/a/${wt}/sites/x`, true, 5110));
  assert.ok(worktreePorts.every((port) => port > 5110 && port < 5120));
  assert.ok(new Set(worktreePorts).size > 1);
  assert.equal(isWorktree(TOOLS_ROOT), fs.statSync(path.join(TOOLS_ROOT, '.git')).isFile());
  assert.equal(sitePort(path.join(TOOLS_ROOT, 'templates', 'ai-site')), 5010);
  assert.throws(() => sitePort(TOOLS_ROOT), /no devPort/);
});

test('setVar replaces an existing var or appends it', () => {
  assert.equal(setVar('A=1\nAPP_URL=old\n', 'APP_URL', 'new'), 'A=1\nAPP_URL=new\n');
  assert.equal(setVar('A=1', 'APP_URL', 'x'), 'A=1\nAPP_URL=x\n');
});

test('stripe listen: forwards to APP_URL with the last test key, rejects placeholder and live keys', () => {
  const key = `sk_test_${'a'.repeat(30)}`;
  const vars = parseVars(
    `# comment\r\nAPP_URL=http://localhost:5464/\r\nSTRIPE_SECRET_KEY=sk_test_xxx\r\nSTRIPE_SECRET_KEY=${key}\r\n`,
  );
  assert.deepEqual(listenArgs(vars), [
    'listen',
    '--api-key',
    key,
    '--forward-to',
    'http://localhost:5464/api/webhooks/stripe',
  ]);
  assert.throws(() => listenArgs({ ...vars, STRIPE_SECRET_KEY: 'sk_test_xxx' }), /test key/);
  assert.throws(() => listenArgs({ ...vars, STRIPE_SECRET_KEY: `sk_live_${'a'.repeat(30)}` }), /test key/);
  assert.throws(() => listenArgs({ STRIPE_SECRET_KEY: key }), /APP_URL/);
});

test('site directory name validation', () => {
  assert.ok(validateSlug('ghibli-photo'));
  assert.ok(!validateSlug('Ghibli'));
  assert.ok(!validateSlug('a'));
  assert.ok(!validateSlug('-bad'));
  assert.deepEqual(parseArgs(['x-y', '--domain', 'xy.com']), {
    slug: 'x-y',
    domain: 'xy.com',
    name: null,
    template: 'ai-site',
  });
});

test('new site: renames, writes README, check-site finds unfinished items', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipwords-'));
  fs.cpSync(path.join(TOOLS_ROOT, 'templates', 'ai-site'), path.join(root, 'templates', 'ai-site'), {
    recursive: true,
    filter: (src) => !/node_modules|[\\/]dist[\\/]?|\.wrangler|[\\/]paraglide|\.dev\.vars$/.test(src),
  });
  const { target } = createSite(root, {
    slug: 'ghibli-photo',
    domain: 'ghibliphoto.ai',
    name: null,
    template: 'ai-site',
  });

  assert.deepEqual(readSiteConfig(target), {
    id: 'ghibliphoto',
    name: 'Ghibli Photo',
    url: 'https://ghibliphoto.ai',
  });
  assert.equal(readStatus(target), 'In development');
  const wrangler = fs.readFileSync(path.join(target, 'wrangler.jsonc'), 'utf8');
  assert.ok(wrangler.includes('"name": "ghibli-photo"'));
  assert.ok(!wrangler.includes('ai-site-template'));
  assert.ok(
    fs.readFileSync(path.join(target, 'package.json'), 'utf8').includes('@shipwords/site-ghibli-photo'),
  );
  assert.ok(wrangler.includes('noreply@ghibliphoto.ai'));
  assert.ok(
    fs
      .readFileSync(path.join(target, 'src', 'site', 'legal.tsx'), 'utf8')
      .includes("'support@ghibliphoto.ai'"),
  );
  for (const file of [
    'project.inlang/settings.json',
    'project.en.inlang/settings.json',
    'messages/legal/en.json',
  ]) {
    assert.ok(fs.existsSync(path.join(target, file)), file);
  }
  assert.ok(!fs.existsSync(path.join(target, '.dev.vars')));

  assert.deepEqual(checkSite(target), [
    'wrangler.jsonc database_id is not set',
    'messages/legal/en.json still has TODO placeholders (policy text or update date)',
    'messages/common/en.json still has TODO placeholders (policy text or update date)',
  ]);
  // A site whose only locale is not English is held to the same rule.
  fs.renameSync(
    path.join(target, 'messages', 'legal', 'en.json'),
    path.join(target, 'messages', 'legal', 'ja.json'),
  );
  assert.ok(
    checkSite(target).includes(
      'messages/legal/ja.json still has TODO placeholders (policy text or update date)',
    ),
  );
  fs.rmSync(path.join(target, 'src', 'routes', 'dmca.tsx'));
  fs.writeFileSync(
    path.join(target, 'src', 'site', 'legal.tsx'),
    "export const SUPPORT_EMAIL = 'support@example.com';\n",
  );
  const problems = checkSite(target);
  assert.ok(problems.includes('Missing policy page src/routes/dmca.tsx'));
  assert.ok(problems.includes('src/site/legal.tsx SUPPORT_EMAIL is still a placeholder'));
  const bad = path.join(target, 'src', 'site', 'bad.ts');
  for (const spec of [
    '../../../other/src/x',
    '../../../../templates/ai-site/src/x',
    '../../../../packages/core/src/x',
  ]) {
    fs.writeFileSync(bad, `import x from '${spec}';\n`);
    assert.ok(
      checkSite(target).some((p) => p.includes('imports another site')),
      spec,
    );
  }
  fs.writeFileSync(
    bad,
    "import site from '../../site.config';\nconst lazy = import('./other');\nimport root from '../..';\n" +
      "// import x from '../../../../packages/core/src/x';\n/* import('../../../other/src/x') */\n",
  );
  assert.ok(!checkSite(target).some((p) => p.includes('imports another site')));
  fs.rmSync(bad);
  fs.rmSync(path.join(target, 'src', 'models.server.ts'));
  assert.ok(checkSite(target).includes('Missing src/models.server.ts'));
  assert.throws(() => createSite(root, { slug: 'ghibli-photo', template: 'ai-site' }), /already exists/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('check-site: fails when the browser bundle contains zh messages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipwords-'));
  fs.mkdirSync(path.join(dir, 'messages', 'common'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist', 'client'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist', 'server'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'messages', 'common', 'zh.json'),
    JSON.stringify({
      $schema: 'x',
      common_sign_out: '\u9000\u51fa\u767b\u5f55',
      common_short: '\u767b\u5f55',
      common_dmca: 'DMCA',
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'dist', 'client', 'a.js'),
    'const s = "Sign out"; const t = "\u767b\u5f55";',
  );
  fs.writeFileSync(path.join(dir, 'dist', 'server', 'a.js'), '/** \u9000\u51fa\u767b\u5f55 */');
  assert.ok(!checkSite(dir).some((p) => p.includes('zh message')));
  fs.writeFileSync(path.join(dir, 'dist', 'client', 'b.js'), 'const s = "\u9000\u51fa\u767b\u5f55";');
  assert.ok(checkSite(dir).some((p) => p.includes('zh message')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('check-site: string scanner reads strings inside template interpolations, and .dev.vars is read as dotenv', () => {
  const source = [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text containing template literals
    'const p = (dog) => `${dog ? "Replace the singer with the dog" : `keep ${"the original coach"}`} now`;',
    "const o = { a: { b: 'after nested braces' } }; // it's a comment",
    "const u = 'https://example.com/x';",
  ].join('\n');
  assert.deepEqual(
    stringLiterals(source).filter((s) => s.trim()),
    [
      'Replace the singer with the dog',
      'keep ',
      'the original coach',
      ' now',
      'after nested braces',
      'https://example.com/x',
    ],
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipwords-'));
  fs.writeFileSync(
    path.join(dir, '.dev.vars'),
    [
      'export YIR_API_KEY="fake-secret-key-123456"',
      'STRIPE_SECRET_KEY=sk_test_abcdefgh # local test',
      "GOOGLE_CLIENT_SECRET='has # inside quotes'",
      '# COMMENTED=not-a-value-at-all',
      'SHORT=abc',
    ].join('\r\n'),
  );
  assert.deepEqual(devVars(dir), [
    ['YIR_API_KEY', 'fake-secret-key-123456'],
    ['STRIPE_SECRET_KEY', 'sk_test_abcdefgh'],
    ['GOOGLE_CLIENT_SECRET', 'has # inside quotes'],
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('check-site: fails when the browser bundle contains server-only text or .dev.vars secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipwords-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist', 'client'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'models.server.ts'),
    [
      "// Don't ship this: the comment's quotes are not strings, nor is 'https://x' in a comment.",
      "const clip = 'assets/demo/reference-clip.mp4';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text containing a template literal
      'const prompt = (who: string) => `Replace ${who} with the person in @image_1, keep the motion.`;',
      'const short = "keep it";',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, '.dev.vars'),
    'APP_URL=http://127.0.0.1:5173\nSTRIPE_SECRET_KEY="sk_test_0123456789"\nRECAPTCHA_SITE_KEY=6Lpublic-site-key\n',
  );
  const leaks = () => checkSite(dir).filter((p) => p.startsWith('Build output'));
  fs.writeFileSync(
    path.join(dir, 'dist', 'client', 'a.js'),
    'fetch("http://127.0.0.1:5173");const k="6Lpublic-site-key";const s="keep it";',
  );
  assert.deepEqual(leaks(), []);
  fs.writeFileSync(
    path.join(dir, 'dist', 'client', 'b.js'),
    'const p=`x with the person in @image_1, keep the motion.`;',
  );
  fs.writeFileSync(
    path.join(dir, 'dist', 'client', 'c.js'),
    "const v='assets/demo/reference-clip.mp4',k='sk_test_0123456789';",
  );
  assert.deepEqual(leaks(), [
    'Build output dist/client/b.js contains server-only text from src/models.server.ts (" with the person in @image_1, keep the m…"); keep it out of files that pages import',
    'Build output dist/client/c.js contains server-only text from src/models.server.ts ("assets/demo/reference-clip.mp4…"); keep it out of files that pages import',
    'Build output dist/client/c.js contains the value of STRIPE_SECRET_KEY from .dev.vars',
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('new site from a vendored shipwords: site lands in the workspace, scripts point at vendored tools', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipwords-host-'));
  const { target } = createSite(root, { slug: 'demo-tool', template: 'ai-site', templatesRoot: TOOLS_ROOT });
  assert.equal(target, path.join(root, 'sites', 'demo-tool'));
  const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  const toolsDir = path.relative(target, path.join(TOOLS_ROOT, 'tools')).replaceAll(path.sep, '/');
  assert.ok(pkg.scripts.dev.includes(`node ${toolsDir}/dev-port.mjs`));
  assert.ok(!pkg.scripts.check.includes('../../tools/'));
  assert.ok(pkg.scripts.deploy.includes(`node ${toolsDir}/check-site.mjs . && wrangler deploy`));
  const drizzle = fs.readFileSync(path.join(target, 'drizzle.config.ts'), 'utf8');
  const packagesDir = path.relative(target, path.join(TOOLS_ROOT, 'packages')).replaceAll(path.sep, '/');
  assert.ok(drizzle.includes(`'${packagesDir}/core/src/db/schema.ts'`));
  fs.rmSync(root, { recursive: true, force: true });
});

test('the template itself passes check-site', () => {
  assert.deepEqual(checkSite(path.join(TOOLS_ROOT, 'templates', 'ai-site')), []);
});

test('new site: dev ports are 10 apart from 5110', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipwords-ports-'));
  assert.equal(nextDevPort(root), 5110);
  assert.equal(
    createSite(root, { slug: 'one-tool', template: 'ai-site', templatesRoot: TOOLS_ROOT }).devPort,
    5110,
  );
  const { target, devPort } = createSite(root, {
    slug: 'two-tool',
    template: 'ai-site',
    templatesRoot: TOOLS_ROOT,
  });
  assert.equal(devPort, 5120);
  assert.equal(sitePort(target), 5120);
  fs.rmSync(root, { recursive: true, force: true });
});

test('check-public: flags real-looking emails, IDs and live keys, accepts placeholders and package specifiers', () => {
  const ok = [
    'noreply@example.com support@acme.test 14013111+me@users.noreply.github.com',
    '"packageManager": "pnpm@10.30.1" plugin-message-format@4.4.0',
    '00000000-0000-0000-0000-000000000000 sk_test_xxx whsec_xxx',
  ].join('\n');
  assert.deepEqual(scanPublic('a.md', ok), []);
  const bad = scanPublic(
    'sites/x/wrangler.jsonc',
    'me@qq.com G-ABCDEFGH12 12345678-1234-1234-1234-123456789abc sk_live_abc 0123456789abcdef0123456789abcdef',
  );
  assert.equal(bad.length, 5);
  assert.match(bad[0], /wrangler.jsonc:1: email/);
  assert.deepEqual(scanPublic('apps/www/public/analytics.js', 'G-PJDL19FZTG'), []);
  assert.equal(isScanned('packages/core/test/auth.test.ts'), false);
  assert.equal(isScanned('sites/x/migrations/meta/0_snapshot.json'), false);
  assert.equal(isScanned('pnpm-lock.yaml'), false);
  assert.equal(isScanned('sites/x/wrangler.jsonc'), true);
});
