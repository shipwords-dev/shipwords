import { Container } from '@cloudflare/containers';
import { proxyRybbit } from '@shipwords/core/analytics';
import { defineGenerationWorkflow } from '@shipwords/jobs/workflow';
import handler from '@tanstack/react-start/server-entry';
import { serveVideo, VIDEO_PATH } from '~/lib/video-range';
import { paraglideMiddleware } from '~/paraglide/server.js';
import site from '../site.config';
import models from './models.server';

// Worker entry: pages and API go to TanStack Start; also exports the generation Workflow class and the compose container.
export const GenerationWorkflow = defineGenerationWorkflow(models, site);

/**
 * Effect video compositing (ffmpeg); the image is in packages/jobs/compose. One instance per jobId.
 * The container process stops itself: it exits after 60 s idle or 10 minutes after start (server.mjs), without relying on sleepAfter here.
 */
export class ComposeContainer extends Container {
  override defaultPort = 8080;
  override sleepAfter = '5m';

  override async onActivityExpired() {
    // The SDK invokes this only after in-flight requests finish. Old images may
    // ignore SIGTERM as PID 1, so release the VM instead of only sending a signal.
    await this.destroy();
    console.log('Compose container destroyed after idle timeout');
  }

  // biome-ignore lint/complexity/noBannedTypes: matches the Container base class constructor signature
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // The account only allows durable_object scheduling, which needs image and instance type in start(); @cloudflare/containers 0.3.7 omits them.
    // Local dev runs no containers (images is absent), so leave it as is.
    const container = ctx.container as
      | (NonNullable<DurableObjectState['container']> & { images?: Record<string, unknown> })
      | undefined;
    if (!container?.images) return;
    const start = container.start.bind(container);
    container.start = (options) =>
      start({ ...options, image: container.images?.compose, instance: 'standard-3' } as never);
  }
}

export default {
  async fetch(request, env) {
    // run_worker_first sends all of /media to the Worker: videos get range slices (206), posters come from static assets as usual.
    const url = new URL(request.url);
    if (url.pathname.startsWith('/media/')) {
      return VIDEO_PATH.test(url.pathname) && ['GET', 'HEAD'].includes(request.method)
        ? serveVideo(request, env.STATIC)
        : env.STATIC.fetch(request);
    }
    // Rybbit analytics go through this site's /stats/ and are forwarded from here to the collector.
    const stats = await proxyRybbit(request, env.RYBBIT_UPSTREAM);
    if (stats) return stats;
    // Only local dev picks the locale from a cookie (Chinese review); production is English only, so requests go straight to TanStack Start.
    return import.meta.env.DEV
      ? paraglideMiddleware(request, () => handler.fetch(request))
      : handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
