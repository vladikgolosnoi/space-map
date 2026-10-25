import type { Panorama, Route } from './types';

// A continuous preview requires a scene at every graph node and an explicit
// transition in the direction of travel. Never infer a path through missing views.
export function panoramaRoute(route: Route | null, panoramas: Panorama[]) {
  if (!route) return { scenes: [] as Panorama[], complete: false };
  const scenes = route.nodes.map((node) => panoramas.find((p) => p.nodeId === node.id));
  const complete =
    scenes.length > 0 &&
    scenes.every(
      (scene, index) =>
        scene &&
        (index === scenes.length - 1 ||
          scene.hotspots.some(
            (h) => h.kind === 'scene' && h.targetPanoramaId === scenes[index + 1]?.id,
          )),
    );
  return { scenes: scenes.filter((p): p is Panorama => !!p), complete };
}
