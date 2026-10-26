import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test('product landing guides a visitor to a real demo or business workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Покажите людям, куда идти/ })).toBeVisible();
  await expect(page.getByTitle('Интерактивная демо-карта ТрансТелеКома')).toHaveAttribute('src', '/embed/demo');
  await expect(page.getByRole('link', { name: 'Сначала посмотреть демо' })).toHaveAttribute('href', '/map/demo');
  await page.getByRole('link', { name: 'Создать пространство', exact: true }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByLabel(/Компания или команда/)).toBeVisible();
});

test('mobile landing and organization dashboard fit a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Покажите людям, куда идти/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.goto('/register');
  await page.getByLabel('Ваше имя').fill('Mobile owner');
  await page.getByLabel(/Компания или команда/).fill('Мобильный офис');
  await page.getByLabel('Электронная почта').fill(`mobile-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('Пароль').fill('long-playwright-password');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByRole('heading', { name: /Добро пожаловать/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole('button', { name: /Новая карта/ })).toBeVisible();
});

test('organization member loading explains a network failure and recovers on retry', async ({ page }) => {
  let failOnce = true;
  await page.route('**/api/organizations/*/members', async (route) => {
    if (failOnce) {
      failOnce = false;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  const email = `retry-${crypto.randomUUID()}@example.test`;
  await page.goto('/register');
  await page.getByLabel('Ваше имя').fill('Пользователь после сбоя сети');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль').fill('retry-after-network-failure');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL(/\/account$/);
  const error = page.locator('.portal-member-error');
  await expect(error).toContainText('Проверьте соединение');
  await error.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.locator('.portal-member-list')).toContainText(email);
  await expect(page.locator('.portal-team-heading')).toContainText('1 участник');
});

test('an empty new space explains that panoramas need a route node first', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Ваше имя').fill('Автор нового пространства');
  await page.getByLabel('Электронная почта').fill(`empty-map-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('Пароль').fill('empty-map-needs-route-node');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByLabel('Название пространства').fill('Новое пространство без узлов');
  await page.getByRole('button', { name: /Новая карта/ }).click();
  await expect(page).toHaveURL(/\/editor\/space-/);
  await page.getByRole('button', { name: 'Панорамы', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить панораму', exact: true }).click();
  const studio = page.getByRole('dialog', { name: 'Добавить панораму' });
  await expect(studio.getByRole('status')).toContainText('Панорама привязывается к узлу маршрута');
  await expect(studio.getByRole('button', { name: 'Сшить фотографии' })).toBeDisabled();
  await expect(studio.getByRole('button', { name: 'Вернуться к конструктору' })).toBeVisible();
  await studio.getByRole('button', { name: 'Вернуться к конструктору' }).click();
  await expect(studio).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Редактор плана' })).toBeVisible();
});

test('team invitation joins an email-matched account and enables shared editor access', async ({ page, browser }) => {
  const ownerEmail = `team-owner-${crypto.randomUUID()}@example.test`;
  const memberEmail = `team-editor-${crypto.randomUUID()}@example.test`;
  await page.goto('/register');
  await page.getByLabel('Ваше имя').fill('Владелец команды');
  await page.getByLabel(/Компания или команда/).fill('Бюро Север');
  await page.getByLabel('Электронная почта').fill(ownerEmail);
  await page.getByLabel('Пароль').fill('owner-team-playwright-password');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL(/\/account$/);
  const org = await page.locator('.portal-org-switch select').inputValue();
  const title = 'Карта общей команды';
  await page.getByLabel('Название пространства').fill(title);
  await page.getByRole('button', { name: /Новая карта/ }).click();
  await expect(page).toHaveURL(/\/editor\/space-/);
  await page.goto('/account');
  await page.getByLabel('Email участника').fill(memberEmail);
  await page.getByRole('button', { name: 'Создать ссылку-приглашение' }).click();
  const inviteUrl = await page.locator('.portal-invite-link input').inputValue();
  expect(inviteUrl).toContain('/register?invite=');

  const member = await browser.newContext({ baseURL: 'http://127.0.0.1:5174' });
  try {
    const invitedPage = await member.newPage();
    await invitedPage.goto(inviteUrl.replace('http://127.0.0.1:5174', ''));
    await invitedPage.getByLabel('Ваше имя').fill('Редактор команды');
    await invitedPage.getByLabel(/Компания или команда/).fill('Моё личное');
    await invitedPage.getByLabel('Электронная почта').fill(memberEmail);
    await invitedPage.getByLabel('Пароль').fill('member-team-playwright-password');
    await invitedPage.getByRole('button', { name: 'Создать аккаунт' }).click();
    await expect(invitedPage).toHaveURL(/\/account$/);
    await expect(invitedPage.getByRole('alert')).toContainText('Приглашение принято');
    await expect(invitedPage.getByRole('option', { name: /Бюро Север/ })).toBeAttached();
    const personalOrg = await invitedPage.locator('.portal-org-switch select').inputValue();
    const personalTitle = 'Личная карта редактора';
    await invitedPage.getByLabel('Название пространства').fill(personalTitle);
    await invitedPage.getByRole('button', { name: /Новая карта/ }).click();
    await expect(invitedPage).toHaveURL(/\/editor\/space-/);
    await invitedPage.goto('/account');
    await expect(invitedPage.locator('.portal-space-card')).toContainText(personalTitle);
    await invitedPage.locator('.portal-org-switch select').selectOption(org);
    await expect(invitedPage.locator('.portal-member-list')).toContainText(memberEmail);
    await expect(invitedPage.locator('.portal-space-card')).not.toContainText(personalTitle);
    await expect(invitedPage.locator('.portal-space-card').filter({ hasText: title })).toContainText('редактор');
    await invitedPage.locator('.portal-org-switch select').selectOption(personalOrg);
    await expect(invitedPage.locator('.portal-space-card')).toContainText(personalTitle);
    await expect(invitedPage.locator('.portal-space-card')).not.toContainText(title);
    await invitedPage.locator('.portal-org-switch select').selectOption(org);
    await invitedPage.locator('.portal-space-card').filter({ hasText: title }).getByRole('link', { name: /Открыть редактор/ }).click();
    await expect(invitedPage).toHaveURL(/\/editor\/space-/);
    await expect(invitedPage.getByRole('button', { name: 'Редактор плана' })).toBeVisible();
    await expect(invitedPage.getByRole('button', { name: 'Публикация' })).toHaveCount(0);

    const viewerEmail = `team-viewer-${crypto.randomUUID()}@example.test`;
    await page.getByLabel('Email участника').fill(viewerEmail);
    await page.getByLabel('Доступ').selectOption('viewer');
    await page.getByRole('button', { name: 'Создать ссылку-приглашение' }).click();
    const viewerInvite = await page.locator('.portal-invite-link input').inputValue();
    const viewer = await browser.newContext({ baseURL: 'http://127.0.0.1:5174' });
    try {
      const readOnlyPage = await viewer.newPage();
      await readOnlyPage.goto(viewerInvite);
      await readOnlyPage.getByLabel('Ваше имя').fill('Наблюдатель команды');
      await readOnlyPage.getByLabel('Электронная почта').fill(viewerEmail);
      await readOnlyPage.getByLabel('Пароль').fill('viewer-team-playwright-password');
      await readOnlyPage.getByRole('button', { name: 'Создать аккаунт' }).click();
      await expect(readOnlyPage).toHaveURL(/\/account$/);
      await readOnlyPage.locator('.portal-org-switch select').selectOption(org);
      await readOnlyPage.locator('.portal-space-card').filter({ hasText: title }).getByRole('link', { name: /Просмотреть черновик/ }).click();
      await expect(readOnlyPage.getByText('Только просмотр команды')).toBeVisible();
      await expect(readOnlyPage.getByRole('button', { name: 'Редактор плана' })).toHaveCount(0);
      await expect(readOnlyPage.getByRole('button', { name: 'Публикация' })).toHaveCount(0);
    } finally {
      await viewer.close();
    }
  } finally {
    await member.close();
  }
});

test('organization owner can review and revoke a pending invite from the account portal', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Ваше имя').fill('Владелец пространства');
  await page.getByLabel('Электронная почта').fill(`invite-owner-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('Пароль').fill('invite-owner-playwright-password');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL(/\/account$/);

  const guestEmail = `invite-pending-${crypto.randomUUID()}@example.test`;
  await page.getByLabel('Email участника').fill(guestEmail);
  await page.getByRole('button', { name: 'Создать ссылку-приглашение' }).click();
  const inviteUrl = await page.locator('.portal-invite-link input').inputValue();
  const inviteToken = new URL(inviteUrl).searchParams.get('invite');
  expect(inviteToken).toBeTruthy();

  const activeInvite = page.locator('.portal-invite-row').filter({ hasText: guestEmail });
  await expect(activeInvite).toContainText('Редактор');
  page.once('dialog', (dialog) => dialog.accept());
  await activeInvite.getByRole('button', { name: 'Отозвать' }).click();
  await expect(page.getByRole('status')).toContainText('Приглашение отозвано');
  await expect(activeInvite).toHaveCount(0);
  const response = await page.request.post('/api/organizations/invites/accept', { data: { token: inviteToken } });
  expect(response.status()).toBe(404);
});

async function point(page: import('@playwright/test').Page, x: number, y: number) {
  const canvas = page.getByTestId('plan-editor-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const position = await canvas.evaluate((svg, p) => {
    const point = new DOMPoint(p.x, p.y).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
    return { x: point.x, y: point.y };
  }, { x, y });
  await page.mouse.click(position.x, position.y);
}

test('a new user creates a private space, publishes it, and sees its visitor count', async ({ page, browser }) => {
  await page.goto('/register');
  await page.getByLabel('Ваше имя').fill('Тестовый владелец');
  await page.getByLabel(/Компания или команда/).fill('Архитектурное бюро «Север»');
  const email = `owner-${crypto.randomUUID()}@example.test`;
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль').fill('long-playwright-password');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page).toHaveURL(/\/account$/);
  const title = `Студия ${email.slice(6, 14)}`;
  await page.getByLabel('Название пространства').fill(title);
  await page.getByRole('button', { name: /Новая карта/ }).click();
  await expect(page).toHaveURL(/\/editor\/space-[a-f0-9]+$/);
  const slug = new URL(page.url()).pathname.split('/').at(-1)!;
  await expect(page.getByText('Режим организатора')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Редактор плана' })).toBeVisible();
  await page.getByRole('button', { name: 'Редактор плана' }).click();
  const editor = page.getByRole('dialog', { name: 'Редактор плана' });
  const python = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  execFileSync(python, [
    '-c',
    "from PIL import Image; from pathlib import Path; p=Path('tmp/e2e/plan.png'); p.parent.mkdir(parents=True,exist_ok=True); Image.new('RGB',(640,420),'#f3f0e8').save(p)",
  ]);
  await editor.getByLabel('Загрузить подложку').setInputFiles('tmp/e2e/plan.png');
  await expect(editor.getByRole('button', { name: 'Убрать подложку' })).toBeVisible();
  await editor.getByRole('button', { name: 'Комната', exact: true }).click();
  await point(page, 180, 170);
  await point(page, 390, 330);
  await editor.getByRole('textbox', { name: 'Название объекта' }).fill('Лаборатория пользователя');
  await editor.getByRole('button', { name: 'Сохранить план', exact: true }).click();
  await expect(editor.getByText('План сохранён.', { exact: false })).toBeVisible();
  await editor.getByRole('button', { name: 'Закрыть редактор плана' }).click();

  const stranger = await browser.newContext({ baseURL: 'http://127.0.0.1:5174' });
  try {
    expect((await stranger.request.get(`/api/spaces/${slug}`)).status()).toBe(404);
    await page.getByRole('button', { name: 'Публикация', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Карта готова к показу?' });
    await dialog.getByRole('button', { name: 'Опубликовать сохранённую версию' }).click();
    await expect(dialog.getByRole('status')).toContainText('Опубликована версия');
    expect((await stranger.request.get(`/api/spaces/${slug}`)).status()).toBe(200);
    const privateMutation = await stranger.request.put(`/api/spaces/${slug}`, { data: await (await stranger.request.get(`/api/spaces/${slug}`)).json() });
    expect(privateMutation.status()).toBe(401);

    // The owner can open the public route while signed in; it must remain a visitor-only view.
    await page.goto(`/map/${slug}`);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Войти в аккаунт' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Редактировать' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Режим посетителя' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Скачать офлайн-карту' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Экспорт проекта' })).toHaveCount(0);
    await expect(page.locator('.map-caption')).toHaveCount(0);
    await expect(page.locator('.project-label')).toHaveText('ПУБЛИЧНАЯ КАРТА');

    const publicPage = await stranger.newPage();
    await publicPage.goto(`/map/${slug}`);
    await expect(publicPage.getByRole('heading', { name: title })).toBeVisible();
    await expect(publicPage.getByRole('button', { name: 'Войти в аккаунт' })).toHaveCount(0);
    await expect(publicPage.getByRole('link', { name: 'Редактировать' })).toHaveCount(0);
    await expect(publicPage.getByRole('button', { name: 'Скачать офлайн-карту' })).toHaveCount(0);
    await expect(publicPage.getByRole('button', { name: 'Экспорт проекта' })).toHaveCount(0);
    await expect(publicPage.locator('.map-caption')).toHaveCount(0);
    await expect(publicPage.getByRole('button', { name: 'Панорамы', exact: true })).toBeVisible();
    await publicPage.close();
  } finally {
    await stranger.close();
  }

  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Пространства команды' })).toBeVisible();
  await expect(page.getByRole('option', { name: /Архитектурное бюро «Север»/i })).toBeAttached();
  const card = page.locator('.portal-space-card').filter({ hasText: title });
  await expect(card).toContainText('Опубликована');
  await expect(card).toContainText('1 просмотр');
  await expect(card.getByRole('link', { name: 'Открыть карту', exact: true })).toHaveAttribute('href', `/map/${slug}`);
  for (const width of [320, 390, 425, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const cardBounds = await card.boundingBox();
    if (!cardBounds) throw new Error('Published space card is missing');
    const actions = await card.locator('.portal-space-actions > *').evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right };
      }),
    );
    for (const action of actions) {
      expect(action.left).toBeGreaterThanOrEqual(cardBounds.x - 1);
      expect(action.right).toBeLessThanOrEqual(cardBounds.x + cardBounds.width + 1);
    }
  }
  await page.getByRole('textbox', { name: 'Поиск по картам' }).fill('нет такой карты');
  await expect(page.getByText('Ничего не найдено')).toBeVisible();
  await page.getByRole('textbox', { name: 'Поиск по картам' }).clear();
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/login');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль').fill('long-playwright-password');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/account$/);
});
