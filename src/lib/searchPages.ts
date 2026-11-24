import type { SearchResult } from '../../shared/types';

export function mergeSearchPages(
  previous: SearchResult,
  providers: string[],
  pages: PromiseSettledResult<SearchResult>[],
  formatError: (reason: unknown) => string,
): SearchResult {
  const next = { ...previous.next };
  const items = new Map(previous.items.map(track => [track.id, track]));
  const notices: string[] = [];
  pages.forEach((page, index) => {
    const provider = providers[index]!;
    if (page.status === 'rejected') {
      notices.push(`${provider}: ${formatError(page.reason)}`);
      return;
    }
    delete next[provider];
    Object.assign(next, page.value.next);
    for (const track of page.value.items) items.set(track.id, track);
    notices.push(...page.value.notices);
  });
  return { items: [...items.values()], next, notices };
}
