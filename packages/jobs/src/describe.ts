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

export interface WorkersAiConfig {
  accountId: string;
  /** An API token with Workers AI permission. */
  apiToken: string;
}

/**
 * Describe with Workers AI over its REST API (POST /accounts/{id}/ai/run/{model}). The request body is the one the Workers binding
 * took for this model (OpenAI-style messages with an image_url part), which the REST endpoint accepts as the model's input.
 */
export function workersAiDescribe(config: WorkersAiConfig, options: { fetcher?: typeof fetch } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/ai/run/${DESCRIBE_MODEL}`;
  return async (imageUrl: string, instruction: string): Promise<string> => {
    const image = await dataUrl(imageUrl, fetcher);
    const response = await fetcher(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
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
      }),
    });
    if (!response.ok) throw new Error(`describe failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { result?: { response?: unknown } };
    return typeof body.result?.response === 'string' ? body.result.response : '';
  };
}
