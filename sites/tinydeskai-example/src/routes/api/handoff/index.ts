import { createFileRoute } from '@tanstack/react-router';
import { handoffApi } from '~/core.server';

export const Route = createFileRoute('/api/handoff/')({
  server: { handlers: { POST: () => handoffApi.create() } },
});
