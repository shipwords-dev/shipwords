import { createServerFn } from '@tanstack/react-start';

// Public config the browser needs (reCAPTCHA site key, Google client ID). Values come from the server's environment (.env), not baked into the build.
export const getPublicConfig = createServerFn({ method: 'GET' }).handler(async () => {
  const { core } = await import('~/core.server');
  const env = core.env;
  return {
    recaptchaSiteKey: env.RECAPTCHA_SITE_KEY || null,
    googleClientId: env.GOOGLE_CLIENT_ID || null,
  };
});
