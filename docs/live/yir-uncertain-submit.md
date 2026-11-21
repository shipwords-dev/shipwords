# Uncertain Yir submits: remaining gaps

Status: open. Found by a cross-model review of the Yir SDK 0.15 upgrade (commit e6e837c, 2026-11-21).

Since SDK 0.14 a keyed submit whose outcome is unknown (the request was sent, then the network or the Gateway failed) rejects with
`YirSubmissionUncertainError`. The adapter now maps it to a retryable error, so the step is retried with the same idempotency key and
usually recovers the Job. Before that, the first such error failed the job and refunded it. The cases below still end in a refund
although the upstream may have created (and charged) a Job. None is new: each used to refund on the first uncertain error. They need
a network failure between Gateway admission and the response, so they should be rare; when they happen we pay the upstream once and
the customer gets the credits back.

1. **Retries run out.** Every resubmit stays uncertain; after the worker's retries the run aborts with `internal_error` and refunds,
   with no upstream ID to cancel or to read the cost from. Better: park the job as "needs reconciliation" and resolve it later by
   resubmitting with the same key, instead of settling.
2. **A later definite rejection hides an earlier uncertain one.** The first attempt was admitted but its response was lost; a retry
   then gets a 4xx (for example 401 after a key rotation). The runner fails and refunds the main task, or records a prep part as
   `SKIPPED`, though the first attempt's Job may exist. The SDK says a rejection only proves that call created nothing. Better: persist
   per idempotency key that an uncertain submit happened, and treat later rejections for that key as uncertain too.
3. **Recovered after the deadline.** The retry recovers the Job ID after the job's deadline; the runner records it, times out before
   the first poll, cancels (since 0.14 `cancelJob` resolves with the finished Job, which the adapter ignores) and refunds, dropping a
   result that may already be there. This is also how any job that times out while its upstream task just finished behaves. Better:
   read the recorded tasks' status once before settling a timeout and deliver a finished result.
4. **Prep hedge copies.** The hedge submit catches every error and returns null, an uncertain one included, so an admitted hedge copy is
   never polled or cancelled and may keep running and billing. Better: retry the hedge submit on an uncertain error, like the main one.

Also noted: the SDK's own `TimeoutError` on a submit keeps its type and is still classified as final (unchanged from before).
