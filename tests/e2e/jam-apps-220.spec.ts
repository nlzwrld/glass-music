import { chromium, expect, test, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaults, type Track } from '../../shared/types';
import { opticalDefaults } from '../../src/components/glass/v3/model';
import { resolveLiquidHubExe } from './exe';

test('two actual app windows follow JAM play pause seek and track changes', async () => {
  test.setTimeout(90000);
  await mkdir('../../work/profiles', { recursive: true });
  await mkdir('test-results', { recursive: true });
  const exe = resolveLiquidHubExe();

  const song: Track = {
    id: 'youtube:M7lc1UVf-VE',
    source: 'youtube',
    sourceId: 'M7lc1UVf-VE',
    kind: 'track',
    title: 'Áudio autoral A',
    artist: 'Liquid Hub QA',
    duration: 48,
    url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
    addedAt: Date.now(),
  };
  const song2: Track = {
    ...song,
    id: 'youtube:dQw4w9WgXcQ',
    sourceId: 'dQw4w9WgXcQ',
    title: 'Áudio autoral B',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  };

  const processes: any[] = [],
    browsers: any[] = [],
    pages: Page[] = [];

  try {
    for (let i = 0; i < 2; i++) {
      const profile = await mkdtemp(resolve('../../work/profiles/jam-app-220-'));
      await mkdir(join(profile, 'offline'));
      const path = join(profile, 'offline', 'fixture.wav');
      await copyFile('assets/audio/prisma.wav', path);
      const db = new DatabaseSync(join(profile, 'library.sqlite'));
      db.exec(
        'CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE offline_tracks(track_id TEXT PRIMARY KEY REFERENCES tracks(id),path TEXT NOT NULL,size INTEGER NOT NULL,duration REAL NOT NULL,created INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);',
      );
      for (const t of [song, song2]) {
        db.prepare('INSERT INTO tracks VALUES(?,?,NULL,?)').run(t.id, JSON.stringify(t), Date.now());
        db.prepare('INSERT INTO offline_tracks VALUES(?,?,?,?,?)').run(t.id, path, 1, 48, Date.now());
      }
      db.prepare('INSERT INTO settings VALUES(?,?)').run(
        'preferences',
        JSON.stringify({
          ...defaults,
          onboardingDone: true,
          onlineConsent: true,
          catalogConsent: true,
          reducedMotion: true,
          transition: 'off',
          autoUpdate: false,
          volume: 0,
          appearance: { ...opticalDefaults, backgroundMotion: 0, background: 'solid' },
        }),
      );
      db.close();

      processes.push(
        spawn(exe, [], {
          windowsHide: true,
          env: {
            ...process.env,
            GLASS_TEST_DATA: profile,
            GLASS_TEST_DISABLE_DIRECT: '1',
            WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${9386 + i}`,
          },
        }),
      );

      for (let j = 0; j < 90; j++) {
        try {
          if ((await fetch(`http://127.0.0.1:${9386 + i}/json/version`)).ok) break;
        } catch {}
        await new Promise(r => setTimeout(r, 150));
      }
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${9386 + i}`);
      browsers.push(browser);
      pages.push(browser.contexts()[0].pages()[0]);
    }

    const [host, guest] = pages;
    for (const [p, name] of [
      [host, 'Host'],
      [guest, 'Friend'],
    ] as const) {
      await p.getByRole('button', { name: 'Configurações', exact: true }).click();
      await p.getByRole('textbox', { name: 'Seu nome na JAM', exact: true }).fill(name);
    }

    await host.getByRole('button', { name: 'Criar na rede local', exact: true }).click();
    await expect(host.locator('.jam-room-code strong')).toBeVisible();
    const code = (await host.locator('.jam-room-code strong').innerText()).trim();

    await host.getByRole('button', { name: 'Copiar convite da JAM', exact: true }).click();
    const link = await host.getByRole('textbox', { name: 'Convite desta JAM', exact: true }).inputValue();
    expect(link).toContain('#jam=' + code);

    await guest.getByRole('textbox', { name: 'Convite da JAM', exact: true }).fill(link);
    await guest.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(guest.locator('.jam-room-code strong')).toHaveText(code);
    await expect(host.locator('.jam-members span')).toHaveCount(2);

    await host.getByRole('button', { name: 'Biblioteca', exact: true }).click();
    await host.getByRole('button', { name: 'Reproduzir ' + song.title, exact: true }).click();
    await expect
      .poll(
        () =>
          guest
            .locator('audio[data-active=true]')
            .evaluate((a: HTMLAudioElement) => !a.paused && a.currentTime > 0.1),
        { timeout: 15000 },
      )
      .toBe(true);

    await host.getByRole('slider', { name: 'Posição da música', exact: true }).fill('12');
    await expect
      .poll(
        async () =>
          Math.abs(
            (await host
              .locator('audio[data-active=true]')
              .evaluate((a: HTMLAudioElement) => a.currentTime)) -
              (await guest
                .locator('audio[data-active=true]')
                .evaluate((a: HTMLAudioElement) => a.currentTime)),
          ),
        { timeout: 10000 },
      )
      .toBeLessThan(0.9);

    await host.locator('footer.player').getByRole('button', { name: 'Pausar', exact: true }).click();
    await expect
      .poll(() =>
        guest.locator('audio[data-active=true]').evaluate((a: HTMLAudioElement) => a.paused),
      )
      .toBe(true);

    await host.getByRole('slider', { name: 'Posição da música', exact: true }).fill('3');
    await expect
      .poll(() =>
        guest.locator('audio[data-active=true]').evaluate((a: HTMLAudioElement) => a.currentTime),
      )
      .toBeLessThan(4);

    await host.getByRole('button', { name: 'Reproduzir ' + song2.title, exact: true }).click();
    await expect(guest.locator('.now-playing')).toContainText(song2.title);
    await expect
      .poll(() =>
        guest.locator('audio[data-active=true]').evaluate((a: HTMLAudioElement) => !a.paused),
      )
      .toBe(true);

    const drift = Math.abs(
      (await host
        .locator('audio[data-active=true]')
        .evaluate((a: HTMLAudioElement) => a.currentTime)) -
        (await guest
          .locator('audio[data-active=true]')
          .evaluate((a: HTMLAudioElement) => a.currentTime)),
    );
    await guest.getByRole('button', { name: 'Configurações', exact: true }).click();
    await guest.getByRole('button', { name: 'Sair da JAM', exact: true }).click();
    await expect(guest.locator('.jam-room-code')).toHaveCount(0);
    await writeFile(
      'test-results/jam-apps-220.json',
      JSON.stringify(
        {
          twoApps: true,
          localServer: true,
          playPauseSeek: true,
          trackSwitch: true,
          guestLeave: true,
          driftSeconds: drift,
        },
        null,
        2,
      ),
    );
  } finally {
    processes.forEach(p => p.kill());
    await Promise.all(browsers.map(b => b.close().catch(() => {})));
  }
});
