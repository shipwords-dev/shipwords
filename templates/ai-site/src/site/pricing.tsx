import { useCheckout } from '@shipwords/core/react/account';
import { track } from '@shipwords/core/react/track';
import type { Product } from '@shipwords/core/site';
import { getRouteApi, Link } from '@tanstack/react-router';
import { type MouseEvent, type ReactNode, useEffect, useRef } from 'react';
import { authClient } from '~/lib/auth';
import { m } from '~/paraglide/messages.js';
import { openSignIn } from '~/site/sign-in';
import site from '../../site.config';

// No separate pricing page: buy from the home #pricing section; other entry points (nav, low credits, account) open a dialog in place.
// Change prices in site.config.ts only.

const OPEN_EVENT = 'site:pricing';
/** Checkout success and cancel both return here; on resume the home page restores the generator from sessionStorage and shows a notice. */
export const RESUME_PATH = '/?resume=1#tool';

export function openPricing(source: string) {
  track('pricing_open', { source });
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function formatPrice(product: Product) {
  const amount = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: product.price.currency,
  }).format(product.price.amount / 100);
  return product.kind === 'subscription' ? `${amount}/${product.interval}` : amount;
}

function describe(product: Product) {
  if (product.kind === 'subscription') {
    return m.common_plan_subscription({
      credits: product.creditsPerPeriod.toLocaleString(),
      interval: product.interval,
    });
  }
  return product.expiresDays
    ? m.common_plan_credits_expiring({ credits: product.credits.toLocaleString(), days: product.expiresDays })
    : m.common_plan_credits({ credits: product.credits.toLocaleString() });
}

/** Link to pricing: opens the dialog with JS, falls back to the home pricing section without. */
export function PricingLink({
  className,
  source,
  children,
}: {
  className?: string;
  source: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useValidAnchor: with JS the click opens the dialog; without JS the href still reaches the home pricing section.
    <a
      href="/#pricing"
      className={className}
      onClick={(e: MouseEvent) => {
        e.preventDefault();
        openPricing(source);
      }}
    >
      {children}
    </a>
  );
}

const root = getRouteApi('__root__');

/** Plan cards and buy buttons; signed-out users sign in first, then go straight to checkout. */
export function Plans({
  heading: Heading = 'h3',
  source = 'section',
}: {
  heading?: 'h2' | 'h3';
  /** Goes into the checkout_start event: section for the home pricing block, dialog for the dialog. */
  source?: string;
}) {
  const config = root.useLoaderData();
  const session = authClient(config.googleClientId).useSession();
  const { checkout, pending, error } = useCheckout();

  function buy(productId: string) {
    // After paying, return to the generator; its input is restored from sessionStorage (routes/index.tsx).
    const start = () => {
      track('checkout_start', { product: productId, source });
      void checkout(productId, RESUME_PATH);
    };
    if (session.data) start();
    else openSignIn(start, 'checkout');
  }

  useEffect(() => {
    if (error) track('checkout_failed', { error: error.slice(0, 100) });
  }, [error]);

  return (
    <>
      <div className="plans">
        {site.products.map((product) => (
          <article key={product.id} className="plan">
            <Heading>{product.name}</Heading>
            <p className="price">{formatPrice(product)}</p>
            <p>{describe(product)}</p>
            <button
              type="button"
              className="primary"
              disabled={pending !== null}
              onClick={() => buy(product.id)}
            >
              {pending === product.id
                ? m.common_plan_redirecting()
                : product.kind === 'subscription'
                  ? m.common_plan_subscribe()
                  : m.common_plan_buy()}
            </button>
          </article>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted">
        {m.common_pay_fine()} {/* Opens in a new tab so the dialog and generator input are kept. */}
        <Link to="/refunds" target="_blank" rel="noopener">
          {m.common_pay_refund_policy()}
        </Link>
      </p>
    </>
  );
}

export function PricingDialog() {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const onOpen = () => dialog.current?.showModal();
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  function close() {
    dialog.current?.close();
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking the backdrop is a mouse shortcut; keyboards close with native Esc.
    <dialog
      ref={dialog}
      className="dialog pricing-dialog"
      aria-labelledby="pricing-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <button type="button" className="dialog-close" aria-label={m.common_close()} onClick={close}>
        ×
      </button>
      <h2 id="pricing-title">{m.common_pricing_dialog_title()}</h2>
      <Plans source="dialog" />
    </dialog>
  );
}
