import { validateGeneration } from '@yir-ai/sdk/shared';
import { expect, it } from 'vitest';
import type { SubmitInput } from '../src/upstream';
import { buildYirRequest } from '../src/yir';

it('validates a reference video and five four-view subjects with the installed SDK', () => {
  const references: SubmitInput['references'] = [
    { role: 'reference_video', url: 'https://example.com/scene.mp4' },
  ];
  for (const subject of ['Singer', 'Sax', 'Keys', 'Left', 'Right']) {
    for (let view = 0; view < 4; view++) {
      references.push({
        role: 'reference_image',
        url: `https://example.com/${subject}-${view}.jpg`,
        subject,
      });
    }
  }
  const request = buildYirRequest({
    kind: 'video',
    upstreamModel: 'klingai/kling-4.0',
    prompt: 'Edit @video_1 using the five named subjects.',
    references,
    parameters: { duration: 18, resolution: '720p', aspect_ratio: 'auto' },
    maxCost: '3.40',
  });
  expect(() => validateGeneration('generate_video', request)).not.toThrow();
});
