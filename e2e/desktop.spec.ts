import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Project, Route } from '../src/types';

const orbit = 'Переговорная «Орбита»';
const adminPassword = 'atlas-local-test-password';

async function openMap(page: Page) {
  await page.goto('/map/demo');
  await expect(page.getByRole('heading', { name: 'Куда отправимся?' })).toBeVisible();
  await expect(page.getByTestId('floor-map')).toHaveAttribute('aria-label', 'План: 1 этаж');
}

async function buildRoute(page: Page): Promise<Route> {
  const result = page.waitForResponse(
    (response) =>
      response.url().includes('/api/projects/demo/route') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Построить маршрут', exact: true }).click();
  const response = await result;
  expect(response.status()).toBe(200);
  await expect(page.getByTestId('route-result')).toBeVisible();
  return response.json();
}

test('visitor finds a room and follows a real route between floors', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openMap(page);
  await page.getByRole('textbox', { name: 'Поиск места' }).fill('Орбита');
  await expect(page.locator('.place-card')).toHaveCount(1);
  await page.locator('.place-card').filter({ hasText: orbit }).click();
  await expect(page.getByRole('heading', { name: orbit, exact: true })).toBeVisible();
  await expect(page.getByTestId('floor-map')).toHaveAttribute('aria-label', 'План: 2 этаж');
  await page.getByRole('button', { name: 'Проложить маршрут' }).click();
  await expect(page.getByRole('combobox', { name: 'Откуда' })).toHaveValue('f1-entrance');
  await expect(page.getByRole('combobox', { name: 'Куда', exact: true })).toHaveValue('f2-orbit');

  const route = await buildRoute(page);
  expect(route.nodes[0].id).toBe('f1-entrance');
  expect(route.nodes.at(-1)?.id).toBe('f2-orbit');
  expect(route.edgeIds).toContain('stairs-f1-f2');
  expect(route.distanceMeters).toBeGreaterThan(0);
  await expect(page.getByTestId('route-result')).toContainText('по лестнице');
  await expect(page.getByTestId('floor-map')).toHaveAttribute('aria-label', 'План: 1 этаж');
  await expect(page.getByTestId('route-segment')).toHaveCount(1);
  const firstFloorPoints = await page.locator('.route-line').getAttribute('points');
  expect(firstFloorPoints).toBe(
    route.nodes
      .filter((node) => node.floorId === 'f1')
      .map((node) => `${node.x},${node.y}`)
      .join(' '),
  );

  await page.locator('.floor-switch').getByRole('button', { name: '2 этаж' }).click();
  await expect(page.getByTestId('floor-map')).toHaveAttribute('aria-label', 'План: 2 этаж');
  await expect(page.locator('.route-line')).toHaveAttribute(
    'points',
    route.nodes
      .filter((node) => node.floorId === 'f2')
      .map((node) => `${node.x},${node.y}`)
      .join(' '),
  );
  expect(await page.locator('.route-line').getAttribute('points')).not.toBe(firstFloorPoints);
  await page.screenshot({
    path: testInfo.outputPath('desktop-route-second-floor.png'),
    fullPage: true,
  });
  expect(pageErrors).toEqual([]);
});

test('accessible profile replaces stairs with a lift and resets when endpoints change', async ({
  page,
}) => {
  await openMap(page);
  await page.getByRole('button', { name: 'Маршрут', exact: true }).click();
  await page.getByRole('combobox', { name: 'Куда', exact: true }).selectOption('f2-orbit');
  await page.getByRole('checkbox', { name: /Без лестниц/ }).check();
  const route = await buildRoute(page);
  expect(route.edgeIds).toContain('elevator-f1-f2');
  expect(route.edgeIds).not.toContain('stairs-f1-f2');
  await expect(page.getByTestId('route-result')).toContainText('Маршрут без лестниц');
  await expect(page.locator('.route-steps')).toContainText('на лифте');
  await expect(page.locator('.route-steps')).not.toContainText('по лестнице');

  await page.getByRole('combobox', { name: 'Куда', exact: true }).selectOption('f1-cafe');
  await expect(page.getByTestId('route-result')).toHaveCount(0);
  await expect(page.getByTestId('route-segment')).toHaveCount(0);
  await page.getByRole('button', { name: 'Поменять начало и конец' }).click();
  await expect(page.getByRole('combobox', { name: 'Откуда' })).toHaveValue('f1-cafe');
  await expect(page.getByRole('combobox', { name: 'Куда', exact: true })).toHaveValue(
    'f1-entrance',
  );
  const reverse = await buildRoute(page);
  expect(reverse.nodes[0].id).toBe('f1-cafe');
  expect(reverse.nodes.at(-1)?.id).toBe('f1-entrance');
});

test('isometric building view keeps real floor transitions and the computed route', async ({
  page,
}, testInfo) => {
  await openMap(page);
  await page.getByRole('button', { name: 'Маршрут', exact: true }).click();
  await page.getByRole('combobox', { name: 'Куда', exact: true }).selectOption('f2-orbit');
  const route = await buildRoute(page);

  await page.getByRole('button', { name: /Объём/ }).click();
  const map = page.getByTestId('isometric-map');
  await expect(map).toBeVisible();
  await expect(map).toContainText('Лестница');
  await expect(map).toContainText('Лифт');
  await expect(map.locator('.iso-route-line')).toBeVisible();
  const points = (await map.locator('.iso-route-line').getAttribute('points'))?.trim().split(/\s+/);
  expect(points).toHaveLength(route.nodes.length);
  await page.screenshot({ path: testInfo.outputPath('isometric-building.png'), fullPage: true });

  await page.locator('.floor-switch').getByRole('button', { name: '2 этаж' }).click();
  await expect(map).toContainText('2 этаж');
  await page.getByRole('button', { name: 'План', exact: true }).click();
  await expect(page.getByTestId('floor-map')).toHaveAttribute('aria-label', 'План: 2 этаж');
});

test('search handles no results and category filters keep relevant places', async ({ page }) => {
  await openMap(page);
  await page.getByRole('textbox', { name: 'Поиск места' }).fill('несуществующая комната 314159');
  await expect(page.getByText('Место не найдено. Попробуйте другой запрос.')).toBeVisible();
  await expect(page.locator('.place-card')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Поиск места' }).clear();
  await page.getByRole('button', { name: 'Залы', exact: true }).click();
  await expect(page.locator('.place-card').filter({ hasText: orbit })).toHaveCount(1);
  await expect(page.locator('.place-card').filter({ hasText: 'Главный вход' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Сервисы', exact: true }).click();
  await expect(page.locator('.place-card').filter({ hasText: 'Главный вход' })).toHaveCount(1);
  await expect(page.locator('.place-card').filter({ hasText: orbit })).toHaveCount(0);
});

test('same start and destination reports zero distance and zero time', async ({ page }) => {
  await openMap(page);
  await page.getByRole('button', { name: 'Маршрут', exact: true }).click();
  await page.getByRole('combobox', { name: 'Куда', exact: true }).selectOption('f1-entrance');
  const result = await buildRoute(page);
  expect(result.distanceMeters).toBe(0);
  expect(result.durationSeconds).toBe(0);
  expect(result.edgeIds).toEqual([]);
  await expect(page.locator('.route-summary')).toContainText('0 м');
  await expect(page.locator('.route-summary')).toContainText('0 мин');
  await expect(page.locator('.route-steps')).toContainText('Вы уже в точке назначения');
});

test('room surface selects its place and expanded map restores navigation', async ({ page }, testInfo) => {
  await openMap(page);
  await page.getByRole('button', { name: 'Развернуть карту', exact: true }).click();
  await expect(page.locator('.map-stage')).toHaveClass(/map-expanded/);
  await page.locator('[data-place="room-cafe"] > rect').click({ position: { x: 10, y: 10 } });
  await expect(page.getByRole('heading', { name: 'Кафе «Пульс»', exact: true })).toBeVisible();
  await expect(page.locator('.map-stage')).not.toHaveClass(/map-expanded/);
  await page.getByRole('button', { name: 'Проложить маршрут', exact: true }).click();
  await page.getByRole('button', { name: 'Построить маршрут', exact: true }).click();
  const map = page.getByTestId('floor-map');
  const initial = await map.getAttribute('viewBox');
  await page.getByRole('button', { name: 'Показать маршрут', exact: true }).click();
  await expect(map).not.toHaveAttribute('viewBox', initial!);
  await page.getByRole('button', { name: 'Развернуть карту', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.map-stage')).not.toHaveClass(/map-expanded/);
  await expect(page.getByRole('button', { name: 'Развернуть карту', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Показать весь этаж', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('map-product-desktop.png'), fullPage: true });
});

test('drag pans the map and exported JSON contains the public project only', async ({ page }) => {
  await openMap(page);
  const map = page.getByTestId('floor-map');
  const initialBox = await map.getAttribute('viewBox');
  const box = await map.boundingBox();
  if (!box) throw new Error('Map is not rendered');
  await page.mouse.move(box.x + 40, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 140, { steps: 8 });
  await page.mouse.up();
  await expect(map).not.toHaveAttribute('viewBox', initialBox!);
  await page.getByRole('button', { name: 'Показать весь этаж' }).click();
  await expect(map).toHaveAttribute('viewBox', initialBox!);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспорт проекта' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('atlas-project.json');
  const file = await download.path();
  if (!file) throw new Error('Export file missing');
  const text = await readFile(file, 'utf8');
  const exported = JSON.parse(text) as Project;
  const apiProject = await (await page.request.get('/api/projects/demo')).json();
  expect(exported).toEqual(apiProject);
  expect(text).not.toContain('password');
  expect(text).not.toContain('session_secret');
});

test('keyboard opens map places and zoom changes then resets the SVG viewport', async ({
  page,
}) => {
  await openMap(page);
  const marker = page.getByRole('button', { name: 'Открыть Кафе «Пульс»', exact: true });
  await marker.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Кафе «Пульс»', exact: true })).toBeVisible();
  const map = page.getByTestId('floor-map');
  const initialBox = await map.getAttribute('viewBox');
  await page.getByRole('button', { name: 'Увеличить карту' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.map-controls')).toContainText('125%');
  expect(await map.getAttribute('viewBox')).not.toBe(initialBox);
  await page.getByRole('button', { name: 'Показать весь этаж' }).click();
  await expect(map).toHaveAttribute('viewBox', initialBox!);
  await page.locator('.floor-switch').getByRole('button', { name: '2 этаж' }).focus();
  await page.keyboard.press('Space');
  await expect(map).toHaveAttribute('aria-label', 'План: 2 этаж');
  await page.getByRole('button', { name: `Открыть ${orbit}`, exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('heading', { name: orbit, exact: true })).toBeVisible();
});

test('anonymous writes and invalid organizer passwords are rejected', async ({ page, request }) => {
  const project = await (await request.get('/api/projects/demo')).json();
  const response = await request.put('/api/projects/demo', { data: project });
  expect(response.status()).toBe(401);
  await openMap(page);
  await page.getByRole('button', { name: 'Организатору', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Вход организатора' });
  await dialog
    .getByRole('textbox', { name: 'Пароль проекта' })
    .fill('intentionally-invalid-password');
  await dialog.getByRole('button', { name: 'Войти в редактор' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Проверьте пароль');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.editor-banner')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('organizer edit survives reload and is visible in a separate visitor browser', async ({
  page,
  browser,
}, testInfo) => {
  await page.goto('/editor/demo');
  const dialog = page.getByRole('dialog', { name: 'Вход организатора' });
  await dialog.getByRole('textbox', { name: 'Пароль проекта' }).fill(adminPassword);
  await dialog.getByRole('button', { name: 'Войти в редактор' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.editor-banner')).toContainText('Режим организатора');
  await page.getByRole('textbox', { name: 'Поиск места' }).fill('Орбита');
  await page.locator('.place-card').filter({ hasText: orbit }).click();
  const original = await page.getByRole('textbox', { name: 'Описание места' }).inputValue();
  const changed = `Проверка сохранения через браузер ${testInfo.testId}. После обновления описание остаётся доступно посетителям.`;
  const visitor = await browser.newContext({ baseURL: 'http://127.0.0.1:5174' });
  try {
    await page.getByRole('textbox', { name: 'Описание места' }).fill(changed);
    await page.getByRole('button', { name: 'Сохранить изменения' }).click();
    await expect(page.getByRole('status')).toContainText('Сохранено');
    await page.reload();
    await expect(page.locator('.editor-banner')).toBeVisible();
    await page.getByRole('textbox', { name: 'Поиск места' }).fill('Орбита');
    await page.locator('.place-card').filter({ hasText: orbit }).click();
    await expect(page.getByRole('textbox', { name: 'Описание места' })).toHaveValue(changed);
    const savedProject = (await (await page.request.get('/api/projects/demo')).json()) as Project;
    expect(savedProject.places.find((place) => place.id === 'orbit')?.description).toBe(changed);

    expect(
      (
        await page.request.post('/api/projects/demo/publish', {
          data: { revision: savedProject.revision },
        })
      ).status(),
    ).toBe(200);
    const visitorPage = await visitor.newPage();
    await openMap(visitorPage);
    expect(
      (await visitor.request.get('/api/session').then((response) => response.json())).authenticated,
    ).toBe(false);
    await visitorPage.getByRole('textbox', { name: 'Поиск места' }).fill('Орбита');
    await visitorPage.locator('.place-card').filter({ hasText: orbit }).click();
    await expect(visitorPage.locator('.place-description')).toHaveText(changed);
    await expect(visitorPage.getByRole('textbox', { name: 'Описание места' })).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('desktop-editor-saved.png'),
      fullPage: true,
    });
  } finally {
    // Preserve the fixture even when an assertion fails after writing.
    const current = (await (await page.request.get('/api/projects/demo')).json()) as Project;
    const restored = await page.request.put('/api/projects/demo', {
      data: {
        ...current,
        places: current.places.map((place) =>
          place.id === 'orbit' ? { ...place, description: original } : place,
        ),
      },
    });
    expect(restored.status()).toBe(200);
    expect(
      (
        await page.request.post('/api/projects/demo/publish', {
          data: { revision: (await restored.json()).revision },
        })
      ).status(),
    ).toBe(200);
    await visitor.close();
  }
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.locator('.editor-banner')).toHaveCount(0);
  expect(
    (await page.request.get('/api/session').then((response) => response.json())).authenticated,
  ).toBe(false);
});
