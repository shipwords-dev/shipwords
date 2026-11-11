import { safeRelativePath } from '@shipwords/core/http';
import { useAccount, waitForOrder } from '@shipwords/core/react/account';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { track } from '~/lib/track';
import { m } from '~/paraglide/messages.js';

const CREDITS_PER_VIDEO = 10;
/** How long to stay after credits arrive before going back, long enough to read the balance. */
const CONTINUE_DELAY_MS = 3500;

const safeNext = (value: unknown) => safeRelativePath(value, '/account');

export const Route = createFileRoute('/billing/return')({
  validateSearch: (search: Record<string, unknown>) => ({
    order: typeof search.order === 'string' ? search.order : '',
    next: safeNext(search.next),
  }),
  head: () => ({ meta: [{ title: m.common_billing_title() }, { name: 'robots', content: 'noindex' }] }),
  component: ReturnPage,
});

// Checkout return: a full-screen overlay covers the page and returns to next (usually the generator) once payment is confirmed.
function ReturnPage() {
  const { order, next } = Route.useSearch();
  const [state, setState] = useState<'checking' | 'paid' | 'pending'>(order ? 'checking' : 'pending');
  const account = useAccount();
  const { refresh } = account;

  useEffect(() => {
    if (!order) return;
    void waitForOrder(order)
      .catch(() => 'pending' as const)
      .then((status) => {
        setState(status);
        // No order id in the event; refreshing the return page records it again for the same order. Low volume, so dedupe by visitor.
        track(status === 'paid' ? 'payment_confirmed' : 'payment_pending');
        if (status !== 'paid') return;
        void refresh();
        setTimeout(() => window.location.assign(next), CONTINUE_DELAY_MS);
      });
  }, [order, next, refresh]);

  const videos =
    state === 'paid' && account.data
      ? Math.floor(Math.max(0, account.data.balance.available) / CREDITS_PER_VIDEO)
      : null;

  return (
    <div className="pay-return" role="dialog" aria-modal="true" aria-labelledby="pay-return-title">
      <div className={`pay-return-card is-${state}`}>
        <p className="pay-return-tag">{m.common_billing_title()}</p>
        <div className="pay-return-mark" aria-hidden="true">
          {state === 'paid' ? '✓' : state === 'pending' ? '…' : null}
        </div>

        {state === 'checking' && (
          <>
            <h1 id="pay-return-title">{m.common_billing_checking()}</h1>
            <p className="pay-return-note">{m.common_billing_checking_note()}</p>
          </>
        )}

        {state === 'paid' && (
          <>
            <h1 id="pay-return-title">{m.common_billing_paid_title()}</h1>
            <p className="pay-return-note">{m.common_billing_paid()}</p>
            {videos !== null && (
              <p className="pay-return-data">{m.common_billing_paid_balance({ videos })}</p>
            )}
            <a className="button primary" href={next}>
              {m.common_billing_continue()}
            </a>
            <div className="pay-return-timer" style={{ animationDuration: `${CONTINUE_DELAY_MS}ms` }} />
          </>
        )}

        {state === 'pending' && (
          <>
            <h1 id="pay-return-title">{m.common_billing_pending_title()}</h1>
            <p className="pay-return-note">
              {m.common_billing_pending_before()} <a href="/account">{m.common_billing_pending_link()}</a>{' '}
              {m.common_billing_pending_after()}
            </p>
            <a className="button primary" href={next}>
              {m.common_billing_continue()}
            </a>
          </>
        )}

        {order && <p className="pay-return-ref">{order}</p>}
      </div>
    </div>
  );
}
