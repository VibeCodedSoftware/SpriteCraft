// Interface icons, drawn for this app on a 16×16 pixel grid to suit it.
const P: Record<string, string> = {
  pencil: 'M11 2h1v1h1v1h1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v1H2v-3h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h-1V2z',
  eraser: 'M9 2h2v1h1v1h1v1h1v2h-1v1h-1v1h-1v1H9v1H8v1H7v1H4v-1H3v-1H2v-2h1V9h1V8h1V7h1V6h1V5h1V4h1V3H9V2zM6 8H5v1H4v1H3v1h1v1h1v1h2v-1h1v-1h1v-1h-1v-1H7V9H6V8z',
  dither: 'M2 2h2v2H2zM6 2h2v2H6zM10 2h2v2h-2zM4 4h2v2H4zM8 4h2v2H8zM12 4h2v2h-2zM2 6h2v2H2zM6 6h2v2H6zM10 6h2v2h-2zM4 8h2v2H4zM8 8h2v2H8zM12 8h2v2h-2zM2 10h2v2H2zM6 10h2v2H6zM10 10h2v2h-2zM4 12h2v2H4zM8 12h2v2H8zM12 12h2v2h-2z',
  pattern: 'M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9zM4 4v1h1V4zM11 4v1h1V4zM4 11v1h1v-1zM11 11v1h1v-1z',
  shade: 'M2 3h3v10H2zM6 3h3v10H6zM10 3h1v10h-1zM12 3h1v10h-1zM14 3h1v10h-1z',
  line: 'M12 2h2v2h-1v1h-1v1h-1v1h-1v1H9v1H8v1H7v1H6v1H5v1H4v1H2v-2h1v-1h1v-1h1V9h1V8h1V7h1V6h1V5h1V4h1V3h1V2z',
  rect: 'M2 3h12v10H2zM4 5v6h8V5z',
  ellipse: 'M6 2h4v1h2v1h1v2h1v4h-1v2h-1v1h-2v1H6v-1H4v-1H3v-2H2V6h1V4h1V3h2V2zM6 4v1H5v1H4v4h1v1h1v1h4v-1h1v-1h1V6h-1V5h-1V4H6z',
  polygon: 'M7 2h2v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-1v1H5v-1H4v-1H3v-1H2V7h1V6h1V5h1V4h1V3h1V2zM7 4v1H6v1H5v1H4v2h1v1h1v1h4v-1h1V9h1V7h-1V6h-1V5H9V4H7z',
  bucket: 'M7 2h2v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1H9v1H8v1H6v-1H5v-1H4v-1H3V9H2V7h1V6h1V5h1V4h1V3h1V2zM13 10h1v2h1v2h-3v-2h1v-2z',
  gradient: 'M2 3h4v10H2zM7 3h1v2h1V3h1v2h-1v2h1v2h-1v2h1v2H9v-2H8v2H7v-2h1V9H7V7h1V5H7zM12 3h1v2h1v2h-1v2h1v2h-1v2h-1v-2h-1V9h1V7h-1V5h1z',
  replace: 'M2 3h5v5H2zM9 8h5v5H9zM9 3h3v1h1v1h1v2h-2V6h-1V5H9zM7 13H4v-1H3v-1H2V9h2v1h1v1h2z',
  eyedropper: 'M11 2h2v1h1v2h-1v1h-1v1h1v1h-1v1h-1V8h-1v1H9v1H8v1H7v1H6v1H5v1H2v-3h1v-1h1v-1h1V9h1V8h1V7h1V6H7V5h1V4h1v1h1V4h1V2z',
  'select-rect': 'M2 2h3v1H3v2H2zM7 2h2v1H7zM11 2h3v3h-1V3h-2zM2 7h1v2H2zM13 7h1v2h-1zM2 11h1v2h2v1H2zM13 11h1v3h-3v-1h2zM7 13h2v1H7z',
  'select-ellipse': 'M6 2h4v1H6zM3 4h2v1H4v1H3zM11 4h2v2h-1V5h-1zM2 7h1v2H2zM13 7h1v2h-1zM3 10h1v1h1v1H3zM12 10h1v2h-2v-1h1zM6 13h4v1H6z',
  lasso: 'M5 2h6v1h2v1h1v3h-1v1h-2v1H6v1H5v1h1v3H5v-1H4v-2h1v-1H3V8H2V4h1V3h2zM5 4v1H4v2h1v1h6V7h1V5h-1V4z',
  wand: 'M10 2h1v2h-1zM13 3h1v1h-1zM12 5h2v1h-2zM8 4h1v1H8zM9 6h2v2h-1v1H9v1H8v1H7v1H6v1H5v1H3v-2h1v-1h1v-1h1V9h1V8h1V7h1z',
  move: 'M7 1h2v1h1v1h1v1H9v3h3V5h1v1h1v1h1v2h-1v1h-1v1h-1V9H9v3h2v1h-1v1H9v1H7v-1H6v-1H5v-1h2V9H4v2H3v-1H2V9H1V7h1V6h1V5h1v2h3V4H5V3h1V2h1z',
  transform: 'M1 1h4v4H4v6h1v4H1v-4h1V5H1zM11 1h4v4h-4V4H5V2h6zM11 11h1V5h2v6h1v4h-4v-1H5v-2h6z',
  hand: 'M6 2h1v5h1V1h1v6h1V2h1v5h1V4h1v8h-1v1h-1v1H6v-1H5v-1H4v-1H3V9H2V8h1v1h1v1h1V3h1z',
  zoom: 'M5 2h4v1h1v1h1v4h-1v1H9v1H5V9H4V8H3V4h1V3h1zM5 4v1H4v2h1v1h1v1h2V8h1V7h1V5H9V4zM10 10h1v1h1v1h1v1h1v1h-2v-1h-1v-1h-1v-1h-1v-1h1z',
  plus: 'M7 3h2v4h4v2H9v4H7V9H3V7h4z',
  minus: 'M3 7h10v2H3z',
  copy: 'M2 2h8v2H4v6H2zM6 6h8v8H6zM8 8v4h4V8z',
  link: 'M2 7h4v2H3v2h3v2H2zM10 3h4v6h-4V7h2V5h-2zM6 7h4v2H6z',
  trash: 'M6 2h4v1h3v2H3V3h3zM4 6h8v8H4zM6 8v4h1V8zM9 8v4h1V8z',
  up: 'M7 3h2v1h1v1h1v1h1v1h1v2h-3v4H6V9H3V7h1V6h1V5h1V4h1z',
  down: 'M6 3h4v4h3v2h-1v1h-1v1h-1v1H9v1H7v-1H6v-1H5v-1H4V9H3V7h3z',
  eye: 'M5 4h6v1h2v1h1v1h1v2h-1v1h-1v1h-2v1H5v-1H3v-1H2V9H1V7h1V6h1V5h2zM7 6v1H6v2h1v1h2V9h1V7H9V6z',
  eyeoff: 'M3 7h1v1h2v1h4V8h2V7h1v2h-1v1h-1v1H5v-1H4V9H3z',
  lock: 'M6 2h4v1h1v3h1v8H4V6h1V3h1zM7 4v2h2V4zM7 8v3h2V8z',
  unlock: 'M6 2h4v1h1v2H9V4H7v2h5v8H4V6h1V3h1zM7 8v3h2V8z',
  folder: 'M2 3h5v1h1v1h6v8H2zM4 7v4h8V7z',
  play: 'M4 2h2v1h2v1h2v1h2v1h2v4h-2v1h-2v1H8v1H6v1H4z',
  stop: 'M3 3h10v10H3z',
  prev: 'M3 3h2v4h1V6h1V5h1V4h1V3h2v10H9v-1H8v-1H7v-1H6V9H5v4H3z',
  next: 'M11 3h2v10h-2V9h-1v1H9v1H8v1H7v1H5V3h2v1h1v1h1v1h1v1h1z',
  onion: 'M5 2h6v1h1v1h1v8h-1v1h-1v1H5v-1H4v-1H3V4h1V3h1zM6 4v8h1V4zM9 4v8h1V4z',
  tag: 'M2 2h6v1h1v1h1v1h1v1h1v1h1v2h-1v1h-1v1h-1v1H9v1H8v1H6v-1H5v-1H4v-1H3V9H2zM4 4v2h2V4z',
  swap: 'M10 1h1v1h1v1h1v1h1v1h-3v3H9V5H6V3h3V2h1zM5 8h2v3h3v2H7v1H6v1H5v-1H4v-1H3v-1H2v-1h3z',
  mask: 'M2 2h12v12H2zM4 4v8h8V4zM6 6h4v4H6z',
  clip: 'M3 2h2v9h8v2H3zM7 2h6v7h-2V4H7z',
  alpha: 'M2 2h4v4H2zM10 2h4v4h-4zM6 6h4v4H6zM2 10h4v4H2zM10 10h4v4h-4z',
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d={P[name] ?? ''} />
    </svg>
  );
}
