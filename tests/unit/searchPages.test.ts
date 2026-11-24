import { expect, it } from 'vitest';
import { mergeSearchPages } from '../../src/lib/searchPages';
import type { SearchResult } from '../../shared/types';

it('preserves the failed cursor and consumes successful providers independently', () => {
  const previous: SearchResult = { items: [], next: { apple: 'a1', deezer: 'd1' }, notices: [] };
  const page: SearchResult = { items: [], next: {}, notices: ['fim'] };
  const result = mergeSearchPages(previous, ['apple', 'deezer'], [
    { status: 'rejected', reason: 'offline' },
    { status: 'fulfilled', value: page },
  ], String);
  expect(result.next).toEqual({ apple: 'a1' });
  expect(result.notices).toEqual(['apple: offline', 'fim']);
  expect(previous.next).toEqual({ apple: 'a1', deezer: 'd1' });
});
