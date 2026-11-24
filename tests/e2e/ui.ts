import { expect, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';

export const sidebar = (page: Page) =>
  page.getByRole('complementary', { name: 'Barra lateral', exact: true });

export const activeAudio = (page: Page) => page.locator('audio[data-active="true"]');

export function navButton(page: Page, name: string) {
  const scope = page.getByRole('navigation', { name: 'Navegação principal', exact: true });
  return scope.getByRole('button', { name, exact: true });
}

export async function openProfileMenuPage(page: Page, name: 'Configurações' | 'Histórico' | 'Perfil') {
  const trigger = page.getByRole('button', { name: 'Perfil e configurações', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

export async function authenticateLocalBroker(
  page: Page,
  opts?: { name?: string; email?: string; password?: string },
) {
  const gate = page.locator('.auth-gate');
  await expect(gate).toBeVisible({ timeout: 15000 });
  const terms = gate.locator('input[type="checkbox"]');
  if (!(await terms.isChecked())) {
    await terms.check();
  }
  await gate.getByRole('button', { name: 'Entrar com e-mail', exact: true }).click();
  await gate.getByRole('button', { name: 'Criar conta com e-mail', exact: true }).click();
  await gate.getByLabel('Nome de exibição').fill(opts?.name || 'Usuário Teste');
  await gate.getByLabel('E-mail').fill(opts?.email || 'e2e@liquidhub.dev');
  await gate
    .getByLabel('Senha (mínimo 12 caracteres)')
    .fill(opts?.password || 'LocalE2EAuthPass!2026');
  await gate.getByRole('button', { name: 'Criar conta', exact: true }).click();
  await expect(page.locator('.sidebar .brand')).toBeVisible({ timeout: 15000 });
}

export function sidebarPlaylist(page: Page, name: string) {
  return sidebar(page)
    .getByRole('button')
    .filter({ has: page.getByText(name, { exact: true }) });
}

export async function openSidebarPlaylist(page: Page, name: string) {
  const target = sidebarPlaylist(page, name);
  await expect(target).toHaveCount(1);
  await target.click();
}

export async function chooseSidebarCreation(
  page: Page,
  item: 'Nova playlist' | 'Importar por link',
) {
  await sidebar(page)
    .getByRole('button', { name: 'Criar ou importar', exact: true })
    .click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

export const importUrlInput = (page: Page) =>
  page.getByRole('dialog').getByRole('textbox', { name: 'URL', exact: true });

export async function selectGlass(page: Page) {
  const glass = page.getByRole('button', { name: 'Liquid Glass', exact: true });
  await expect(glass).toBeVisible();
  if ((await glass.getAttribute('aria-pressed')) !== 'true') await glass.click();
  await expect(glass).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => page.evaluate(async () => (await window.glass.bootstrap()).preferences.uiStyle))
    .toBe('glass');
}

export async function waitForCdp(
  proc: ChildProcess,
  port: number,
  attempts = 90,
  intervalMs = 200,
) {
  let stdout = '';
  let stderr = '';
  let spawnError: Error | undefined;
  proc.stdout?.on('data', chunk => {
    stdout = (stdout + String(chunk)).slice(-4000);
  });
  proc.stderr?.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  proc.on('error', error => {
    spawnError = error;
  });
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  for (let i = 0; i < attempts; i++) {
    if (spawnError) throw spawnError;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `Liquid Hub exited before CDP port ${port} opened (code=${proc.exitCode}, signal=${proc.signalCode}). stderr=${stderr.trim() || '<empty>'} stdout=${stdout.trim() || '<empty>'}`,
      );
    }
    try {
      if ((await fetch(endpoint)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for CDP at ${endpoint} (pid=${proc.pid ?? 'none'}, exitCode=${proc.exitCode}). stderr=${stderr.trim() || '<empty>'} stdout=${stdout.trim() || '<empty>'}`,
  );
}
