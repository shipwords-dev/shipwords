import { createFileRoute } from '@tanstack/react-router';
import { handoffApi } from '~/core.server';

export const Route = createFileRoute('/api/handoff/$token')({
  server: {
    handlers: {
      GET: ({ params }) => handoffApi.read(params.token),
      POST: ({ request, params }) => handoffApi.add(request, params.token),
    },
  },
});
