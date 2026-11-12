// Guards the project's open source status: everything that ships inside the app must be under a permissive licence.
// Adding a dependency under anything else (GPL, LGPL, AGPL, or no licence at all) fails this test.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Zlib', 'Unlicense']);

function licenseOf(pkg: any): string {
  return typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? pkg.licenses?.[0]?.type ?? 'UNKNOWN';
}

function findPackage(name: string, from: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const p = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(p)) return p;
    if (path.dirname(dir) === dir) return null;
  }
}

function shipped(): { name: string; license: string }[] {
  const seen = new Map<string, string>();
  const walk = (name: string, from: string) => {
    if (seen.has(name)) return;
    const file = findPackage(name, from);
    if (!file) return;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    seen.set(name, licenseOf(pkg));
    for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, path.dirname(file));
  };
  const own = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const dep of Object.keys(own.dependencies)) walk(dep, ROOT);
  return [...seen].map(([name, license]) => ({ name, license }));
}

describe('licences of everything shipped', () => {
  it('are all permissive', () => {
    const list = shipped();
    expect(list.length).toBeGreaterThan(2);
    expect(list.filter((d) => !ALLOWED.has(d.license))).toEqual([]);
  });
  it('are listed in the notices file that ships with the app', () => {
    const notices = fs.readFileSync(path.join(ROOT, 'packaging', 'NOTICE.md'), 'utf8');
    for (const d of shipped()) expect(notices, `${d.name} is missing from packaging/NOTICE.md`).toContain(d.name);
  });
  it('the app imports only from its own code and its declared dependencies', () => {
    // A shared-app import would pull other projects' files and licences into this build unnoticed.
    const own = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const bad: string[] = [];
    for (const f of walk(path.join(ROOT, 'src'))) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/from '([^.'][^']*)'/g)) {
        const name = m[1].split('/')[0];
        if (!own.dependencies[name]) bad.push(`${path.basename(f)}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
