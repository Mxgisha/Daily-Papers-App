/**
 * Onboarding seed selection.
 *
 * The entire cold-start profile comes from the papers a user picks here, so the picker
 * matters more than it looks. Port of `cmd_seeds` in recsys/__main__.py: prefer papers that
 * are renderable and recent, and spread them across categories so one field cannot dominate
 * the resulting profile.
 */

import type { Corpus, Paper } from './feed';

export function pickSeeds(corpus: Corpus, limit: number): Paper[] {
  const byCategory = new Map<string, Paper[]>();

  const renderable = corpus.papers
    .filter((p) => p.htmlAvailable && p.vecIndex !== null && p.publishedAt !== null)
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));

  for (const p of renderable) {
    const list = byCategory.get(p.primaryCategory);
    if (list) list.push(p);
    else byCategory.set(p.primaryCategory, [p]);
  }

  // Largest categories first, then round-robin so the pick is spread rather than
  // concentrated in whatever field happens to be biggest.
  let order = [...byCategory.keys()].sort(
    (a, b) => (byCategory.get(b)?.length ?? 0) - (byCategory.get(a)?.length ?? 0),
  );

  const picked: Paper[] = [];
  let i = 0;
  while (picked.length < limit && order.length > 0) {
    const cat = order[i % order.length];
    const bucket = byCategory.get(cat);
    if (bucket && bucket.length > 0) {
      picked.push(bucket.shift() as Paper);
    }
    order = order.filter((c) => (byCategory.get(c)?.length ?? 0) > 0);
    if (order.length === 0) break;
    i += 1;
  }
  return picked;
}
