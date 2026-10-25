import { test, expect } from '@playwright/test';

test('publication dialog fits a phone viewport and reports an already published version', async ({ page }) => {
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/editor/demo');
  await page.getByRole('button', { name: 'Публикация', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Карта готова к показу?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Версия уже опубликована' })).toBeDisabled();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', await page.locator('body').evaluate((body) => body.clientWidth));
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Публикация', exact: true }).click();
  await page.mouse.click(8, 8);
  await expect(dialog).toBeHidden();
});

test('draft stays private until UI publication and embed follows the same release', async ({
  page,
  browser,
}, testInfo) => {
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  const original = await (await page.request.get('/api/projects/demo')).json();
  const visitor = await browser.newContext({ baseURL: 'http://127.0.0.1:5174' });
  try {
    const changed = structuredClone(original);
    changed.places.find((p: { id: string }) => p.id === 'reception').description =
      'Опубликованная стойка регистрации — проверка версии';
    expect((await page.request.put('/api/projects/demo', { data: changed })).status()).toBe(200);
    const before = await (await visitor.request.get('/api/projects/demo')).json();
    expect(
      before.places.find((p: { id: string }) => p.id === 'reception').description,
    ).not.toContain('проверка версии');
    await page.goto('/editor/demo');
    await page.getByRole('button', { name: 'Публикация', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Карта готова к показу?' });
    await expect(dialog.getByRole('textbox', { name: 'Ссылка посетителя' })).toHaveValue(
      'http://127.0.0.1:5174/map/demo',
    );
    await dialog.getByText('Встроить карту на сайт', { exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Код для встраивания' })).toHaveValue(
      /\/embed\/demo/,
    );
    await dialog.getByRole('button', { name: 'Опубликовать сохранённую версию' }).click();
    await expect(dialog.getByRole('status')).toContainText('Опубликована версия');
    const publishedButton = dialog.getByRole('button', { name: 'Версия уже опубликована' });
    await expect(publishedButton).toBeDisabled();
    await expect(publishedButton).toHaveCSS('background-color', 'rgb(237, 240, 237)');
    await expect(dialog.locator('.publish-version')).toContainText('Новых сохранённых изменений нет');
    await page.screenshot({ path: testInfo.outputPath('publication.png') });
    const publicPage = await visitor.newPage();
    await publicPage.goto('/map/demo');
    await publicPage.getByRole('textbox', { name: 'Поиск места' }).fill('Ресепшен');
    await publicPage.locator('.place-card').filter({ hasText: 'Ресепшен' }).click();
    await expect(publicPage.locator('.place-description')).toContainText('проверка версии');
    await publicPage.setContent(
      '<iframe src="/embed/demo" title="Карта" style="width:100%;height:720px"></iframe>',
    );
    const frame = publicPage.frameLocator('iframe');
    await expect(frame.getByRole('textbox', { name: 'Поиск места' })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Организатору' })).toHaveCount(0);
    await frame.getByRole('textbox', { name: 'Поиск места' }).fill('Ресепшен');
    await frame.locator('.place-card').filter({ hasText: 'Ресепшен' }).click();
    await expect(frame.locator('.place-description')).toContainText('проверка версии');
    await publicPage.screenshot({ path: testInfo.outputPath('embedded-map.png') });
  } finally {
    const current = await (await page.request.get('/api/projects/demo')).json();
    const restored = await (
      await page.request.put('/api/projects/demo', {
        data: { ...original, revision: current.revision },
      })
    ).json();
    expect(
      (
        await page.request.post('/api/projects/demo/publish', {
          data: { revision: restored.revision },
        })
      ).status(),
    ).toBe(200);
    await visitor.close();
  }
});
