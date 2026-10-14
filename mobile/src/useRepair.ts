/**
 * Fill in metadata for stored records that were written before it was known.
 *
 * A record can be stored without its details — a cold open, or a tap on save before the arXiv
 * lookup returned — leaving a row whose title is its arXiv id and which has no abstract.
 * Toggling such a row would delete it rather than fix it, so the gaps are filled in place.
 *
 * This lives in one place because two screens need it (Saved and History) and the logic is
 * subtle in two specific ways that each cost a debugging session:
 *
 *  1. **It must not be cancelled by an effect cleanup.** The first version used an `alive`
 *     flag cleared on cleanup, and React runs effects twice in development — Expo Go is a
 *     development build. The first pass added the id to its "attempted" set and started the
 *     lookup, the cleanup cancelled it, and the second pass found the id already attempted.
 *     Nothing ever repaired. Work that has to finish is not tied to an effect's lifetime.
 *
 *  2. **A cache hit is not automatically a repair.** The local metadata cache is filled by
 *     whatever renders, so a broken record could register itself as the cached metadata for
 *     its own id, and the repair would read that back, find nothing changed, and stop. The
 *     cache now refuses placeholders, and `patchFromPaper` checks again here — because a
 *     device may already have a poisoned cache persisted.
 *
 * Lookups run one at a time, so a long history cannot fire dozens of requests at once.
 */

import { useEffect, useRef, useState } from 'react';

import { fetchArxivById } from './arxiv';
import { needsRepair, patchFromPaper, type MetaPatch } from './library';
import type { PaperItem } from './types';

interface RepairOptions<T extends { id: string; title: string; abstract: string }> {
  entries: T[];
  /** Which entries are missing details. Defaults to `needsRepair`. */
  needs?: (entry: T) => boolean;
  paperMeta: (id: string) => PaperItem | null;
  apply: (id: string, patch: MetaPatch) => void;
  /** Lookups per pass. See below. */
  maxPerPass?: number;
}

/**
 * How many records to look up before yielding.
 *
 * History can legitimately hold hundreds of entries, and a lookup is a network round trip. The
 * effect re-runs whenever `entries` changes — and applying a patch changes it — so the queue
 * resumes on the next pass. Bounding each pass keeps a long history from firing hundreds of
 * requests back to back, and keeps the first repairs visible immediately.
 */
const DEFAULT_BATCH = 12;

/**
 * @returns the number of lookups currently outstanding, for a "fetching details" hint.
 */
export function useRepairQueue<T extends { id: string; title: string; abstract: string }>({
  entries,
  needs = needsRepair,
  paperMeta,
  apply,
  maxPerPass = DEFAULT_BATCH,
}: RepairOptions<T>): number {
  const inFlight = useRef<Set<string>>(new Set());
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const todo = entries
      .filter((e) => needs(e) && !inFlight.current.has(e.id))
      .slice(0, maxPerPass);
    if (todo.length === 0) return;

    // Claim them synchronously so a re-render mid-queue does not start duplicates.
    for (const entry of todo) inFlight.current.add(entry.id);
    setPending((n) => n + todo.length);

    // Deliberately no cancellation flag, and no cleanup that aborts the loop. Applying a
    // repair changes `entries`, which re-runs this effect — and a first version read that as
    // "cancel the old run", so the queue stopped after its first success and the rest of the
    // history was left unrepaired until something else happened to change. The work is
    // idempotent and `apply` is a functional update, so letting it finish is safe whenever
    // the component is still mounted, and harmless if it is not.
    void (async () => {
      try {
        for (const entry of todo) {
          // The local cache first: it is free, and it is usually right.
          let patch = patchFromPaper(paperMeta(entry.id));
          if (!patch) {
            const remote = await fetchArxivById(entry.id);
            if (!remote) continue;
            patch = {
              title: remote.title,
              abstract: remote.abstract,
              category: remote.category,
              authors: remote.authors,
              published: remote.published ? remote.published.slice(0, 10) : null,
            };
          }
          if (patch) apply(entry.id, patch);
        }
      } finally {
        // Cleared either way. On success `needs` is false so the entry is not picked up
        // again; on failure a later render gets another chance rather than the record being
        // written off for the session.
        for (const entry of todo) inFlight.current.delete(entry.id);
        setPending((n) => Math.max(0, n - todo.length));
      }
    })();
  }, [entries, needs, paperMeta, apply, maxPerPass]);

  return pending;
}
