import type { Project } from './types';

declare global {
  interface Window {
    __SPACE_OFFLINE__?: { project: Project; assets: Record<string, string>; createdAt: string };
  }
}
export const offline = window.__SPACE_OFFLINE__;
export const assetUrl = (id: string) =>
  offline ? (offline.assets[id] ?? '') : `/api/assets/${id}`;
