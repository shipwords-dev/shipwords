import { analyticsScripts } from '@shipwords/core/analytics';
import { captureAttribution } from '@shipwords/core/react/attribution';
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';
import { authClient } from '~/lib/auth';
import { getPublicConfig } from '~/lib/public-config';
import { m } from '~/paraglide/messages.js';
import { getLocale, setLocale } from '~/paraglide/runtime.js';
import { AccountDialog, AccountLink } from '~/site/account';
import { GUIDES } from '~/site/guide';
import { SUPPORT_EMAIL } from '~/site/legal';
import { PricingDialog, PricingLink } from '~/site/pricing';
import { openSignIn, promptGoogleOneTap, SignInDialog } from '~/site/sign-in';
import appCss from '~/site/styles.css?url';
import site from '../../site.config';

export const Route = createRootRoute({
  loader: () => getPublicConfig(),
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Anton&family=Fraunces:opsz,wght@9..144,600;9..144,800&family=Instrument+Sans:wght@400;600&family=JetBrains+Mono:wght@500&display=swap',
      },
      { rel: 'stylesheet', href: appCss },
      // Link previews and many crawlers ignore SVG, so the ICO goes first as a fallback.
      { rel: 'icon', href: '/favicon.ico', sizes: '32x32' },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    ],
    // The stats script is not loaded in local dev, so dev traffic stays out of reports.
    scripts: import.meta.env.DEV ? [] : analyticsScripts(site),
  }),
  shellComponent: Document,
  component: Layout,
  notFoundComponent: NotFound,
});

// 404: React 19 hoists title and meta into head.
function NotFound() {
  return (
    <section className="sheet legal">
      <title>{m.common_not_found_title({ name: site.name })}</title>
      <meta name="robots" content="noindex" />
      <h1>{m.common_not_found_heading()}</h1>
      <p className="legal-intro">{m.common_not_found_intro()}</p>
      <ul>
        <li>
          <Link to="/">{m.common_not_found_make()}</Link>
        </li>
        <li>
          <a href="/#pricing">{m.common_nav_pricing()}</a>
        </li>
        {GUIDES.map((guide) => (
          <li key={guide.path}>
            <Link to={guide.path}>{guide.title()}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang={getLocale()}>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Layout() {
  const config = Route.useLoaderData();
  const auth = authClient(config.googleClientId);
  const session = auth.useSession();

  useEffect(() => {
    captureAttribution();
  }, []);

  useEffect(() => {
    // Show Google One Tap when signed out; skip it when Google is not configured.
    if (session.isPending || session.data || !config.googleClientId) return;
    promptGoogleOneTap(config.googleClientId);
  }, [session.isPending, session.data, config.googleClientId]);

  return (
    <div className="page">
      <header className="site-header">
        <Link to="/" className="brand">
          <img className="brand-mark" src="/logo.svg" alt="" width={47} height={43} />
          {site.name}
        </Link>
        <nav>
          <a href="/#how" className="nav-how">
            {m.common_nav_how()}
          </a>
          <PricingLink source="nav">{m.common_nav_pricing()}</PricingLink>
          <a href="/#faq">{m.common_nav_faq()}</a>
          {import.meta.env.DEV && <LocaleToggle />}
          {session.data ? (
            <AccountLink className="avatar" title={session.data.user.email}>
              {session.data.user.image ? (
                <img src={session.data.user.image} alt="" referrerPolicy="no-referrer" />
              ) : (
                (session.data.user.name || session.data.user.email).slice(0, 1).toUpperCase()
              )}
            </AccountLink>
          ) : (
            <a
              href="/login"
              onClick={(e) => {
                e.preventDefault();
                openSignIn();
              }}
            >
              {m.common_nav_sign_in()}
            </a>
          )}
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="site-footer">
        <span>{m.common_footer_notice({ year: new Date().getFullYear(), name: site.name })}</span>
        <nav>
          <Link to="/privacy">{m.common_footer_privacy()}</Link>
          <Link to="/terms">{m.common_footer_terms()}</Link>
          <Link to="/refunds">{m.common_footer_refunds()}</Link>
          <Link to="/dmca">{m.common_footer_dmca()}</Link>
          <a href={`mailto:${SUPPORT_EMAIL}`}>{m.common_footer_contact()}</a>
        </nav>
        <nav className="footer-guides" aria-label={m.common_footer_guides()}>
          {GUIDES.map((guide) => (
            <Link key={guide.path} to={guide.path}>
              {guide.title()}
            </Link>
          ))}
        </nav>
      </footer>
      <SignInDialog />
      <PricingDialog />
      <AccountDialog />
    </div>
  );
}

// For local review: the globe icon in the header toggles en/zh (sets a cookie and reloads). Production is English only; DEV is false in builds, so it never renders.
// Dev only, with inline styles, kept out of styles.css.
function LocaleToggle() {
  const zh = getLocale() === 'zh';
  const label = zh ? 'Switch to English' : '切换到中文';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setLocale(zh ? 'en' : 'zh')}
      style={{
        position: 'relative',
        display: 'inline-grid',
        placeItems: 'center',
        width: '2rem',
        height: '2rem',
        padding: 0,
        border: '1px solid var(--color-line)',
        borderRadius: 999,
        background: 'transparent',
        color: 'var(--color-cream)',
        cursor: 'pointer',
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
      </svg>
      <span
        style={{
          position: 'absolute',
          right: -6,
          bottom: -4,
          padding: '0 3px',
          borderRadius: 4,
          background: 'var(--color-amber)',
          color: 'var(--color-ink)',
          font: '600 9px/14px var(--font-mono, monospace)',
        }}
      >
        {zh ? '中' : 'EN'}
      </span>
    </button>
  );
}
