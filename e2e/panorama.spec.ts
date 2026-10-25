import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { panoramaRoute } from '../src/panoramaRoute';
import type { Panorama, Route } from '../src/types';

test('panorama import, real WebGL, hotspot, visitor and deletion', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(8000);
  const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  execFileSync(python, [
    '-c',
    "from PIL import Image,ImageDraw; from pathlib import Path; p=Path('tmp/e2e/sphere.png'); p.parent.mkdir(parents=True,exist_ok=True); im=Image.new('RGB',(1024,512),'#b7d4ef'); d=ImageDraw.Draw(im); d.rectangle((0,256,1024,512),fill='#415979'); d.rectangle((420,170,600,360),fill='#e8b36e'); im.save(p)",
  ]);
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  const initial = await (await page.request.get('/api/projects/demo')).json();
  const original = await (
    await page.request.put('/api/projects/demo', {
      data: {
        ...initial,
        panoramas: initial.panoramas.filter((p: { name: string }) => p.name !== 'Тестовая сфера'),
      },
    })
  ).json();
  const visitor = await browser.newContext({ baseURL: 'http://127.0.0.1:5174' });
  try {
    await page.goto('/editor/demo');
    await page.getByRole('button', { name: 'Панорамы', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить панораму', exact: true }).click();
    const studio = page.getByRole('dialog', { name: 'Добавить панораму' });
    await studio.getByLabel('Источник').selectOption('import');
    await studio.getByLabel('Фотографии', { exact: true }).setInputFiles('tmp/e2e/sphere.png');
    await studio.getByRole('button', { name: 'Загрузить панораму' }).click();
    await studio.getByLabel('Название панорамы').fill('Тестовая сфера');
    await studio.getByRole('button', { name: 'Добавить на карту' }).click();
    await expect(studio).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Тестовая сфера', exact: false })
      .filter({ has: page.locator('img') })
      .click();
    const viewer = page.getByRole('dialog', { name: 'Тестовая сфера' });
    await expect(viewer.getByRole('button', { name: 'Приблизить панораму' })).toBeVisible({
      timeout: 20000,
    });
    await viewer.getByRole('combobox', { name: 'Место', exact: true }).selectOption('reception');
    await viewer.getByRole('button', { name: 'Добавить метку', exact: true }).click();
    await expect(viewer.getByRole('button', { name: 'Удалить метку Ресепшен' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('panorama-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileStage = await viewer.locator('.pano-stage').boundingBox();
    expect(mobileStage?.height).toBeGreaterThanOrEqual(320);
    expect(mobileStage?.height).toBeLessThanOrEqual(460);
    await expect(viewer.locator('.pano-sidebar')).toBeVisible();
    expect(await viewer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await viewer.getByRole('button', { name: 'Добавить метку', exact: true }).scrollIntoViewIfNeeded();
    await expect(viewer.getByRole('button', { name: 'Добавить метку', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('panorama-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const withHotspot = await (await page.request.get('/api/projects/demo')).json();
    const first = withHotspot.panoramas.find((p: Panorama) => p.name === 'Тестовая сфера');
    const next = {
      ...first,
      id: 'test-next-scene',
      name: 'Соседняя сцена',
      nodeId: withHotspot.nodes[1].id,
      floorId: withHotspot.nodes[1].floorId,
      x: withHotspot.nodes[1].x,
      y: withHotspot.nodes[1].y,
      hotspots: [
        { id: 'back', kind: 'scene', text: 'Назад', yaw: 0, pitch: 0, targetPanoramaId: first.id },
      ],
    };
    expect(
      (
        await page.request.put('/api/projects/demo', {
          data: { ...withHotspot, panoramas: [...withHotspot.panoramas, next] },
        })
      ).status(),
    ).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: 'Открыть панораму: Тестовая сфера' }).click();
    await expect(page.getByRole('button', { name: 'Удалить метку Ресепшен' })).toBeVisible();
    await viewer.getByRole('combobox', { name: 'Тип метки' }).selectOption('scene');
    await viewer
      .getByRole('combobox', { name: 'Панорама назначения' })
      .selectOption('test-next-scene');
    await viewer.getByRole('button', { name: 'Добавить метку', exact: true }).click();
    await expect(
      viewer.getByRole('button', { name: 'Удалить метку Соседняя сцена' }),
    ).toBeVisible();
    const ready = await (await page.request.get('/api/projects/demo')).json();
    expect(
      (
        await page.request.post('/api/projects/demo/publish', {
          data: { revision: ready.revision },
        })
      ).status(),
    ).toBe(200);
    const visitorPage = await visitor.newPage();
    await visitorPage.goto('/map/demo');
    await visitorPage.getByRole('button', { name: 'Открыть панораму: Тестовая сфера' }).click();
    await expect(visitorPage.getByRole('button', { name: 'Приблизить панораму' })).toBeVisible();
    await expect(
      visitorPage.getByRole('button', { name: 'Добавить метку', exact: true }),
    ).toHaveCount(0);
    await visitorPage.locator('.pano-hotspot-list button').filter({ hasText: 'Ресепшен' }).click();
    await expect(visitorPage.locator('.pano-place-detail')).toContainText('Ресепшен');
    await visitorPage.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        visitorPage
          .locator('.pnlm-render-container canvas')
          .evaluate((canvas) => canvas.getBoundingClientRect().height),
      )
      .toBeGreaterThan(300);
    await visitorPage.screenshot({ path: testInfo.outputPath('panorama-mobile.png') });
    expect(
      await visitorPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await visitorPage
      .locator('.pano-hotspot-list button')
      .filter({ hasText: 'Соседняя сцена' })
      .click();
    await expect(visitorPage.getByRole('dialog', { name: 'Соседняя сцена' })).toBeVisible();
    await visitorPage.locator('.pano-hotspot-list button').filter({ hasText: 'Назад' }).click();
    await expect(visitorPage.getByRole('dialog', { name: 'Тестовая сфера' })).toBeVisible();
    await page.getByRole('button', { name: 'Закрыть панораму' }).click();
    await page.getByRole('button', { name: 'Панорамы', exact: true }).click();
    await page.getByRole('button', { name: 'Удалить панораму «Тестовая сфера»' }).click();
    await expect(page.locator('.pano-card').filter({ hasText: 'Тестовая сфера' })).toHaveCount(0);
    const route: Route = await (
      await page.request.post('/api/projects/demo/route', {
        data: { startId: 'f1-entrance', endId: 'f1-reception', profile: 'shortest' },
      })
    ).json();
    const current = await (await page.request.get('/api/projects/demo')).json();
    const routeScenes = route.nodes.map((node, index) => ({
      ...first,
      id: `route-scene-${index}`,
      name: `Сцена пути ${index + 1}`,
      nodeId: node.id,
      floorId: node.floorId,
      x: node.x,
      y: node.y,
      hotspots:
        index === route.nodes.length - 1
          ? []
          : [
              {
                id: `forward-${index}`,
                kind: 'scene',
                yaw: 0,
                pitch: 0,
                text: 'Далее',
                targetPanoramaId: `route-scene-${index + 1}`,
              },
            ],
    }));
    expect(
      (
        await page.request.put('/api/projects/demo', {
          data: { ...current, panoramas: routeScenes },
        })
      ).status(),
    ).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: 'Маршрут', exact: true }).click();
    await page.getByRole('combobox', { name: 'Куда', exact: true }).selectOption('f1-reception');
    await page.getByRole('button', { name: 'Построить маршрут', exact: true }).click();
    await page.getByRole('button', { name: 'Панорамы вдоль маршрута' }).click();
    await page.getByRole('button', { name: 'Предпросмотр маршрута' }).click();
    for (let index = 1; index < routeScenes.length; index++) {
      await page.getByRole('button', { name: 'Следующая сцена маршрута' }).click();
      await expect(page.getByRole('dialog', { name: `Сцена пути ${index + 1}` })).toBeVisible();
    }
    await expect(page.getByText('Вы достигли конца маршрута.')).toBeVisible();
  } finally {
    const current = await (await page.request.get('/api/projects/demo')).json();
    expect(
      (
        await page.request.put('/api/projects/demo', {
          data: { ...current, panoramas: original.panoramas },
        })
      ).status(),
    ).toBe(200);
    const restored = await (await page.request.get('/api/projects/demo')).json();
    await page.request.post('/api/projects/demo/publish', {
      data: { revision: restored.revision },
    });
    await visitor.close();
  }
});

test('390px panorama studio keeps source, guidance and upload controls usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  await page.goto('/editor/demo');
  await page.getByRole('button', { name: 'Панорамы', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить панораму', exact: true }).click();
  const studio = page.getByRole('dialog', { name: 'Добавить панораму' });
  await expect(studio.getByLabel('Источник')).toBeVisible();
  await expect(studio.getByLabel('Фотографии', { exact: true })).toBeVisible();
  await expect(studio.getByText('Выбрать фотографии')).toBeVisible();
  await expect(studio.getByText('Снять или выбрать кадр')).toBeVisible();
  const studioBounds = await studio.boundingBox();
  expect(studioBounds).not.toBeNull();
  expect(studioBounds!.height).toBeLessThan(844);
  await expect(studio.getByRole('button', { name: 'Сшить фотографии' })).toBeDisabled();
  expect(await studio.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('panorama-studio-mobile.png'), fullPage: true });
  await studio.getByRole('button', { name: 'Закрыть загрузку' }).click();
  await expect(studio).toHaveCount(0);
});

test('panorama route requires every node and correctly directed scene links', () => {
  const route = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } as Route;
  const scenes = [
    { id: 'pa', nodeId: 'a', hotspots: [{ kind: 'scene', targetPanoramaId: 'pb' }] },
    { id: 'pb', nodeId: 'b', hotspots: [{ kind: 'scene', targetPanoramaId: 'pc' }] },
    { id: 'pc', nodeId: 'c', hotspots: [] },
  ] as unknown as Panorama[];
  expect(panoramaRoute(route, scenes).complete).toBe(true);
  expect(panoramaRoute(route, [scenes[0], scenes[2]]).complete).toBe(false);
  expect(panoramaRoute({ ...route, nodes: [...route.nodes].reverse() }, scenes).complete).toBe(
    false,
  );
  expect(panoramaRoute(null, scenes).complete).toBe(false);
});

test('three real photos produce an attachable partial panorama and clear its resumed job', async ({ page }) => {
  test.setTimeout(150000);
  const paths = [1, 2, 3].map((i) => `tmp/fixtures/stitching/boat${i}.jpg`);
  test.skip(!paths.every(existsSync), 'Fetch optional OpenCV photo fixtures first');
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  await page.goto('/editor/demo');
  await page.getByRole('button', { name: 'Панорамы', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить панораму', exact: true }).click();
  const studio = page.getByRole('dialog', { name: 'Добавить панораму' });
  await studio.getByLabel('Фотографии', { exact: true }).setInputFiles(paths);
  await studio.getByRole('button', { name: 'Сшить фотографии', exact: true }).click();
  await expect(studio.getByText('Обработка может занять', { exact: false })).toBeVisible();
  await studio.getByRole('button', { name: 'Закрыть загрузку' }).click();
  await page.getByRole('button', { name: 'Добавить панораму', exact: true }).click();
  await expect(studio.getByLabel('Название панорамы')).toBeVisible({ timeout: 130000 });
  await expect(studio).toContainText('Частичная панорама');
  await expect(studio.getByAltText('Результат обработки')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('space-stitch-job:demo'))).not.toBeNull();
  await studio.getByLabel('Название панорамы').fill('Сшитая тестовая панорама');
  await studio.getByRole('button', { name: 'Добавить на карту' }).click();
  await expect(studio).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('space-stitch-job:demo'))).toBeNull();
  const saved = await (await page.request.get('/api/projects/demo')).json();
  expect(saved.panoramas.some((panorama: Panorama) => panorama.name === 'Сшитая тестовая панорама')).toBe(true);
});
