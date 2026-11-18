import { invoke } from '@tauri-apps/api/core';
import type { CatalogResult } from '../../shared/types';
import type { LanJamAnnouncement } from '../../shared/jam';

const key = 'glass:discover:v2';
const freshFor = 15 * 60_000,
  keepFor = 7 * 24 * 60 * 60_000;
let cached: { at: number; value: CatalogResult } | undefined;
let pending: { id: string; promise: Promise<CatalogResult> } | undefined;

export function cachedDiscoveries(): CatalogResult | undefined {
  if (cached) return cached.value;
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 500_000) return;
    const entry = JSON.parse(raw);
    if (
      typeof entry.at !== 'number' ||
      entry.at > Date.now() + 60_000 ||
      Date.now() - entry.at > keepFor ||
      !Array.isArray(entry.value?.sections)
    )
      return;
    const sections = entry.value.sections;
    if (
      sections.length > 6 ||
      sections.some(
        (s: { source: string; items: unknown[] }) =>
          !['youtube', 'soundcloud', 'deezer'].includes(s.source) ||
          !Array.isArray(s.items) ||
          s.items.length > 60,
      )
    )
      return;
    cached = { at: entry.at, value: { sections, notices: [] } };
    return cached.value;
  } catch {
    return;
  }
}

export function discoverMusic(force = false): Promise<CatalogResult> {
  cachedDiscoveries();
  if (!force && cached && Date.now() - cached.at < freshFor) return Promise.resolve(cached.value);
  if (pending) return pending.promise;
  const id = crypto.randomUUID();
  const promise = window.glass
    .discover(id)
    .then(value => {
      if (value.sections.length) {
        cached = { at: Date.now(), value: { ...value, notices: [] } };
        try {
          localStorage.setItem(key, JSON.stringify(cached));
        } catch {
          /* Storage can be disabled; memory caching still works. */
        }
      }
      return value;
    })
    .finally(() => {
      if (pending?.id === id) pending = undefined;
    });
  pending = { id, promise };
  return promise;
}

export function cancelDiscoveries() {
  if (pending) {
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
