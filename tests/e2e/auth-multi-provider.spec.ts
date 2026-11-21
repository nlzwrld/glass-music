import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { computePkceS256Challenge, createBroker } from '../../server/broker';
import { createJam } from '../../server/jam';
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '../../shared/auth';
import { defaults } from '../../shared/types';
import { opticalDefaults } from '../../src/components/glass/v3/model';
import { resolveLiquidHubExe } from './exe';

interface MockProviderProfile {
  mode?: 'approve' | 'cancel';
  delayMs?: number;
  id: string;
  username: string;
  displayName?: string | null;
  email?: string | null;
  emailVerified?: boolean;
  avatar?: string | null;
  privateEmailsForbidden?: boolean;
}

async function startMockOAuthServer(
  provider: 'discord' | 'github',
  initial: MockProviderProfile,
) {
  let current = initial;
  const server = createServer(async (req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/authorize') {
      if (current.delayMs && current.delayMs > 0) {
        await new Promise(r => setTimeout(r, current.delayMs));
      }
      const redirectUri = u.searchParams.get('redirect_uri')!;
      const state = u.searchParams.get('state')!;
      const target = new URL(redirectUri);
      target.searchParams.set('state', state);
      if (current.mode === 'cancel') {
        target.searchParams.set('error', 'access_denied');
        target.searchParams.set('error_description', 'Autorização recusada pelo usuário');
      } else {
        target.searchParams.set('code', `oauth_code_${provider}_${current.id}_${Date.now()}`);
      }
      res.writeHead(302, { Location: target.toString() }).end();
      return;
    }
    if (req.method === 'POST' && u.pathname === '/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ access_token: `tok_${provider}_${current.id}`, token_type: 'Bearer' }),
      );
      return;
    }
    if (req.method === 'GET' && u.pathname === '/user') {
      if (provider === 'discord') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            id: current.id,
            username: current.username,
            global_name: current.displayName ?? null,
            avatar: current.avatar ?? null,
            email: current.email ?? null,
            verified: current.emailVerified ?? Boolean(current.email),
          }),
        );
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            id: Number(current.id) || current.id,
            login: current.username,
            name: current.displayName ?? null,
            avatar_url: current.avatar ?? null,
            email: current.privateEmailsForbidden ? null : (current.email ?? null),
          }),
        );
      }
      return;
    }
    if (req.method === 'GET' && u.pathname === '/user/emails') {
      if (current.privateEmailsForbidden) {
        res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Forbidden' }));
        return;
      }
      const rows = current.email
        ? [{ email: current.email, primary: true, verified: current.emailVerified ?? true }]
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(rows));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    setProfile(next: MockProviderProfile) {
      current = next;
    },
    config() {
      return {
        clientId: `${provider}_e2e_client`,
        clientSecret: `${provider}_e2e_secret`,
        authorizeUrl: `${base}/authorize`,
        tokenUrl: `${base}/token`,
        userInfoUrl: `${base}/user`,
        emailsUrl: `${base}/user/emails`,
      };
    },
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

function stopProcessTree(proc?: ChildProcess) {
  if (!proc || proc.killed || !proc.pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    try {
      proc.kill();
    } catch {}
  }
}

async function launchApp(opts: {
  exe: string;
  profile: string;
  runIndex: number;
  cdpPort: number;
  brokerUrl?: string;
  args?: string[];
  errors: string[];
}) {
  const proc = spawn(opts.exe, opts.args || [], {
    windowsHide: true,
    env: {
      ...process.env,
      GLASS_TEST_DATA: opts.profile,
      GLASS_TEST_DISABLE_DIRECT: '1',
      LIQUID_HUB_TEST_OAUTH_AUTOFOLLOW: '1',
      ...(opts.brokerUrl ? { LIQUID_HUB_BROKER_URL: opts.brokerUrl } : {}),
      WEBVIEW2_USER_DATA_FOLDER: join(opts.profile, `webview-${opts.runIndex}`),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${opts.cdpPort}`,
    },
  });

  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${opts.cdpPort}/json/version`);
      if (res.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.cdpPort}`);
  let page: Page | undefined;
  await expect
    .poll(async () => {
      const ctx = browser.contexts()[0];
      const pages = ctx?.pages() || [];
      for (const p of pages) {
        try {
          const ok = await p.evaluate(
            () =>
              Boolean(
                (window as any).glass &&
                  (document.querySelector('.sidebar .brand') ||
                    document.querySelector('.auth-gate') ||
                    document.querySelector('.onboarding')),
              ),
          );
          if (ok) {
            page = p;
            return true;
          }
        } catch {}
      }
      return false;
    }, { timeout: 15000 })
    .toBe(true);
  if (!page) {
    throw new Error('Janela principal do Liquid Hub não ficou pronta no WebView2.');
  }
  page.on('pageerror', e => opts.errors.push(`run${opts.runIndex}: ${e.message}`));
  return { proc, browser, page };
}

async function waitForAuthenticated(page: Page, expectedDisplayName?: string) {
  await expect
    .poll(async () => {
      try {
        const st = await page.evaluate(() => window.glass.hubStatus());
        return st.authenticated;
      } catch {
        return false;
      }
    }, { timeout: 15000 })
    .toBe(true);
  if (expectedDisplayName) {
    await expect
      .poll(async () => {
        try {
          const st = await page.evaluate(() => window.glass.hubStatus());
          return st.displayName || st.subject;
        } catch {
          return '';
        }
      }, { timeout: 15000 })
      .toBe(expectedDisplayName);
  }
}

async function waitForLoggedOut(page: Page) {
  await expect
    .poll(async () => {
      try {
        const st = await page.evaluate(() => window.glass.hubStatus());
        return st.authenticated;
      } catch {
        return true;
      }
    }, { timeout: 15000 })
    .toBe(false);
}

test('Multi-Provider Auth (Email, Discord, GitHub), Linking, Security Rules, Persistence & Pre-Login JAM Invite', async () => {
  test.setTimeout(180000);
  await mkdir('.test-data/profiles', { recursive: true });
  await mkdir('test-results', { recursive: true });

  const exe = resolveLiquidHubExe();
  const profile = await mkdtemp(resolve('.test-data/profiles/auth-multi-'));
  const brokerDbPath = join(profile, 'broker.sqlite');
  const keypair = generateKeyPairSync('ed25519');
  const privateKeyPem = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const capturedEmails: Array<{ kind: string; to: string; token: string }> = [];
  const discordMock = await startMockOAuthServer('discord', {
    id: '4001001',
    username: 'ana_discord',
    displayName: 'Ana Discord',
    email: 'ana.discord@example.com',
    emailVerified: true,
    avatar: 'abc_avatar',
  });
  const githubMock = await startMockOAuthServer('github', {
    id: '5002002',
    username: 'ana_github',
    displayName: 'Ana GitHub',
    email: 'ana.gh@example.com',
    emailVerified: true,
    avatar: 'https://avatars.githubusercontent.com/u/5002002?v=4',
  });

  const brokerServer = createBroker(
    {
      BROKER_ACCESS_TOKEN: 'e2e-owner-broker-secret-token-123456',
      BROKER_ED25519_PRIVATE_KEY: privateKeyPem,
      BROKER_DB_PATH: brokerDbPath,
      BROKER_REQUESTS_PER_MINUTE: '600',
      BROKER_AUTH_REQUESTS_PER_MINUTE: '300',
      SOUNDCLOUD_CLIENT_ID: 'e2e-sc-id',
      SOUNDCLOUD_CLIENT_SECRET: 'e2e-sc-secret',
    },
    async () => new Response(JSON.stringify({ access_token: 'sc_tok', expires_in: 3600 })),
    Date.now,
    {
      argon2Params: { memory: 4096, passes: 1, parallelism: 1, tagLength: 16 },
      discord: discordMock.config(),
      github: githubMock.config(),
      onAuthEmail: msg => {
        capturedEmails.push({ kind: msg.kind, to: msg.to, token: msg.token });
      },
    },
  );
  await new Promise<void>(r => brokerServer.listen(0, '127.0.0.1', r));
  const brokerPort = (brokerServer.address() as { port: number }).port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  const jwkX = brokerServer.auth.publicJwk().x;
  const jamServer = createJam({
    JAM_REQUIRE_AUTH: '1',
    JAM_AUTH_PUBLIC_KEY: jwkX,
  });
  await new Promise<void>(r => jamServer.listen(0, '127.0.0.1', r));
  const jamPort = (jamServer.address() as { port: number }).port;
  const jamUrl = `http://127.0.0.1:${jamPort}`;

  // Seed initial library.sqlite with onboardingDone: false so Welcome Terms acceptance runs first
  {
    const db = new DatabaseSync(join(profile, 'library.sqlite'));
    db.exec(
      'CREATE TABLE tracks(id TEXT PRIMARY KEY,data TEXT NOT NULL,local_path TEXT,refreshed INTEGER NOT NULL);CREATE TABLE offline_tracks(track_id TEXT PRIMARY KEY REFERENCES tracks(id),path TEXT NOT NULL,size INTEGER NOT NULL,duration REAL NOT NULL,created INTEGER NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);',
    );
    db.prepare('INSERT INTO settings VALUES(?,?)').run(
      'preferences',
      JSON.stringify({
        ...defaults,
        jamEndpoint: jamUrl,
        onboardingDone: false,
        onlineConsent: false,
        catalogConsent: false,
        reducedMotion: true,
        transition: 'off',
        autoUpdate: false,
        volume: 0,
        appearance: { ...opticalDefaults, backgroundMotion: 0, background: 'solid' },
      }),
    );
    db.close();
  }

  let proc: ChildProcess | undefined;
  let browser: Browser | undefined;
  const errors: string[] = [];

  try {
    // =========================================================================
    // RUN 1: Onboarding -> Scenarios 1, 2, 3, 4, 5, 6, 7, 8, 9, 11
    // =========================================================================
    const run1 = await launchApp({
      exe,
      profile,
      runIndex: 1,
      cdpPort: 9391,
      errors,
    });
    proc = run1.proc;
    browser = run1.browser;
    let page = run1.page;

    // 0. Mandatory Onboarding + Terms/Privacy Version Acceptance
    await expect(page.getByText('Permitir acesso online?')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(new RegExp(CURRENT_TERMS_VERSION))).toBeVisible();
    await page.getByRole('button', { name: 'Permitir e continuar', exact: true }).click();
    await expect(page.getByText('Permitir acesso online?')).toHaveCount(0);

    const prefsAfterWelcome = await page.evaluate(async () => {
      const snap = await window.glass.bootstrap();
      return snap.preferences;
    });
    expect(prefsAfterWelcome.termsVersion).toBe(CURRENT_TERMS_VERSION);
    expect(prefsAfterWelcome.privacyVersion).toBe(CURRENT_PRIVACY_VERSION);
    expect(typeof prefsAfterWelcome.termsAcceptedAt).toBe('number');

    // 1. Verify Mandatory Login Gate locks the entire app (no sidebar, no close button)
    await expect(page.locator('.sidebar')).toHaveCount(0);
    const gate = page.locator('.auth-gate');
    await expect(gate).toBeVisible({ timeout: 15000 });
    await expect(gate.getByRole('button', { name: 'Fechar login' })).toHaveCount(0);
    await expect(gate.getByRole('heading', { name: 'Entrar no Liquid Hub' })).toBeVisible();
    await expect(gate.getByRole('button', { name: 'Continuar com Discord', exact: true })).toBeVisible();
    await expect(gate.getByRole('button', { name: 'Continuar com GitHub', exact: true })).toBeVisible();
    await expect(gate.getByRole('button', { name: 'Entrar com e-mail', exact: true })).toBeVisible();

    // Configure local brokerUrl directly from the mandatory login screen
    await gate.locator('summary', { hasText: 'Servidor de autenticação' }).click();
    await gate.getByLabel('Servidor de autenticação').fill(brokerUrl);

    // Scenario 1: Cadastro com e-mail + verificação de e-mail
    await gate.getByRole('button', { name: 'Entrar com e-mail', exact: true }).click();
    await gate.getByRole('button', { name: 'Criar conta com e-mail', exact: true }).click();
    await gate.getByLabel('Nome de exibição').fill('Ana Costa');
    await gate.getByLabel('E-mail').fill('ana@liquidhub.dev');
    await gate.getByLabel('Senha (mínimo 12 caracteres)').fill('StrongAuthPass!2026');
    await gate.getByRole('button', { name: 'Criar conta', exact: true }).click();

    await waitForAuthenticated(page, 'Ana Costa');
    await expect(page.locator('.sidebar .brand')).toBeVisible({ timeout: 15000 });
    await page.locator('.sidebar nav').getByRole('button', { name: 'Configurações', exact: true }).click();
    await expect(page.getByText(/Cofre DPAPI ativo/)).toBeVisible();
    await expect(page.getByText(/Não verificado/)).toBeVisible();

    const verifyMail = capturedEmails.find(
      m => m.kind === 'verify_email' && m.to === 'ana@liquidhub.dev',
    );
    expect(verifyMail).toBeTruthy();
    await page.getByRole('button', { name: 'Verificar e-mail com código', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Código de verificação').fill(verifyMail!.token);
    await page.getByRole('dialog').getByRole('button', { name: 'Verificar e-mail', exact: true }).click();
    await expect(page.getByText(/\(Verificado\)/)).toBeVisible();

    // Scenario 11 & Scenario 2: Logout re-locks the app -> Recuperação de senha + Login com e-mail
    await page.getByRole('button', { name: 'Encerrar sessão', exact: true }).click();
    await waitForLoggedOut(page);
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await expect(gate).toBeVisible();

    await gate.getByRole('button', { name: 'Entrar com e-mail', exact: true }).click();
    await gate.getByRole('button', { name: 'Esqueci minha senha', exact: true }).click();
    await gate.getByLabel('E-mail').fill('ana@liquidhub.dev');
    await gate.getByRole('button', { name: 'Enviar código de recuperação', exact: true }).click();
    await expect(gate.getByLabel('Código de recuperação')).toBeVisible();

    const resetMail = capturedEmails.find(
      m => m.kind === 'reset_password' && m.to === 'ana@liquidhub.dev',
    );
    expect(resetMail).toBeTruthy();
    await gate.getByLabel('Código de recuperação').fill(resetMail!.token);
    await gate.getByLabel('Nova senha (mínimo 12 caracteres)').fill('RecoveredPass!2026');
    await gate.getByRole('button', { name: 'Salvar nova senha', exact: true }).click();

    await expect(gate.getByLabel('E-mail ou nome de usuário')).toBeVisible();
    await gate.getByLabel('E-mail ou nome de usuário').fill('ana@liquidhub.dev');
    await gate.getByLabel('Senha').fill('RecoveredPass!2026');
    await gate.getByRole('button', { name: 'Entrar', exact: true }).click();
    await waitForAuthenticated(page, 'Ana Costa');
    await expect(page.locator('.sidebar .brand')).toBeVisible({ timeout: 15000 });
    await page.locator('.sidebar nav').getByRole('button', { name: 'Configurações', exact: true }).click();

    // Scenario 8: Vinculação de duas identidades (Ana vincula Discord + GitHub e depois desvincula Discord)
    await page.getByRole('button', { name: 'Vincular Discord', exact: true }).click();
    await expect(
      page.locator('[data-hub-provider="discord"]').getByRole('button', { name: 'Desvincular' }),
    ).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Vincular GitHub', exact: true }).click();
    await expect(
      page.locator('[data-hub-provider="github"]').getByRole('button', { name: 'Desvincular' }),
    ).toBeVisible({ timeout: 15000 });

    const linkedStatus = await page.evaluate(() => window.glass.hubStatus());
    expect(linkedStatus.identities?.map(i => i.provider).sort()).toEqual([
      'discord',
      'email',
      'github',
    ]);

    // Unlink Discord cleanly while Email + GitHub stay intact
    await page.locator('[data-hub-provider="discord"]').getByRole('button', { name: 'Desvincular' }).click();
    await expect(
      page.locator('[data-hub-provider="discord"]').getByRole('button', { name: 'Vincular Discord' }),
    ).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Encerrar sessão', exact: true }).click();
    await waitForLoggedOut(page);
    await expect(gate).toBeVisible();

    // Scenario 3 & Scenario 9: Login com Discord + tentativa de vincular GitHub já pertencente a outro usuário (Ana)
    discordMock.setProfile({
      id: '4002222',
      username: 'lucas_discord',
      displayName: 'Lucas Discord',
      email: 'lucas@example.com',
      emailVerified: true,
    });
    await gate.getByRole('button', { name: 'Continuar com Discord', exact: true }).click();
    await waitForAuthenticated(page, 'Lucas Discord');
    await page.getByRole('button', { name: 'Configurações', exact: true }).click();

    // Lucas tem apenas Discord -> botão Desvincular deve ficar desabilitado (não deixa excluir único método)
    await expect(
      page.locator('[data-hub-provider="discord"]').getByRole('button', { name: 'Desvincular' }),
    ).toBeDisabled();

    // Tenta vincular o GitHub da Ana (id 5002002) na conta do Lucas -> REJEITADO
    await page.getByRole('button', { name: 'Vincular GitHub', exact: true }).click();
    await expect(page.locator('.account-notice')).toContainText(/outro usuário/i, {
      timeout: 15000,
    });
    await expect(
      page.locator('[data-hub-provider="github"]').getByRole('button', { name: 'Vincular GitHub' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Encerrar sessão', exact: true }).click();
    await waitForLoggedOut(page);
    await expect(gate).toBeVisible();

    // Scenario 5: Cancelamento do OAuth (recusa no provedor e cancelamento no aplicativo)
    discordMock.setProfile({
      mode: 'cancel',
      id: '4003333',
      username: 'canceled_user',
    });
    await gate.getByRole('button', { name: 'Continuar com Discord', exact: true }).click();
    await expect(gate.locator('.auth-error-banner')).toContainText(/cancelada/i, {
      timeout: 15000,
    });
    expect((await page.evaluate(() => window.glass.hubStatus())).authenticated).toBe(false);

    discordMock.setProfile({
      mode: 'approve',
      delayMs: 4000,
      id: '4004444',
      username: 'slow_discord',
      displayName: 'Slow',
    });
    await gate.getByRole('button', { name: 'Continuar com Discord', exact: true }).click();
    await gate.locator('.auth-pending-banner').getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(gate.locator('.auth-error-banner')).toContainText(/cancelada/i, {
      timeout: 15000,
    });
    expect((await page.evaluate(() => window.glass.hubStatus())).authenticated).toBe(false);

    // Scenario 7: Discord sem e-mail disponível
    discordMock.setProfile({
      mode: 'approve',
      id: '4007777',
      username: 'discord_no_email',
      displayName: 'Sem Email Discord',
      email: null,
      emailVerified: false,
    });
    await gate.getByRole('button', { name: 'Continuar com Discord', exact: true }).click();
    await waitForAuthenticated(page, 'Sem Email Discord');
    expect((await page.evaluate(() => window.glass.hubStatus())).email).toBeNull();
    await page.getByRole('button', { name: 'Configurações', exact: true }).click();
    await page.getByRole('button', { name: 'Encerrar sessão', exact: true }).click();
    await waitForLoggedOut(page);
    await expect(gate).toBeVisible();

    // Scenario 4 & Scenario 6: Login com GitHub + e-mail privado no GitHub (403 no /user/emails)
    githubMock.setProfile({
      id: '5007777',
      username: 'privado_gh',
      displayName: 'Privado GitHub',
      email: null,
      privateEmailsForbidden: true,
      avatar: 'https://avatars.githubusercontent.com/u/5007777?v=4',
    });
    await gate.getByRole('button', { name: 'Continuar com GitHub', exact: true }).click();
    await waitForAuthenticated(page, 'Privado GitHub');
    await page.getByRole('button', { name: 'Configurações', exact: true }).click();
    await expect(page.locator('[data-hub-provider="github"]')).toContainText(/E-mail privado/);

    await browser.close().catch(() => {});
    stopProcessTree(proc);
    browser = undefined;
    proc = undefined;

    // =========================================================================
    // RUN 2: Scenario 10 (Persistência de sessão entre reinicializações do app)
    // =========================================================================
    const run2 = await launchApp({
      exe,
      profile,
      runIndex: 2,
      cdpPort: 9392,
      brokerUrl,
      errors,
    });
    proc = run2.proc;
    browser = run2.browser;
    page = run2.page;

    await waitForAuthenticated(page, 'Privado GitHub');
    await expect(page.locator('.auth-gate')).toHaveCount(0);
    await expect(page.locator('.sidebar .brand')).toBeVisible();
    const persistedAudit = await page.evaluate(async () => {
      const status = await window.glass.hubStatus();
      return {
        status,
        hasJwtInStorage: /eyJ[A-Za-z0-9_-]{10,}/.test(
          JSON.stringify({ local: localStorage, session: sessionStorage }),
        ),
      };
    });
    expect(persistedAudit.status.authenticated).toBe(true);
    expect(persistedAudit.hasJwtInStorage).toBe(false);

    // Logout before Scenario 12 so the app starts unauthenticated with an incoming JAM invite
    await page.getByRole('button', { name: 'Configurações', exact: true }).click();
    await page.getByRole('button', { name: 'Encerrar sessão', exact: true }).click();
    await waitForLoggedOut(page);
    await expect(page.locator('.auth-gate')).toBeVisible();

    await browser.close().catch(() => {});
    stopProcessTree(proc);
    browser = undefined;
    proc = undefined;

    // =========================================================================
    // RUN 3: Scenario 12 (Convite de JAM recebido antes do login + retorno automático)
    // =========================================================================
    // Host Ana obtains a valid Ed25519 JWT and creates a requireAuth JAM room
    const vHost = randomBytes(32).toString('base64url');
    const hostLoginRes = await fetch(`${brokerUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'ana@liquidhub.dev',
        password: 'RecoveredPass!2026',
        client_id: 'liquid-hub-desktop',
        code_challenge: computePkceS256Challenge(vHost),
        code_challenge_method: 'S256',
      }),
    });
    expect(hostLoginRes.status).toBe(200);
    const { code: hostPkceCode } = (await hostLoginRes.json()) as { code: string };
    const hostTokRes = await fetch(`${brokerUrl}/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: hostPkceCode,
        client_id: 'liquid-hub-desktop',
        code_verifier: vHost,
      }),
    });
    const hostTokJson = (await hostTokRes.json()) as { access_token: string };
    const jamCreateRes = await fetch(`${jamUrl}/v1/jam`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostTokJson.access_token}`,
      },
      body: JSON.stringify({
        action: 'create',
        name: 'HostAna',
        roomName: 'Sessão Autenticada JAM',
        requireAuth: true,
        clientId: 'e2e_jam_host_1',
        timestamp: Date.now(),
        nonce: randomBytes(16).toString('hex'),
      }),
    });
    expect(jamCreateRes.status).toBe(201);
    const createdRoom = (await jamCreateRes.json()) as { code: string };
    expect(createdRoom.code).toMatch(/^[A-Z0-9]{8}$/);

    // Reset local terms acceptance in preferences so AuthModal also enforces Terms check during invite login
    {
      const db = new DatabaseSync(join(profile, 'library.sqlite'));
      const row = db.prepare("SELECT value FROM settings WHERE key = 'preferences'").get() as {
        value: string;
      };
      const parsedPrefs = JSON.parse(row.value);
      delete parsedPrefs.termsVersion;
      delete parsedPrefs.privacyVersion;
      delete parsedPrefs.termsAcceptedAt;
      db.prepare("UPDATE settings SET value = ? WHERE key = 'preferences'").run(
        JSON.stringify(parsedPrefs),
      );
      db.close();
    }

    githubMock.setProfile({
      id: '5009999',
      username: 'jam_guest_gh',
      displayName: 'Convidado JAM GitHub',
      email: 'guest.jam@example.com',
      emailVerified: true,
      avatar: 'https://avatars.githubusercontent.com/u/5009999?v=4',
    });

    const deepLinkInvite = `liquidhub://jam/join/${createdRoom.code}?endpoint=${encodeURIComponent(jamUrl)}`;
    const run3 = await launchApp({
      exe,
      profile,
      runIndex: 3,
      cdpPort: 9393,
      brokerUrl,
      args: [deepLinkInvite],
      errors,
    });
    proc = run3.proc;
    browser = run3.browser;
    page = run3.page;

    // App stays strictly locked on mandatory login gate showing the pending JAM invite banner
    const gateRun3 = page.locator('.auth-gate');
    await expect(gateRun3).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await expect(
      gateRun3.getByText('Você recebeu um convite de JAM — entre na sua conta para continuar.'),
    ).toBeVisible({ timeout: 15000 });
    await gateRun3.getByRole('button', { name: 'Continuar com GitHub', exact: true }).click();
    await expect(
      gateRun3.getByText('Aceite os Termos de Uso e a Política de Privacidade para continuar.'),
    ).toBeVisible();

    await gateRun3.locator('input[type="checkbox"]').check();
    await gateRun3.getByRole('button', { name: 'Continuar com GitHub', exact: true }).click();

    // Unlocks app AND opens JamInviteModal automatically ready to join!
    await waitForAuthenticated(page, 'Convidado JAM GitHub');
    await expect(page.locator('.auth-gate')).toHaveCount(0);
    await expect(page.getByText('Sessão Autenticada JAM')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Esta sala exige autenticação no Liquid Hub.')).toHaveCount(0);

    await page.getByRole('button', { name: 'Entrar na JAM', exact: true }).click();
    const livePill = page.locator('.sidebar .jam-live-pill');
    await expect(livePill).toContainText(/JAM ao vivo\s*2/, { timeout: 15000 });
    await expect(livePill).toHaveAttribute('title', /2 ouvinte\(s\)/);

    expect(errors).toEqual([]);
    await writeFile(
      'test-results/auth-multi-provider-e2e.json',
      JSON.stringify(
        {
          scenariosVerified: 12,
          termsVersion: CURRENT_TERMS_VERSION,
          emailSignupAndVerify: true,
          emailLoginAndRecovery: true,
          discordOAuth: true,
          discordWithoutEmail: true,
          githubOAuth: true,
          githubPrivateEmail: true,
          oauthCancel: true,
          identityLinkingAndSafeUnlink: true,
          crossUserLinkRejected: true,
          sessionPersistenceAcrossRestart: true,
          logoutVerified: true,
          preLoginJamInviteRestored: true,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser?.close().catch(() => {});
    stopProcessTree(proc);
    brokerServer.closeAllConnections();
    jamServer.closeAllConnections();
    await new Promise<void>(r => brokerServer.close(() => r()));
    await new Promise<void>(r => jamServer.close(() => r()));
    await discordMock.close();
    await githubMock.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
});
