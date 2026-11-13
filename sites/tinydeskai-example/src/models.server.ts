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

/** Kling subject names: the prompt writes @Lead and so on; letters, digits and underscores only. */
const SUBJECTS: Record<Seat, string> = {
  lead: 'Lead',
  sax: 'Sax',
  keys: 'Keys',
  backLeft: 'BackLeft',
  backRight: 'BackRight',
};

const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * The prompt follows the tested run: start with Edit @video_1 (written as Reference it becomes reference-to-video), replace each person,
 * then keep motion, expressions, lip sync, camera, cuts and duration frame by frame. Each name is followed by an appearance description (a vision model
 * describes the prepped front view; left out if that fails), as in Kling's multi-person replace example, to tell look-alikes apart (11-09: the lead got the back-right face).
 * The animal sentence only covers seats marked as pets (default stage dogs, photos with the paw on); people always get human hands: an all-people job grew furry hands.
 * Keys also shows in the lower right of the sax close-up (half a face) and needs his own sentence, or the original coach stays there.
 * Clothes are worn as in the photo, keeping colors, logos, letters and numbers: customers want their own team's jersey.
 */
function editPrompt(images: Readonly<Record<string, string>>, { kinds, describe }: PromptContext) {
  const filled = SEATS.filter((seat) => images[seat]);
  const name = (seat: Seat) => images[seat]!;
  const pets = filled.filter((seat) => kinds[seat] === 'pet');
  const people = filled.filter((seat) => kinds[seat] !== 'pet');
  return [
    'Edit @video_1.',
    ...filled.map((seat) => `Replace ${WHO[seat]} with ${name(seat)}${describe(seat)}.`),
    ...(images.keys
      ? [
          `The keyboard player also appears in the lower right corner of the saxophone close-up shot; replace him there with ${name('keys')} too, so the original keyboard player never appears anywhere in the video.`,
        ]
      : []),
    'The lead singer appears only in the close-up shot; the wide band shots show only the keyboard player and the two backing singers, so do not add the lead singer or any other new character to them.',
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
      ? ['Each replaced performer is a different individual: never put one performer’s face on another.']
      : []),
    'Keep the face of each replaced performer exactly consistent with their reference photos, with natural skin texture and stable and consistent features across frames with no flicker.',
    `Each replaced performer keeps the original person's position, pose, head direction, gestures, facial expressions and mouth movements frame by frame, and wears the outfit from their own reference photos in every shot, with the same colors, logos, letters and numbers.${filled.length < SEATS.length ? ' Everyone else stays exactly as in @video_1.' : ''}`,
    'Keep everything else unchanged: the room, the shelves, the instruments, the microphones, the camera cuts, the camera movement, the lighting, the timing and the video duration.',
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
 * Each photo becomes 4 reference views: face close-up (the main image; Kling suggests a frontal one), front waist-up (jersey number in frame),
 * three-quarter, and full profile (the sax close-up is a profile). Kling takes 2–4 images per subject; a refused or failed view falls back to the original
 * photo (the engine dedupes, adding a second URL if only one is left). Outfits stay as is (logos, numbers, wigs, hats): "plain clothes, no logos" erased
 * customers' jerseys (two complaints on 11-09). Tested on those 10 photos: SFace similarity of the 20 views to the originals, close-up 0.75–0.88, waist-up 0.81–0.90.
 */
const PREP_BASE =
  'Make a realistic reference photo of the main person or animal in this image, for a character reference sheet. Keep exactly the same individual: the same face and features, skin tone or fur, age, hairstyle, glasses and facial hair, with natural skin or fur texture. Only this one subject: remove any other people or animals and their arms or hands, phone status bars, app interface, captions, stickers and watermarks. Keep their own outfit exactly as in the photo, including any wig, hat, glasses and accessories, and keep every logo, letter, number and team mark on the clothes exactly as it is. Plain light wall background, soft even daylight, sharp focus, no added text, labels or borders.';
const PREP_SHEET = `${PREP_BASE} Output exactly one borderless 2 by 2 character reference sheet: four equal rectangular panels covering the entire canvas, with divisions exactly at 50% width and 50% height, no gaps or grid lines. Each panel shows the same individual independently, wholly inside its own panel; do not let heads or bodies cross a panel boundary. Top left: front-facing head-and-shoulders close-up, relaxed natural smile. Top right: front-facing waist-up, arms relaxed, the whole front of the top and its logo or number clearly visible. Bottom left: waist-up, body and head turned 45 degrees to the left, three-quarter view. Bottom right: chest-up, head and body turned 90 degrees to the right, full right-facing profile. Keep identical face, hair, outfit, colors, letters, numbers and team marks across all panels. Do not mirror or invent visible clothing details. Same pale background and lighting in every panel. No labels, captions or borders.`;

export default serverModels(catalog, {
  'tiny-desk': {
    upstream: 'yir',
    upstreamModel: 'klingai/kling-4.0',
    // Kling is quoted at $3.06 (billed as 18 s, same with subject reference), capped at 3.40. A missed swap does not rerun Kling: Pruna repairs it, up to 4 rounds at 0.40 each.
    // Once Kling has charged, credits are not refunded: if someone is still missed after the repairs, the version with the fewest misses is delivered and REVIEW_EMAIL gets a review alert.
    // Prep: one four-view sheet per person, cropped locally; five sheets cost $0.0425, capped at $0.075, without hedges.
    // The job cap of 5.60 stays below the net per video of the cheapest pack (10 for $59.99, about 5.80 after fees), so even a fully repaired job breaks even.
    maxCost: '5.60',
    // Usually about 8 minutes (6 to generate, 2 for the face check and compose); each repair round adds a few minutes, plus room for upstream queues.
    timeoutMinutes: 45,
    effect: {
      slots: catalog
        .find((model) => model.id === 'tiny-desk')!
        .effect!.slots.map((slot) => ({ ...slot, prepSheet: PREP_SHEET })),
      prep: {
        upstreamModel: 'openai/gpt-image-2.5-sunburst',
        parameters: { resolution: '1K', aspect_ratio: '3:4' },
        maxCost: '0.015',
      },
      // Describe the front waist-up view (view 1): it shows both face and clothes. Tested with Llama 4 Scout: it names the hairstyle, glasses, jersey colors and number.
      describe: {
        instruction:
          'Describe the person or animal in this photo in one short phrase of at most 20 words: for a person their gender, approximate age, hair, facial hair, glasses and outfit with its colors, team name, logos and numbers; for an animal its species, breed and colors. No names and no guesses about who it is. Output only the phrase.',
        view: 1,
      },
      segments: [
        {
          id: 'full',
          referenceVideo: CLIP,
          slots: ['lead', 'sax', 'keys', 'backLeft', 'backRight'],
          subjects: SUBJECTS,
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
