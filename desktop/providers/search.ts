import type { MusicProvider, SearchRequest, SearchResult } from '../../shared/types';
import { trackSchema } from '../../shared/validation';
export class SearchService {
  private cache = new Map<string, { time: number; value: SearchResult }>();
  private active = new Map<string, AbortController>();
  constructor(private providers: MusicProvider[]) {}
  clear() { this.cache.clear(); this.active.forEach(c => c.abort()); this.active.clear(); }
  cancel(id: string) { this.active.get(id)?.abort(); this.active.delete(id); }
  async search(r: SearchRequest): Promise<SearchResult> {
    const key = JSON.stringify([r.query.toLowerCase(), r.kind, r.source, r.cursor]); const cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < 300000) return cached.value;
    const controller = new AbortController(); this.active.set(r.requestId, controller);
    try {
      const selected = this.providers.filter(p => r.source === 'all' || p.id === r.source);
      const results = await Promise.allSettled(selected.map(p => p.search(r, controller.signal)));
      if (controller.signal.aborted) throw new Error('Pesquisa cancelada.');
      const value: SearchResult = { items: [], next: {}, notices: [] };
      results.forEach((result, i) => { if (result.status === 'fulfilled') { const valid = result.value.items.flatMap(item => { const parsed = trackSchema.safeParse(item); return parsed.success ? [parsed.data] : []; }); value.items.push(...valid); if (result.value.next) value.next[selected[i].id] = result.value.next; } else value.notices.push(`${selected[i].id === 'youtube' ? 'YouTube' : 'SoundCloud'}: ${result.reason.message}`); });
      // Interleave sources, retaining original identity and attribution.
      value.items.sort((a,b) => { const ai = results.flatMap(x => x.status === 'fulfilled' ? x.value.items : []).findIndex(x => x.id === a.id); const bi = results.flatMap(x => x.status === 'fulfilled' ? x.value.items : []).findIndex(x => x.id === b.id); return (ai % 20) - (bi % 20); });
      value.items = [...new Map(value.items.map(t => [t.id, t])).values()];
      if (!value.notices.length) { if (this.cache.size >= 80) this.cache.delete(this.cache.keys().next().value!); this.cache.set(key, { time: Date.now(), value }); }
      return value;
    } finally { this.active.delete(r.requestId); }
  }
}
