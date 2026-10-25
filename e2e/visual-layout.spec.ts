import { expect, test } from '@playwright/test';

const widths = [320, 390, 768, 1440];

async function fitsViewport(page: import('@playwright/test').Page, width: number) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `Horizontal overflow at ${width}px on ${page.url()}`).toBeLessThanOrEqual(width);
}

test('primary public screens and organizer dialogs fit phone and desktop widths', async ({ page }) => {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/', '/login', '/register', '/map/demo']) {
      await page.goto(path);
      await fitsViewport(page, width);
    }
  }
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/editor/demo');
    await page.getByRole('button', { name: 'Публикация', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Карта готова к показу?' });
    await expect(dialog).toBeVisible();
    const dialogBounds = await dialog.boundingBox();
    expect(dialogBounds).not.toBeNull();
    expect(dialogBounds!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(width);
    await fitsViewport(page, width);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Редактор плана' }).click();
    const editor = page.getByRole('dialog', { name: 'Редактор плана' });
    await expect(editor).toBeVisible();
    await fitsViewport(page, width);
    if (width <= 900) {
      const header = editor.locator('.plan-header');
      const headerBounds = await header.boundingBox();
      expect(headerBounds).not.toBeNull();
      for (const button of await header.locator('button').all()) {
        const bounds = await button.boundingBox();
        if (!bounds) continue;
        expect(bounds.x).toBeGreaterThanOrEqual(headerBounds!.x - 1);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(headerBounds!.x + headerBounds!.width + 1);
      }
    }
  }
});

test('account cards and team forms remain readable without horizontal overflow', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Ваше имя').fill('Аудит интерфейса');
  await page.getByLabel('Электронная почта').fill(`visual-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('Пароль').fill('visual-layout-password');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByLabel('Название пространства').fill('Карта для проверки макета');
  await page.getByRole('button', { name: /Новая карта/ }).click();
  await expect(page).toHaveURL(/\/editor\/space-/);
  await page.goto('/account');
  const card = page.locator('.portal-space-card').filter({ hasText: 'Карта для проверки макета' });
  await expect(card).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await fitsViewport(page, width);
    const cardBounds = await card.boundingBox();
    expect(cardBounds).not.toBeNull();
    for (const action of await card.locator('.portal-space-actions > *').all()) {
      const bounds = await action.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(cardBounds!.x - 1);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(cardBounds!.x + cardBounds!.width + 1);
    }
  }
});

test('mobile route focus action stays separate from zoom controls', async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/map/demo');
    await page.getByRole('button', { name: 'Маршрут', exact: true }).click();
    await page.getByRole('combobox', { name: 'Куда', exact: true }).selectOption('f2-orbit');
    await page.getByRole('button', { name: 'Построить маршрут', exact: true }).click();
    await expect(page.getByTestId('route-result')).toBeVisible();
    const focus = await page.getByRole('button', { name: 'Показать маршрут' }).boundingBox();
    const zoom = await page.locator('.map-controls').boundingBox();
    expect(focus).not.toBeNull();
    expect(zoom).not.toBeNull();
    expect(focus!.y + focus!.height).toBeLessThanOrEqual(zoom!.y - 4);
    await fitsViewport(page, width);
  }
});
