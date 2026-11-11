import { pageHead } from '@shipwords/core/seo';
import { useGeneration } from '@shipwords/jobs/react';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { m } from '~/paraglide/messages.js';
import { BeforeYouPay, formatPrice, Plans, packName } from '~/site/pricing';
import { ReturnNotice, TinyDeskTool } from '~/site/tool';
import site from '../../site.config';

// Generator home page: face swap any of the 5 slots on stage, same price for 1–5 people. Sign in (Google One Tap), buy credits, then generate; no free trial.
// Upload and generation live in ~/site/tool; the whole clip is swapped in one pass, re-aligned to the original cuts with the song mixed back in, plus a silent copy.
// The generator suggests friends, coworkers and teammates, never uploading celebrity photos.
// Copy lives in messages/home; locale depends on the request, so the constants below hold message functions called at render.

const RESOLUTION = '720p';
const BAND_PRICE = formatPrice(site.products[0]);

// Samples are the hero dog version (sample-dogs) cut into 4 segments at the original cut points, in public/media; the template page uses the original shot-*.mp4 cut the same way.
const SHOTS = [
  { time: '0:00', name: m.home_shot_band, who: m.home_shot_band_who, clip: 'shot-band-dogs' },
  { time: '0:05', name: m.home_shot_lead, who: m.home_shot_lead_who, clip: 'shot-lead-dogs' },
  { time: '0:12', name: m.home_shot_sax, who: m.home_shot_sax_who, clip: 'shot-sax-dogs' },
  { time: '0:15', name: m.home_shot_band2, who: m.home_shot_band_who, clip: 'shot-band2-dogs' },
];

// Viral wall below the hero: the first two are viral TikToks trimmed at the end of the performance (tutorial ad removed), labeled as trend references, not our usage;
// the third is a real output from this site (lead only: a Georgia coach replaces the Alabama coach, the rest is original). It links back to the product and is the page's VideoObject sample.
const VIRAL = [
  {
    tag: m.home_viral_warriors_tag,
    label: m.home_viral_warriors_label,
    hook: m.home_viral_warriors_hook,
    clip: 'viral-warriors',
    note: m.home_viral_note_tiktok,
  },
  {
    tag: m.home_viral_nfl_tag,
    label: m.home_viral_nfl_label,
    hook: m.home_viral_nfl_hook,
    clip: 'viral-nfl',
    note: m.home_viral_note_tiktok,
  },
  {
    tag: m.home_viral_new_lead_tag,
    label: m.home_viral_new_lead_label,
    hook: m.home_viral_new_lead_hook,
    clip: 'sample-new-lead',
    note: m.home_viral_note_ours,
  },
];

// Real outputs: in its 11-09 recheck ChatGPT marked us down for having no real sample going from input photos to a full video. Only checkable facts here:
// the dog and people versions were both single Kling 4.0 Edit renders on 10-28,
// and the new-lead clip used the older 10-27 pipeline (Seedance 2.0 Mini), stated as such.
const RESULTS: { title: () => string; text: () => string; flaw?: () => string }[] = [
  { title: m.home_results_dogs_title, text: m.home_results_dogs_text, flaw: m.home_results_dogs_flaw },
  { title: m.home_results_faces_title, text: m.home_results_faces_text },
  { title: m.home_results_lead_title, text: m.home_results_lead_text },
];

// Meme origin. Dates checked: NPR published 2023-06-05; Outstanding is from The Gap Band IV (1982).
const ORIGIN = [
  { when: m.home_origin_2023_when, text: m.home_origin_2023_text },
  { when: m.home_origin_2026_when, text: m.home_origin_2026_text },
  { when: m.home_origin_now_when, text: m.home_origin_now_text },
];

// Scene entries put celebrities first: the meme itself is about celebrities, so the friends version goes last.
const CREWS = [
  { title: m.home_crew_losers_title, text: m.home_crew_losers_text },
  { title: m.home_crew_rival_title, text: m.home_crew_rival_text },
  { title: m.home_crew_players_title, text: m.home_crew_players_text },
  { title: m.home_crew_you_title, text: m.home_crew_you_text },
  { title: m.home_crew_chat_title, text: m.home_crew_chat_text },
];

const STEPS = [
  { title: m.home_step_cast_title, text: m.home_step_cast_text },
  { title: m.home_step_make_title, text: m.home_step_make_text },
  { title: m.home_step_post_title, text: m.home_step_post_text },
];

// FAQ in our own words, covering the follow-ups ChatGPT asked in tests: price, number of photos, model, wait time, CapCut, whether it can be posted, whether it is real.
const FAQ: { q: () => string; a: () => string }[] = [
  { q: m.home_faq_what_q, a: () => m.home_faq_what_a({ name: site.name }) },
  { q: m.home_faq_people_q, a: m.home_faq_people_a },
  {
    q: m.home_faq_cost_q,
    a: () =>
      m.home_faq_cost_a({ plans: site.products.map((p) => `${packName(p)} ${formatPrice(p)}`).join(', ') }),
  },
  { q: m.home_faq_free_q, a: m.home_faq_free_a },
  { q: m.home_faq_model_q, a: () => m.home_faq_model_a({ resolution: RESOLUTION }) },
  { q: m.home_faq_time_q, a: m.home_faq_time_a },
  { q: m.home_faq_format_q, a: () => m.home_faq_format_a({ resolution: RESOLUTION }) },
  { q: m.home_faq_song_q, a: m.home_faq_song_a },
  { q: m.home_faq_capcut_q, a: m.home_faq_capcut_a },
  { q: m.home_faq_photo_q, a: m.home_faq_photo_a },
  { q: m.home_faq_celebrity_q, a: m.home_faq_celebrity_a },
  { q: m.home_faq_real_q, a: m.home_faq_real_a },
  { q: m.home_faq_post_q, a: m.home_faq_post_a },
  { q: m.home_faq_fail_q, a: m.home_faq_fail_a },
  { q: m.home_faq_photos_q, a: m.home_faq_photos_a },
  { q: m.home_faq_npr_q, a: () => m.home_faq_npr_a({ name: site.name }) },
];

export const Route = createFileRoute('/')({
  head: () =>
    pageHead(site, {
      title: m.home_title(),
      description: m.home_description({ price: BAND_PRICE }),
      path: '/',
      jsonLd: [
        {
          '@type': 'WebApplication',
          name: site.name,
          url: site.url,
          applicationCategory: 'MultimediaApplication',
          operatingSystem: 'Web',
          offers: site.products.map((p) => ({
            '@type': 'Offer',
            name: p.name,
            price: (p.price.amount / 100).toFixed(2),
            priceCurrency: p.price.currency.toUpperCase(),
          })),
        },
        {
          '@type': 'VideoObject',
          name: m.home_viral_new_lead_label(),
          description: `${m.home_viral_new_lead_hook()} ${m.home_viral_note_ours()}.`,
          thumbnailUrl: `${site.url}/media/sample-new-lead.jpg`,
          contentUrl: `${site.url}/media/sample-new-lead.mp4`,
          // When the first production deploy with the sample-new-lead media finished.
          uploadDate: '2026-10-27T15:02:46Z',
          duration: 'PT18S',
        },
        {
          '@type': 'FAQPage',
          mainEntity: FAQ.map((item) => ({
            '@type': 'Question',
            name: item.q(),
            acceptedAnswer: { '@type': 'Answer', text: item.a() },
          })),
        },
      ],
    }),
  component: HomePage,
});

// Only one video plays sound at a time: unmuting a new one mutes the previous.
let muteCurrent: (() => void) | null = null;

// Video with original audio: muted autoplay by default; click the frame or the top-right toggle for sound.
// Switching clips keeps the same video element: if sound is on it stays on and the new clip keeps playing.
function SoundClip({ clip, tag, label }: { clip: string; tag: string; label: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the src changes with clip; keep playing when sound is on
  useEffect(() => {
    const el = video.current;
    if (el && !el.muted) void el.play().catch(() => undefined);
  }, [clip]);
  const mute = () => {
    if (video.current) video.current.muted = true;
    setMuted(true);
  };
  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (!muted) {
      mute();
      muteCurrent = null;
      return;
    }
    muteCurrent?.();
    muteCurrent = mute;
    el.muted = false;
    void el.play();
    setMuted(false);
  };
  return (
    <div className="clip-frame">
      <span className="poster-tag">{tag}</span>
      <video
        ref={video}
        src={`/media/${clip}.mp4`}
        poster={`/media/${clip}.jpg`}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={label}
        onClick={toggle}
      />
      <button
        type="button"
        className="sound-toggle"
        onClick={toggle}
        aria-pressed={!muted}
        aria-label={muted ? m.home_sound_on() : m.home_sound_mute()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4z" />
          {muted ? (
            <path d="m16 9 5 6m0-6-5 6" />
          ) : (
            <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
          )}
        </svg>
      </button>
    </div>
  );
}

// Hero sample: defaults to the dog version (every competitor's sample is people, so pets set us apart): Kling 4.0 edit mode swaps
// all 5 for AI-generated dogs in one run (a few human fingers still show at the keyboard's lower edge), re-timed per shot to match the original frame by frame.
// It can switch to the top viral TikTok (College Football Week 8, about 288K likes, starting at the three coaches singing, skipping the opening profile shot),
// or to a real output with people: all 5 swapped (AI-generated faces), same pipeline, original song mixed back in.
const HERO_CLIPS = {
  dogs: {
    clip: 'sample-dogs',
    tab: m.home_hero_tab_dogs,
    tag: m.home_dogs_band_tag,
    label: m.home_dogs_band_label,
    hook: m.home_dogs_band_hook,
    note: m.home_dogs_band_note,
  },
  viral: {
    clip: 'viral-coaches',
    tab: m.home_hero_tab_viral,
    tag: m.home_viral_coaches_tag,
    label: m.home_viral_coaches_label,
    hook: m.home_viral_coaches_hook,
    note: m.home_viral_coaches_note,
  },
  ours: {
    clip: 'sample-full-band',
    tab: m.home_hero_tab_ours,
    tag: m.home_ours_band_tag,
    label: m.home_ours_band_label,
    hook: m.home_ours_band_hook,
    note: m.home_ours_band_note,
  },
} as const;

type HeroView = keyof typeof HERO_CLIPS;

function HeroClip({ view, onPick }: { view: HeroView; onPick: (view: HeroView) => void }) {
  const shown = HERO_CLIPS[view];
  // Prefetch both posters: right after a switch the new clip has no first frame yet, so show its poster instead of a black flash.
  useEffect(() => {
    for (const { clip } of Object.values(HERO_CLIPS)) new Image().src = `/media/${clip}.jpg`;
  }, []);
  return (
    <figure className="sample-card">
      <fieldset className="clip-switch" aria-label={m.home_hero_tab_label()}>
        {(Object.keys(HERO_CLIPS) as HeroView[]).map((key) => (
          <button key={key} type="button" aria-pressed={view === key} onClick={() => onPick(key)}>
            {HERO_CLIPS[key].tab()}
          </button>
        ))}
      </fieldset>
      <SoundClip clip={shown.clip} tag={shown.tag()} label={shown.label()} />
      <figcaption>
        <strong>{shown.hook()}</strong>
        <span className="mono">{shown.note()}</span>
      </figcaption>
    </figure>
  );
}

const root = getRouteApi('__root__');

function HomePage() {
  const config = root.useLoaderData();
  const generation = useGeneration({ recaptchaSiteKey: config.recaptchaSiteKey });
  // The hero sample and the stage show the same cast, so it is clear who replaced whom; on load both are dogs, matching the 5 dogs placed on the stage by default.
  const [heroView, setHeroView] = useState<HeroView>('dogs');
  return (
    <>
      <section className="hero" id="make">
        <div className="hero-head">
          <ReturnNotice jobs={generation.jobs} />
          <p className="rec mono">{m.home_hero_rec()}</p>
          <h1>{m.home_hero_title()}</h1>
          <p className="lead">{m.home_hero_lead()}</p>
        </div>
        <HeroClip view={heroView} onPick={setHeroView} />
        <div className="hero-tool">
          <TinyDeskTool generation={generation} stage={heroView} />
        </div>
      </section>

      <section className="band" id="fyp">
        <p className="kicker">{m.home_fyp_kicker()}</p>
        <h2>{m.home_fyp_title()}</h2>
        <ul className="viral">
          {VIRAL.map((item) => (
            <li key={item.clip}>
              <SoundClip clip={item.clip} tag={item.tag()} label={item.label()} />
              <strong>{item.hook()}</strong>
              <span className="mono muted">{item.note()}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="band" id="whats-in">
        <p className="kicker">{m.home_cut_kicker()}</p>
        <h2>{m.home_cut_title()}</h2>
        <p className="muted">{m.home_cut_text()}</p>
        <ol className="shots">
          {SHOTS.map((shot) => (
            <li key={shot.time}>
              <video
                src={`/media/${shot.clip}.mp4`}
                poster={`/media/${shot.clip}.jpg`}
                autoPlay
                muted
                loop
                playsInline
                preload="none"
                aria-label={m.home_shot_label({ name: shot.name() })}
              />
              <span className="mono">{shot.time}</span>
              <strong>{shot.name()}</strong>
              <span className="muted">{shot.who()}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="band" id="results">
        <p className="kicker">{m.home_results_kicker()}</p>
        <h2>{m.home_results_title()}</h2>
        <p className="muted">{m.home_results_intro()}</p>
        <ul className="steps">
          {RESULTS.map((item) => (
            <li key={item.title()}>
              <h3>{item.title()}</h3>
              <p>{item.text()}</p>
              {item.flaw && <p className="muted">{item.flaw()}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section className="sheet" id="how">
        <h2>{m.home_how_title()}</h2>
        <ol className="steps">
          {STEPS.map((step) => (
            <li key={step.title()}>
              <h3>{step.title()}</h3>
              <p>{step.text()}</p>
            </li>
          ))}
        </ol>
        <p className="steps-more">
          <Link to="/how-to-make-outstanding-tiny-desk-ai-video">{m.home_how_guide_link()}</Link>
        </p>
      </section>

      <section className="band" id="pricing">
        <h2>{m.home_pricing_title()}</h2>
        <Plans />
        <BeforeYouPay />
      </section>

      <section className="band" id="crews">
        <p className="kicker">{m.home_crews_kicker()}</p>
        <h2>{m.home_crews_title()}</h2>
        <ul className="lineup">
          {CREWS.map((crew) => (
            <li key={crew.title()}>
              <h3>{crew.title()}</h3>
              <p className="muted">{crew.text()}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="band" id="meme">
        <h2>{m.home_meme_title()}</h2>
        <ol className="origin">
          {ORIGIN.map((item) => (
            <li key={item.when()}>
              <span className="mono">{item.when()}</span>
              <p className="origin-text">{item.text()}</p>
            </li>
          ))}
        </ol>
        <p className="muted">
          <Link to="/outstanding-tiny-desk-meme">{m.home_meme_story_link()}</Link>
          {m.home_meme_or_original()}{' '}
          <a href="https://www.rollingstone.com/music/music-news/charlie-wilson-gap-band-tiny-desk-1234759558/">
            {m.home_meme_original_link()}
          </a>
        </p>
      </section>

      <section className="sheet faq" id="faq">
        <h2>{m.home_faq_title()}</h2>
        {FAQ.map((item) => (
          <details key={item.q()}>
            <summary>{item.q()}</summary>
            <p>{item.a()}</p>
          </details>
        ))}
      </section>

      <section className="band closer">
        <h2>{m.home_closer_title()}</h2>
        <p className="muted">{m.home_closer_text({ price: BAND_PRICE })}</p>
        <a className="button primary closer-cta" href="#make">
          {m.home_closer_cta()}
        </a>
      </section>
    </>
  );
}
