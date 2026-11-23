import { fileURLToPath } from 'node:url';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Build output for Paraglide lives in its own folder, not src/paraglide: that one belongs to the dev server and typecheck.
// Overwriting it with English only during check would make a running dev server recompile and break the Chinese toggle.
const PARAGLIDE_BUILD = fileURLToPath(new URL('./node_modules/.paraglide', import.meta.url));

export default defineConfig(({ command }) => ({
  resolve: {
    alias: [
      ...(command === 'serve' ? [] : [{ find: /^~\/paraglide\//, replacement: `${PARAGLIDE_BUILD}/` }]),
      { find: '~', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  // Pin IPv4: when only ::1 is bound, browsers behind a proxy or preferring IPv4 get refused on localhost.
  // Fail if the port is taken instead of silently switching: APP_URL and the Google sign-in origin use the fixed dev port.
  server: { host: '127.0.0.1', port: Number(process.env.PORT) || 5173, strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
  plugins: [
    // i18n uses Paraglide. Production ships English only: the build uses project.en.inlang (en only), so no Chinese messages;
    // local dev uses project.inlang with zh, switched by cookie, and the dev toggle in the header switches to Chinese for review.
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
