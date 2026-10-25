import { expect, test } from '@playwright/test';

test('390px mobile map and route remain usable without horizontal overflow', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/map/demo');
  await expect(page.getByRole('heading', { name: 'Куда отправимся?' })).toBeVisible();
  await expect(page.getByTestId('floor-map')).toHaveAttribute('aria-label', 'План: 1 этаж');
  await page.screenshot({ path: testInfo.outputPath('mobile-overview-390.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.getByRole('textbox', { name: 'Поиск места' }).fill('Орбита');
  await page.locator('.place-card').filter({ hasText: 'Переговорная «Орбита»' }).click();
  await page.getByRole('button', { name: 'Проложить маршрут' }).click();
  await page.getByRole('checkbox', { name: /Без лестниц/ }).check();
  await page.getByRole('button', { name: 'Построить маршрут', exact: true }).click();
  await expect(page.getByTestId('route-result')).toContainText('на лифте');
  await page.locator('.floor-switch').getByRole('button', { name: '2 этаж' }).click();
  await expect(page.getByTestId('floor-map')).toHaveAttribute('aria-label', 'План: 2 этаж');
  await expect(page.getByTestId('route-segment')).toHaveCount(1);
  await page.getByRole('button', { name: 'Увеличить карту' }).click();
  await expect(page.locator('.map-controls')).toContainText('125%');
  await page.getByRole('button', { name: 'Показать весь этаж' }).click();
  await page.getByRole('button', { name: /Объём/ }).click();
  await expect(page.getByTestId('isometric-map')).toBeVisible();
  await expect(page.locator('.iso-interior').first()).toBeVisible();
  await page.getByRole('button', { name: 'Показать обстановку', exact: true }).click();
  await expect(page.locator('.iso-interior')).toHaveCount(0);
  await page.getByRole('button', { name: 'План', exact: true }).click();
  await expect(page.locator('.room-interior')).toHaveCount(0);
  await page.getByRole('button', { name: 'Показать обстановку', exact: true }).click();
  await expect(page.locator('.room-interior').first()).toBeVisible();
  await page.getByRole('button', { name: /Объём/ }).click();
  await expect(page.getByTestId('isometric-map')).toContainText('Лестница');
  await expect(page.getByTestId('isometric-map')).toContainText('Лифт');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath('mobile-isometric-map-390.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'План', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath('mobile-accessible-route-390.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
