import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { shortestRoute } from '../src/routing';
import type { Project } from '../src/types';

test('offline Dijkstra matches server for every demo endpoint and profile', async ({ request }) => {
  test.setTimeout(120000);
  const project: Project = await (await request.get('/api/projects/demo?view=published')).json();
  for (const start of project.nodes)
    for (const end of project.nodes)
      for (const accessible of [false, true]) {
        const response = await request.post('/api/projects/demo/route?view=published', {
          data: {
            startId: start.id,
            endId: end.id,
            profile: accessible ? 'accessible' : 'shortest',
          },
        });
        if (response.status() === 404)
          expect(() => shortestRoute(project, start.id, end.id, accessible)).toThrow();
        else {
          expect(response.status()).toBe(200);
          expect(shortestRoute(project, start.id, end.id, accessible)).toEqual(
            await response.json(),
          );
        }
      }
  const blocked = { ...project, edges: project.edges.map((e) => ({ ...e, blocked: true })) };
  expect(() => shortestRoute(blocked, project.nodes[0].id, project.nodes[1].id, false)).toThrow();
  const edge = project.edges[0];
  const directed = { ...project, edges: [{ ...edge, blocked: false, bidirectional: false }] };
  expect(shortestRoute(directed, edge.fromId, edge.toId, false).edgeIds).toEqual([edge.id]);
  expect(() => shortestRoute(directed, edge.toId, edge.fromId, false)).toThrow();
});

test('downloaded HTML opens with network disabled and computes a route', async ({
  request,
  browser,
}, testInfo) => {
  const response = await request.get('/api/projects/demo/offline');
  expect(response.status()).toBe(200);
  const filename = testInfo.outputPath('space-map.html');
  await writeFile(filename, await response.body());
  const context = await browser.newContext({ offline: true });
  try {
    const page = await context.newPage();
    const errors: string[] = [],
      network: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (/^https?:/.test(r.url())) network.push(r.url());
    });
    await page.goto(pathToFileURL(filename).href);
    await expect(page.getByText(/Офлайн-копия · версия/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Организатору' })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Поиск места' }).fill('Орбита');
    await expect(page.locator('.place-card')).toHaveCount(1);
    await page.getByRole('button', { name: 'Маршрут', exact: true }).click();
    await page.getByRole('combobox', { name: 'Куда', exact: true }).selectOption('f2-orbit');
    await page.getByRole('checkbox', { name: /Без лестниц/ }).check();
    await page.getByRole('button', { name: 'Построить маршрут', exact: true }).click();
    await expect(page.locator('.route-steps')).toContainText('на лифте');
    await expect(page.getByTestId('route-segment')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('offline-route.png'), fullPage: true });
    expect(errors).toEqual([]);
    expect(network).toEqual([]);
  } finally {
    await context.close();
  }
});

test('UI download preserves panorama WebGL and plan image without network', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const imagePath = testInfo.outputPath('sphere.png');
  execFileSync(python, [
    '-c',
    "from PIL import Image,ImageDraw; import sys; im=Image.new('RGB',(1024,512),'#b7d4ef'); d=ImageDraw.Draw(im); d.rectangle((0,256,1024,512),fill='#415979'); d.rectangle((420,170,600,360),fill='#e8b36e'); im.save(sys.argv[1])",
    imagePath,
  ]);
  await page.request.post('/api/session', { data: { password: 'atlas-local-test-password' } });
  const initial: Project = await (await page.request.get('/api/projects/demo')).json();
  const context = await browser.newContext({ offline: true });
  try {
    const file = { name: 'sphere.png', mimeType: 'image/png', buffer: await readFile(imagePath) };
    const media = await (
      await page.request.post('/api/panorama-import', {
        multipart: { file, haov: '360', vaov: '180', vOffset: '0' },
      })
    ).json();
    const plan = await (
      await page.request.post('/api/plan-import', { multipart: { file } })
    ).json();
    const node = initial.nodes[0];
    const panorama = {
      ...media,
      id: 'offline-test',
      name: 'Офлайн-сфера',
      floorId: node.floorId,
      nodeId: node.id,
      x: node.x,
      y: node.y,
      yawOffset: 0,
      hotspots: [],
    };
    delete panorama.warnings;
    const savedResponse = await page.request.put('/api/projects/demo', {
      data: {
        ...initial,
        floors: initial.floors.map((f) =>
          f.id === node.floorId ? { ...f, backgroundAssetId: plan.assetId } : f,
        ),
        panoramas: [...initial.panoramas, panorama],
      },
    });
    expect(savedResponse.status()).toBe(200);
    const saved = await savedResponse.json();
    expect(
      (
        await page.request.post('/api/projects/demo/publish', {
          data: { revision: saved.revision },
        })
      ).status(),
    ).toBe(200);
    await page.goto('/map/demo');
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Скачать офлайн-карту' }).click();
    const download = await downloaded;
    const filename = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(filename);
    const local = await context.newPage();
    const network: string[] = [],
      errors: string[] = [];
    local.on('request', (r) => {
      if (/^https?:/.test(r.url())) network.push(r.url());
    });
    local.on('pageerror', (e) => errors.push(e.message));
    await local.goto(pathToFileURL(filename).href);
    await expect(local.locator('svg image').first()).toHaveAttribute(
      'href',
      /^data:image\/jpeg;base64,/,
    );
    await local.getByRole('button', { name: 'Открыть панораму: Офлайн-сфера' }).click();
    await expect(local.getByRole('button', { name: 'Приблизить панораму' })).toBeVisible();
    await expect(local.locator('.pnlm-render-container canvas')).toBeVisible();
    await local.screenshot({ path: testInfo.outputPath('offline-panorama.png'), fullPage: true });
    expect(network).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    const current = await (await page.request.get('/api/projects/demo')).json();
    const restored = await (
      await page.request.put('/api/projects/demo', {
        data: { ...initial, revision: current.revision },
      })
    ).json();
    await page.request.post('/api/projects/demo/publish', {
      data: { revision: restored.revision },
    });
  }
});
