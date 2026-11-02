import { serverModels } from '@shipwords/jobs/models';
import catalog from '../site.models';

// Server only: never import this file from pages or components. site.models.ts holds the public part of each entry.

// One effect: 1.375–19.063 s of the viral TikTok Tiny Desk clip (skips the opening side view of the singer; 17.688 s, 4 shots). Same price for 1–5 people.
// The whole clip renders in one run: Kling 4.0 edit mode (Edit @video_1) replaces every person who has a photo entirely (face, hair and clothes from the photo);
// empty seats keep the original coaches. Tested: all 5 swapped 5/5, scene and cuts match the original, $3.06 at 720p, about 6 minutes.
// Each photo is cleaned up first (prep), and anyone Kling misses is re-rendered shot by shot with Pruna (repair); a charged render is never refunded.
// An earlier per-shot Seedance 2.0 mini pipeline (outfit photo edits, eye masks, 4 segments, a check per segment) was structurally fragile and was dropped.
// Assets live in R2 under assets/tinydesk/: full-17s.mp4 is that span of the viral clip as is (720×1280, 24 fps, with the song),
// used as the reference video, the original for the face check and the base clip.

/** Who sits in each seat of the original, by position and outfit, so the model knows whom to replace. This order is the @image_1… order. */
const WHO = {
  lead: 'the lead singer in the red cap and black hoodie',
  sax: 'the saxophone player in the navy hoodie',
  keys: 'the keyboard player in the white cap and black pullover',
  backLeft: 'the backing singer standing at the back left in the white pullover',
  backRight: 'the backing singer standing at the back right in the red jacket',
} as const;
type Seat = keyof typeof WHO;

/** Face occlusion, off by default: when on, prep draws grey boxes and the video prompt asks to rebuild the features. */
const FACE_OCCLUSION = false;

/**
 * The prompt follows the tested run: start with Edit @video_1 (written as Reference it becomes reference-to-video), replace each person,
 * then keep motion, expressions, lip sync, camera, cuts and duration frame by frame. The engine names images @image1; Kling 4.0 wants @image_1 and Yir rejects the wrong name.
 * The stage starts with 5 dogs, so a photo may be a person or a dog and the server cannot tell; the prompt says "person or animal".
 * The animal sentence and "no lead singer or new character in the band shots" come from the tested dog run: without them a second lead appears and hands stay human.
 * A mix of people and dogs in one job is untested.
 */
function editPrompt(images: Readonly<Record<string, string>>) {
  const filled = (Object.keys(WHO) as Seat[]).filter((seat) => images[seat]);
  const swaps = filled.map(
    (seat) =>
      `Replace ${WHO[seat]} with the person or animal in ${images[seat]!.replace(/^@image(\d+)$/, '@image_$1')}.`,
  );
  const others =
    filled.length < Object.keys(WHO).length ? ' Everyone else stays exactly as in @video_1.' : '';
  return [
    'Edit @video_1.',
    ...swaps,
    'The lead singer appears only in the close-up shot; the wide band shots show only the keyboard player and the two backing singers, so do not add the lead singer or any other new character to them.',
    "A performer replaced with a dog or another animal becomes that animal completely, with its fur, face and paws; every visible hand of that performer, including raised hands, clapping hands, hands on the keyboard and hands partly outside the frame edges, becomes the animal's furry paws with no human fingers or skin.",
    FACE_OCCLUSION
      ? 'Each reference photo is a three-view strip whose panels each have part of the face covered by a grey box; reconstruct the complete, symmetric, natural facial features of each replaced performer from the three panels, keeping the face exactly consistent with the photo, hyper-realistic skin texture, and stable and consistent across frames with no flicker.'
      : 'Keep the facial features of each replaced performer exactly consistent with their reference photo, with natural skin texture and stable and consistent features across frames with no flicker.',
    `Each replaced performer keeps the original person's position, pose, head direction, gestures, facial expressions and mouth movements frame by frame, and wears the clothes from their own photo.${others}`,
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
function repairPrompt(slots: readonly string[]) {
  const keep =
    'face, hair and clothes. Keep the position, pose, gestures, head direction and mouth movements. Do not change anyone else.';
  if (slots.length === 1)
    return `Replace ${SPOT[slots[0] as Seat]} with the person or animal in the image: ${keep}`;
  const images = slots.map((slot, i) => `image ${i + 1} is ${SPOT[slot as Seat]}`).join('; ');
  return `In order, ${images}. Replace each of these people with the person or animal in their image: ${keep}`;
}

const CLIP = 'assets/tinydesk/full-17s.mp4';

/**
 * Each photo first becomes a horizontal three-view strip (front, left and right profile); if prep is refused or fails, the original photo is used.
 * FACE_OCCLUSION is off by default and keeps every feature visible; when on, each view hides a different part and the video prompt asks to rebuild them.
 * Occlusion only suits people: eyes, nose and mouth boxes don't apply to animals.
 */
const PREP = [
  'Make a horizontal reference strip of the main person in this image, divided into three equal side-by-side panels of the same subject: left panel in left profile, middle panel facing straight on, right panel in right profile. Keep exactly the same individual in every panel: the same face and features, skin tone, age, hairstyle and facial hair, with natural skin texture. Head and shoulders, the face large and in focus in each panel.',
  FACE_OCCLUSION
    ? 'Draw one solid flat mid-grey (RGB 127,127,127) rectangle over part of the face in every panel, so no single panel shows a complete face: on the left panel cover the left eye and the mouth, leaving the nose and right eye visible; on the middle panel cover the nose and the mouth, leaving both eyes visible; on the right panel cover the right eye and the nose, leaving the mouth and left eye visible. Across the three panels both eyes, the nose and the mouth are each visible at least once.'
    : 'Keep the face fully visible in each view, with no boxes, masks or added occlusion.',
  'Only this one subject: remove any other people or animals and their arms or hands, phone status bars, app interface, captions, stickers and watermarks. Keep their own clothes, but plain, with no logos, letters, numbers or team marks. Plain light wall background, soft daylight, realistic photos, no text, labels or borders.',
].join(' ');

export default serverModels(catalog, {
  'tiny-desk': {
    upstream: 'yir',
    upstreamModel: 'klingai/kling-4.0',
    // Kling is quoted at $3.06 (billed as 18 s), capped at 3.40. A missed swap does not rerun Kling: Pruna repairs the missed shots, up to 5 rounds at 0.40 each.
    // Once Kling has charged, credits are not refunded: if someone is still missed after the repairs, the version with the fewest misses is delivered.
    // Prep costs $0.0085 per photo (capped at 0.02; a slow one gets a second copy, so 0.20 for 5 photos).
    // The job cap of 5.60 stays below the net per video of the cheapest pack (10 for $59.99, about 5.80 after fees), so even a fully repaired job breaks even.
    maxCost: '5.60',
    // Usually about 8 minutes (6 to generate, 2 for the face check and compose); each repair round adds a few minutes, plus room for upstream queues.
    timeoutMinutes: 45,
    effect: {
      slots: catalog
        .find((model) => model.id === 'tiny-desk')!
        .effect!.slots.map((slot) => ({ ...slot, prep: PREP })),
      prep: {
        upstreamModel: 'openai/gpt-image-2.5-sunburst',
        parameters: { resolution: '1K', aspect_ratio: '16:9' },
        maxCost: '0.02',
      },
      segments: [
        {
          id: 'full',
          referenceVideo: CLIP,
          slots: ['lead', 'sax', 'keys', 'backLeft', 'backRight'],
          prompt: editPrompt,
          // duration must be a whole number: the 17.688 s reference asks for 18 s, which comes back as 18.04 s with each cut 1–3 frames late; compose re-aligns shot by shot.
          // generate_audio can only be on with Yir; compose swaps the original song back in.
          parameters: { duration: 18, resolution: '720p', aspect_ratio: 'auto' },
          maxCost: '3.40',
          target: 17.688,
          cuts: [5.333, 11.625, 15.0],
          base: CLIP,
          // Original face centers, taken at the start of each one's shot (band 0 s, lead 5.4 s, sax 11.67 s).
          // Threshold 0.45: swapped faces score at most 0.28; the original person present scores 0.78–0.94, and a 2-second leftover side view of the original lead 0.52.
          check: {
            original: CLIP,
            faces: {
              keys: [0.395, 0.496, 0],
              backLeft: [0.073, 0.204, 0],
              backRight: [0.859, 0.224, 0],
              lead: [0.793, 0.323, 5.4],
              sax: [0.186, 0.287, 11.67],
            },
            maxSimilarity: 0.45,
          },
          // Missed people have only shown up in the wide shots (keys and the two backing singers, shots 1 and 4): first repair the whole frame with every uploaded photo in it.
          // The back-left singer sits in the top-left corner and a full-frame repair often skips them, so that 320×496 area is also cropped, repaired alone and feathered back in
          // (both tested jobs recovered; about 8 s and $0.25 per round). The lead and sax close-ups have never missed; they are configured just in case.
          repair: {
            upstreamModel: 'pruna/p-video-replace',
            prompt: repairPrompt,
            parameters: { resolution: '720p' },
            maxCost: '0.40',
            rounds: 5,
            onMiss: 'deliver',
            shots: [['keys', 'backLeft', 'backRight'], ['lead'], ['sax'], ['keys', 'backLeft', 'backRight']],
            crops: { backLeft: [0, 0, 0.444, 0.3875] },
            // Also repair a lead close-up that doesn't look like the photo: across six live jobs the lead scored 0.44–0.66 against the prepped photo;
            // the 0.44 one drew a "can't recognize him" complaint and scored 0.60 after a Pruna repair.
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
