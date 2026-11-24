import { test, expect, chromium, type Browser } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createBroker } from '../../server/broker';
import { defaults, type Track } from '../../shared/types';
import { activeAudio, navButton, openProfileMenuPage, waitForCdp } from './ui';

test('validates continuity, concurrency, error recovery, keyboard a11y, responsive layouts & restart persistence', async () => {
  test.setTimeout(120000);
  await mkdir('.test-data/profiles', { recursive: true });

  const brokerServer = createBroker(
    {
      BROKER_ACCESS_TOKEN: 'ux-e2e-broker-secret-token-123456',
      SOUNDCLOUD_CLIENT_ID: 'ux-sc-id',
      SOUNDCLOUD_CLIENT_SECRET: 'ux-sc-secret',
    },
    async () => new Response(JSON.stringify({ access_token: 'sc', expires_in: 3600 })),
    Date.now,
    { argon2Params: { memory: 1024, passes: 1, parallelism: 1, tagLength: 16 } },
  );
  await new Promise<void>(r => brokerServer.listen(0, '127.0.0.1', r));
  const brokerUrl = `http://127.0.0.1:${(brokerServer.address() as { port: number }).port}`;

  const profile = await mkdtemp(resolve('.test-data/profiles/ux-continuity-'));
  const db = new DatabaseSync(join(profile, 'library.sqlite'));
  db.exec(
    'CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);' +
      'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);',
  );

  const audioPath = resolve('assets/audio/prisma.wav');
  const now = Date.now();
  const tracks: Track[] = [
    {
      id: 'local:ux-a',
      source: 'local',
      kind: 'track',
      sourceId: 'ux-a',
      title: 'Aurora Translúcida — Faixa A de Continuidade',
      artist: 'Orquestra Liquid',
      album: ' Prisma ',
      duration: 20,
      addedAt: now - 1000,
    },
    {
      id: 'local:ux-b',
      source: 'local',
      kind: 'track',
      sourceId: 'ux-b',
      title: 'Pulso Magnético — Faixa B de Concorrência',
      artist: 'Orquestra Liquid',
      album: 'Prisma',
      duration: 20,
      addedAt: now - 2000,
    },
    {
      id: 'local:ux-c',
      source: 'local',
      kind: 'track',
      sourceId: 'ux-c',
      title: 'Horizonte Sereno — Faixa C da Fila',
      artist: 'Sintonia Boreal',
      album: 'Horizontes',
      duration: 20,
      addedAt: now - 3000,
    },
    {
      id: 'local:ux-d',
      source: 'local',
      kind: 'track',
      sourceId: 'ux-d',
      title: 'Vento Solar — Faixa D da Fila',
      artist: 'Sintonia Boreal',
      album: 'Horizontes',
      duration: 20,
      addedAt: now - 4000,
    },
  ];
  for (const t of tracks) {
    db.prepare('INSERT INTO tracks VALUES(?,?,?,?)').run(t.id, JSON.stringify(t), audioPath, now);
  }
  db.prepare('INSERT INTO settings VALUES(?,?)').run(
    'preferences',
    JSON.stringify({
      ...defaults,
      onboardingDone: true,
      onlineConsent: true,
      catalogConsent: false,
      volume: 44,
      reducedMotion: false,
    }),
  );
  db.close();

  const exePath =
    process.env.GLASS_EXE || join(process.env.LOCALAPPDATA!, 'Liquid Hub/liquid-hub.exe');
  const errors: string[] = [];
  let browser: Browser | undefined;
  let proc = spawn(exePath, [], {
    windowsHide: true,
    env: {
      ...process.env,
      GLASS_TEST_DATA: profile,
      GLASS_TEST_DISABLE_DIRECT: '1',
      LIQUID_HUB_BROKER_URL: brokerUrl,
      WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9391',
    },
  });

  try {
    await waitForCdp(proc, 9391, 90, 200);
    browser = await chromium.connectOverCDP('http://127.0.0.1:9391');
    const context = browser.contexts()[0]!;
    const page = context.pages()[0]!;
    page.on('pageerror', e => errors.push(e.message));

    // Register account to unlock full authenticated persistence
    const gate = page.locator('.auth-gate');
    await expect(gate).toBeVisible({ timeout: 15000 });
    await gate.locator('input[type="checkbox"]').check();
    await gate.getByRole('button', { name: 'Entrar com e-mail', exact: true }).click();
    await gate.getByRole('button', { name: 'Criar conta com e-mail', exact: true }).click();
    await gate.getByLabel('Nome de exibição').fill('Validador UX');
    await gate.getByLabel('E-mail').fill('ux-validator@liquidhub.dev');
    await gate.getByLabel('Senha (mínimo 12 caracteres)').fill('UxValidationPass!2026');
    await gate.getByRole('button', { name: 'Criar conta', exact: true }).click();
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 15000 });

    // 1. CONTINUIDADE: Play Track A, navigate across views, minimize & restore
    await navButton(page, 'Biblioteca').click();
    await page.getByRole('button', { name: `Reproduzir ${tracks[0]!.title}`, exact: true }).click();
    await expect
      .poll(() => activeAudio(page).evaluate((a: HTMLAudioElement) => a.currentTime))
      .toBeGreaterThan(0.25);

    await navButton(page, 'Downloads').click();
    await navButton(page, 'Início').click();
    await page.evaluate(() => void window.glass.window('minimize'));
    await page.waitForTimeout(150);
    await page.evaluate(() => void window.glass.window('restore'));
    const posAfterNav = await activeAudio(page).evaluate((a: HTMLAudioElement) => ({
      paused: a.paused,
      t: a.currentTime,
    }));
    expect(posAfterNav.paused).toBe(false);
    expect(posAfterNav.t).toBeGreaterThan(0.35);

    // 2. CONCORRÊNCIA + SEEK + VOLUME PRESERVATION: Rapid B -> C -> A, seek, pause/resume
    await navButton(page, 'Biblioteca').click();
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('.track-row .track-identity'));
      btns[1]?.click();
      btns[2]?.click();
      btns[0]?.click();
    });
    await expect(page.locator('.now-info strong')).toHaveText(tracks[0]!.title);
    await expect
      .poll(() => activeAudio(page).evaluate((a: HTMLAudioElement) => !a.paused && a.currentTime > 0.1))
      .toBe(true);

    // Seek via slider and verify volume preference (44) is preserved
    const seekSlider = page.locator('footer.player').getByRole('slider', { name: 'Posição da música' });
    await seekSlider.fill('6');
    await expect
      .poll(() => activeAudio(page).evaluate((a: HTMLAudioElement) => a.currentTime))
      .toBeGreaterThanOrEqual(5.5);

    // Mute and unmute restores user volume 44 (not hardcoded 65!)
    await page.locator('footer.player').getByRole('button', { name: 'Silenciar', exact: true }).click();
    await page.locator('footer.player').getByRole('button', { name: 'Ativar som', exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.glass.bootstrap())).preferences.volume)
      .toBe(44);

    // 3. BUSCA PERSISTENTE + FILA FOCO DETERMINÍSTICO + ESCAPE EM CAMADAS
    await page.keyboard.press('Control+k');
    const searchInput = page.getByRole('textbox', { name: 'Buscar músicas, artistas e playlists' });
    await expect(searchInput).toBeFocused();
    await searchInput.fill('Sintonia Boreal');
    await expect(page.locator('.search-page .track-row')).toHaveCount(2);
    await navButton(page, 'Downloads').click();
    await page.getByRole('button', { name: 'Voltar', exact: true }).click();
    await expect(searchInput).toHaveValue('Sintonia Boreal');
    await expect(page.locator('.search-page .track-row')).toHaveCount(2);

    // Open Queue, remove first upcoming item, verify focus stays on next remove button
    await page.getByRole('button', { name: 'Fila de reprodução', exact: true }).click();
    await expect(page.locator('.queue-panel')).toBeVisible();
    const firstRemove = page.locator('.queue-panel button[aria-label^="Remover "]').first();
    await firstRemove.focus();
    await firstRemove.click();
    await expect
      .poll(() =>
        page.evaluate(() => Boolean(document.activeElement?.closest('.queue-panel'))),
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Fechar fila', exact: true }).click();

    // Open Expanded Player, open Context Menu, press Escape -> menu closes, Expanded Player stays open!
    await page.getByRole('button', { name: 'Abrir player expandido', exact: true }).click();
    await expect(page.locator('.expanded-player')).toBeVisible();
    await page.getByRole('button', { name: 'Opções no player expandido', exact: true }).click();
    await expect(page.locator('.glass-context-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.glass-context-menu')).toHaveCount(0);
    await expect(page.locator('.expanded-player')).toBeVisible();
    await page.getByRole('button', { name: 'Fechar player expandido', exact: true }).click();

    // 4. RESPONSIVE + DESKTOP MINI-PLAYER (440x680) + MOBILE ERROR VISIBILITY (390x844)
    const cdp = await context.newCDPSession(page);
    await page.getByRole('button', { name: 'Mini-player', exact: true }).click();
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 440,
      height: 680,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect(page.locator('html')).toHaveAttribute('data-mobile', 'false');
    await expect(page.getByRole('button', { name: 'Sair do mini-player', exact: true })).toBeVisible();
    await expect(page.locator('.mobile-bottom-nav')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sair do mini-player', exact: true }).click();

    // Mobile 390x844 + controlled playback error visibility
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect(page.locator('html')).toHaveAttribute('data-mobile', 'true');
    await page.evaluate(() => {
      const a = document.querySelector<HTMLAudioElement>('audio[data-active="true"]');
      if (a) {
        a.src = 'http://127.0.0.1:9/broken-stream.mp3';
        a.dispatchEvent(new Event('error'));
      }
    });
    await expect(page.locator('.playback-error')).toBeVisible();
    const errInViewport = await page.locator('.playback-error').evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.height > 10 && r.top >= 0 && r.bottom <= window.innerHeight;
    });
    expect(errInViewport).toBe(true);
    await page.getByRole('button', { name: 'Fechar aviso de reprodução', exact: true }).click();

    // Restore desktop viewport & save preferences + like + playlist for restart persistence check
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await openProfileMenuPage(page, 'Configurações');
    await page.getByRole('button', { name: 'Aparência', exact: true }).click();
    await page.getByRole('button', { name: 'Liquid Glass', exact: true }).click();
    await page.getByRole('button', { name: 'Claro', exact: true }).click();
    await page.evaluate(async () => {
      await window.glass.library({
        action: 'like',
        track: (await window.glass.bootstrap()).tracks[0]!,
      });
      await window.glass.library({ action: 'create', name: 'Persistência Verificada' });
    });
    await expect
      .poll(async () => (await page.evaluate(() => window.glass.bootstrap())).preferences.theme)
      .toBe('light');

    expect(errors).toEqual([]);

    // 5. PERSISTÊNCIA APÓS REINICIAR O APLICATIVO
    await browser.close();
    browser = undefined;
    proc.kill();
    await new Promise(r => setTimeout(r, 400));

    proc = spawn(exePath, [], {
      windowsHide: true,
      env: {
        ...process.env,
        GLASS_TEST_DATA: profile,
        GLASS_TEST_DISABLE_DIRECT: '1',
        LIQUID_HUB_BROKER_URL: brokerUrl,
        WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9392',
      },
    });
    await waitForCdp(proc, 9392, 90, 200);
    browser = await chromium.connectOverCDP('http://127.0.0.1:9392');
    const page2 = browser.contexts()[0]!.pages()[0]!;
    await expect(page2.locator('.sidebar')).toBeVisible({ timeout: 15000 });
    await expect(page2.locator('html')).toHaveAttribute('data-ui-style', 'glass');
    await expect(page2.locator('html')).toHaveAttribute('data-theme', 'light');
    const persisted = await page2.evaluate(() => window.glass.bootstrap());
    expect(persisted.preferences.volume).toBe(44);
    expect(persisted.likes).toContain('local:ux-a');
    expect(persisted.playlists.some(p => p.name === 'Persistência Verificada')).toBe(true);
  } finally {
    proc.kill();
    await browser?.close().catch(() => {});
    brokerServer.closeAllConnections();
    await new Promise<void>(r => brokerServer.close(() => r()));
  }
});
