import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBroker } from '../../server/broker';
import { defaults, type Track } from '../../shared/types';
import { opticalDefaults } from '../../src/components/glass/v3/model';
import { resolveLiquidHubExe } from './exe';

const activeAudio = (p: Page) => p.locator('audio[data-active="true"]');

test('Liquid Hub rebranding, Zero-Trust PKCE+Ed25519+DPAPI login, Shuffle Play and conditional Lyrics UI', async () => {
  test.setTimeout(120000);
  await mkdir('../../work/profiles', { recursive: true });
  await mkdir('test-results', { recursive: true });

  // Start an in-process Zero-Trust Hub Broker on loopback for real desktop E2E authentication
  const brokerServer = createBroker({
    BROKER_ACCESS_TOKEN: 'e2e-static-owner-broker-token-1234567890',
    SOUNDCLOUD_CLIENT_ID: 'e2e-client',
    SOUNDCLOUD_CLIENT_SECRET: 'e2e-secret',
  });
  await new Promise<void>(r => brokerServer.listen(0, '127.0.0.1', r));
  const brokerPort = (brokerServer.address() as { port: number }).port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  const profile = await mkdtemp(resolve('../../work/profiles/liquid-hub-220-'));
  const db = new DatabaseSync(join(profile, 'library.sqlite'));
  db.exec(
    'CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE offline_tracks(track_id TEXT PRIMARY KEY REFERENCES tracks(id),path TEXT NOT NULL,size INTEGER NOT NULL,duration REAL NOT NULL,created INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE playlists(id TEXT PRIMARY KEY,name TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE playlist_tracks(playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,position INTEGER NOT NULL,PRIMARY KEY(playlist_id,track_id));',
  );

  const wavPath = resolve('assets/audio/prisma.wav');
  await mkdir(join(profile, 'offline'), { recursive: true });
  const offlineWavPath = join(profile, 'offline', 'fixture.wav');
  await copyFile(wavPath, offlineWavPath);
  const lyriclessTrack: Track = {
    id: 'local:no-lyrics',
    source: 'local',
    sourceId: 'no-lyrics',
    kind: 'track',
    title: 'Faixa Instrumental Sem Letra',
    artist: 'Liquid Hub Lab',
    duration: 20,
    addedAt: Date.now(),
  };
  const lyricTrack: Track = {
    id: 'local:with-lyrics',
    source: 'local',
    sourceId: 'with-lyrics',
    kind: 'track',
    title: 'Faixa Com Letra Sincronizada',
    artist: 'Liquid Hub Lab',
    duration: 20,
    addedAt: Date.now(),
  };
  const thirdTrack: Track = {
    id: 'youtube:M7lc1UVf-VE',
    source: 'youtube',
    sourceId: 'M7lc1UVf-VE',
    kind: 'track',
    title: 'Faixa Offline Hub',
    artist: 'Liquid Hub Online',
    duration: 20,
    offline: true,
    url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
    addedAt: Date.now(),
  };

  const spotifyImportedTrack: Track = {
    id: 'link:0123456789abcdef0123456789abcdef',
    source: 'link',
    sourceId: '0123456789abcdef0123456789abcdef',
    kind: 'track',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    duration: 20,
    durationMs: 20000,
    catalogSource: 'spotify',
    url: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
    addedAt: Date.now(),
  };

  for (const t of [lyriclessTrack, lyricTrack, thirdTrack, spotifyImportedTrack]) {
    db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(
      t.id,
      JSON.stringify(t),
      t.source === 'local' ? wavPath : null,
      Date.now(),
    );
  }
  db.prepare('INSERT INTO offline_tracks VALUES(?,?,?,?,?)').run(
    thirdTrack.id,
    offlineWavPath,
    1024,
    20,
    Date.now(),
  );
  db.prepare('INSERT INTO playlists VALUES(?,?,?)').run('hub-mix', 'Mix Principal', Date.now());
  [lyriclessTrack, lyricTrack, thirdTrack].forEach((t, i) =>
    db.prepare('INSERT INTO playlist_tracks VALUES(?,?,?)').run('hub-mix', t.id, i),
  );
  db.prepare('INSERT INTO settings VALUES(?,?)').run(
    'preferences',
    JSON.stringify({
      ...defaults,
      onboardingDone: true,
      onlineConsent: true,
      catalogConsent: true,
      shuffle: false,
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
      GLASS_TEST_DISABLE_DIRECT: '1',
      WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9389',
    },
  });

  let browser: Browser | undefined;
  const errors: string[] = [];

  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch('http://127.0.0.1:9389/json/version')).ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:9389');
    const page = browser.contexts()[0].pages()[0];
    page.on('pageerror', e => errors.push(e.message));

    // 1. Rebranding verification
    await expect(page).toHaveTitle('Liquid Hub');
    await expect(page.locator('.sidebar .brand')).toContainText('Liquid Hub');

    // Deterministic lyrics mock distinguishing lyricless vs synced-lyrics track
    await page.evaluate(() => {
      window.glass.lyrics = async (t: any) => {
        if (t.id === 'local:with-lyrics') {
          return {
            id: 777,
            title: t.title,
            artist: t.artist,
            instrumental: false,
            provider: 'LRCLIB',
            syncedLyrics: '[00:00.00]Primeira linha Hub\n[00:04.00]Segunda linha Hub',
          };
        }
        return null;
      };
    });

    // 2. Conditional Lyrics Icon: hidden when playing lyricless track, visible when playing track with lyrics
    await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    await page
      .getByRole('button', { name: `Reproduzir ${lyriclessTrack.title}`, exact: true })
      .click();
    await expect
      .poll(() => activeAudio(page).evaluate((a: HTMLAudioElement) => a.currentTime))
      .toBeGreaterThan(0.1);
    await expect(
      page.locator('footer.player').getByRole('button', { name: 'Letras', exact: true }),
    ).toHaveCount(0);

    // Switch to track with valid synced lyrics -> Lyrics icon appears smoothly!
    await page
      .getByRole('button', { name: `Reproduzir ${lyricTrack.title}`, exact: true })
      .click();
    const lyricsBtn = page
      .locator('footer.player')
      .getByRole('button', { name: 'Letras', exact: true });
    await expect(lyricsBtn).toBeVisible({ timeout: 5000 });
    await lyricsBtn.click();
    await expect(page.locator('.lyrics-lines button.active')).toHaveText('Primeira linha Hub');

    // Pop out Detached Lyrics window and verify Always-on-Top Pin button
    await page.getByRole('button', { name: 'Destacar janela de letras', exact: true }).click();
    await expect.poll(() => browser!.contexts()[0].pages().length).toBe(2);
    const detachedPage = browser.contexts()[0].pages().find(p => p !== page)!;
    await expect(detachedPage.locator('.detached-lyrics .lyrics-panel')).toBeVisible();
    const unpinBtn = detachedPage.getByRole('button', { name: 'Desafixar do topo', exact: true });
    await expect(unpinBtn).toBeVisible();
    await unpinBtn.click();
    await expect(
      detachedPage.getByRole('button', { name: 'Fixar no topo', exact: true }),
    ).toBeVisible();
    await detachedPage.getByRole('button', { name: 'Fechar letras', exact: true }).click();
    await expect.poll(() => browser!.contexts()[0].pages().length).toBe(1);

    // 3. Shuffle Play button on Playlist view + Queue badge + Dual Source Badge + "Trocar fonte de áudio"
    await page.evaluate(async () => {
      window.glass.streamCandidates = async () => [
        {
          provider: 'ytmusic',
          id: '4NRXx6U8ABQ',
          title: 'Blinding Lights',
          artist: 'The Weeknd - Topic',
          duration: 20,
          durationMs: 20000,
          durationDeltaMs: 0,
          score: 99,
          url: 'https://music.youtube.com/watch?v=4NRXx6U8ABQ',
          isOfficialTopic: true,
        },
        {
          provider: 'soundcloud',
          id: 'sc_blinding_99',
          title: 'Blinding Lights',
          artist: 'The Weeknd',
          duration: 20,
          durationMs: 20000,
          durationDeltaMs: 120,
          score: 91,
          url: 'https://soundcloud.com/theweeknd/blinding-lights',
        },
      ];
    });

    await page.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    await page.getByRole('button', { name: 'Opções de Blinding Lights', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'Trocar fonte de áudio', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Trocar fonte de áudio', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /The Weeknd - Topic/ }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Verify persistent SQLite mapping hydrated Dual Badge ("Importado do Spotify • Tocando via YT Music")
    await expect(
      page.locator('[title="Importado do Spotify • Tocando via YT Music"]').first(),
    ).toBeVisible();

    await page.getByRole('button', { name: /Mix Principal/ }).first().click();
    const shuffleBtn = page.getByRole('button', {
      name: 'Reproduzir playlist no aleatório',
      exact: true,
    });
    await expect(shuffleBtn).toBeVisible();
    await shuffleBtn.click();
    await expect
      .poll(async () => (await page.evaluate(() => window.glass.bootstrap())).preferences.shuffle)
      .toBe(true);
    await expect(page.locator('footer.player .queue-count-dot')).toHaveText('2');
    await page.locator('footer.player').getByRole('button', { name: 'Pausar', exact: true }).click();

    // 4. Zero-Trust Hub Login + Anti-Spam Notification Mode selector in Settings
    await page.getByRole('button', { name: 'Configurações', exact: true }).click();
    const notifySelect = page.getByRole('combobox', {
      name: 'Notificações ao trocar de faixa',
      exact: true,
    });
    await expect(notifySelect).toHaveValue('off');
    await notifySelect.selectOption('background');
    await expect(notifySelect).toHaveValue('background');
    await notifySelect.selectOption('off');

    await page.locator('summary', { hasText: 'Sessão Liquid Hub (Zero-Trust)' }).click();
    await page.getByRole('button', { name: 'Registrar nova conta', exact: true }).click();
    await page.getByPlaceholder('https://hub.exemplo.com').fill(brokerUrl);
    await page.locator('.hub-auth-form input[type="text"]').fill('qa_security');
    await page.locator('.hub-auth-form input[type="password"]').fill('ZeroTrustVault#2026!');
    await page.getByRole('button', { name: 'Criar conta segura', exact: true }).click();

    await expect(page.getByText(/Cofre DPAPI ativo/)).toBeVisible({ timeout: 15000 });

    // Verify ZERO sensitive tokens exist in Web Storage or in window.glass.hubStatus()
    const storageAudit = await page.evaluate(async () => {
      const status = await window.glass.hubStatus();
      const localKeys = Object.keys(localStorage);
      const sessionKeys = Object.keys(sessionStorage);
      const dump = JSON.stringify({
        status,
        local: Object.fromEntries(localKeys.map(k => [k, localStorage.getItem(k)])),
        session: Object.fromEntries(sessionKeys.map(k => [k, sessionStorage.getItem(k)])),
      });
      return { status, localKeys, sessionKeys, hasJwtInWeb: /eyJ[A-Za-z0-9_-]{10,}/.test(dump) };
    });
    expect(storageAudit.status.authenticated).toBe(true);
    expect(storageAudit.hasJwtInWeb).toBe(false);
    expect(Object.keys(storageAudit.status).sort()).toEqual(
      ['authenticated', 'brokerUrl', 'expiresAt', 'subject', 'tokenActive'].sort(),
    );

    // 5. Live JAM sidebar & player indicators
    await page.getByRole('textbox', { name: 'Seu nome na JAM', exact: true }).fill('HubHost');
    await page.getByRole('button', { name: 'Criar na rede local', exact: true }).click();
    await expect(page.locator('.sidebar .jam-live-pill')).toBeVisible();
    await expect(page.locator('footer.player .jam-player-badge')).toBeVisible();
    await page.getByRole('button', { name: 'Encerrar JAM', exact: true }).click();

    await page.getByRole('button', { name: 'Encerrar sessão', exact: true }).click();
    await expect(page.getByText(/Cofre DPAPI ativo/)).toHaveCount(0);

    expect(errors).toEqual([]);
    await writeFile(
      'test-results/liquid-hub-e2e.json',
      JSON.stringify(
        {
          rebrandedToLiquidHub: true,
          conditionalLyricsVerified: true,
          detachedPinAlwaysOnTop: true,
          shufflePlayVerified: true,
          zeroTrustPkceDpapiVerified: true,
          noTokensInWebStorage: true,
          liveJamIndicatorsVerified: true,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    proc.kill();
    await browser?.close().catch(() => {});
    brokerServer.closeAllConnections();
    await new Promise<void>(r => brokerServer.close(() => r()));
  }
});
