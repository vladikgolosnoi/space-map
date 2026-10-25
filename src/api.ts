import { offline } from './offline';
import { shortestRoute } from './routing';
import type { MediaResult, Project, Route, StitchJob } from './types';

export interface SpaceSummary {
  slug: string;
  title: string;
  revision: number;
  publishedRevision: number | null;
  isPublic: boolean;
  views: number;
  createdAt: number;
  updatedAt: number;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  organizationId: string;
}

export interface OrganizationSummary { id: string; name: string; role: 'owner' | 'admin' | 'editor' | 'viewer' }
export interface OrganizationMember { id: string; email: string; name: string; role: 'owner' | 'admin' | 'editor' | 'viewer' }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  if (offline)
    throw new Error(
      'Офлайн-копия доступна только для просмотра. Откройте сервер для редактирования.',
    );
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
    });
  } catch {
    throw new Error('Не удалось связаться с сервером. Проверьте соединение и повторите попытку.');
  }
  if (!response.ok) {
    let detail = '';
    try {
      const data = await response.json();
      detail =
        typeof data.detail === 'string'
          ? data.detail
          : Array.isArray(data.detail)
            ? data.detail.map((item: { msg: string }) => item.msg).join('; ')
            : '';
    } catch {
      /* HTTP status remains available */
    }
    if (response.status === 409 && !url.includes('/api/auth/'))
      throw new Error('Карта уже изменена в другом окне. Обновите страницу перед сохранением.');
    if ((response.status === 401 || response.status === 403) && url.includes('/api/auth/'))
      throw new Error(detail || 'Не удалось войти. Проверьте данные и повторите попытку.');
    if (response.status === 401 || response.status === 403)
      throw new Error(
        'Не удалось подтвердить доступ организатора. Проверьте пароль или войдите снова.',
      );
    if (response.status === 404 && url.includes('/route'))
      throw new Error('Прохода по выбранным условиям нет. Измените точки или режим маршрута.');
    throw new Error(detail || `Сервер вернул ошибку ${response.status}. Повторите попытку.`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const api = {
  importPlan: (file: File, slug = 'demo') => {
    const body = new FormData();
    body.append('file', file);
    return request<{ assetId: string; width: number; height: number }>(`/api/plan-import${slug === 'demo' ? '' : `?space=${encodeURIComponent(slug)}`}`, {
      method: 'POST',
      body,
    });
  },
  project: (draft = false, slug = 'demo') =>
    offline
      ? Promise.resolve(offline.project)
      : request<Project>(slug === 'demo' ? `/api/projects/demo?view=${draft ? 'draft' : 'published'}` : `/api/spaces/${encodeURIComponent(slug)}?view=${draft ? 'draft' : 'published'}`),
  publish: (revision: number, slug = 'demo') =>
    request<Project>(slug === 'demo' ? '/api/projects/demo/publish' : `/api/spaces/${encodeURIComponent(slug)}/publish`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
    }),
  save: (project: Project, slug = 'demo') =>
    request<Project>(slug === 'demo' ? '/api/projects/demo' : `/api/spaces/${encodeURIComponent(slug)}`, { method: 'PUT', body: JSON.stringify(project) }),
  route: (startId: string, endId: string, accessible: boolean, draft = false, slug = 'demo') =>
    offline
      ? Promise.resolve().then(() => shortestRoute(offline!.project, startId, endId, accessible))
      : request<Route>(slug === 'demo' ? `/api/projects/demo/route?view=${draft ? 'draft' : 'published'}` : `/api/spaces/${encodeURIComponent(slug)}/route?view=${draft ? 'draft' : 'published'}`, {
          method: 'POST',
          body: JSON.stringify({ startId, endId, profile: accessible ? 'accessible' : 'shortest' }),
        }),
  session: (slug = 'demo') =>
    offline
      ? Promise.resolve({ authenticated: false })
      : request<{ authenticated: boolean }>(slug === 'demo' ? '/api/session' : '/api/auth/session'),
  login: (password: string, slug = 'demo', email = '') =>
    request<{ authenticated: boolean }>(slug === 'demo' ? '/api/session' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(slug === 'demo' ? { password } : { email, password }),
    }),
  logout: (slug = 'demo') => request<void>(slug === 'demo' ? '/api/session' : '/api/auth/session', { method: 'DELETE' }),
  account: () => request<{ user: { id: string; email: string; name: string; organization: string }; spaces: SpaceSummary[]; organizations: OrganizationSummary[] }>('/api/account'),
  register: (name: string, email: string, password: string, organization = '') => request<{ authenticated: boolean }>('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ name, email, password, organization }),
  }),
  createSpace: (title: string, organizationId?: string) => request<Project>('/api/spaces', { method: 'POST', body: JSON.stringify({ title, organizationId }) }),
  teamMembers: (organizationId: string) => request<{ members: OrganizationMember[] }>(`/api/organizations/${encodeURIComponent(organizationId)}/members`),
  inviteMember: (organizationId: string, email: string, role: string) => request<{ token: string; email: string; role: string; expiresAt: number }>('/api/organizations/invites', { method: 'POST', body: JSON.stringify({ organizationId, email, role }) }),
  acceptInvite: (token: string) => request<{ organization: OrganizationSummary }>('/api/organizations/invites/accept', { method: 'POST', body: JSON.stringify({ token }) }),
  updateMemberRole: (organizationId: string, memberId: string, role: string) => request<{ members: OrganizationMember[] }>(`/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberId)}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeMember: (organizationId: string, memberId: string) => request<void>(`/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' }),
  countView: (slug: string, visitorId: string) => request<void>(`/api/spaces/${encodeURIComponent(slug)}/view`, {
    method: 'POST', body: JSON.stringify({ visitorId }),
  }),
  importPanorama: (file: File, angles: { haov: number; vaov: number; vOffset: number }, slug = 'demo') => {
    const body = new FormData();
    body.append('file', file);
    for (const [key, value] of Object.entries(angles)) body.append(key, String(value));
    return request<MediaResult>(`/api/panorama-import${slug === 'demo' ? '' : `?space=${encodeURIComponent(slug)}`}`, { method: 'POST', body });
  },
  startStitch: (files: File[], slug = 'demo') => {
    const body = new FormData();
    files.forEach((file) => body.append('files', file));
    return request<StitchJob>(`/api/stitch-jobs${slug === 'demo' ? '' : `?space=${encodeURIComponent(slug)}`}`, { method: 'POST', body });
  },
  stitchJob: (id: string, slug = 'demo') => request<StitchJob>(`/api/stitch-jobs/${encodeURIComponent(id)}${slug === 'demo' ? '' : `?space=${encodeURIComponent(slug)}`}`),
};
