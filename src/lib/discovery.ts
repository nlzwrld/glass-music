import { invoke } from '@tauri-apps/api/core';
import type { CatalogResult, DiscoveryCacheEntry } from '../../shared/types';
import type { LanJamAnnouncement } from '../../shared/jam';

const key = 'glass:discover:v2';
const DISCOVER_CACHE_KEY = 'catalog-discover-v2';
const freshFor = 15 * 60_000,
  keepFor = 7 * 24 * 60 * 60_000;
let cached: { at: number; value: CatalogResult } | undefined;
let pending: { id: string; seq: number; promise: Promise<CatalogResult> } | undefined;
let discoverSeq = 0;

function validCatalogSections(sections: unknown): sections is CatalogResult['sections'] {
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > 6) return false;
  return !sections.some(
    (s: { source: string; items: unknown[] }) =>
      !['youtube', 'soundcloud', 'deezer'].includes(s.source) ||
      !Array.isArray(s.items) ||
      s.items.length > 60,
  );
}

export function cachedDiscoveries(): CatalogResult | undefined {
  if (cached) return cached.value;
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 500_000) return;
    const entry = JSON.parse(raw);
    if (
      typeof entry.at !== 'number' ||
      entry.at > Date.now() + 60_000 ||
      Date.now() - entry.at > keepFor ||
      !validCatalogSections(entry.value?.sections)
    )
      return;
    cached = { at: entry.at, value: { sections: entry.value.sections, notices: [] } };
    return cached.value;
  } catch {
    return;
  }
}

export function discoverMusicState(): { hasCache: boolean; fresh: boolean; at?: number } {
  cachedDiscoveries();
  if (!cached) return { hasCache: false, fresh: false };
  return {
    hasCache: true,
    fresh: Date.now() - cached.at < freshFor,
    at: cached.at,
  };
}

export async function hydrateDiscoveries(): Promise<{
  value: CatalogResult;
  fresh: boolean;
  at: number;
} | null> {
  cachedDiscoveries();
  if (cached) {
    return {
      value: cached.value,
      fresh: Date.now() - cached.at < freshFor,
      at: cached.at,
    };
  }
  if (typeof window !== 'undefined' && typeof window.glass?.cacheGet === 'function') {
    try {
      const dbEntry = (await window.glass.cacheGet<CatalogResult>(
        DISCOVER_CACHE_KEY,
      )) as DiscoveryCacheEntry<CatalogResult> | null;
      if (
        dbEntry &&
        typeof dbEntry.updatedAt === 'number' &&
        Date.now() - dbEntry.updatedAt <= keepFor &&
        validCatalogSections(dbEntry.payload?.sections)
      ) {
        const normalized: CatalogResult = {
          sections: dbEntry.payload.sections,
          notices: [],
        };
        cached = { at: dbEntry.updatedAt, value: normalized };
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(key, JSON.stringify(cached));
          }
        } catch {}
        return {
          value: normalized,
          fresh: Date.now() - dbEntry.updatedAt < freshFor,
          at: dbEntry.updatedAt,
        };
      }
    } catch {
      // Fallback safely to network discovery
    }
  }
  return null;
}

export function clearDiscoveryCache(): void {
  discoverSeq++;
  cached = undefined;
  if (pending) {
    void window.glass?.cancelSearch?.(pending.id);
    pending = undefined;
  }
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {}
}

export function discoverMusic(force = false): Promise<CatalogResult> {
  cachedDiscoveries();
  if (!force && cached && Date.now() - cached.at < freshFor) return Promise.resolve(cached.value);
  if (!force && pending) return pending.promise;
  if (force && pending) {
    void window.glass?.cancelSearch?.(pending.id);
    pending = undefined;
  }
  const id = crypto.randomUUID();
  const seq = ++discoverSeq;
  const promise = window.glass
    .discover(id)
    .then(value => {
      if (seq !== discoverSeq) {
        return cached?.value ?? value;
      }
      if (value.sections.length) {
        const at = Date.now();
        cached = { at, value: { ...value, notices: [] } };
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(key, JSON.stringify(cached));
          }
        } catch {
          /* Storage can be disabled; memory caching still works. */
        }
        if (typeof window.glass?.cacheSet === 'function') {
          void window.glass
            .cacheSet({
              key: DISCOVER_CACHE_KEY,
              signature: 'catalog-discover-v2',
              payload: cached.value,
              ttlMs: freshFor,
            })
            .catch(() => {});
        }
      }
      return value;
    })
    .finally(() => {
      if (pending?.id === id) pending = undefined;
    });
  pending = { id, seq, promise };
  return promise;
}

export function cancelDiscoveries() {
  if (pending) {
    discoverSeq++;
    void window.glass.cancelSearch(pending.id);
    pending = undefined;
  }
}

/** Discovers active LAN JAM rooms via native UDP broadcast/loopback beacon (`jam_lan.rs`). */
export async function discoverLanJamRooms(targetCode?: string): Promise<LanJamAnnouncement[]> {
  try {
    const res = await invoke<{ rooms?: LanJamAnnouncement[] }>('call', {
      action: 'jam',
      payload: { action: 'discoverLan' },
    });
    const list = Array.isArray(res?.rooms) ? res.rooms : [];
    if (!targetCode) return list;
    const upper = targetCode.toUpperCase();
    return list.filter(r => r.code?.toUpperCase() === upper);
  } catch {
    return [];
  }
}
