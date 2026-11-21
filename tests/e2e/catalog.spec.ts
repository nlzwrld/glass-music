import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createBroker } from '../../server/broker';
import { createCatalog } from '../../server/catalog';
import { navButton, waitForCdp } from './ui';

// The desktop and catalog server are real. Only external platform responses are fixtures.
// This test never sends owner credentials or fixture search terms to a real platform.
test('shared catalog: consent, discovery, search, pagination and recovery without user keys', async () => {
  let failSoundcloud = false;
  let browser: Browser | undefined;
  let processHandle: ChildProcess | undefined;
  const traffic: string[] = [], errors: string[] = [];
  const video = (second = false) => ({ id: second ? 'AAAAAAAAAA2' : 'AAAAAAAAAA1', snippet: { title: second ? 'YouTube segunda página' : 'YouTube catálogo de teste', channelTitle: 'Artista de teste' }, contentDetails: { duration: 'PT2M3S' }, status: { embeddable: true } });
  const api = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith('soundcloud.com') && failSoundcloud) return new Response('{}', { status: 503 });
    if (url.pathname === '/oauth/token') return Response.json({ access_token: 'fixture-oauth', expires_in: 3600 });
    if (url.hostname === 'api.soundcloud.com') {
      const next = url.searchParams.has('offset');
      return Response.json({ collection: [{ id: next ? 124 : 123, urn: `soundcloud:tracks:${next ? 124 : 123}`, title: next ? 'SoundCloud segunda página' : 'SoundCloud catálogo de teste', user: { username: 'Artista de teste' }, duration: 90000, permalink_url: `https://soundcloud.com/glass-fixture/${next ? 'two' : 'one'}` }], next_href: next ? undefined : 'https://api.soundcloud.com/tracks?offset=20' });
    }
    if (url.pathname.endsWith('/search')) {
      const next = url.searchParams.has('pageToken'), row = video(next);
      return Response.json({ items: [{ ...row, id: { videoId: row.id } }], nextPageToken: next ? undefined : 'second-page' });
    }
    if (url.pathname.endsWith('/videos')) return Response.json({ items: [video(url.searchParams.get('id') === 'AAAAAAAAAA2')] });
    throw new Error(`Unexpected upstream: ${url.origin}`);
  };
  const server = createCatalog({ YOUTUBE_API_KEY: 'fixture-owner-key', SOUNDCLOUD_CLIENT_ID: 'fixture-owner-id', SOUNDCLOUD_CLIENT_SECRET: 'fixture-owner-secret' }, api as typeof fetch);
  server.on('request', req => traffic.push(req.url || ''));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const brokerServer = createBroker(
    {
      BROKER_ACCESS_TOKEN: 'catalog-e2e-broker-secret-token-123456',
      SOUNDCLOUD_CLIENT_ID: 'catalog-sc-id',
      SOUNDCLOUD_CLIENT_SECRET: 'catalog-sc-secret',
    },
    async () => new Response(JSON.stringify({ access_token: 'sc', expires_in: 3600 })),
    Date.now,
    { argon2Params: { memory: 1024, passes: 1, parallelism: 1, tagLength: 16 } },
  );
  await new Promise<void>(done => brokerServer.listen(0, '127.0.0.1', done));
  const brokerUrl = `http://127.0.0.1:${(brokerServer.address() as { port: number }).port}`;
  await mkdir('.test-data/profiles', { recursive: true });
  const profile = await mkdtemp(resolve('.test-data/profiles/catalog-'));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cargoManifest = await readFile('src-tauri/Cargo.toml', 'utf8');
  const targetVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargoManifest)?.[1];
  expect(targetVersion).toBeTruthy();
  let page: Page;
  try {
    processHandle = spawn(process.env.GLASS_EXE || join(process.env.LOCALAPPDATA!, 'Liquid Hub/liquid-hub.exe'), [], { windowsHide: true, env: { ...process.env, GLASS_TEST_DATA: profile, GLASS_TEST_CATALOG_URL: base, GLASS_TEST_DISABLE_DIRECT: '1', LIQUID_HUB_BROKER_URL: brokerUrl, WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9339' } });
    await waitForCdp(processHandle, 9339, 90, 300);
    browser = await chromium.connectOverCDP('http://127.0.0.1:9339');
    const context = browser.contexts()[0];
    page = context.pages()[0] || await context.waitForEvent('page', { timeout: 15000 });
    page.on('pageerror', e => errors.push(e.message));
    await expect(page.getByRole('button',{name:'Permitir e continuar'})).toBeVisible({timeout:15000});
    await expect(page.getByRole('dialog', { name: 'Permitir acesso online?' }).getByRole('button', { name: 'Agora não', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.glass.integrations())).toMatchObject({ version: targetVersion, catalogConfigured: true });
    // Opening Home and calling the bridge directly must not access the catalog before consent.
    const denied = await page.evaluate(async () => { try { await window.glass.discover('before-consent'); return false; } catch { return true; } });
    expect(denied).toBe(true); expect(traffic).toEqual([]);
    await page.getByRole('button', { name: 'Permitir e continuar', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.glass.bootstrap()).preferences.catalogConsent)).toBe(true);
    const gate = page.locator('.auth-gate');
    await expect(gate).toBeVisible({ timeout: 15000 });
    await gate.getByRole('button', { name: 'Entrar com e-mail', exact: true }).click();
    await gate.getByRole('button', { name: 'Criar conta com e-mail', exact: true }).click();
    await gate.getByLabel('Nome de exibição').fill('CatalogTester');
    await gate.getByLabel('E-mail').fill('catalog-qa@liquidhub.dev');
    await gate.getByLabel('Senha (mínimo 12 caracteres)').fill('CatalogStrongPass!2026');
    await gate.getByRole('button', { name: 'Criar conta', exact: true }).click();
    await expect(page.locator('.sidebar .brand')).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Início', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Música em alta no YouTube · BR' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Eletrônica no SoundCloud' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reproduzir YouTube catálogo de teste', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reproduzir SoundCloud catálogo de teste', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/catalog-fixture-home.png' });
    const cdp = await browser.contexts()[0].newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 920, height: 650, deviceScaleFactor: 1, mobile: false });
    expect(await page.evaluate(() => { const main = document.querySelector('.main-scroll')!; return main.scrollWidth <= main.clientWidth + 1; })).toBe(true);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await page.keyboard.press('Control+k');
    await page.getByRole('textbox', { name: 'Buscar músicas, artistas e playlists' }).fill('ambient');
    await page.getByRole('button', { name: 'Músicas', exact: true }).click();
    // Keep the fixture offline: "Todas" also includes Deezer, which is not a shared-catalog provider.
    const rows = page.locator('.search-page .track-row');
    for (const source of ['YouTube', 'SoundCloud']) {
      await page.getByRole('button', { name: source, exact: true }).click();
      await expect(rows).toHaveCount(1);
      await page.getByRole('button', { name: 'Carregar mais', exact: true }).click();
      await expect(rows).toHaveCount(2);
      await expect(page.getByRole('button', { name: 'Carregar mais', exact: true })).toHaveCount(0);
    }
    failSoundcloud = true;
    const request = { query: 'recover', kind: 'track' as const, source: 'soundcloud' as const, requestId: 'recover-one' };
    const healthy = await page.evaluate(r => window.glass.search(r), { ...request, source: 'youtube' as const, requestId: 'recover-youtube' });
    expect(healthy.items.map(t => t.source)).toEqual(['youtube']); expect(healthy.notices).toEqual([]);
    const partial = await page.evaluate(r => window.glass.search(r), request);
    expect(partial.items).toEqual([]); expect(partial.notices).toHaveLength(1);
    failSoundcloud = false;
    const recovered = await page.evaluate(r => window.glass.search(r), { ...request, requestId: 'recover-two' });
    expect(recovered.items.map(t => t.source)).toEqual(['soundcloud']); expect(recovered.notices).toEqual([]);
    await navButton(page,'Configurações').click();
    await page.getByRole('switch', { name: 'Acesso online' }).click();
    await expect.poll(() => page.evaluate(async () => (await window.glass.bootstrap()).preferences.catalogConsent)).toBe(false);
    const count = traffic.length;
    await page.getByRole('button', { name: 'Início', exact: true }).click();
    await expect(page.locator('.online-catalog')).toHaveCount(0);
    await expect(page.locator('.catalog-intro')).toContainText('Acesso online desativado');
    const after = await page.evaluate(r => window.glass.search(r), { ...request, requestId: 'after-revoke' });
    expect(after.items).toEqual([]); expect(after.notices.join()).toContain('Ative as integrações'); expect(traffic).toHaveLength(count);
    expect(errors).toEqual([]);
    await writeFile('test-results/catalog-validation.json', JSON.stringify({ version: targetVersion, testedAt: new Date().toISOString(), desktop: 'real Tauri/WebView2', catalog: 'real HTTP server', platformResponses: 'test fixtures, no live credentials', consentBeforeNetwork: true, noEndUserKeys: true, discoveryBothSources: true, paginationItems: 4, transientFailureRecovery: true, revocationBlocksNetwork: true, responsive920: true, errors }, null, 2));
  } finally {
    if (processHandle && !processHandle.killed) processHandle.kill();
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    brokerServer.closeAllConnections(); await new Promise<void>(done => brokerServer.close(() => done()));
  }
});
