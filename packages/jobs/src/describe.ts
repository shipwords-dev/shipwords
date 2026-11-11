// Describe a person in a prep image with a Workers AI vision model (effect.describe → RunnerDeps.describe). The answer goes into the
// video prompt after the person's image name, so the model can tell apart people who look or dress alike.

/** A vision model on Workers AI that takes an image in an OpenAI-style message; cheap enough to run per person per job. */
export const DESCRIBE_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/** The image as a data URL: the model can't fetch URLs itself. */
async function dataUrl(url: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`image ${response.status}`);
  const type = response.headers.get('content-type')?.split(';')[0] || 'image/png';
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

export function workersAiDescribe(ai: Ai, options: { fetcher?: typeof fetch } = {}) {
  const fetcher = options.fetcher ?? fetch;
  return async (imageUrl: string, instruction: string): Promise<string> => {
    const image = await dataUrl(imageUrl, fetcher);
    const result = (await ai.run(
      DESCRIBE_MODEL as never,
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
        max_tokens: 80,
      } as never,
    )) as { response?: unknown };
    return typeof result?.response === 'string' ? result.response : '';
  };
}
