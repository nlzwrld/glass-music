import { useApp } from '../stores/app';

const attempted = new Set<string>();
let active = 0;

export function repairArtwork() {
  const state = useApp.getState();
  if (!state.data.preferences.onlineConsent || !state.data.preferences.onboardingDone) return;
  const pending = state.data.tracks.filter(
    t => !t.artwork && t.source !== 'local' && t.url && !attempted.has(t.id),
  );
  while (active < 5 && pending.length) {
    const track = pending.shift()!;
    attempted.add(track.id);
    active++;
    void window.glass
      .trackArtwork(track.id)
      .then(artwork => {
        if (!artwork) return;
        useApp.setState(s => ({
          data: {
            ...s.data,
            tracks: s.data.tracks.map(t => (t.id === track.id ? { ...t, artwork } : t)),
          },
          queue: s.queue.map(t => (t.id === track.id ? { ...t, artwork } : t)),
          preview: s.preview
            ? {
                ...s.preview,
                tracks: s.preview.tracks.map(t => (t.id === track.id ? { ...t, artwork } : t)),
              }
            : s.preview,
        }));
      })
      .catch(() => {})
      .finally(() => {
        active--;
        setTimeout(repairArtwork, 40);
      });
  }
}
