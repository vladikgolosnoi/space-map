declare module 'pannellum';
declare module 'pannellum/build/pannellum.css';

interface PannellumViewer {
  on(event: string, callback: (value?: unknown) => void): PannellumViewer;
  getYaw(): number;
  getPitch(): number;
  getHfov(): number;
  setHfov(value: number, animated?: number | boolean): PannellumViewer;
  lookAt(pitch: number, yaw: number, hfov?: number, animated?: number | boolean): PannellumViewer;
  resize(): PannellumViewer;
  destroy(): void;
}

interface Window {
  pannellum: {
    viewer(container: HTMLElement, config: Record<string, unknown>): PannellumViewer;
  };
}
