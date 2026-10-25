import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { Project } from '../src/types';
async function publishCurrent(page: Page) {
  const project = await (await page.request.get('/api/projects/demo')).json();
  expect(
    (
      await page.request.post('/api/projects/demo/publish', {
        data: { revision: project.revision },
      })
    ).status(),
  ).toBe(200);
}

test('390px editor creates, moves and deletes a place without horizontal overflow', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  const original: Project = await (await page.request.get('/api/projects/demo')).json();
  try {
    await page.goto('/editor/demo');
    await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Редактор плана' });
    await editor.getByRole('button', { name: 'Инструменты', exact: true }).click();
    await editor.getByRole('button', { name: 'Добавить этаж' }).click();
    await editor.getByRole('button', { name: 'Место', exact: true }).click();
    await point(page, 300, 300);
    await editor.getByRole('button', { name: 'Свойства и объекты' }).click();
    await editor.getByRole('textbox', { name: 'Название объекта' }).fill('Мобильная точка');
    await editor.getByRole('button', { name: 'Переместить на плане' }).click();
    await point(page, 400, 400);
    await editor.getByRole('button', { name: 'Свойства и объекты' }).click();
    await expect(editor.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('400');
    await expect(editor.getByRole('spinbutton', { name: 'Y', exact: true })).toHaveValue('400');
    await editor.getByRole('button', { name: 'Сохранить план', exact: true }).click();
    await expect(editor.getByText('План сохранён.', { exact: false })).toBeVisible();
    await publishCurrent(page);
    const current: Project = await (await page.request.get('/api/projects/demo')).json();
    const place = current.places.find((p) => p.name === 'Мобильная точка')!;
    expect(place.x).toBe(400);
    expect(current.nodes.find((n) => n.id === place.nodeId)?.x).toBe(400);
    await editor.getByRole('navigation', { name: 'Панели конструктора' }).getByRole('button', { name: 'План', exact: true }).click();
    await page.getByTestId('plan-editor-canvas').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('plan-editor-mobile.png') });
    expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await editor.getByRole('button', { name: 'Свойства и объекты' }).click();
    await editor.getByRole('button', { name: 'Удалить объект' }).click();
    await editor.getByRole('button', { name: 'Сохранить план', exact: true }).click();
    await expect(editor.getByText('План сохранён.', { exact: false })).toBeVisible();
    await publishCurrent(page);
    expect(
      (await (await page.request.get('/api/projects/demo')).json()).places.some(
        (p: { id: string }) => p.id === place.id,
      ),
    ).toBe(false);
  } finally {
    const current = await (await page.request.get('/api/projects/demo')).json();
    expect(
      (
        await page.request.put('/api/projects/demo', {
          data: { ...original, revision: current.revision },
        })
      ).status(),
    ).toBe(200);
    await publishCurrent(page);
  }
});

async function point(page: Page, x: number, y: number) {
  await page.getByTestId('plan-editor-canvas').scrollIntoViewIfNeeded();
  const position = await page.getByTestId('plan-editor-canvas').evaluate(
    (svg, p) => {
      const point = new DOMPoint(p.x, p.y).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
      return { x: point.x, y: point.y };
    },
    { x, y },
  );
  await page.mouse.click(position.x, position.y);
}

test('RoomPlan intake previews measured walls and objects before importing the underlay', async ({ page }) => {
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  await page.goto('/editor/demo');
  await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактор плана' });
  const intake = editor.locator('details.plan-roomplan');
  await intake.locator('summary').click();
  await intake.getByLabel('Файл скана JSON').setInputFiles({
    name: 'invalid-roomplan.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      format: 'space-map-roomplan', version: 1, unit: 'm',
      rooms: [{ id: 'bad-room', name: 'Ошибочное помещение', walls: [{ id: 'w', start: [0, 0], end: [4, 0], confidence: 'high' }], objects: [{ id: 'bad-object', category: 'chair', center: [1, 1], size: [-1, 1, 1], confidence: 'high' }] }],
    })),
  });
  await expect(editor.getByRole('alert')).toContainText('предмет 1 имеет неверные данные');
  await intake.getByLabel('Файл скана JSON').setInputFiles({
    name: 'roomplan.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      format: 'space-map-roomplan', version: 1, unit: 'm', source: 'apple-roomplan',
      rooms: [
        {
          id: 'room-1', name: 'Комната 1', story: 0, height: 2.8,
          walls: [
            { id: 'w1', start: [0, 0], end: [6, 0], confidence: 'high' },
            { id: 'w2', start: [6, 0], end: [6, 4], confidence: 'low' },
            { id: 'w3', start: [6, 4], end: [0, 4], confidence: 'medium' },
            { id: 'w4', start: [0, 4], end: [0, 0], confidence: 'high' },
          ],
          openings: [{ id: 'door-1', kind: 'door', center: [0, 2], width: 0.9, confidence: 'high' }],
          objects: [{ id: 'table-1', category: 'table', center: [3, 2], size: [1.2, 0.75, 0.8], confidence: 'medium' }],
        },
        { id: 'room-2', name: 'Комната 2', story: 1, walls: [{ id: 'w5', start: [10, 10], end: [14, 10], confidence: 'high' }, { id: 'w6', start: [14, 10], end: [14, 14], confidence: 'high' }, { id: 'w7', start: [14, 14], end: [10, 14], confidence: 'high' }, { id: 'w8', start: [10, 14], end: [10, 10], confidence: 'high' }], openings: [],
        },
      ],
    })),
  });
  await expect(intake).toContainText('2 уровней RoomPlan');
  await expect(intake.getByLabel('Этаж RoomPlan')).toHaveValue('0');
  await expect(intake).toContainText('1 помещений · 4 стен · 1 проёмов · 1 предметов');
  await expect(intake).toContainText('Низкая уверенность: 1 элементов');
  await expect(intake.getByRole('img', { name: 'Предпросмотр обмерных стен, проёмов и распознанных предметов' })).toBeVisible();
  await intake.getByLabel('Этаж RoomPlan').selectOption('1');
  await expect(intake).toContainText('1 помещений · 4 стен · 0 проёмов · 0 предметов');
  await expect(intake).toContainText('Габарит скана: 4.00 × 4.00 м');
  await intake.getByLabel('Этаж RoomPlan').selectOption('0');
  await intake.getByRole('button', { name: 'Добавить скан как подложку' }).click();
  await expect(editor.getByRole('button', { name: 'Убрать подложку' })).toBeVisible();
  await expect(editor.getByText('Скан добавлен как подложка.', { exact: false })).toBeVisible();
});

test('editor decorations are selectable, compact in the catalog and visible in 3D', async ({ page }, testInfo) => {
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  await page.goto('/editor/demo');
  await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактор плана' });
  const library = editor.getByTestId('decoration-library');
  await expect(library.getByRole('button')).toHaveCount(7);
  await expect(library.getByRole('button', { name: 'Стол', exact: true })).toBeVisible();
  await expect(library.getByRole('button', { name: 'Растение', exact: true })).toBeVisible();
  const catalog = editor.locator('details.plan-decoration-list');
  await expect(catalog).toHaveJSProperty('open', false);
  await catalog.locator('summary').click();
  const catalogText = await catalog.innerText();
  expect(catalogText).toContain('Стол');
  expect(catalogText).not.toMatch(/\b(counter|chair|plant|table|sofa|desk|shelf)\b/i);
  await editor.locator('.plan-decoration-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('decoration-catalog-desktop.png') });
  const decoration = catalog.locator('[data-decoration-id]').first();
  await expect(decoration).toBeVisible();
  await expect(decoration).toHaveAttribute('aria-label', /^Выбрать декорацию: .+, .+$/);
  const id = await decoration.getAttribute('data-decoration-id');
  await decoration.click();
  await expect(editor.getByText('ДЕКОРАЦИЯ', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '3D-обзор', exact: true }).click();
  const projectedDecoration = editor.locator(`[data-iso-decoration="${id}"]`);
  await expect(projectedDecoration).toBeVisible();
  await expect(projectedDecoration.locator('polygon')).toHaveCount(2);
});

test('Figma-style canvas drag moves and resizes a room in one undoable edit', async ({ page }) => {
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  await page.goto('/editor/demo');
  await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактор плана' });
  await editor.getByRole('button', { name: 'Добавить этаж' }).click();
  await editor.getByRole('button', { name: 'Комната', exact: true }).click();
  const roomPoint = async (x: number, y: number) => page.getByTestId('plan-editor-canvas').evaluate((svg, p) => {
    const result = new DOMPoint(p.x, p.y).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
    return { x: result.x, y: result.y };
  }, { x, y });
  const drawStart = await roomPoint(100, 100);
  const drawEnd = await roomPoint(300, 250);
  await page.mouse.move(drawStart.x, drawStart.y);
  await page.mouse.down();
  await page.mouse.move(drawEnd.x, drawEnd.y, { steps: 5 });
  await page.mouse.up();
  const room = page.locator('[data-room-id]').last();
  const shape = room.locator('rect').first();
  await editor.getByRole('button', { name: 'Выбор', exact: true }).click();
  const start = await roomPoint(200, 175);
  const end = await roomPoint(250, 225);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await expect(shape).toHaveAttribute('x', '150');
  await expect(shape).toHaveAttribute('y', '150');
  const resizeStart = await roomPoint(350, 300);
  const resizeEnd = await roomPoint(400, 350);
  await page.mouse.move(resizeStart.x, resizeStart.y);
  await page.mouse.down();
  await page.mouse.move(resizeEnd.x, resizeEnd.y, { steps: 5 });
  await page.mouse.up();
  await expect(shape).toHaveAttribute('width', '250');
  await expect(shape).toHaveAttribute('height', '200');
  await editor.getByRole('button', { name: 'Отменить действие', exact: true }).click();
  await expect(shape).toHaveAttribute('width', '200');
  await expect(shape).toHaveAttribute('height', '150');
  await page.keyboard.press('Control+d');
  await expect(page.locator('[data-room-id]')).toHaveCount(2);
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-room-id]')).toHaveCount(1);
  await editor.getByRole('button', { name: 'Отменить действие', exact: true }).click();
  await expect(page.locator('[data-room-id]')).toHaveCount(2);
});

test('visible furniture blocks are placed on the canvas and remain directly movable', async ({ page }) => {
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  await page.goto('/editor/demo');
  await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактор плана' });
  await editor.getByTestId('decoration-library').getByRole('button', { name: 'Растение', exact: true }).click();
  await point(page, 920, 630);
  const decoration = page.locator('[data-decoration-id]').last();
  const shape = decoration.locator('circle').first();
  const start = await page.getByTestId('plan-editor-canvas').evaluate((svg) => {
    const p = new DOMPoint(920, 630).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  const end = await page.getByTestId('plan-editor-canvas').evaluate((svg) => {
    const p = new DOMPoint(880, 590).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await expect(shape).toHaveAttribute('cx', '882');
  await expect(shape).toHaveAttribute('cy', '592');
  await expect(editor.getByText('Объект перемещён.', { exact: false })).toBeVisible();
});

test('390px editor decoration catalog shows localized selectable rows without overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  await page.goto('/editor/demo');
  await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактор плана' });
  await editor.getByRole('button', { name: 'Инструменты', exact: true }).click();
  const catalog = editor.locator('details.plan-decoration-list');
  await catalog.scrollIntoViewIfNeeded();
  await catalog.locator('summary').click();
  const row = catalog.locator('[data-decoration-id]').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(/(Стойка|Стул|Растение|Стол)/);
  expect(await catalog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('decoration-catalog-mobile.png') });
  await row.click();
  await editor.getByRole('button', { name: 'Свойства и объекты' }).click();
  await expect(editor.getByText('ДЕКОРАЦИЯ', { exact: true })).toBeVisible();
});

test('organizer creates a floor, plan, doors and a navigable graph without code', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(8000);
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  const original: Project = await (await page.request.get('/api/projects/demo')).json();
  const visitor = await browser.newContext({ baseURL: 'http://127.0.0.1:5174' });
  try {
    await page.goto('/editor/demo');
    await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Редактор плана' });
    await editor.getByRole('button', { name: 'Добавить этаж' }).click();
    await editor.getByRole('textbox', { name: 'Название этажа' }).fill('Тестовый павильон');
    const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
    execFileSync(python, [
      '-c',
      "from PIL import Image; from pathlib import Path; p=Path('tmp/e2e/plan.png'); p.parent.mkdir(parents=True,exist_ok=True); Image.new('RGB',(1000,700),'#fafafa').save(p)",
    ]);
    await editor.getByLabel('Загрузить подложку').setInputFiles('tmp/e2e/plan.png');
    await expect(editor.getByRole('button', { name: 'Убрать подложку' })).toBeVisible();
    await editor.getByRole('button', { name: 'Комната', exact: true }).click();
    await point(page, 300, 200);
    await point(page, 600, 400);
    await editor.getByRole('textbox', { name: 'Название объекта' }).fill('Тестовый зал');
    await editor.getByRole('button', { name: 'Коридор', exact: true }).click();
    await point(page, 300, 400);
    await point(page, 600, 500);
    await editor.getByRole('button', { name: 'Дверь', exact: true }).click();
    await point(page, 450, 400);
    await editor.getByRole('textbox', { name: 'Название узла' }).fill('Дверь зала');
    await editor.getByRole('button', { name: 'Место', exact: true }).click();
    await point(page, 450, 300);
    await editor.getByRole('textbox', { name: 'Название объекта' }).fill('Цель проверки');
    await point(page, 450, 450);
    await editor.getByRole('textbox', { name: 'Название объекта' }).fill('Старт проверки');
    await editor.getByRole('button', { name: 'Проход', exact: true }).click();
    await editor.getByRole('button', { name: 'Узел: Цель проверки', exact: true }).click();
    await editor.getByRole('button', { name: 'Узел: Дверь зала', exact: true }).click();
    await editor.getByRole('button', { name: 'Узел: Дверь зала', exact: true }).click();
    await editor.getByRole('button', { name: 'Узел: Старт проверки', exact: true }).click();
    expect((await (await visitor.request.get('/api/projects/demo')).json()).floors).toHaveLength(
      original.floors.length,
    );
    await editor.getByRole('button', { name: 'Сохранить план', exact: true }).click();
    await expect(editor.getByText('План сохранён.', { exact: false })).toBeVisible();
    await publishCurrent(page);
    const saved: Project = await (await page.request.get('/api/projects/demo')).json();
    const start = saved.places.find((p) => p.name === 'Старт проверки')!,
      end = saved.places.find((p) => p.name === 'Цель проверки')!;
    await page.request.post('/api/projects/demo/publish', { data: { revision: saved.revision } });
    const route = await visitor.request.post('/api/projects/demo/route', {
      data: { startId: start.nodeId, endId: end.nodeId, profile: 'shortest' },
    });
    expect(route.status()).toBe(200);
    expect((await route.json()).distanceMeters).toBeCloseTo(15);
    await page.screenshot({ path: testInfo.outputPath('plan-editor.png') });
    await editor.getByRole('checkbox', { name: 'Проход закрыт' }).check();
    await editor.getByRole('button', { name: 'Сохранить план', exact: true }).click();
    await expect(editor.getByText('План сохранён.', { exact: false })).toBeVisible();
    await publishCurrent(page);
    expect(
      (
        await visitor.request.post('/api/projects/demo/route', {
          data: { startId: start.nodeId, endId: end.nodeId, profile: 'shortest' },
        })
      ).status(),
    ).toBe(404);
    await editor.getByRole('checkbox', { name: 'Проход закрыт' }).uncheck();
    await editor.getByRole('button', { name: 'Сохранить план', exact: true }).click();
    await expect(editor.getByText('План сохранён.', { exact: false })).toBeVisible();
    await publishCurrent(page);
    await editor.getByRole('button', { name: 'Закрыть редактор плана' }).click();
    const visitorPage = await visitor.newPage();
    await visitorPage.goto('/map/demo');
    await visitorPage.getByRole('textbox', { name: 'Поиск места' }).fill('Цель проверки');
    await visitorPage.locator('.place-card').filter({ hasText: 'Цель проверки' }).click();
    await expect(visitorPage.getByTestId('floor-map')).toHaveAttribute(
      'aria-label',
      'План: Тестовый павильон',
    );
    await page.reload();
    await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
    await editor.getByRole('combobox', { name: 'Этаж', exact: true }).selectOption(start.floorId);
    await editor
      .locator('.plan-object-list button')
      .filter({ hasText: 'Дверь зала' })
      .first()
      .click();
    await editor.getByRole('button', { name: 'Удалить объект' }).click();
    await editor.getByRole('button', { name: 'Отменить действие' }).click();
    await expect(
      editor.getByRole('button', { name: 'Узел: Дверь зала', exact: true }),
    ).toBeVisible();
  } finally {
    const current = await (await page.request.get('/api/projects/demo')).json();
    expect(
      (
        await page.request.put('/api/projects/demo', {
          data: { ...original, revision: current.revision },
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

test('pending stair connection survives switching floors and connects matching nodes', async ({ page }) => {
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  const original: Project = await (await page.request.get('/api/projects/demo')).json();
  try {
    await page.goto('/editor/demo');
    await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Редактор плана' });
    const floorSelect = editor.getByRole('combobox', { name: 'Этаж', exact: true });
    await editor.getByRole('button', { name: 'Добавить этаж', exact: true }).click();
    await editor.getByRole('button', { name: 'Узел пути', exact: true }).click();
    await point(page, 300, 300);
    await editor.getByRole('textbox', { name: 'Название узла', exact: true }).fill('Лестница верх');
    await editor.getByRole('combobox', { name: 'Тип узла', exact: true }).selectOption('stairs');
    await editor.getByRole('button', { name: 'Проход', exact: true }).click();
    await editor.getByRole('button', { name: 'Узел: Лестница верх', exact: true }).click();
    await floorSelect.selectOption(original.floors[0].id);
    await expect(editor.locator('.plan-pending-edge')).toContainText('Лестница верх');
    await editor.getByRole('button', { name: 'Узел пути', exact: true }).click();
    await point(page, 500, 500);
    await editor.getByRole('textbox', { name: 'Название узла', exact: true }).fill('Лестница низ');
    await editor.getByRole('combobox', { name: 'Тип узла', exact: true }).selectOption('stairs');
    await editor.getByRole('button', { name: 'Проход', exact: true }).click();
    await editor.getByRole('button', { name: 'Узел: Лестница низ', exact: true }).click();
    await expect(editor.getByText('Проход добавлен.', { exact: false })).toBeVisible();
    await expect(editor.getByRole('spinbutton', { name: /Длина перехода между этажами/ })).toBeVisible();
  } finally {
    const current = await (await page.request.get('/api/projects/demo')).json();
    await page.request.put('/api/projects/demo', { data: { ...original, revision: current.revision } });
    const restored = await (await page.request.get('/api/projects/demo')).json();
    await page.request.post('/api/projects/demo/publish', { data: { revision: restored.revision } });
  }
});

test('editor 3D overview returns to the editable 2D canvas', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  await page.goto('/editor/demo');
  await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактор плана' });
  await editor.getByRole('button', { name: '3D-обзор', exact: true }).click();
  await expect(editor.getByTestId('plan-editor-3d')).toBeVisible();
  await editor.getByRole('button', { name: '2D-план', exact: true }).click();
  const canvas = editor.getByTestId('plan-editor-canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(150);
  // A DOM-only assertion misses the Chromium repaint regression this flow once had.
  // The rendered plan contains grid, room fills and graph lines, so its PNG is
  // materially larger than an all-white canvas.
  expect((await canvas.screenshot()).length).toBeGreaterThan(20_000);
  expect(errors).toEqual([]);
});

test('studio history, layers and draft preview preserve unpublished changes', async ({ page }, testInfo) => {
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  const before = await (await page.request.get('/api/projects/demo')).json();
  await page.goto('/editor/demo');
  await page.getByRole('button', { name: 'Редактор плана', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Редактор плана' });
  await editor.getByRole('button', { name: 'Добавить этаж', exact: true }).click();
  await editor.getByRole('button', { name: 'Комната', exact: true }).click();
  await point(page, 100, 100);
  const end = await page.getByTestId('plan-editor-canvas').evaluate((svg) => {
    const p = new DOMPoint(300, 250).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(end.x, end.y);
  await expect(page.getByTestId('room-drawing-preview')).toBeVisible();
  await page.mouse.click(end.x, end.y);
  await expect(editor.locator('.plan-room-metrics')).toContainText('м²');
  await editor.getByRole('button', { name: 'Отменить действие', exact: true }).click();
  await expect(editor.locator('.plan-object-list')).not.toContainText('Новое помещение');
  await editor.getByRole('button', { name: 'Повторить действие', exact: true }).click();
  await expect(editor.locator('.plan-object-list')).toContainText('Новое помещение');
  await editor.getByRole('button', { name: 'Отменить действие', exact: true }).click();
  await editor.getByRole('button', { name: 'Отменить действие', exact: true }).click();
  await expect(editor.getByRole('combobox', { name: 'Этаж', exact: true })).toHaveValue(before.floors[0].id);
  await editor.getByRole('button', { name: 'Повторить действие', exact: true }).click();
  await editor.getByRole('button', { name: 'Отменить действие', exact: true }).click();
  await editor.getByRole('textbox', { name: 'Название пространства', exact: true }).fill('Черновик для проверки');
  await expect(editor.getByRole('button', { name: 'Повторить действие', exact: true })).toBeDisabled();
  await editor.getByRole('checkbox', { name: 'Сеть проходов', exact: true }).uncheck();
  await expect(page.getByTestId('plan-editor-canvas').locator('line')).toHaveCount(0);
  await editor.getByRole('checkbox', { name: 'Сеть проходов', exact: true }).check();
  await editor.getByRole('group', { name: 'Типы объектов этажа' }).getByRole('button', { name: /^Комнаты/ }).click();
  await expect(editor.locator('.plan-object-list')).toContainText('Ресепшен');
  await expect(editor.locator('.plan-object-list')).not.toContainText('Лестница');
  await editor.getByRole('group', { name: 'Типы объектов этажа' }).getByRole('button', { name: /^Все/ }).click();
  await editor.getByRole('searchbox', { name: 'Найти объект' }).fill('Ресепшен');
  await expect(editor.locator('.plan-object-list')).toContainText('Ресепшен');
  await expect(editor.locator('.plan-object-list')).not.toContainText('Кафе');
  await editor.getByRole('searchbox', { name: 'Найти объект' }).fill('');
  await page.screenshot({ path: testInfo.outputPath('studio-desktop.png'), fullPage: true });
  await editor.getByRole('button', { name: 'Предпросмотр', exact: true }).click();
  await expect(editor.locator('.plan-preview-info h2')).toHaveText('Черновик для проверки');
  await editor.getByRole('button', { name: 'Проверить маршрут', exact: true }).click();
  await expect(editor.getByTestId('draft-route-result')).toContainText('лестнице');
  await editor.getByRole('checkbox', { name: 'Без лестниц', exact: true }).check();
  await editor.getByRole('button', { name: 'Проверить маршрут', exact: true }).click();
  await expect(editor.getByTestId('draft-route-result')).toContainText('лифте');
  await editor.getByRole('button', { name: 'Объём', exact: false }).click();
  await expect(editor.getByTestId('isometric-map')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('studio-preview.png'), fullPage: true });
  await editor.getByRole('button', { name: 'Развернуть карту', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'К конструктору', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: 'Название пространства', exact: true })).toHaveValue('Черновик для проверки');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await editor.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await editor.getByRole('button', { name: 'Предпросмотр', exact: true }).click();
  expect(await editor.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('studio-preview-mobile.png'), fullPage: true });
  await editor.getByRole('button', { name: 'К конструктору', exact: true }).click();
  await editor.getByRole('navigation', { name: 'Панели конструктора' }).getByRole('button', { name: 'Инструменты', exact: true }).click();
  await editor.getByRole('spinbutton', { name: 'Метров в единице плана', exact: true }).fill('-0.1');
  await editor.getByRole('button', { name: 'Предпросмотр', exact: true }).click();
  await editor.getByRole('button', { name: 'Проверить маршрут', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('положительными числами');
  expect(await (await page.request.get('/api/projects/demo')).json()).toEqual(before);
});
