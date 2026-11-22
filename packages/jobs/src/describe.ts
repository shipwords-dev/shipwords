// Describe a person in a prep image with a vision model (effect.describe → RunnerDeps.describe): a model on the AI Gateway when the
// site names one and the runtime has a gateway key, otherwise Workers AI. The answer goes into the video prompt after the person's
// image name, so the model can tell apart people who look or dress alike.

/** A vision model on Workers AI that takes an image in an OpenAI-style message; cheap enough to run per person per job. */
export const DESCRIBE_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/** One budget for downloading the image and asking the model, so an optional description can't hold up the job for long. */
const DESCRIBE_TIMEOUT_MS = 60_000;

/** The image as a data URL: the model can't fetch URLs itself. */
async function dataUrl(url: string, fetcher: typeof fetch, signal: AbortSignal): Promise<string> {
  const response = await fetcher(url, { signal });
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
    const signal = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS);
    const image = await dataUrl(imageUrl, fetcher, signal);
    const response = await fetcher(url, {
      method: 'POST',
      signal,
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
    if (!response.ok) throw new Error(`describe failed: ${response.status}${await errorCode(response)}`);
    const body = (await response.json()) as { result?: { response?: unknown } };
    return typeof body.result?.response === 'string' ? body.result.response : '';
  };
}

/**
 * The error code of a failed response, never its body or message: those can echo the request (the image, the instruction) into
 * the logs.
 */
async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; type?: unknown };
      errors?: { code?: unknown }[];
    };
    const code = body.error?.code ?? body.error?.type ?? body.errors?.[0]?.code;
    return typeof code === 'string' || typeof code === 'number' ? ` ${String(code).slice(0, 60)}` : '';
  } catch {
    return '';
  }
}

/** Vercel AI Gateway, OpenAI-compatible endpoint. */
export const AI_GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1';

export interface AiGatewayConfig {
  apiKey: string;
  /** Defaults to AI_GATEWAY_URL. */
  baseURL?: string;
}

/**
 * Describe with a vision model on the AI Gateway (chat completions, the image inlined as a data URL). The model comes from the site's
 * effect.describe.model, so the instruction and the model it was tuned for live together in the site's server config.
 */
export function aiGatewayDescribe(config: AiGatewayConfig, options: { fetcher?: typeof fetch } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const url = `${(config.baseURL ?? AI_GATEWAY_URL).replace(/\/$/, '')}/chat/completions`;
  return async (imageUrl: string, instruction: string, model?: string): Promise<string> => {
    if (!model) throw new Error('describe: no AI Gateway model (effect.describe.model)');
    const signal = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS);
    const image = await dataUrl(imageUrl, fetcher, signal);
    const response = await fetcher(url, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
        // A 20-word phrase is ~30 tokens; room for a reasoning model that thinks a little first.
        max_tokens: 300,
      }),
    });
    if (!response.ok) throw new Error(`describe failed: ${response.status}${await errorCode(response)}`);
    const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const text = body.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : '';
  };
}

type Describe = (imageUrl: string, instruction: string, model?: string) => Promise<string>;

/**
 * The describer a runtime gets: the AI Gateway for a site that names a model (when there is a gateway key), Workers AI otherwise
 * (when there are Cloudflare credentials). Undefined when neither is configured, so descriptions are left out.
 */
export function chooseDescribe(
  gateway: Describe | undefined,
  workersAi: Describe | undefined,
): Describe | undefined {
  if (!gateway && !workersAi) return undefined;
  return async (imageUrl, instruction, model) => {
    if (model && gateway) return gateway(imageUrl, instruction, model);
    if (workersAi) return workersAi(imageUrl, instruction);
    throw new Error(
      model ? "describe: no AI_GATEWAY_API_KEY for the site's model" : 'describe: no Workers AI credentials',
    );
  };
}
