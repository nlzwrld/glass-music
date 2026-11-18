import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createCatalog } from '../../server/catalog';

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
  await mkdir('../../work/profiles', { recursive: true });
  const profile = await mkdtemp(resolve('../../work/profiles/catalog-'));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let page: Page;
  try {
    processHandle = spawn(process.env.GLASS_EXE || join(process.env.LOCALAPPDATA!, 'Liquid Hub/liquid-hub.exe'), [], { windowsHide: true, env: { ...process.env, GLASS_TEST_DATA: profile, GLASS_TEST_CATALOG_URL: base, WEBVIEW2_USER_DATA_FOLDER: join(profile, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9339' } });
    for (let i = 0; i < 90; i++) { try { if ((await fetch('http://127.0.0.1:9339/json/version')).ok) break; } catch {} await new Promise(r => setTimeout(r, 300)); }
    browser = await chromium.connectOverCDP('http://127.0.0.1:9339');
    page = browser.contexts()[0].pages()[0];
    page.on('pageerror', e => errors.push(e.message));
    await expect(page.getByRole('button',{name:'Permitir e continuar'})).toBeVisible({timeout:15000});
    await expect(page.getByRole('button', { name: 'Ativar acesso online', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.glass.integrations())).toMatchObject({ version: '2.0.1', catalogConfigured: true });
    // Opening Home and calling the bridge directly must not access the catalog before consent.
    const denied = await page.evaluate(async () => { try { await window.glass.discover('before-consent'); return false; } catch { return true; } });
    expect(denied).toBe(true); expect(traffic).toEqual([]);
    await page.getByRole('button', { name: 'Permitir e continuar', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.glass.bootstrap()).preferences.catalogConsent)).toBe(true);
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
    await expect(page.locator('.results-count')).toHaveText('2 resultados');
    await page.getByRole('button', { name: 'Carregar mais resultados' }).click();
    await expect(page.locator('.results-count')).toHaveText('4 resultados');
    await expect(page.getByRole('button', { name: 'Carregar mais resultados' })).toHaveCount(0);
    failSoundcloud = true;
    const request = { query: 'recover', kind: 'track' as const, source: 'all' as const, requestId: 'recover-one' };
    const partial = await page.evaluate(r => window.glass.search(r), request);
    expect(partial.items.map(t => t.source)).toEqual(['youtube']); expect(partial.notices).toHaveLength(1);
    failSoundcloud = false;
    const recovered = await page.evaluate(r => window.glass.search(r), { ...request, requestId: 'recover-two' });
    expect(recovered.items.map(t => t.source)).toEqual(['youtube', 'soundcloud']); expect(recovered.notices).toEqual([]);
    await page.getByRole('button', { name: 'Configurações', exact: true }).click();
    await page.getByRole('switch', { name: 'Acesso online' }).click();
    await expect.poll(() => page.evaluate(async () => (await window.glass.bootstrap()).preferences.catalogConsent)).toBe(false);
    const count = traffic.length;
    await page.getByRole('button', { name: 'Início', exact: true }).click();
    await expect(page.locator('.online-catalog')).toHaveCount(0);
    const after = await page.evaluate(r => window.glass.search(r), { ...request, requestId: 'after-revoke' });
    expect(after.items).toEqual([]); expect(after.notices.join()).toContain('Ative as integrações'); expect(traffic).toHaveLength(count);
    expect(errors).toEqual([]);
    await writeFile('test-results/catalog-validation.json', JSON.stringify({ version: '2.0.1', testedAt: new Date().toISOString(), desktop: 'real Tauri/WebView2', catalog: 'real HTTP server', platformResponses: 'test fixtures, no live credentials', consentBeforeNetwork: true, noEndUserKeys: true, discoveryBothSources: true, paginationItems: 4, transientFailureRecovery: true, revocationBlocksNetwork: true, responsive920: true, errors }, null, 2));
  } finally {
    if (processHandle && !processHandle.killed) processHandle.kill();
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  }
});
