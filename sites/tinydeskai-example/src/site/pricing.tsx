import { useCheckout } from '@shipwords/core/react/account';
import { track } from '@shipwords/core/react/track';
import type { Product } from '@shipwords/core/site';
import { getRouteApi, Link } from '@tanstack/react-router';
import { type MouseEvent, type ReactNode, useEffect, useRef } from 'react';
import { authClient } from '~/lib/auth';
import { m } from '~/paraglide/messages.js';
import { openSignIn } from '~/site/sign-in';
import site from '../../site.config';
import models from '../../site.models';

// Pricing has no page of its own: the home page #pricing section checks out directly, other entry points (nav, low credits, account, guides) open a dialog,
// so the visitor stays on the page with the stage photos intact. Unit prices derive from pack credits (site.config.ts) and the per-video price (site.models.ts).

const CREDITS_PER_VIDEO = models[0].credits;
const OPEN_EVENT = 'tinydesk:pricing';
/** Checkout return and cancel both land here; tool.tsx sees resume, scrolls to the generator and says the stage is intact. */
const RESUME_PATH = '/?resume=1#make';

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

export function perVideo(product: (typeof site.products)[number]) {
  const videos = product.credits / CREDITS_PER_VIDEO;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: product.price.currency }).format(
    product.price.amount / 100 / videos,
  );
}

/** Link to pricing: a dialog with JS, the home page pricing section without. */
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
    // biome-ignore lint/a11y/useValidAnchor: with JS we intercept it to open the dialog; without JS the href still reaches the home page pricing section.
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

/** Every card lists the same inclusions: the tiers differ only in count, and the list shows what one video buys. */
const INCLUDES = [
  m.common_plan_include_length,
  m.common_plan_include_song,
  m.common_plan_include_people,
  m.common_plan_include_watermark,
  m.common_plan_include_expiry,
];

/** Plan names come from messages by id; name in site.config is the English fallback for unregistered ids. */
const PACK_NAMES: Record<string, () => string> = {
  video_1: m.common_pack_video_1,
  video_3: m.common_pack_video_3,
  video_10: m.common_pack_video_10,
};

export const packName = (product: (typeof site.products)[number]) =>
  PACK_NAMES[product.id]?.() ?? product.name;

/** Savings per video versus the single pack, from unit price, rounded to a percent. */
function savings(product: (typeof site.products)[number]) {
  const base = site.products[0];
  const unit = (p: typeof product) => p.price.amount / (p.credits / CREDITS_PER_VIDEO);
  return Math.round((1 - unit(product) / unit(base)) * 100);
}

/** Plan cards + buy buttons; signed-out visitors sign in first, then go straight to checkout. compact is for the dialog and skips the inclusions. */
export function Plans({
  heading: Heading = 'h3',
  compact = false,
  source = 'section',
}: {
  heading?: 'h2' | 'h3';
  compact?: boolean;
  /** Sent with the checkout_start event: section for the home page pricing block, dialog for the dialog. */
  source?: string;
}) {
  const config = root.useLoaderData();
  const session = authClient(config.googleClientId).useSession();
  const { checkout, pending, error } = useCheckout();

  function buy(productId: string) {
    // After paying, return to the generator; stage photos restore from sessionStorage (tool.tsx).
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
        {site.products.map((product, i) => {
          const featured = i === 1;
          const save = savings(product);
          return (
            <article key={product.id} className={featured ? 'plan plan-featured' : 'plan'}>
              {featured && <span className="plan-badge">{m.common_plan_badge()}</span>}
              <Heading>{packName(product)}</Heading>
              <p className="price">{formatPrice(product)}</p>
              <p className="plan-unit">
                <span className="mono">{m.common_plan_per_video({ price: perVideo(product) })}</span>
                {save > 0 && <span className="plan-save">{m.common_plan_save({ percent: save })}</span>}
              </p>
              {!compact && (
                <ul className="plan-includes">
                  {INCLUDES.map((item) => (
                    <li key={item.name}>{item()}</li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className={featured ? 'plan-buy primary' : 'plan-buy'}
                disabled={pending !== null}
                onClick={() => buy(product.id)}
              >
                {pending === product.id
                  ? m.common_plan_redirecting()
                  : m.common_plan_buy({ name: packName(product) })}
              </button>
            </article>
          );
        })}
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/** Payment notes under the cards: reassuring facts first, expectations squeezed into one small line. */
export function BeforeYouPay() {
  return (
    <div className="before-pay">
      <p className="plan-trust">
        <span>{m.common_pay_one_time()}</span>
        <span>{m.common_pay_refund()}</span>
        <span>{m.common_pay_secure()}</span>
      </p>
      <p className="plan-fine">
        {m.common_pay_fine()} {/* Opens in a new tab: the dialog and stage photos stay. */}
        <Link to="/refunds" target="_blank" rel="noopener">
          {m.common_pay_refund_policy()}
        </Link>
      </p>
    </div>
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking the backdrop is a mouse shortcut; keyboard users close with native Esc.
    <dialog
      ref={dialog}
      className="sign-in-dialog pricing-dialog"
      aria-labelledby="pricing-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <button type="button" className="dialog-close" aria-label={m.common_close()} onClick={close}>
        ×
      </button>
      <h2 id="pricing-title">{m.common_pricing_dialog_title()}</h2>
      <p className="muted sign-in-note">{m.common_pricing_dialog_note()}</p>
      <Plans compact source="dialog" />
      <BeforeYouPay />
    </dialog>
  );
}
