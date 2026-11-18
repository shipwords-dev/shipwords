import { fileURLToPath } from 'node:url';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds write Paraglide output to their own dir, not src/paraglide: that one belongs to the dev server and typecheck,
// and overwriting it with en-only output during check makes a running dev server recompile and lose the zh toggle.
const PARAGLIDE_BUILD = fileURLToPath(new URL('./node_modules/.paraglide', import.meta.url));

export default defineConfig(({ command }) => ({
  resolve: {
    alias: [
      ...(command === 'serve' ? [] : [{ find: /^~\/paraglide\//, replacement: `${PARAGLIDE_BUILD}/` }]),
      { find: '~', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  // Pin IPv4: when only ::1 is bound, browsers that go through a proxy or prefer IPv4 get refused on localhost.
  // Fail if the port is taken instead of silently switching: APP_URL and the Google sign-in origin are registered for dev-port's fixed port.
  server: { host: '127.0.0.1', port: Number(process.env.PORT) || 5173, strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
  plugins: [
    // i18n via Paraglide. Production is English only: builds use the en-only project.en.inlang, so zh messages stay out of the bundle;
    // local dev uses project.inlang with zh, switched by cookie; the dev toggle switches to Chinese for review.
    paraglideVitePlugin(
      command === 'serve'
        ? { project: './project.inlang', outdir: './src/paraglide', strategy: ['cookie', 'baseLocale'] }
        : { project: './project.en.inlang', outdir: PARAGLIDE_BUILD, strategy: ['baseLocale'] },
    ),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
}));
