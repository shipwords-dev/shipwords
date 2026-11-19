#!/usr/bin/env node
// Usage: pnpm new-site <dir> [--domain example.com] [--name "Site Name"] [--template ai-site]
// Copies a new site from a template (including project*.inlang and messages/): names the compose project and image paths,
// sets the site config and the support/sender email domains, and writes README.md and DESIGN.md. Policy text stays as
// TODO placeholders, and check-site blocks until it is written. Touches neither Cloudflare nor Stripe; the commands to
// create resources are printed for a human to run.
import fs from 'node:fs';
import path from 'node:path';
import { sitePort } from './dev-port.mjs';
import { ROOT, siteDirs, TOOLS_ROOT } from './lib.mjs';

const SKIP = new Set([
  'node_modules',
  'dist',
  '.wrangler',
  '.output',
  '.tanstack',
  '.preview',
  'paraglide',
  '.dev.vars',
  '.env',
  '.data',
  'worker-configuration.d.ts',
]);
const SKIP_FILE = /routeTree\.gen\.ts$/;

export function parseArgs(argv) {
  const [slug, ...rest] = argv;
  const options = { slug, domain: null, name: null, template: 'ai-site' };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    if (key && key in options) options[key] = rest[i + 1] ?? null;
  }
  return options;
}

/** Sites get dev ports 10 apart, starting at 5110 (templates and examples sit below). */
export function nextDevPort(root) {
  const ports = siteDirs(root)
    .filter((site) => site.group === 'sites')
    .map((site) => sitePort(site.dir));
  return ports.length ? Math.max(...ports) + 10 : 5110;
}

export function validateSlug(slug) {
  return typeof slug === 'string' && /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || SKIP_FILE.test(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

function edit(file, transform) {
  fs.writeFileSync(file, transform(fs.readFileSync(file, 'utf8')));
}

export function createSite(root, options) {
  const { slug, template } = options;
  const domain = options.domain ?? `${slug}.example.com`;
  const name =
    options.name ??
    slug
      .split('-')
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ');
  const templatesRoot = options.templatesRoot ?? root;
  const source = path.join(templatesRoot, 'templates', template);
  const target = path.join(root, 'sites', slug);
  if (!fs.existsSync(source)) throw new Error(`Template not found: templates/${template}`);
  if (fs.existsSync(target)) throw new Error(`Site already exists: sites/${slug}`);
  const devPort = nextDevPort(root);
  copyDir(source, target);

  // Sites reference shipwords' tools and package schemas by relative path; repoint them when shipwords is vendored elsewhere.
  const relativeTo = (dir) => path.relative(target, path.join(templatesRoot, dir)).replaceAll(path.sep, '/');
  const toolsDir = relativeTo('tools');
  edit(path.join(target, 'drizzle.config.ts'), (text) =>
    text.replaceAll('../../packages/', `${relativeTo('packages')}/`),
  );
  edit(path.join(target, 'package.json'), (text) =>
    text
      .replace(/"name": "[^"]+"/, `"name": "@shipwords/site-${slug}"`)
      .replace(/"devPort": \d+/, `"devPort": ${devPort}`)
      .replaceAll('../../tools/', `${toolsDir}/`),
  );
  // Docker: the image builds from the workspace root, so the paths in compose.yaml and the Dockerfile name this site; the compose
  // service is built from wherever shipwords' packages live.
  const sitePath = `sites/${slug}`;
  const workspaceRoot = path.relative(target, root).replaceAll(path.sep, '/');
  edit(path.join(target, 'compose.yaml'), (text) =>
    text
      .replace(/^name: ai-site$/m, `name: ${slug}`)
      .replaceAll('templates/ai-site', sitePath)
      .replace(/context: \.\.\/\.\./, `context: ${workspaceRoot}`)
      .replace('build: ../../packages/jobs/compose', `build: ${relativeTo('packages/jobs/compose')}`),
  );
  edit(path.join(target, 'Dockerfile'), (text) =>
    text.replaceAll('templates/ai-site', sitePath).replaceAll('ai-site', slug),
  );
  edit(path.join(target, '.env.example'), (text) => text.replace('noreply@example.com', `noreply@${domain}`));
  edit(path.join(target, 'site.config.ts'), (text) =>
    text
      .replace(/id: '[^']*'/, `id: '${slug.replaceAll('-', '').slice(0, 16)}'`)
      .replace(/name: 'AI Site'/, `name: '${name.replaceAll("'", "\\'")}'`)
      .replace(/url: '[^']*'/, `url: 'https://${domain}'`),
  );

  edit(path.join(target, 'src', 'site', 'legal.tsx'), (text) =>
    text.replace("SUPPORT_EMAIL = 'support@example.com'", `SUPPORT_EMAIL = 'support@${domain}'`),
  );

  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(target, 'README.md'),
    `# ${name}

- **Status**: In development
- **Domain**: ${domain}
- **Target keyword**: (main keyword and search intent)
- **Competitors**: (top-ranking sites and what they lack)
- **Launch date**:
- **Payment account**: (Stripe or PayPal, legal entity, account name)
- **Metrics**: GA4 property ID, Rybbit siteId (analytics in site.config.ts), GSC
- **Created**: ${today}

## How this site differs from competitors

(Unique content, features or angle. If there is none, do not launch yet.)

## Log

- ${today} Created from templates/${template}.
`,
  );
  fs.writeFileSync(
    path.join(target, 'DESIGN.md'),
    `# ${name} design direction

Each site should look clearly different from the others. Write this down before changing src/site/styles.css and components:

- **Mood**: (e.g. utilitarian, editorial, handmade)
- **Fonts**:
- **Primary and accent colors**:
- **Home page first-screen layout**:
- **Avoid**: (anything that looks like your other sites)
`,
  );
  return { target, domain, name, devPort };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const options = parseArgs(process.argv.slice(2));
  if (!validateSlug(options.slug)) {
    console.error('Usage: pnpm new-site <dir> [--domain example.com] [--name "Site Name"]');
    console.error(
      'The dir name uses only lowercase letters, digits and hyphens, 3 to 32 characters, starting with a letter.',
    );
    process.exit(1);
  }
  const { domain } = createSite(ROOT, { ...options, templatesRoot: TOOLS_ROOT });
  const slug = options.slug;
  console.log(`Created sites/${slug}. Next:

    1. pnpm install
  2. A local database: create ${slug.replaceAll('-', '_')}_dev (and a role for it) on your Postgres.
  3. Local settings: copy sites/${slug}/.env.example to ~/.config/shipwords/${slug}.env, fill it in (DATABASE_URL, secrets;
     MAIL_LOG=1 and UPSTREAM_MOCK=1 to start), then pnpm setup:worktree
  4. cd sites/${slug} && pnpm db:generate && pnpm db:migrate && pnpm dev
  5. Before launch, go through docs/site-launch.md (domain ${domain}, database, bucket, email, Stripe, reCAPTCHA).`);
}
