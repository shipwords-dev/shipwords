import { Container } from '@cloudflare/containers';
import { proxyRybbit } from '@shipwords/core/analytics';
import { defineGenerationWorkflow } from '@shipwords/jobs/workflow';
import handler from '@tanstack/react-start/server-entry';
import { serveVideo, VIDEO_PATH } from '~/lib/video-range';
import { paraglideMiddleware } from '~/paraglide/server.js';
import site from '../site.config';
import models from './models.server';

// Worker 入口：页面和 API 交给 TanStack Start，另外导出生成任务的 Workflow 类和拼接容器。
export const GenerationWorkflow = defineGenerationWorkflow(models, site);

/**
 * 特效成片拼接（ffmpeg），镜像在 packages/jobs/compose；按 jobId 取实例。
 * 停机靠容器进程自己：空闲 60 秒或启动满 10 分钟就退出（server.mjs），不依赖这里的 sleepAfter。
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

  // biome-ignore lint/complexity/noBannedTypes: 与 Container 基类构造函数签名一致
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // 账号只能用 durable_object 调度：镜像和规格要在 start() 时指定，@cloudflare/containers 0.3.7 不传，这里补上。
    // 本地 dev 不开容器（images 不存在），保持原样。
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
    // run_worker_first 把 /media 整个目录交给 Worker：视频切片（206），封面照常从静态资源取。
    const url = new URL(request.url);
    if (url.pathname.startsWith('/media/')) {
      return VIDEO_PATH.test(url.pathname) && ['GET', 'HEAD'].includes(request.method)
        ? serveVideo(request, env.STATIC)
        : env.STATIC.fetch(request);
    }
    // Rybbit 统计走本站 /stats/，由这里转发到采集地址。
    const stats = await proxyRybbit(request, env.RYBBIT_UPSTREAM);
    if (stats) return stats;
    // 本地 dev 才按 cookie 取语言（中文审稿）；线上只有英文，请求原样交给 TanStack Start。
    return import.meta.env.DEV
      ? paraglideMiddleware(request, () => handler.fetch(request))
      : handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
