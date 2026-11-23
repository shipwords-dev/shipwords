import { llmsTxt } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import { GUIDES } from '~/site/guide';
import site from '../../site.config';

export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: () =>
        llmsTxt(
          site,
          `Tiny Desk AI makes the viral "Outstanding" Tiny Desk AI video: the end of Charlie Wilson's 2023 NPR Tiny Desk performance of The Gap Band's "Outstanding", as cut on TikTok (band, big laugh close-up, sax solo, band again). Swap any 1 to 5 band members (lead vocals, sax, keys, two backing singers) for anyone (this week's losing coaches, players, celebrities, friends or yourself): the stage starts with five dogs; tap a dog and add one photo per person. Dogs you leave alone stay in the video; remove a dog to keep the coach from the viral video. Output: an about 18-second vertical 9:16 MP4 at 720p with the original song plus a silent copy, no watermark, rendered with Kuaishou Kling 4.0 in edit mode in about 7 to 10 minutes. Price: $9.98 per video for 1 to 5 people; packs of 3 for $24.99 and 10 for $59.99; one-time payment, credits never expire, failed videos refund automatically; no free renders. Sign in with Google or email before paying. Photos leave the site within 2 days; a private copy stays with the order until the customer asks to delete it. Independent fan tool for parody videos, not affiliated with NPR, Tiny Desk Concerts, Charlie Wilson or The Gap Band.`,
          [
            {
              title: 'Tiny Desk AI video generator',
              path: '/',
              description:
                'Swap any 1 to 5 band members in the Outstanding Tiny Desk video; pricing (1 video $9.98, 3 for $24.99, 10 for $59.99, same price for 1 to 5 people); FAQ.',
            },
            ...GUIDES.map((guide) => ({ ...guide, title: guide.title(), description: guide.description() })),
            {
              title: 'Refund policy',
              path: '/refunds',
              description: 'Failed videos refund their credits automatically; unused packs within 14 days.',
            },
            {
              title: 'Privacy policy',
              path: '/privacy',
              description:
                'Uploaded photos leave the site within 2 days; a private copy stays with the order for support until the customer asks to delete it.',
            },
            {
              title: 'DMCA and takedown',
              path: '/dmca',
              description: 'How to ask us to remove a video or material.',
            },
          ],
        ),
    },
  },
});
