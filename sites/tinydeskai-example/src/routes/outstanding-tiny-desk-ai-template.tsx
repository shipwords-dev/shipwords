import { pageHead } from '@shipwords/core/seo';
import { createFileRoute, Link } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { Faq, type FaqItem, faqJsonLd, GuidePage } from '~/site/guide';
import { formatPrice } from '~/site/pricing';
import site from '../../site.config';

// Template page: targets searches like "outstanding tiny desk ai template" and "capcut". Splits the video into 4 shots and 5 spots and explains how it differs from CapCut templates.
// It describes the original viral cut as visitors know it (19.06 s, 5 shots, cuts at 1.375 / 6.708 / 13.0 / 16.375 s), with times on the original timeline.
// This site skips the first 1.4 s side view of the lead (SHOTS on the home page use the output timeline); only the "why it skips the profile shot" section says so.

const PATH = '/outstanding-tiny-desk-ai-template';
// Our own engineering notes on Hugging Face (2026-10-30): an outside source for the trade-offs on this page.
const HF_NOTES = 'https://huggingface.co/blog/gargantuax/tiny-desk-ai-video-face-swap';

// The profile shot has no clip of its own, so it only appears in the table.
const shots = (): { time: string; name: string; seats: string; clip?: string }[] => [
  {
    time: '0:00–0:01',
    name: m.guides_template_shot_profile(),
    seats: m.guides_template_seats_profile(),
  },
  {
    time: '0:01–0:07',
    name: m.guides_template_shot_band(),
    seats: m.guides_template_seats_band(),
    clip: 'shot-band',
  },
  {
    time: '0:07–0:13',
    name: m.guides_template_shot_lead(),
    seats: m.guides_template_seats_lead(),
    clip: 'shot-lead',
  },
  {
    time: '0:13–0:16',
    name: m.guides_template_shot_sax(),
    seats: m.guides_template_seats_sax(),
    clip: 'shot-sax',
  },
  {
    time: '0:16–0:19',
    name: m.guides_template_shot_band2(),
    seats: m.guides_template_seats_band(),
    clip: 'shot-band2',
  },
];

const faq = (): FaqItem[] => [
  {
    q: m.guides_template_faq1_q(),
    a: m.guides_template_faq1_a({ site: site.name, price: formatPrice(site.products[0]) }),
  },
  { q: m.guides_template_faq2_q(), a: m.guides_template_faq2_a() },
  { q: m.guides_template_faq3_q(), a: m.guides_template_faq3_a() },
  { q: m.guides_template_faq4_q(), a: m.guides_template_faq4_a() },
  { q: m.guides_template_faq5_q(), a: m.guides_template_faq5_a() },
];

export const Route = createFileRoute('/outstanding-tiny-desk-ai-template')({
  head: () =>
    pageHead(site, {
      title: m.guides_template_meta_title(),
      description: m.guides_template_meta_description(),
      path: PATH,
      jsonLd: [faqJsonLd(faq())],
    }),
  component: TemplatePage,
});

function TemplatePage() {
  const shotList = shots();
  return (
    <GuidePage
      path={PATH}
      title={m.guides_template_title()}
      updated={m.guides_template_updated()}
      intro={<p>{m.guides_template_intro()}</p>}
    >
      <h2>{m.guides_template_shots_heading()}</h2>
      <p>{m.guides_template_shots_intro()}</p>
      <ol className="shots guide-shots">
        {shotList
          .filter((shot) => shot.clip)
          .map((shot) => (
            <li key={shot.time}>
              <video
                src={`/media/${shot.clip}.mp4`}
                poster={`/media/${shot.clip}.jpg`}
                autoPlay
                muted
                loop
                playsInline
                preload="none"
                aria-label={m.guides_template_shot_aria({ shot: shot.name })}
              />
              <span className="mono">{shot.time}</span>
              <strong>{shot.name}</strong>
            </li>
          ))}
      </ol>

      <h2>{m.guides_template_spots_heading()}</h2>
      <div className="table-wrap">
        <table className="narrow">
          <thead>
            {/* Time sits in the shot column: three columns scroll sideways on phones and push "who is on screen" out of view. */}
            <tr>
              <th>{m.guides_template_spots_col_shot()}</th>
              <th>{m.guides_template_spots_col_who()}</th>
            </tr>
          </thead>
          <tbody>
            {shotList.map((shot) => (
              <tr key={shot.time}>
                <td>
                  <span className="mono">{shot.time}</span>
                  <br />
                  {shot.name}
                </td>
                <td>{shot.seats}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>{m.guides_template_spots_outro()}</p>

      <h2>{m.guides_template_start_heading()}</h2>
      <p>{m.guides_template_start_text()}</p>
      <p>
        {m.guides_template_notes_before()}
        <a href={HF_NOTES}>{m.guides_template_notes_link()}</a>
        {m.guides_template_notes_after()}
      </p>

      <h2>{m.guides_template_vs_heading()}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              <th>{m.guides_template_vs_col_capcut()}</th>
              <th>{site.name}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{m.guides_template_vs_cuts()}</td>
              <td>{m.guides_template_vs_cuts_capcut()}</td>
              <td>{m.guides_template_vs_cuts_us()}</td>
            </tr>
            <tr>
              <td>{m.guides_template_vs_face()}</td>
              <td>{m.guides_template_vs_face_capcut()}</td>
              <td>{m.guides_template_vs_face_us()}</td>
            </tr>
            <tr>
              <td>{m.guides_template_vs_people()}</td>
              <td>{m.guides_template_vs_people_capcut()}</td>
              <td>{m.guides_template_vs_people_us()}</td>
            </tr>
            <tr>
              <td>{m.guides_template_vs_editing()}</td>
              <td>{m.guides_template_vs_editing_capcut()}</td>
              <td>{m.guides_template_vs_editing_us()}</td>
            </tr>
            <tr>
              <td>{m.guides_template_vs_price()}</td>
              <td>{m.guides_template_vs_price_capcut()}</td>
              <td>{m.guides_template_vs_price_us({ price: formatPrice(site.products[0]) })}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        {m.guides_template_more_before()}{' '}
        <Link to="/how-to-make-outstanding-tiny-desk-ai-video">{m.guides_template_more_link()}</Link>
        {m.guides_template_more_after()}
      </p>

      <Faq title={m.guides_template_faq_title()} items={faq()} />
    </GuidePage>
  );
}
