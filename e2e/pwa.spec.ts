import { expect, test } from '@playwright/test';

test('installable app manifest and icons are served with standalone launch metadata', async ({
  page,
}) => {
  const response = await page.request.get('/manifest.webmanifest');
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/map/demo?source=installed-app');
  for (const icon of manifest.icons.filter((item: { sizes: string }) => item.sizes !== 'any')) {
    expect((await page.request.get(icon.src)).ok()).toBeTruthy();
  }
  await page.goto('/map/demo');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  await expect(page.getByRole('button', { name: 'Установить приложение' })).toBeVisible();
});

test('installation control gives browser-specific home-screen instructions', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
    });
  });
  await page.goto('/map/demo');
  await page.getByRole('button', { name: 'Установить приложение' }).click();
  const dialog = page.getByRole('dialog', { name: 'Карта пространства — как приложение' });
  await expect(dialog).toContainText('Откройте эту страницу в Safari');
  await expect(dialog).toContainText('Нажмите «Поделиться»');
  await expect(dialog).toContainText('На экран Домой');
  await dialog.getByRole('button', { name: 'Понятно' }).click();
  await expect(dialog).toBeHidden();
});

test('native browser install prompt is invoked from the product button', async ({ page }) => {
  await page.goto('/map/demo');
  await page.evaluate(() => {
    const installEvent = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(installEvent, {
      prompt: async () => {
        window.sessionStorage.setItem('pwa-prompt-called', 'yes');
      },
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    });
    window.dispatchEvent(installEvent);
  });
  await page.getByRole('button', { name: 'Установить приложение' }).click();
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem('pwa-prompt-called')))
    .toBe('yes');
  await expect(page.getByRole('button', { name: 'Установить приложение' })).toBeHidden();
});

test('390px installed-app entry keeps the map and install help inside the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
    });
  });
  await page.goto('/map/demo?source=installed-app');
  await expect(page.getByRole('button', { name: 'Установить приложение' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Установить приложение' }).click();
  const dialog = page.getByRole('dialog', { name: 'Карта пространства — как приложение' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('На экран Домой');
  await expect
    .poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
});
