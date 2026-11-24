import { generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { createBroker } from '../../server/broker';
import { createJam } from '../../server/jam';
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '../../shared/auth';
import { defaults, type Track } from '../../shared/types';
import { opticalDefaults } from '../../src/components/glass/v3/model';
import { resolveLiquidHubExe } from './exe';

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

async function launchAppInstance(opts: {
  exe: string;
  port: number;
  brokerUrl: string;
  args?: string[];
  jamEndpoint?: string;
}) {
  await mkdir('.test-data/profiles', { recursive: true });
  const profile = await mkdtemp(resolve('.test-data/profiles/jam-app-220-'));
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
      jamEndpoint: opts.jamEndpoint || '',
      onboardingDone: true,
      onlineConsent: true,
      catalogConsent: true,
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
      termsAcceptedAt: Date.now(),
      reducedMotion: true,
      transition: 'off',
      autoUpdate: false,
      volume: 0,
      appearance: { ...opticalDefaults, backgroundMotion: 0, background: 'solid' },
    }),
  );
  db.close();

  const proc = spawn(opts.exe, opts.args || [], {
    windowsHide: true,
    env: {
      ...process.env,
      GLASS_TEST_DATA: profile,
      GLASS_TEST_DISABLE_DIRECT: '1',
      LIQUID_HUB_BROKER_URL: opts.brokerUrl,
      WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${opts.port}`,
    },
  });

  for (let j = 0; j < 100; j++) {
    try {
      if ((await fetch(`http://127.0.0.1:${opts.port}/json/version`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.waitForEvent('page', { timeout: 15000 }));
  return { proc, browser, page, profile };
}

async function unlockWithEmail(page: Page, email: string, name: string) {
  const gate = page.locator('.auth-gate');
  await expect(gate).toBeVisible({ timeout: 15000 });
  await gate.getByRole('button', { name: 'Entrar com e-mail', exact: true }).click();
  await gate.getByRole('button', { name: 'Criar conta com e-mail', exact: true }).click();
  await gate.getByLabel('Nome de exibição').fill(name);
  await gate.getByLabel('E-mail').fill(email);
  await gate.getByLabel('Senha (mínimo 12 caracteres)').fill('JamE2ePassword!2026');
  await gate.getByRole('button', { name: 'Criar conta', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 15000 });
}

test('two actual app windows follow JAM play pause seek track changes, link bridge, raw code lookup and cold/warm deep links', async () => {
  test.setTimeout(150000);
  await mkdir('.test-data/profiles', { recursive: true });
  await mkdir('test-results', { recursive: true });
  const exe = resolveLiquidHubExe();

  const brokerServer = createBroker(
    {
      BROKER_ACCESS_TOKEN: 'jam-e2e-broker-secret-token-123456',
      SOUNDCLOUD_CLIENT_ID: 'jam-sc-id',
      SOUNDCLOUD_CLIENT_SECRET: 'jam-sc-secret',
    },
    async () => new Response(JSON.stringify({ access_token: 'sc', expires_in: 3600 })),
    Date.now,
    { argon2Params: { memory: 1024, passes: 1, parallelism: 1, tagLength: 16 } },
  );
  await new Promise<void>(r => brokerServer.listen(0, '127.0.0.1', r));
  const brokerUrl = `http://127.0.0.1:${(brokerServer.address() as { port: number }).port}`;

  const processes: any[] = [];
  const browsers: Browser[] = [];
  const profiles: string[] = [];
  const errors: string[] = [];

  try {
    const hostInst = await launchAppInstance({ exe, port: 9386, brokerUrl });
    const guestInst = await launchAppInstance({ exe, port: 9387, brokerUrl });
    processes.push(hostInst.proc, guestInst.proc);
    browsers.push(hostInst.browser, guestInst.browser);
    profiles.push(hostInst.profile, guestInst.profile);

    const host = hostInst.page;
    const guest = guestInst.page;
    host.on('pageerror', e => errors.push(`host: ${e.message}`));
    guest.on('pageerror', e => errors.push(`guest: ${e.message}`));

    await Promise.all([
      unlockWithEmail(host, 'host-jam@liquidhub.dev', 'Host'),
      unlockWithEmail(guest, 'friend-jam@liquidhub.dev', 'Friend'),
    ]);

    for (const [p, name] of [
      [host, 'Host'],
      [guest, 'Friend'],
    ] as const) {
      await p.getByRole('button', { name: 'Configurações', exact: true }).click();
      await p.getByRole('textbox', { name: 'Seu nome na JAM', exact: true }).fill(name);
    }

    await host.getByRole('textbox', { name: 'Nome da JAM', exact: true }).fill('Sessão Liquid');
    await host.getByRole('button', { name: 'Criar na rede local', exact: true }).click();
    await expect(host.locator('.jam-room-code strong')).toBeVisible();
    const code = (await host.locator('.jam-room-code strong').innerText()).trim();
    expect(code).toMatch(/^[A-Z0-9]{8}$/);

    await host.getByRole('button', { name: 'Copiar convite da JAM', exact: true }).click();
    const link = await host.getByRole('textbox', { name: 'Convite desta JAM', exact: true }).inputValue();
    expect(link).toContain(`/jam/join/${code}`);
    const origin = new URL(link).origin;

    // Verify web invite landing bridge page returns HTML with deep link & install fallback
    const bridgeRes = await fetch(link);
    expect(bridgeRes.status).toBe(200);
    const bridgeHtml = await bridgeRes.text();
    expect(bridgeHtml).toContain('Sessão Liquid');
    expect(bridgeHtml).toContain('1/8 ouvintes');
    expect(bridgeHtml).toContain(`liquidhub://jam/join/${code}?endpoint=`);
    expect(bridgeHtml).toContain('Baixar Liquid Hub');

    // Share bar buttons present
    await expect(host.getByRole('button', { name: 'WhatsApp', exact: true })).toBeVisible();
    await expect(host.getByRole('button', { name: 'Discord', exact: true })).toBeVisible();
    await expect(host.getByRole('button', { name: 'Compartilhar', exact: true })).toBeVisible();

    // Guest pastes shareable invite link -> preview appears -> clicks "Entrar na JAM"
    await guest.getByRole('textbox', { name: 'Convite da JAM', exact: true }).fill(link);
    await expect(guest.locator('.jam-preview-card')).toContainText('Sessão Liquid', { timeout: 10000 });
    await expect(guest.locator('.jam-preview-card')).toContainText('Host');
    await guest.locator('.jam-preview-card').getByRole('button', { name: 'Entrar na JAM', exact: true }).click();

    await expect(guest.locator('.jam-room-code strong')).toHaveText(code);
    await expect(host.locator('.jam-members .jam-member')).toHaveCount(2);

    // Real-time playback sync: play, seek, pause, track switch
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

    // Guest leaves and tests invalid code + raw lowercase hyphenated code lookup (NO URL, NO cloud endpoint)
    await guest.getByRole('button', { name: 'Sair da JAM', exact: true }).click();
    await expect(guest.locator('.jam-room-code')).toHaveCount(0);

    await guest.getByRole('textbox', { name: 'Convite da JAM', exact: true }).fill('ZZZZ9999');
    await guest.getByRole('button', { name: 'Buscar JAM', exact: true }).click();
    await expect(guest.locator('.jam-error-banner')).toContainText(/Nenhuma JAM encontrada/i, {
      timeout: 10000,
    });

    const rawLower = `${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`;
    await guest.getByRole('textbox', { name: 'Convite da JAM', exact: true }).fill(rawLower);
    await expect(guest.locator('.jam-preview-card')).toContainText('Sessão Liquid', { timeout: 10000 });
    await guest.locator('.jam-preview-card').getByRole('button', { name: 'Entrar na JAM', exact: true }).click();
    await expect(guest.locator('.jam-room-code strong')).toHaveText(code);

    // Warm-start deep link while Guest is on Biblioteca
    await guest.getByRole('button', { name: 'Sair da JAM', exact: true }).click();
    await expect(guest.locator('.jam-room-code')).toHaveCount(0);
    await guest.getByRole('button', { name: 'Biblioteca', exact: true }).click();

    const deepLinkUrl = `liquidhub://jam/join/${code}?endpoint=${encodeURIComponent(origin)}`;
    const dispatched = await guest.evaluate(u => window.glass.dispatchDeepLink(u), deepLinkUrl);
    expect(dispatched).toBe(true);
    await expect(guest.locator('.jam-invite-modal')).toBeVisible({ timeout: 10000 });
    await expect(guest.locator('.jam-invite-modal')).toContainText('Sessão Liquid');
    await guest.locator('.jam-invite-modal').getByRole('button', { name: 'Entrar na JAM', exact: true }).click();
    await expect(guest.locator('.jam-room-code strong')).toHaveText(code, { timeout: 10000 });

    // Cold-start deep link: launch 3rd desktop process directly with liquidhub:// argument
    const coldInst = await launchAppInstance({ exe, port: 9388, brokerUrl, args: [deepLinkUrl] });
    processes.push(coldInst.proc);
    browsers.push(coldInst.browser);
    profiles.push(coldInst.profile);
    const coldGuest = coldInst.page;
    coldGuest.on('pageerror', e => errors.push(`coldGuest: ${e.message}`));
    await unlockWithEmail(coldGuest, 'cold-jam@liquidhub.dev', 'ColdFriend');

    await expect(coldGuest.locator('.jam-invite-modal')).toBeVisible({ timeout: 15000 });
    await expect(coldGuest.locator('.jam-invite-modal')).toContainText('Sessão Liquid');
    await coldGuest.locator('.jam-invite-modal').getByRole('button', { name: 'Entrar na JAM', exact: true }).click();
    await expect(coldGuest.locator('.jam-room-code strong')).toHaveText(code, { timeout: 10000 });

    await host.getByRole('button', { name: 'Configurações', exact: true }).click();
    await expect(host.locator('.jam-members .jam-member')).toHaveCount(3, { timeout: 10000 });

    // Host closes JAM -> guests exit automatically and old code shows ROOM_ENDED state
    await host.getByRole('button', { name: 'Encerrar JAM', exact: true }).click();
    await expect(host.locator('.jam-room-code')).toHaveCount(0);
    await expect(guest.locator('.jam-room-code')).toHaveCount(0, { timeout: 10000 });
    await expect(coldGuest.locator('.jam-room-code')).toHaveCount(0, { timeout: 10000 });

    await guest.getByRole('textbox', { name: 'Convite da JAM', exact: true }).fill(code);
    await guest.getByRole('button', { name: 'Buscar JAM', exact: true }).click();
    await expect(guest.locator('.jam-error-banner')).toContainText(/encerrada/i, { timeout: 10000 });

    expect(errors).toEqual([]);
    await writeFile(
      'test-results/jam-apps-220.json',
      JSON.stringify(
        {
          twoApps: true,
          threeAppsColdDeepLink: true,
          warmDeepLink: true,
          rawCodeLookup: true,
          invalidCodeFeedback: true,
          endedRoomLookup: true,
          webInviteLandingPage: true,
          playPauseSeek: true,
          trackSwitch: true,
          hostCloseSync: true,
          driftSeconds: drift,
        },
        null,
        2,
      ),
    );
  } finally {
    processes.forEach(p => p.kill());
    await Promise.all(browsers.map(b => b.close().catch(() => {})));
    await Promise.all(profiles.map(p => rm(p, { recursive: true, force: true }).catch(() => {})));
    brokerServer.closeAllConnections();
    await new Promise<void>(r => brokerServer.close(() => r()));
  }
});

test('server-side Ed25519 authentication blocks untrusted JAM joins cleanly in desktop UI', async () => {
  test.setTimeout(90000);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };

  const server = createJam({
    JAM_REQUIRE_AUTH: '1',
    JAM_AUTH_PUBLIC_KEY: jwk.x,
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const endpoint = `http://127.0.0.1:${port}`;

  // Independent broker with a different Ed25519 key so its JWT is rejected by the private JAM server
  const untrustedBroker = createBroker(
    {
      BROKER_ACCESS_TOKEN: 'untrusted-broker-secret-token-123456',
      SOUNDCLOUD_CLIENT_ID: 'jam-sc-id-2',
      SOUNDCLOUD_CLIENT_SECRET: 'jam-sc-secret-2',
    },
    async () => new Response(JSON.stringify({ access_token: 'sc', expires_in: 3600 })),
    Date.now,
    { argon2Params: { memory: 1024, passes: 1, parallelism: 1, tagLength: 16 } },
  );
  await new Promise<void>(r => untrustedBroker.listen(0, '127.0.0.1', r));
  const untrustedBrokerUrl = `http://127.0.0.1:${(untrustedBroker.address() as { port: number }).port}`;

  const iat = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      iss: 'liquid-hub-auth',
      aud: 'liquid-hub-desktop',
      sub: 'usr_host',
      fam: 'fam_e2e',
      iat,
      exp: iat + 600,
    }),
  ).toString('base64url');
  const jwt = `${hdr}.${body}.${sign(null, Buffer.from(`${hdr}.${body}`, 'ascii'), privateKey).toString('base64url')}`;

  const created = (await (
    await fetch(`${endpoint}/v1/jam`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        action: 'create',
        name: 'AuthHost',
        roomName: 'Sala Privada',
      }),
    })
  ).json()) as { code: string };

  const exe = resolveLiquidHubExe();
  const inst = await launchAppInstance({ exe, port: 9390, brokerUrl: untrustedBrokerUrl, jamEndpoint: endpoint });
  try {
    const page = inst.page;
    await unlockWithEmail(page, 'untrusted@liquidhub.dev', 'UntrustedGuest');
    await page.getByRole('button', { name: 'Configurações', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Convite da JAM', exact: true })
      .fill(`${endpoint}/jam/join/${created.code}`);
    await expect(page.locator('.jam-preview-card')).toContainText('Sala Privada', { timeout: 10000 });
    await page.locator('.jam-preview-card').getByRole('button', { name: 'Entrar na JAM', exact: true }).click();
    await expect(page.locator('.jam-error')).toContainText(
      /Autenticação|Assinatura|inválida|expirada|recusada/i,
      { timeout: 10000 },
    );
    await expect(page.locator('.jam-room-code')).toHaveCount(0);
  } finally {
    inst.proc.kill();
    await inst.browser.close().catch(() => {});
    await rm(inst.profile, { recursive: true, force: true }).catch(() => {});
    untrustedBroker.closeAllConnections();
    await new Promise<void>(r => untrustedBroker.close(() => r()));
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});
