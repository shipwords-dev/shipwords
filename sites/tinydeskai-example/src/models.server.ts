import { type PromptContext, type SlotKind, serverModels } from '@shipwords/jobs/models';
import catalog from '../site.models';

// Server only: never import this file from pages or components. site.models.ts holds only what the browser may see (id, name, price, slots) and is bundled into the client.

// One effect: 1.375–19.063 s of the viral TikTok Tiny Desk clip (skips the opening side view of the singer; 17.688 s, 4 shots). Same price for 1–5 people.
// Since 2026-10-28 the whole clip renders in one run: Kling 4.0 edit mode (Edit @video_1) replaces every person who has a photo entirely (face, hair and clothes from the photo);
// empty seats keep the original coaches. Tested: all 5 swapped 5/5, scene and cuts match the original, $3.06 at 720p, about 6 minutes.
// An earlier per-shot Seedance 2.0 mini pipeline (outfit photo edits, eye and nose masks, 4 segments, a check per segment) was structurally fragile and was dropped.
// Assets live in R2 under assets/tinydesk/:
// full-17s.mp4 is that span of the viral clip as is (720×1280, 24 fps, with the song), used as the reference video, the original for the face check and the base clip.
//
// Since 2026-11-10: Kling subject reference (character sheets). Each photo is prepped into 4 views, sent as one subject's 4 images and named like @Lead in the prompt.
// Based on the manual redo of two customer complaints on 11-09: same photos, subject reference swapped all 5 in one run, jersey numbers and logos right, no face mix-ups.
//
// Since 2026-11-15: no more subject reference, one image per person. Each photo is prepped into one two-panel reference image (face on the left, outfit
// from the neck down on the right), sent whole as that person's only reference, and the prompt says which shot, time span and spot each person is in.
// After 11-13 subject reference kept putting the lead at the front keyboard (five live jobs) and the checks didn't catch it; the same photos on the same
// Kling 4.0 route with one image per person and a time-span prompt got every seat right and a closer lead likeness (0.53 vs 0.49).

/** Who sits in each seat of the original, by position and outfit, so the model knows whom to replace. */
const WHO = {
  lead: 'the lead singer in the red cap and black hoodie',
  sax: 'the saxophone player in the navy hoodie',
  keys: 'the keyboard player in the white cap and black pullover',
  backLeft: 'the backing singer standing at the back left in the white pullover',
  backRight: 'the backing singer standing at the back right in the red jacket',
} as const;
type Seat = keyof typeof WHO;
const SEATS = Object.keys(WHO) as Seat[];

const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** Which shot and spot each seat is in (cuts at 5.333, 11.625 and 15.000 s), told to Kling by time span so it doesn't put the lead at the keyboard in the wide shots. */
const WHERE: Record<Seat, string> = {
  lead: 'They appear only in the solo close-up from 5.333 to 11.625 seconds, singing with the original mouth movements and gestures. They are alone in that close-up, with no second face, head or shoulder anywhere in the frame, including its edges, and with empty hands: no saxophone, mouthpiece or other instrument. They never appear in the wide shots or in the saxophone close-up.',
  sax: "They appear only in the saxophone close-up from 11.625 to 15.000 seconds, playing the original saxophone with the original playing action and camera angle; the original saxophone player's face, head and clothes are replaced completely.",
  keys: 'They sit at the keyboard in front, in the centre of both wide shots (0 to 5.333 seconds and 15.000 seconds to the end), and they are also the person partly visible in the lower right corner of the saxophone close-up.',
  backLeft:
    "They stand at the back on the viewer's left in both wide shots (0 to 5.333 seconds and 15.000 seconds to the end).",
  backRight:
    "They stand at the back on the viewer's right in both wide shots (0 to 5.333 seconds and 15.000 seconds to the end).",
};
const ROLE: Record<Seat, string> = {
  lead: 'The lead singer',
  sax: 'The saxophone player',
  keys: 'The keyboard player',
  backLeft: 'The backing singer at the back left',
  backRight: 'The backing singer at the back right',
};

/**
 * The one-image-per-person prompt, from the tested run: start with Edit @video_1 (written as Reference it becomes reference-to-video), say that each
 * reference image is one person with the face on the left and the outfit on the right, then give each seat who, which time span and which spot; empty
 * seats stay as in the original. The engine names ungrouped images @image1…, while Kling 4.0 expects @image_1, so the names are rewritten here.
 * Each name is followed by an appearance description (a vision model describes the prepped image; left out if that fails) to tell look-alikes apart.
 * The lead is alone in the close-up and holds no instrument (customers care most about those 6 seconds; one lineup was reordered 3 times over a second
 * face there), and no one takes an original performer's face (a customer in a white cap got the original keyboard coach's face). The animal sentence
 * only covers seats marked as pets; people always get human hands (an all-people job grew furry hands). Clothes keep their colors, logos, letters
 * and numbers: customers want their own team's jersey.
 */
function editPrompt(images: Readonly<Record<string, string>>, { kinds, describe }: PromptContext) {
  const filled = SEATS.filter((seat) => images[seat]);
  const empty = SEATS.filter((seat) => !images[seat]);
  const name = (seat: Seat) => images[seat]!.replace(/^@image(\d+)$/, '@image_$1');
  const pets = filled.filter((seat) => kinds[seat] === 'pet');
  const people = filled.filter((seat) => kinds[seat] !== 'pet');
  return [
    'Edit @video_1. Keep its four shots, exact camera cuts, framing, background, instruments, microphones, headsets, lighting and timing.',
    'Each reference image shows one performer. When it has two panels, the left panel is their face and the right panel is their outfit seen from the neck down (for an animal, its body); use both for that performer only and never show the panels themselves.',
    ...filled.map((seat) => `${ROLE[seat]} is ${name(seat)}${describe(seat)}. ${WHERE[seat]}`),
    ...(empty.length
      ? [
          `${list(empty.map((seat) => WHO[seat])).replace(/^t/, 'T')} ${empty.length > 1 ? 'stay' : 'stays'} exactly as in @video_1.`,
        ]
      : []),
    ...(pets.length
      ? [
          `${list(pets.map(name))} ${pets.length > 1 ? 'are animals: each becomes' : 'is an animal and becomes'} that animal completely, with its fur, face and paws; every visible hand of that performer, including raised hands, clapping hands, hands on the keyboard and hands partly outside the frame edges, becomes the animal's furry paws with no human fingers or skin.`,
        ]
      : []),
    ...(people.length
      ? [
          `${list(people.map(name))} ${people.length > 1 ? 'are people' : 'is a person'} with normal human hands and bare skin, never fur or paws.`,
        ]
      : []),
    ...(filled.length > 1
      ? [
          "Each replaced performer is a different individual and never takes another performer's place, face, clothes or instrument.",
        ]
      : []),
    'No replaced performer has the face of a performer from @video_1, even when they wear a similar cap, glasses or clothes.',
    "Each replaced performer keeps the face, hair and outfit from their own reference image in every shot, with the same colors, logos, letters and numbers, and keeps the original person's pose, head direction, gestures, facial expressions and mouth movements frame by frame. Do not add logos, letters or numbers that are not in the reference images.",
    'Natural skin texture, sharp detail and stable faces with no flicker.',
    'Keep the audio exactly identical to the original video. Do not add any new sounds.',
  ].join(' ');
}

/** How each seat is named in the repair (Pruna p-video-replace) prompt: by position, since a swapped person no longer wears the original's clothes. */
const SPOT: Record<Seat, string> = {
  lead: 'the lead singer',
  sax: 'the saxophone player',
  keys: 'the keyboard player sitting at the front center',
  backLeft: 'the backing singer standing at the back left',
  backRight: 'the backing singer standing at the back right',
};

/** Wording from the tested repair runs: with several people, say who each image is, then keep position, motion and mouth movements. */
function repairPrompt(slots: readonly string[], kinds: Readonly<Record<string, SlotKind>>) {
  const who = (slot: string) => (kinds[slot] === 'pet' ? 'animal' : 'person');
  const keep =
    'face, hair and clothes. Keep the position, pose, gestures, head direction and mouth movements. Do not change anyone else.';
  if (slots.length === 1)
    return `Replace ${SPOT[slots[0] as Seat]} with the ${who(slots[0]!)} in the image: ${keep}`;
  const images = slots
    .map((slot, i) => `image ${i + 1} is ${SPOT[slot as Seat]}, replaced with the ${who(slot)} in it`)
    .join('; ');
  return `In order, ${images}. Replace each of them: ${keep}`;
}

const CLIP = 'assets/tinydesk/full-17s.mp4';

/**
 * Each photo becomes one two-panel reference image: a front head-and-shoulders close-up on the left (a large, sharp face) and the front of the outfit
 * from the neck to the waist on the right (jersey number in frame, no second face). A refused or failed prep falls back to the original photo. Outfits
 * stay as is (logos, numbers, wigs, hats): "plain clothes, no logos" erased customers' jerseys (two complaints on 11-09). The base wording was tested on
 * those 10 photos (close-up vs original 0.75–0.88); the two-panel version on three photos: one face each, 0.85–0.95 vs the originals, but drawn down
 * to the hips it invented trousers the photo didn't show, so it stops at the waist.
 */
const PREP_BASE =
  'Make a realistic reference photo of the main person or animal in this image, for a character reference sheet. Keep exactly the same individual: the same face and features, skin tone or fur, age, hairstyle, glasses and facial hair, with natural skin or fur texture. Only this one subject: remove any other people or animals and their arms or hands, phone status bars, app interface, captions, stickers and watermarks. Keep their own outfit exactly as in the photo, including any wig, hat, glasses and accessories, and keep every logo, letter, number and team mark on the clothes exactly as it is. Plain light wall background, soft even daylight, sharp focus, no added text, labels or borders.';
const PREP_PAIR = `${PREP_BASE} Output exactly one borderless 1 by 2 character reference sheet: two equal portrait panels side by side covering the entire canvas, divided exactly at 50% width, with no gap or line between them. Each panel shows the same individual independently, wholly inside its own panel. Left panel: front-facing head-and-shoulders close-up, relaxed natural smile, face large and sharp. Right panel: the same individual front-facing, framed from the neck down to the waist so the face is not shown again; for a person, the whole front of their top with its logo, letters or number and any badge or accessory clearly visible; for an animal, its body and coat. Show only what the photo shows: do not add trousers, shoes or other clothing that is not visible in it. Keep identical skin tone or fur, outfit, colors, letters, numbers and team marks in both panels. Do not mirror or invent visible clothing details. Same pale background and lighting in both panels. No labels, captions or borders.`;

export default serverModels(catalog, {
  'tiny-desk': {
    upstream: 'yir',
    upstreamModel: 'klingai/kling-4.0',
    // Kling is quoted at $3.06 (billed as 18 s), capped at 3.40. A missed swap does not rerun Kling: Pruna repairs it, up to 4 rounds at 0.40 each.
    // Once Kling has charged, credits are not refunded: if someone is still missed after the repairs, the version with the fewest misses is delivered and REVIEW_EMAIL gets a review alert.
    // Prep: one two-panel image per person, five cost $0.0425; a slow one gets a hedge copy, so the cap counts two each: $0.15.
    // The job cap of 5.60 stays below the net per video of the cheapest pack (10 for $59.99, about 5.80 after fees), so even a fully repaired job breaks even.
    maxCost: '5.60',
    // Usually about 8 minutes (6 to generate, 2 for the face check and compose); each repair round adds a few minutes, plus room for upstream queues.
    timeoutMinutes: 45,
    effect: {
      slots: catalog
        .find((model) => model.id === 'tiny-desk')!
        .effect!.slots.map((slot) => ({ ...slot, prep: PREP_PAIR })),
      prep: {
        upstreamModel: 'openai/gpt-image-2.5-sunburst',
        // Two 3:4 portrait panels side by side make 3:2 (1536×1024).
        parameters: { resolution: '1K', aspect_ratio: '3:2' },
        maxCost: '0.015',
      },
      // Describe the two-panel image (view 0): it shows both face and clothes. Tested with Llama 4 Scout: it names the hairstyle, glasses, jersey colors and number.
      describe: {
        instruction:
          'Describe the person or animal in this photo in one short phrase of at most 20 words: for a person their gender, approximate age, hair, facial hair, glasses and outfit with its colors, team name, logos and numbers; for an animal its species, breed and colors. No names and no guesses about who it is. Output only the phrase.',
        view: 0,
      },
      segments: [
        {
          id: 'full',
          referenceVideo: CLIP,
          slots: ['lead', 'sax', 'keys', 'backLeft', 'backRight'],
          prompt: editPrompt,
          // duration must be a whole number: the 17.688 s reference asks for 18 s, which comes back as 18.04 s with each cut 1–6 frames late; compose re-aligns shot by shot.
          // generate_audio can only be on with Yir; compose swaps the original song back in.
          parameters: { duration: 18, resolution: '720p', aspect_ratio: 'auto' },
          maxCost: '3.40',
          target: 17.688,
          cuts: [5.333, 11.625, 15.0],
          base: CLIP,
          // Original face centers, from the start of each one's shot (band 0 s, lead 5.4 s, sax 11.67 s); keys also has the half face in the sax close-up's lower right (12.5 s).
          // Threshold 0.45: swapped faces score at most 0.28; the original person present scores 0.78–0.94, and a 2-second leftover side view of the original lead (a live job) 0.52;
          // a lead profile whose nose resembles the original can reach 0.58, but when it also looks like the user's photo the engine treats it as a false positive (likeness passes).
          check: {
            original: CLIP,
            faces: {
              keys: [
                [0.395, 0.496, 0],
                [0.87, 0.824, 12.5],
              ],
              backLeft: [0.073, 0.204, 0],
              backRight: [0.859, 0.224, 0],
              lead: [0.793, 0.323, 5.4],
              sax: [0.186, 0.287, 11.67],
            },
            maxSimilarity: 0.45,
          },
          // The wide shots (shots 1 and 4) are one group: keys and the two backing singers, repaired full frame with all three photos; the sax close-up is another (sax and keys in the corner).
          // Full-frame repair often skips the top-corner backing singers, so those are cropped and repaired alone too (11-09: the back-right customer wore red like the original; Kling only swapped clothes).
          // Crops use Pruna's 7:9 output ratio and are aligned to the background frame by frame when pasted back (align.py in the container).
          repair: {
            upstreamModel: 'pruna/p-video-replace',
            prompt: repairPrompt,
            parameters: { resolution: '720p' },
            maxCost: '0.40',
            rounds: 4,
            onMiss: 'deliver',
            shots: [
              ['keys', 'backLeft', 'backRight'],
              ['lead'],
              ['sax', 'keys'],
              ['keys', 'backLeft', 'backRight'],
            ],
            crops: { backLeft: [0, 0, 0.444, 0.3875], backRight: [0.5, 0, 0.5, 0.3875] },
            aspect: 7 / 9,
            // Also repair a lead close-up unlike the photo or more like someone else: in six jobs on 10-30/31 the lead scored 0.44–0.66 vs the prepped photo; 0.44 drew a "can't recognize him" complaint.
            // The sax is a side view while playing (always 0.33–0.36) and faces in the wide shots are small, so those scores are unreliable and have no threshold.
            likeness: { lead: 0.5 },
          },
        },
      ],
      // Output: the original song from 1.375–19.063 s of the viral clip, 720×1280, 24 fps.
      compose: {
        audio: 'assets/tinydesk/song.m4a',
        audioStart: 1.375,
        audioDuration: 17.688,
        width: 720,
        height: 1280,
        fps: 24,
      },
    },
  },
});
