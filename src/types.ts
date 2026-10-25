export interface Floor {
  id: string;
  name: string;
  level: number;
  width: number;
  height: number;
  metersPerUnit: number;
  backgroundAssetId?: string | null;
}
export interface Room {
  id: string;
  floorId: string;
  name: string;
  kind: 'room' | 'corridor';
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface MapNode {
  id: string;
  floorId: string;
  x: number;
  y: number;
  label: string;
  kind: 'walk' | 'stairs' | 'elevator';
}
export interface Edge {
  id: string;
  fromId: string;
  toId: string;
  kind: 'walk' | 'stairs' | 'elevator';
  accessible: boolean;
  blocked: boolean;
  bidirectional: boolean;
  distanceMeters?: number | null;
}
export interface Place {
  id: string;
  floorId: string;
  nodeId: string;
  name: string;
  category: string;
  description: string;
  x: number;
  y: number;
}
export type DecorationKind = 'table' | 'chair' | 'sofa' | 'desk' | 'plant' | 'counter' | 'shelf';
export interface Decoration {
  id: string;
  floorId: string;
  roomId?: string | null;
  kind: DecorationKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}
export interface Project {
  id: string;
  slug: string;
  title: string;
  revision: number;
  floors: Floor[];
  rooms: Room[];
  nodes: MapNode[];
  edges: Edge[];
  places: Place[];
  decorations: Decoration[];
  panoramas: Panorama[];
}
export interface Hotspot {
  id: string;
  yaw: number;
  pitch: number;
  text: string;
  kind: 'info' | 'scene';
  placeId?: string;
  targetPanoramaId?: string;
}
export interface MediaResult {
  assetId: string;
  thumbnailId: string;
  width: number;
  height: number;
  haov: number;
  vaov: number;
  vOffset: number;
  projection: 'equirectangular';
  source: 'stitched' | 'imported';
  warnings: string[];
  sourceCount?: number;
  usedImageCount?: number;
}
export interface Panorama {
  id: string;
  name: string;
  floorId: string;
  nodeId: string;
  x: number;
  y: number;
  yawOffset: number;
  assetId: string;
  thumbnailId: string;
  projection: 'equirectangular';
  haov: number;
  vaov: number;
  vOffset: number;
  width: number;
  height: number;
  source: 'stitched' | 'imported';
  hotspots: Hotspot[];
}
export interface StitchJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  error?: string | null;
  result?: MediaResult | null;
}
export interface Route {
  nodes: MapNode[];
  edgeIds: string[];
  distanceMeters: number;
  durationSeconds: number;
  steps: string[];
}
