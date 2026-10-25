import { test, expect } from '@playwright/test';

test.use({ hasTouch: true });
for (const viewport of [{ width: 360, height: 780 }, { width: 768, height: 1024 }, { width: 844, height: 390 }]) {
  test(`mobile product ${viewport.width}x${viewport.height}: panels, 3D return, preview and studio`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/editor/demo');
    await page.getByLabel('Пароль проекта').fill('atlas-local-test-password');
    await page.getByRole('button', { name: /Войти в редактор/ }).click();
    await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Редактор плана' });
    const nav = editor.getByRole('navigation', { name: 'Панели конструктора' });
    await expect(nav).toBeVisible();
    await nav.getByRole('button', { name: 'Инструменты', exact: true }).tap();
    await expect(editor.getByRole('button', { name: 'Комната', exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Комната', exact: true }).tap();
    await expect(nav.getByRole('button', { name: 'План', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('plan-editor-canvas')).toBeVisible();
    await expect(editor.getByLabel('Этаж на плане')).toBeVisible();
    await expect(editor).toHaveJSProperty('scrollWidth', viewport.width);
    await page.screenshot({ path: testInfo.outputPath('editor-canvas.png') });
    await editor.getByRole('button', { name: '3D-обзор', exact: true }).tap();
    await expect(page.getByTestId('plan-editor-3d')).toBeVisible();
    await editor.getByRole('button', { name: '2D-план', exact: true }).tap();
    await expect(page.getByTestId('plan-editor-canvas')).toBeVisible();
    await editor.getByRole('button', { name: 'Предпросмотр', exact: true }).tap();
    await expect(editor.getByTestId('floor-map')).toBeVisible();
    await editor.getByRole('button', { name: 'К конструктору', exact: true }).tap();
    await nav.getByRole('button', { name: 'Свойства и объекты' }).tap();
    await expect(editor.getByLabel('Найти объект')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('editor-properties.png') });
    await editor.getByRole('button', { name: 'Закрыть редактор плана' }).tap();
    await page.getByRole('button', { name: 'Панорамы', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить панораму', exact: true }).click();
    const studio = page.getByRole('dialog', { name: 'Добавить панораму' });
    await expect(studio.getByLabel('Источник')).toBeVisible();
    expect(await studio.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('studio.png') });
    expect(errors).toEqual([]);
  });
}

test('two real touch pointers zoom the map without selecting a room', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/map/demo');
  const map = page.getByTestId('floor-map');
  await expect(map).toBeVisible();
  await map.scrollIntoViewIfNeeded();
  const box = (await map.boundingBox())!;
  const client = await context.newCDPSession(page);
  const y = box.y + box.height/2;
  const x = box.x + box.width/2;
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x:x-30,y,id:1 }, { x:x+30,y,id:2 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x:x-65,y,id:1 }, { x:x+65,y,id:2 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => Number((await page.locator('.map-controls').innerText()).match(/(\d+)%/)?.[1])).toBeGreaterThan(100);
  await expect(page.getByRole('heading', { name: 'Куда отправимся?' })).toBeVisible();
});

test('native Android export hands an actual project Blob to the document bridge', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: navigator.userAgent + ' SpaceMapNative/Android' });
    Object.assign(window, { SpaceMapNative: { saveBlob: (url: string, filename: string, mime: string) => {
      Object.assign(window, { nativeExport: { url, filename, mime } });
    } } });
  });
  await page.goto('/map/demo');
  await expect(page.getByRole('button', { name: 'Установить приложение' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Экспорт проекта', exact: true }).click();
  const saved = await page.evaluate(async () => {
    const exported = (window as unknown as { nativeExport: { url: string; filename: string; mime: string } }).nativeExport;
    return { ...exported, project: await (await fetch(exported.url)).json() };
  });
  expect(saved.filename).toBe('atlas-project.json');
  expect(saved.mime).toBe('application/json');
  expect(saved.project.floors.length).toBeGreaterThan(0);
});
