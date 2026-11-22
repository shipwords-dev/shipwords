import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';

describe('createDb', () => {
  it('reports a dropped idle connection instead of crashing the process', () => {
    const seen: Error[] = [];
    const db = createDb('postgres://nobody@127.0.0.1:1/none', {}, (error) => seen.push(error));
    const pool = (db as unknown as { $client: { emit(event: string, error: Error): boolean } }).$client;
    expect(() => pool.emit('error', new Error('connection terminated'))).not.toThrow();
    expect(seen.map((error) => error.message)).toEqual(['connection terminated']);
  });
});
