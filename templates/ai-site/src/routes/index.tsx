import { track } from '@shipwords/core/react/track';
import { pageHead } from '@shipwords/core/seo';
import { creditsFor, sanitizeParameters } from '@shipwords/jobs/models';
import { type PublicJob, UPLOAD_ACCEPT, uploadReference, useGeneration } from '@shipwords/jobs/react';
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { authClient } from '~/lib/auth';
import { m } from '~/paraglide/messages.js';
import { Plans, PricingLink } from '~/site/pricing';
import { openSignIn } from '~/site/sign-in';
import site from '../../site.config';
import models from '../../site.models';

// Tool page template: the tool above the fold, site-specific content sections and pricing below. Start a new site here and rewrite titles, copy and sections for the target keyword.
// Copy lives in messages/home. Locale is per request, so constants hold message functions that are called at render time.

export const Route = createFileRoute('/')({
  head: () =>
    pageHead(site, {
      title: m.home_meta_title({ name: site.name }),
      description: m.home_meta_description(),
      path: '/',
      jsonLd: [
        {
          '@type': 'WebApplication',
          name: site.name,
          url: site.url,
          applicationCategory: 'MultimediaApplication',
          operatingSystem: 'Web',
        },
      ],
    }),
  component: ToolPage,
});

const root = getRouteApi('__root__');
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const STEPS = [m.home_how_prompt, m.home_how_options, m.home_how_download];

// Generator state is kept in sessionStorage so input survives sign-in, leaving for checkout, or a reload.
const STATE_KEY = 'tool:state';
type ToolState = { modelId: string; prompt: string; aspectRatio: string; references: string[] };

function saveState(state: ToolState) {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {}
}

function loadState(): ToolState | null {
  try {
    return JSON.parse(sessionStorage.getItem(STATE_KEY) ?? 'null') as ToolState | null;
  } catch {
    return null;
  }
}

const isActive = (job: PublicJob) => job.status === 'queued' || job.status === 'submitted';

function ToolPage() {
  const config = root.useLoaderData();
  const session = authClient(config.googleClientId).useSession();
  const { jobs, generate, cancel, submitting, error } = useGeneration({
    recaptchaSiteKey: config.recaptchaSiteKey,
  });
  const [modelId, setModelId] = useState<string>(models[0].id);
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [references, setReferences] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  // Ask for confirmation when a job is already running: users who think nothing happened click again and get charged twice.
  const [confirmAnother, setConfirmAnother] = useState(false);
  const restored = useRef(false);
  const model = models.find((item) => item.id === modelId) ?? models[0];
  const cost = creditsFor(model, sanitizeParameters(model, { aspect_ratio: aspectRatio }));
  const rendering = jobs.some(isActive);

  useEffect(() => {
    const saved = loadState();
    if (saved) {
      if (models.some((item) => item.id === saved.modelId)) setModelId(saved.modelId);
      setPrompt(saved.prompt);
      setAspectRatio(saved.aspectRatio);
      setReferences(saved.references);
    }
    restored.current = true;
    // Checkout return (RESUME_PATH in pricing.tsx): show a notice, then drop resume from the URL so a reload does not repeat it.
    const url = new URL(window.location.href);
    if (url.searchParams.has('resume')) {
      setResumed(Boolean(saved?.prompt));
      url.searchParams.delete('resume');
      window.history.replaceState(window.history.state, '', url);
    }
  }, []);

  useEffect(() => {
    if (restored.current) saveState({ modelId, prompt, aspectRatio, references });
  }, [modelId, prompt, aspectRatio, references]);

  useEffect(() => {
    if (!rendering) setConfirmAnother(false);
  }, [rendering]);

  useEffect(() => {
    if (error) track('generate_failed', { code: error.code ?? 'unknown' });
  }, [error]);

  // Result events: only track jobs seen going from running to done/failed on this page; ones already finished on load are not re-tracked.
  const statuses = useRef(new Map<string, PublicJob['status']>());
  useEffect(() => {
    for (const job of jobs) {
      const before = statuses.current.get(job.id);
      statuses.current.set(job.id, job.status);
      if (before !== 'queued' && before !== 'submitted') continue;
      const seconds = job.finishedAt ? Math.round((job.finishedAt - job.createdAt) / 1000) : 0;
      if (job.status === 'succeeded') track('result_ready', { seconds });
      else if (job.status === 'failed' || job.status === 'canceled')
        track('result_failed', { status: job.status });
    }
  }, [jobs]);

  async function onUpload(files: FileList | null) {
    setUploadError(null);
    for (const file of Array.from(files ?? []).slice(0, model.maxReferences - references.length)) {
      try {
        const path = await uploadReference(file);
        setReferences((list) => [...list, path]);
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : m.home_tool_upload_failed());
      }
    }
  }

  async function start() {
    const job = await generate({ modelId, prompt, references, parameters: { aspect_ratio: aspectRatio } });
    if (job) track('generate_started', { model: modelId, another: rendering });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    // blocked records which step this click got stuck on; none means generation started directly.
    const click = (blocked: string) => track('generate_click', { model: modelId, blocked });
    if (rendering && !confirmAnother) {
      click('confirm_another');
      setConfirmAnother(true);
      return;
    }
    setConfirmAnother(false);
    click('none');
    await start();
  }

  return (
    <>
      <ReturnNotice jobs={jobs} />
      <section className="tool" id="tool">
        <h1>{m.home_title()}</h1>
        <p className="lead">{m.home_lead()}</p>

        <form onSubmit={onSubmit} className="tool-form">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={m.home_tool_placeholder()}
            rows={4}
            maxLength={4000}
            required
          />
          <div className="tool-controls">
            <label>
              {m.home_tool_model()}
              <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.guest ? m.home_tool_model_free({ name: item.name }) : item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {m.home_tool_aspect_ratio()}
              <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                {ASPECT_RATIOS.map((ratio) => (
                  <option key={ratio}>{ratio}</option>
                ))}
              </select>
            </label>
            {model.maxReferences > 0 && (
              <label>
                {m.home_tool_references({ count: references.length, max: model.maxReferences })}
                <input
                  type="file"
                  accept={UPLOAD_ACCEPT}
                  multiple
                  disabled={references.length >= model.maxReferences}
                  onChange={(e) => void onUpload(e.target.files)}
                />
              </label>
            )}
          </div>
          {references.length > 0 && (
            <div className="references">
              {references.map((path) => (
                <button
                  type="button"
                  key={path}
                  onClick={() => setReferences((list) => list.filter((p) => p !== path))}
                  title={m.home_tool_remove()}
                >
                  <img src={path} alt={m.home_tool_reference_alt()} width={64} height={64} />
                </button>
              ))}
            </div>
          )}
          <button type="submit" className="primary" disabled={submitting || !prompt.trim()}>
            {submitting
              ? m.home_tool_starting()
              : confirmAnother
                ? m.home_tool_submit_another({ cost })
                : m.home_tool_submit({ cost })}
          </button>
          {resumed && !error && jobs.length === 0 && <p className="notice">{m.home_tool_resumed()}</p>}
          {confirmAnother && <p className="notice">{m.home_tool_confirm_another({ cost })}</p>}
          {uploadError && <p className="error">{uploadError}</p>}
          {error && <GenerationError code={error.code} message={error.message} retry={() => void start()} />}
        </form>

        <div className="results" id="results">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              email={session.data?.user.email}
              onCancel={() => void cancel(job.id)}
            />
          ))}
        </div>
      </section>

      <section className="content">
        <h2>{m.home_how_heading()}</h2>
        <ol>
          {STEPS.map((step) => (
            <li key={step.name}>{step()}</li>
          ))}
        </ol>
      </section>

      <section className="content" id="pricing">
        <h2>{m.home_pricing_heading()}</h2>
        <Plans />
      </section>
    </>
  );
}

const RECENT_MS = 24 * 3600_000;

/** Return-visit notice above the fold: when a job is running or finished within a day, one click jumps to results below the generator. */
function ReturnNotice({ jobs }: { jobs: PublicJob[] }) {
  const rendering = jobs.some(isActive);
  const latest = jobs[0];
  const ready =
    latest?.status === 'succeeded' &&
    latest.finishedAt !== null &&
    Date.now() - latest.finishedAt < RECENT_MS;
  if (!rendering && !ready) return null;
  return (
    <a
      className="notice return-notice"
      href="#results"
      data-rybbit-event="return_notice_click"
      data-rybbit-prop-state={rendering ? 'generating' : 'ready'}
    >
      {rendering ? m.home_return_generating() : m.home_return_ready()}
    </a>
  );
}

function GenerationError({
  code,
  message,
  retry,
}: {
  code: string | undefined;
  message: string;
  retry: () => void;
}) {
  if (code === 'login_required') {
    return (
      <p className="notice">
        {m.home_tool_login_required({ credits: site.signup.bonusCredits })}{' '}
        {/* Sign in via the dialog in place, input is kept; generation continues after sign-in. */}
        <button type="button" className="link-button" onClick={() => openSignIn(retry, 'login_required')}>
          {m.home_tool_sign_in()}
        </button>
      </p>
    );
  }
  if (code === 'insufficient_credits') {
    return (
      <p className="notice">
        {m.home_tool_need_credits()}{' '}
        <PricingLink source="insufficient_credits">{m.home_tool_get_credits()}</PricingLink>
      </p>
    );
  }
  return <p className="error">{message}</p>;
}

function JobCard({ job, email, onCancel }: { job: PublicJob; email?: string; onCancel: () => void }) {
  const active = isActive(job);
  return (
    <article className="job">
      {job.outputs.map((output) =>
        output.mediaType.startsWith('video/') ? (
          // biome-ignore lint/a11y/useMediaCaption: generated videos have no caption track.
          <video key={output.url} src={output.url} controls playsInline />
        ) : (
          <img key={output.url} src={output.url} alt={job.prompt} loading="lazy" />
        ),
      )}
      {job.outputs.map((output) => (
        <a key={output.url} className="button" href={output.url} download data-rybbit-event="result_download">
          {m.home_job_download()}
        </a>
      ))}
      {active && (
        <div className="job-pending">
          <p>{m.home_job_generating()}</p>
          {/* Only signed-in users get the completion email (the notify step in packages/jobs). */}
          {email && <p className="muted">{m.home_job_email({ email })}</p>}
        </div>
      )}
      {job.status === 'failed' && <p className="error">{m.home_job_failed()}</p>}
      {job.status === 'canceled' && <p className="muted">{m.home_job_canceled()}</p>}
      <p className="job-prompt">{job.prompt}</p>
      {/* Only before the upstream has it: a running render bills anyway, so the engine refuses to cancel and refund it. */}
      {job.status === 'queued' && (
        <button type="button" onClick={onCancel}>
          {m.home_job_cancel()}
        </button>
      )}
    </article>
  );
}
