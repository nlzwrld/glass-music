import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaults, type Track } from '../../shared/types';
import { opticalDefaults } from '../../src/components/glass/v3/model';
import { resolveLiquidHubExe } from './exe';

const active = (p: Page) => p.locator('audio[data-active="true"]');

test('real playback latency, crossfade, offline download, detached lyrics and two-client LAN JAM', async () => {
  test.setTimeout(210000);
  await mkdir('.test-data/profiles', { recursive: true });
  await mkdir('test-results', { recursive: true });
  const profile = await mkdtemp(resolve('.test-data/profiles/features-220-')),
    db = new DatabaseSync(join(profile, 'library.sqlite'));
  db.exec(
    'CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE playlists(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE playlist_tracks(playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,position INTEGER NOT NULL,PRIMARY KEY(playlist_id,track_id));',
  );
  const local: Track[] = ['A validação', 'B validação'].map((title, i) => ({
    id: 'local:feature' + i,
    source: 'local',
    sourceId: 'feature' + i,
    kind: 'track',
    title,
    artist: 'Teste local',
    duration: 20,
    addedAt: Date.now(),
  }));
  const remote: Track = {
    id: 'youtube:dQw4w9WgXcQ',
    source: 'youtube',
    sourceId: 'dQw4w9WgXcQ',
    kind: 'track',
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley',
    duration: 213,
    artwork: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    addedAt: Date.now(),
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  };
  for (const t of [...local, remote]) {
    db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(
      t.id,
      JSON.stringify(t),
      t.source === 'local' ? resolve('assets/audio/prisma.wav') : null,
      Date.now(),
    );
  }
  db.prepare('INSERT INTO playlists VALUES(?,?,?)').run('my-list', 'Minha coleção', Date.now());
  local.forEach((t, i) =>
    db.prepare('INSERT INTO playlist_tracks VALUES(?,?,?)').run('my-list', t.id, i),
  );
  db.prepare('INSERT INTO settings VALUES(?,?)').run(
    'preferences',
    JSON.stringify({
      ...defaults,
      onboardingDone: true,
      onlineConsent: true,
      catalogConsent: true,
      autoUpdate: false,
      volume: 0,
      reducedMotion: true,
      appearance: { ...opticalDefaults, background: 'solid', backgroundMotion: 0 },
    }),
  );
  db.close();

  const proc = spawn(resolveLiquidHubExe(), [], {
    windowsHide: true,
    env: {
      ...process.env,
      GLASS_TEST_DATA: profile,
      WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9385',
    },
  });
  let browser: Browser | undefined;
  const errors: string[] = [],
    report: any = {};

  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch('http://127.0.0.1:9385/json/version')).ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:9385');
    const page = browser.contexts()[0].pages()[0];
    page.on('pageerror', e => errors.push(e.message));

    await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    await expect(page.getByRole('button', { name: /Minha coleção/ }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Configurações', exact: true }).click();
    await page.getByRole('slider', { name: 'Volume booster', exact: true }).fill('6');
    await page.getByRole('button', { name: 'Graves', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Dispositivo de saída', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Transição entre músicas', exact: true }).selectOption('crossfade');
    await page.getByRole('slider', { name: 'Duração da transição', exact: true }).fill('2');
    report.audioSettings = true;

    await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    await page.getByRole('button', { name: /Minha coleção/ }).first().click();
    await page.getByRole('button', { name: 'Reproduzir playlist', exact: true }).click();
    await expect.poll(() => active(page).evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.1);

    const duration = await active(page).evaluate((a: HTMLAudioElement) => a.duration);
    await page.getByRole('slider', { name: 'Posição da música', exact: true }).fill(String(duration - 1.6));
    await expect
      .poll(
        () =>
          page
            .locator('audio')
            .evaluateAll((all: HTMLAudioElement[]) => all.filter(a => !a.paused && a.currentTime > 0).length),
        { intervals: [50, 100, 150] },
      )
      .toBe(2);
    await expect(page.locator('.now-playing')).toContainText('B validação');
    report.crossfadeOverlappingDecks = true;
    await page.locator('footer.player').getByRole('button', { name: 'Pausar', exact: true }).click();

    await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    const cold = Date.now();
    await page.getByRole('button', { name: 'Reproduzir ' + remote.title, exact: true }).click();
    await expect
      .poll(() => active(page).evaluate((a: HTMLAudioElement) => a.currentTime), {
        timeout: 45000,
        intervals: [100, 150, 250],
      })
      .toBeGreaterThan(0.1);
    report.coldAudioMs = Date.now() - cold;

    await expect(page.locator('footer.player').getByRole('button', { name: 'Letras', exact: true })).toBeVisible({
      timeout: 20000,
    });
    await page.locator('footer.player').getByRole('button', { name: 'Mini-player', exact: true }).click();
    await page.locator('footer.player').getByRole('button', { name: 'Letras', exact: true }).click();
    await expect.poll(() => browser!.contexts()[0].pages().length).toBe(2);
    const lyrics = browser.contexts()[0].pages().find(p => p !== page)!;
    await expect(lyrics.locator('.detached-lyrics .lyrics-panel')).toBeVisible();
    await expect(lyrics.locator('.lyrics-lines button')).not.toHaveCount(0, { timeout: 20000 });
    await lyrics.getByRole('button', { name: 'Fechar letras', exact: true }).click();
    await page.locator('footer.player').getByRole('button', { name: 'Sair do mini-player', exact: true }).click();
    report.detachedLyrics = { separateWindow: true };

    const download = Date.now();
    const saved = await page.evaluate(t => window.glass.downloadOffline(t), remote);
    expect(saved.tracks.find(t => t.id === remote.id)?.offline).toBe(true);
    report.downloadMs = Date.now() - download;

    const invoke = async (payload: any) =>
      page.evaluate(p => (window as any).__TAURI_INTERNALS__.invoke('call', { action: 'jam', payload: p }), payload);
    const host: any = await invoke({ action: 'createLocal', name: 'Anfitrião' });
    const guest: any = await invoke({ action: 'join', name: 'Amigo', code: host.code, endpoint: host.endpoint });
    await invoke({
      action: 'sync',
      code: host.code,
      token: host.token,
      endpoint: host.endpoint,
      playback: { track: remote, playing: true, position: 12 },
    });
    const polled: any = await invoke({
      action: 'poll',
      code: host.code,
      token: guest.token,
      endpoint: host.endpoint,
    });
    expect(polled.playback.track.id).toBe(remote.id);
    expect(polled.playback.position).toBe(12);
    expect(polled.members).toHaveLength(2);
    await invoke({ action: 'leave', code: host.code, token: host.token, endpoint: host.endpoint });
    report.nativeLanJam = { twoIndependentSessions: true, transport: true, hostState: true };

    await page.getByRole('button', { name: 'Configurações', exact: true }).click();
    await page.getByRole('textbox', { name: 'Seu nome na JAM', exact: true }).fill('Validação');
    await page.getByRole('button', { name: 'Criar na rede local', exact: true }).click();
    await expect(page.locator('.jam-room-code strong')).toBeVisible();
    await page.getByRole('button', { name: 'Encerrar JAM', exact: true }).click();
    report.jamUI = true;

    await page.screenshot({ path: 'test-results/features-220-settings.png' });
    expect(errors).toEqual([]);
    report.errors = errors;
    await writeFile('test-results/features-220.json', JSON.stringify(report, null, 2));
  } finally {
    proc.kill();
    await browser?.close().catch(() => {});
  }
});
