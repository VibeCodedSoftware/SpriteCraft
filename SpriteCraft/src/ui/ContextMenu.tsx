import { useEffect, useState } from 'react';

export interface MenuItem { label: string; run: () => void; disabled?: boolean }

let open: ((m: { x: number; y: number; items: MenuItem[] } | null) => void) | null = null;
export const showContextMenu = (x: number, y: number, items: MenuItem[]) => open?.({ x, y, items });

export function ContextMenuHost() {
  const [m, setM] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  useEffect(() => { open = setM; return () => { open = null; }; }, []);
  useEffect(() => {
    if (!m) return;
    const close = () => setM(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); };
  }, [m]);
  if (!m) return null;
  const x = Math.min(m.x, window.innerWidth - 200), y = Math.min(m.y, window.innerHeight - m.items.length * 28 - 8);
  return (
    <div className="menu-pop ctx" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      {m.items.map((it) => <button key={it.label} className="menu-item" disabled={it.disabled} onClick={() => { setM(null); it.run(); }}><span>{it.label}</span></button>)}
    </div>
  );
}
