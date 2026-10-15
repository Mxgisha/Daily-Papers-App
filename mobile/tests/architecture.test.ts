/**
 * Architectural guard: only shipping code is reachable from a screen.
 *
 * The app carries two bodies of work that are deliberately off its path: the static-bundle
 * and recommendation pipeline under `src/core/` and `src/platform/bundle.ts`. They are real,
 * tested code, but nothing a user can reach depends on them, and they pull in four
 * dependencies (fzstd, js-sha256, expo-sqlite, expo-file-system) that the app itself has no
 * use for.
 *
 * Metro only bundles what is reachable, so this is currently true — verified by searching the
 * built web and Android bundles for their distinctive symbols, which are absent from both.
 * But "currently true" is fragile: one convenience import from a screen and a few hundred KB
 * of machinery, plus four native modules, silently join the app. That is exactly the sort of
 * legacy creep this test exists to catch.
 *
 * The second check is broader: every relative import in a screen must resolve to a file that
 * exists. A moved or deleted module otherwise surfaces as a red screen on a device rather
 * than as a failing build.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, '..', 'app');

/** Modules that must never be reachable from a screen. */
const OFF_PATH = ['src/core/', 'src/platform/bundle'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const screens = walk(APP_DIR).sort();

test('there are screens to check', () => {
  assert.ok(screens.length >= 4, `expected several screens, found ${screens.length}`);
});

test('no screen reaches off-path machinery', () => {
  const violations: string[] = [];
  for (const file of screens) {
    const source = readFileSync(file, 'utf8');
    for (const spec of importSpecifiers(source)) {
      if (OFF_PATH.some((prefix) => spec.includes(prefix))) {
        violations.push(`${file.replace(APP_DIR, 'app')} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `screens must not import off-path modules:\n  ${violations.join('\n  ')}`,
  );
});

test('every relative import from a screen resolves', () => {
  const missing: string[] = [];
  for (const file of screens) {
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const base = resolve(dirname(file), spec);
      const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
      if (!candidates.some(existsSync)) {
        missing.push(`${file.replace(APP_DIR, 'app')} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(missing, [], `unresolved imports:\n  ${missing.join('\n  ')}`);
});

/** Both `import x from 'y'` and `export ... from 'y'`, which is all this codebase uses. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import)\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}
