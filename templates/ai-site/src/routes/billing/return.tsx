import { safeRelativePath } from '@shipwords/core/http';
import { useAccount, waitForOrder } from '@shipwords/core/react/account';
import { track } from '@shipwords/core/react/track';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { m } from '~/paraglide/messages.js';

/** How long to wait after credits arrive before redirecting back, long enough to read the balance. */
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

// Checkout return: a full-screen overlay shows the balance once credits arrive, then returns to next (usually the generator) after a few seconds.
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
        // The order id is not sent with the event; reloading this page re-tracks the same order, which is rare, so dedupe by visitor.
        track(status === 'paid' ? 'payment_confirmed' : 'payment_pending');
        if (status !== 'paid') return;
        void refresh();
        setTimeout(() => window.location.assign(next), CONTINUE_DELAY_MS);
      });
  }, [order, next, refresh]);

  const credits = state === 'paid' && account.data ? Math.max(0, account.data.balance.available) : null;

  return (
    <div className="pay-return" role="dialog" aria-modal="true" aria-labelledby="pay-return-title">
      <div className="pay-return-card">
        {state === 'checking' && (
          <>
            <h1 id="pay-return-title">{m.common_billing_checking()}</h1>
            <p>{m.common_billing_checking_note()}</p>
          </>
        )}

        {state === 'paid' && (
          <>
            <h1 id="pay-return-title">{m.common_billing_paid_title()}</h1>
            <p>{m.common_billing_paid()}</p>
            {credits !== null && <p className="balance">{m.common_billing_paid_balance({ credits })}</p>}
            <a className="button primary" href={next}>
              {m.common_billing_continue()}
            </a>
          </>
        )}

        {state === 'pending' && (
          <>
            <h1 id="pay-return-title">{m.common_billing_pending_title()}</h1>
            <p>
              {m.common_billing_pending_before()} <a href="/account">{m.common_billing_pending_link()}</a>{' '}
              {m.common_billing_pending_after()}
            </p>
            <a className="button primary" href={next}>
              {m.common_billing_continue()}
            </a>
          </>
        )}

        {order && <p className="muted">{order}</p>}
      </div>
    </div>
  );
}
