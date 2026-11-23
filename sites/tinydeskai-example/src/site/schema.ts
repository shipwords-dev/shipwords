// Tables owned by this site. Avoid them: anything that fits in packages goes there; only data unique to this site lives here.
import { nowMs } from '@shipwords/core/db/schema';
import { bigint, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

const ms = (name: string) => bigint(name, { mode: 'number' });

/** Pairing codes for phone uploads by QR code: desktop opens one, and the phone registers photos into it within 30 minutes. */
export const handoffs = pgTable('handoffs', {
  token: text('token').primaryKey(),
  createdAt: ms('created_at').notNull().default(nowMs),
});

/** Photo paths (/files/uploads/...) the phone registered under a code, read in registration order. */
export const handoffItems = pgTable(
  'handoff_items',
  {
    token: text('token')
      .notNull()
      .references(() => handoffs.token, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    createdAt: ms('created_at').notNull().default(nowMs),
  },
  (t) => [primaryKey({ columns: [t.token, t.path] })],
);
