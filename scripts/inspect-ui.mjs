import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9340');
const page = browser.contexts()[0].pages()[0];
await expect(page.locator('.home-greeting')).toBeVisible({ timeout: 25000 });
const errors = []; page.on('pageerror', e => errors.push(e.message));
if (process.argv.includes('--listen')) {
  await page.evaluate(async () => { const s = await window.glass.bootstrap(); await window.glass.preferences({ ...s.preferences, volume: 0 }); });
  await page.reload(); await expect(page.locator('.home-greeting')).toBeVisible();
  await page.getByRole('button', { name: 'Reproduzir Meu Flow', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate(a => a.currentTime)).toBeGreaterThan(.5);
  const footer = page.getByRole('contentinfo', { name: 'Controles de reprodução' });
  for (let i = 0; i < 2; i++) { await footer.getByRole('button', { name: 'Próxima faixa', exact: true }).click(); await expect.poll(() => page.locator('audio').evaluate(a => a.currentTime)).toBeGreaterThan(.4); }
  await footer.getByRole('button', { name: 'Pausar', exact: true }).click();
}
const dims = process.argv.find(a => /^\d+x\d+$/.test(a));
if (dims) { const [width, height] = dims.split('x').map(Number); const session = await browser.contexts()[0].newCDPSession(page); await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); }
await new Promise(r => setTimeout(r, 700));
await mkdir('test-results/reference', { recursive: true });
const name = process.argv.find(a => a.startsWith('--name='))?.split('=')[1] || 'current';
await page.screenshot({ path: `test-results/reference/${name}.png` });
const info = await page.evaluate(() => ({ viewport: [innerWidth,innerHeight], elements: ['.glass-window','.sidebar','.main-shell','.global-search','.home-greeting','.feature-grid','.recent-section','.discovery-section','.side-player','.side-cover','.player'].map(selector => { const e = document.querySelector(selector); const r = e?.getBoundingClientRect(); return { selector, box: r ? { x:r.x, y:r.y, width:r.width, height:r.height } : null }; }), audioElements:document.querySelectorAll('audio').length, horizontalOverflow:document.documentElement.scrollWidth > innerWidth }));
await writeFile(`test-results/reference/${name}.json`, JSON.stringify({ ...info, errors },null,2));
console.log(JSON.stringify({ ...info, errors }));
await browser.close();
