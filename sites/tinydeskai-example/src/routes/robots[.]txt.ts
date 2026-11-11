import { robotsTxt } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import site from '../../site.config';

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: { GET: () => robotsTxt(site, ['/api/', '/account', '/billing/', '/phone/']) },
  },
});
