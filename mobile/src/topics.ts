/**
 * Topic groups for the picker.
 *
 * arXiv categories are precise but not what a reader thinks in: nobody browses "cs.CL", they
 * browse "ML / AI". These groups map the category prefixes we actually hold onto labels a
 * person would recognise, and are ordered so the broad ones come first.
 */

export interface TopicGroup {
  key: string;
  label: string;
  /** Category prefixes. Empty means "everything". */
  prefixes: string[];
}

export const TOPIC_GROUPS: TopicGroup[] = [
  { key: 'all', label: 'All', prefixes: [] },
  {
    key: 'ml',
    label: 'ML / AI',
    prefixes: ['cs.LG', 'cs.AI', 'cs.CL', 'cs.CV', 'cs.NE', 'cs.RO', 'cs.IR', 'stat.ML'],
  },
  { key: 'cs', label: 'CS', prefixes: ['cs.'] },
  { key: 'math', label: 'Math', prefixes: ['math.'] },
  {
    key: 'physics',
    label: 'Physics',
    prefixes: [
      'physics.', 'hep-', 'quant-ph', 'astro-ph', 'cond-mat', 'gr-qc', 'nucl-', 'nlin.',
    ],
  },
  { key: 'bio', label: 'Biology', prefixes: ['q-bio.'] },
  { key: 'stats', label: 'Statistics', prefixes: ['stat.'] },
  { key: 'signals', label: 'Signals', prefixes: ['eess.'] },
  { key: 'econ', label: 'Economics', prefixes: ['econ.', 'q-fin.'] },
];

export function matchesTopic(category: string, key: string): boolean {
  if (key === 'all') return true;
  const group = TOPIC_GROUPS.find((g) => g.key === key);
  if (!group) return true;
  return group.prefixes.some((p) => category.startsWith(p));
}

/** Counts per group, so the picker can hide topics the corpus has nothing for. */
export function topicCounts(categories: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const group of TOPIC_GROUPS) {
    counts[group.key] = categories.filter((c) => matchesTopic(c, group.key)).length;
  }
  return counts;
}
