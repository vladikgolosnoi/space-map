import { chromium, request } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import net from 'node:net';

// Isolated production server and database; never writes the user's demo.
const output = path.resolve(process.argv[2] || 'tmp/qa/performance.json');
await mkdir('tmp/performance', { recursive: true });
const folder = await mkdtemp(path.resolve('tmp/performance/run-'));
const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
const password = randomBytes(24).toString('hex');
const socket = net.createServer();
await new Promise((resolve, reject) => {
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', resolve);
});
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const baseURL = `http://127.0.0.1:${port}`;
const server = spawn(
  python,
  ['-m', 'uvicorn', 'backend.app.main:app', '--host', '127.0.0.1', '--port', String(port)],
  {
    env: {
      ...process.env,
      SPACE_DB_PATH: path.join(folder, 'space.db'),
      SPACE_ADMIN_PASSWORD: password,
    },
    windowsHide: true,
    stdio: 'ignore',
  },
);
let browser, api;
try {
  api = await request.newContext({ baseURL });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Benchmark server could not start.');
    try {
      ready = (await api.get('/api/health')).ok();
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Benchmark server did not become ready.');
  const login = await api.post('/api/session', { data: { password } });
  if (!login.ok()) throw new Error('Isolated benchmark session could not be established.');
  const fixture = path.join(folder, 'synthetic.jpg');
  execFileSync(python, [
    '-c',
    'import sys,numpy as np; from PIL import Image; rng=np.random.default_rng(42); a=rng.integers(0,256,(1024,2048,3),dtype=np.uint8); Image.fromarray(a).save(sys.argv[1],quality=82)',
    fixture,
  ]);
  const imported = await api.post('/api/panorama-import', {
    multipart: {
      file: { name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: await readFile(fixture) },
      haov: '360',
      vaov: '180',
      vOffset: '0',
    },
  });
  if (!imported.ok()) throw new Error(await imported.text());
  const { warnings, ...media } = await imported.json();
  const project = await (await api.get('/api/projects/demo')).json();
  const node = project.nodes[0];
  project.panoramas = [
    {
      ...media,
      id: 'benchmark',
      name: 'Тест загрузки (синтетический)',
      floorId: node.floorId,
      nodeId: node.id,
      x: node.x,
      y: node.y,
      yawOffset: 0,
      hotspots: [],
    },
  ];
  const saved = await api.put('/api/projects/demo', { data: project });
  if (!saved.ok()) throw new Error(await saved.text());
  const published = await api.post('/api/projects/demo/publish', {
    data: { revision: (await saved.json()).revision },
  });
  if (!published.ok()) throw new Error(await published.text());
  browser = await chromium.launch();
  const runs = [];
  for (let run = 0; run < 3; run++) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: 1600000 / 8,
      uploadThroughput: 750000 / 8,
      connectionType: 'cellular4g',
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Performance.enable');
    let bytes = 0;
    const errors = [];
    cdp.on('Network.loadingFinished', (event) => {
      bytes += event.encodedDataLength;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseURL + '/map/demo');
    await page.getByTestId('floor-map').waitFor();
    await page.getByRole('heading', { name: 'Куда отправимся?' }).waitFor();
    const mapReadyMs = await page.evaluate(() => performance.now());
    const mapBytes = bytes;
    const clickStart = await page.evaluate(() => performance.now());
    await page
      .getByRole('button', { name: 'Открыть панораму: Тест загрузки (синтетический)' })
      .click();
    await page.getByRole('button', { name: 'Приблизить панораму' }).waitFor({ timeout: 60000 });
    await page.locator('.pnlm-render-container canvas').waitFor();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const panoramaReadyMs = await page.evaluate((start) => performance.now() - start, clickStart);
    const metrics = await cdp.send('Performance.getMetrics');
    if (errors.length) throw new Error(errors.join('\n'));
    runs.push({
      mapReadyMs: Math.round(mapReadyMs),
      mapTransferredBytes: mapBytes,
      panoramaReadyMs: Math.round(panoramaReadyMs),
      totalTransferredBytes: bytes,
      jsHeapUsedBytes: metrics.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value,
    });
    await context.close();
    console.log(
      `Run ${run + 1}: map ${runs.at(-1).mapReadyMs} ms, panorama ${runs.at(-1).panoramaReadyMs} ms`,
    );
  }
  const median = (key) => runs.map((r) => r[key]).sort((a, b) => a - b)[1];
  const report = {
    createdAt: new Date().toISOString(),
    browser: browser.version(),
    platform: process.platform,
    profile: {
      viewport: '390x844',
      cpuSlowdown: 4,
      downloadBitsPerSecond: 1600000,
      uploadBitsPerSecond: 750000,
      latencyMs: 150,
      cache: 'disabled, fresh context each run',
      runs: 3,
    },
    fixture: {
      description: 'Seeded random RGB image, synthetic load fixture; not an indoor quality sample',
      width: media.width,
      height: media.height,
      jpegBytes: (await (await api.get('/api/assets/' + media.assetId)).body()).length,
      oneRgbaTextureBytes: media.width * media.height * 4,
    },
    measurements:
      'Map: navigation to visible map and sidebar. Panorama: click to loaded controls, visible canvas and two animation frames. Includes Playwright observation overhead. JS heap excludes GPU and native image memory; RGBA is one-texture estimate, not peak memory.',
    runs,
    median: Object.fromEntries(Object.keys(runs[0]).map((key) => [key, median(key)])),
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${output}`);
} finally {
  await browser?.close();
  await api?.dispose();
  server.kill();
}
