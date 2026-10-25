import type { Room } from './types';

export interface InteriorShape {
  x: number; y: number; width: number; height: number;
  kind: 'table' | 'seat' | 'counter' | 'shelf' | 'plant' | 'stage';
  round?: boolean;
}

// Illustrative furniture for the fictional Atlas seed only. Never used as routing geometry.
export function demoInterior(room: Room): InteriorShape[] {
  if (room.kind !== 'room' || room.width < 100 || room.height < 80) return [];
  const shapes: InteriorShape[] = [];
  const add = (x: number, y: number, w: number, h: number, kind: InteriorShape['kind'], round = false) => {
    shapes.push({ x: room.x + x * room.width, y: room.y + y * room.height, width: w * room.width, height: h * room.height, kind, round });
  };
  const table = (x: number, y: number) => {
    add(x, y, .09, .12, 'table', true);
    add(x - .025, y + .025, .025, .06, 'seat');
    add(x + .09, y + .025, .025, .06, 'seat');
  };
  switch (room.id) {
    case 'r-cafe':
      add(.08, .09, .52, .1, 'counter');
      [.14, .36, .58, .8].forEach((x) => table(x, .77));
      table(.78, .13);
      break;
    case 'r-meridian':
      add(.2, .06, .6, .1, 'stage');
      [.24, .77, .86].forEach((y) => [.12, .23, .34, .61, .72, .83].forEach((x) => add(x, y, .055, .055, 'seat')));
      break;
    case 'r-orbit':
      [.19, .76].forEach((y) => {
        add(.25, y, .5, .085, 'table');
        [.3, .43, .56, .69].forEach((x) => add(x, y + (y < .5 ? -.065 : .085), .045, .05, 'seat'));
      });
      add(.06, .12, .02, .17, 'stage');
      break;
    case 'r-coworking':
    case 'r-workshop':
      [.12, .78].forEach((y) => [.12, .35, .65].forEach((x) => {
        add(x, y, .15, .09, 'table'); add(x + .05, y + .1, .045, .045, 'seat');
      }));
      break;
    case 'r-library':
      [.1, .32, .54, .76].forEach((x) => add(x, .1, .12, .13, 'shelf'));
      [.2, .47, .74].forEach((x) => table(x, .75));
      break;
    case 'r-lounge':
    case 'r-terrace':
      [.15, .65].forEach((x) => {
        add(x, .15, .2, .085, 'seat'); add(x, .76, .2, .085, 'seat');
        add(x + .06, .28, .08, .08, 'table', true);
        add(x + .06, .62, .08, .08, 'table', true);
      });
      break;
    case 'r-reception':
      add(.15, .12, .55, .12, 'counter');
      add(.15, .78, .19, .08, 'seat'); add(.65, .78, .19, .08, 'seat');
      break;
    case 'r-studio':
      add(.15, .1, .7, .1, 'stage');
      add(.12, .76, .25, .1, 'table'); add(.62, .76, .25, .1, 'table');
      break;
    default: return [];
  }
  add(.05, .08, .035, .06, 'plant', true);
  add(.91, .86, .035, .06, 'plant', true);
  return shapes;
}

export const interiorColors = {
  table: '#fffdf8', seat: '#b8c6cb', counter: '#d3b995', shelf: '#c4b89c', plant: '#88a48b', stage: '#aab5c9',
};
