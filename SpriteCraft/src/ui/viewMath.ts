// View position and zoom. Zoom counts device pixels per canvas pixel, always a whole number from 1 up: at Windows scaling
// such as 125% or 150%, that is what keeps every canvas pixel the same size on screen.
import { ed, type View } from '../editor/editor';

export const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128];

/** Size of the viewport in device pixels. Set by the viewport. */
export const area = { w: 800, h: 600 };

export function fitView(s = ed.s) {
  const d = s.doc;
  const max = Math.min((area.w * 0.92) / d.width, (area.h * 0.92) / d.height);
  let z = ZOOMS[0];
  for (const n of ZOOMS) if (n <= max) z = n;
  s.view = { zoom: z, x: Math.round((area.w - d.width * z) / 2), y: Math.round((area.h - d.height * z) / 2) };
  ed.notify();
}

export function zoomAt(v: View, nz: number, cx: number, cy: number): View {
  const k = nz / v.zoom;
  return { zoom: nz, x: Math.round(cx - (cx - v.x) * k), y: Math.round(cy - (cy - v.y) * k) };
}

export function nextZoom(z: number, dir: number): number {
  if (dir > 0) return ZOOMS.find((n) => n > z) ?? z;
  return [...ZOOMS].reverse().find((n) => n < z) ?? z;
}

export function zoomStep(dir: number, cx = area.w / 2, cy = area.h / 2) {
  const s = ed.s;
  if (!s.view) fitView(s);
  const nz = nextZoom(s.view!.zoom, dir);
  if (nz !== s.view!.zoom) { s.view = zoomAt(s.view!, nz, cx, cy); ed.notify(); }
}
