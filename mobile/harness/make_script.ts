/**
 * Prints the reader's injected script, so the Python harness runs the real thing rather than
 * a copy that drifts.
 *
 *   npx tsx harness/make_script.ts '{"spot":{"fraction":0.5,"anchor":40}}'
 *   npx tsx harness/make_script.ts --selector
 */

import { BLOCK_SELECTOR, buildReaderScript } from '../src/readerScript';

const arg = process.argv[2] ?? '{}';

if (arg === '--selector') {
  process.stdout.write(JSON.stringify(BLOCK_SELECTOR));
} else {
  const parsed = JSON.parse(arg) as {
    spot?: { fraction: number; anchor: number } | null;
    css?: string;
    theme?: 'light' | 'dark';
  };
  process.stdout.write(
    buildReaderScript({
      css: parsed.css ?? '',
      theme: parsed.theme ?? 'dark',
      spot: parsed.spot ?? null,
    }),
  );
}
