/**
 * Paper of the day.
 *
 * What "hot right now" can honestly mean here:
 *
 *   - **Citations are useless for this corpus.** All 300 bundled papers are from a single
 *     day and exactly one has a citation at all, so ranking by citations would be noise.
 *   - **We collect no read counts.** There is no telemetry yet, so "most read" is not
 *     available and cannot be faked.
 *   - **Hugging Face Daily Papers has real upvotes.** It is a genuine, human, daily hotness
 *     signal for ML papers, and it has an API. That is the metric used when reachable.
 *
 * If HF is unreachable (it sends `Access-Control-Allow-Origin: https://huggingface.co`, so
 * browsers block it) the app falls back to a deterministic local pick that rotates daily.
 * That fallback is NOT a popularity signal and is not presented as one.
 */

export interface HotPaper {
  id: string;
  title: string;
  summary: string;
  /** null when the source has no vote count (the local fallback). */
  upvotes: number | null;
  source: 'huggingface' | 'local';
}

interface HfEntry {
  paper?: {
    id?: string;
    title?: string;
    summary?: string;
    upvotes?: number;
    submittedOnDailyAt?: string;
  };
}

const HF_DAILY = 'https://huggingface.co/api/daily_papers';

/** Deterministic per calendar day: stable within a day, different the next. */
function dailyIndex(day: string, modulo: number): number {
  let h = 2166136261;
  for (let i = 0; i < day.length; i++) {
    h ^= day.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % Math.max(modulo, 1);
}

export function localPaperOfTheDay(
  papers: { id: string; title: string; abstract: string }[],
  today = new Date().toISOString().slice(0, 10),
): HotPaper | null {
  if (papers.length === 0) return null;
  const pick = papers[dailyIndex(today, papers.length)];
  return {
    id: pick.id,
    title: pick.title,
    summary: pick.abstract,
    upvotes: null,
    source: 'local',
  };
}

/** Today's most-upvoted Hugging Face daily paper, or null if unreachable. */
export async function fetchHuggingFaceTop(): Promise<HotPaper | null> {
  try {
    // Bounded: the app should show a list, not hang on a slow third party.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${HF_DAILY}?limit=30`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const entries = (await res.json()) as HfEntry[];
    const withVotes = entries
      .map((e) => e.paper)
      .filter((p): p is NonNullable<HfEntry['paper']> => !!p?.id)
      .map((p) => ({
        id: String(p.id),
        title: String(p.title ?? ''),
        summary: String(p.summary ?? ''),
        upvotes: Number(p.upvotes ?? 0),
        source: 'huggingface' as const,
      }))
      .sort((a, b) => b.upvotes - a.upvotes);

    if (withVotes.length === 0) return null;
    // Only show it if it actually has a signal; a "hot" paper with 0 upvotes is not hot.
    return withVotes[0].upvotes > 0 ? withVotes[0] : null;
  } catch {
    return null;
  }
}

/** HF when it has a real signal, otherwise a rotating local pick. */
export async function fetchPaperOfTheDay(
  localCandidates: { id: string; title: string; abstract: string }[],
): Promise<HotPaper | null> {
  return (await fetchHuggingFaceTop()) ?? localPaperOfTheDay(localCandidates);
}
