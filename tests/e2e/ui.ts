import { expect, type Page } from '@playwright/test';

export const sidebar = (page: Page) =>
  page.getByRole('complementary', { name: 'Barra lateral', exact: true });

export const activeAudio = (page: Page) => page.locator('audio[data-active="true"]');

export function navButton(page: Page, name: string) {
  const scope =
    name === 'Configurações'
      ? sidebar(page)
      : page.getByRole('navigation', { name: 'Navegação principal', exact: true });
  return scope.getByRole('button', { name, exact: true });
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
