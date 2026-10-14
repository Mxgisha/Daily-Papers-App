/**
 * Search all of arXiv, not just the papers bundled with the app.
 *
 * The bundled list is a snapshot of 300 papers from one day. Searching only that is a toy;
 * this queries the arXiv API over the whole corpus.
 *
 * CORS note: `export.arxiv.org` sends no `Access-Control-Allow-Origin`, so this works
 * directly on native (no CORS there) but not in a browser. When `EXPO_PUBLIC_ARXIV_PROXY`
 * is set the request is routed through that prefix instead — `reader/server.py` exposes a
 * matching `/arxiv` route — which is how the web build and the verification harness exercise
 * the same code path.
 */

import { XMLParser } from 'fast-xml-parser';

const ARXIV_API = 'https://export.arxiv.org/api/query';

export interface ArxivResult {
  id: string;
  title: string;
  abstract: string;
  published: string | null;
  category: string;
  categories: string[];
  authors: string[];
  html: boolean;
  pdf: string;
}

function endpoint(): string {
  const proxy = (process.env.EXPO_PUBLIC_ARXIV_PROXY ?? '').replace(/\/$/, '');
  return proxy ? `${proxy}/arxiv` : ARXIV_API;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // The Atom feed is a list in every one of these positions; without this a single result
  // comes back as an object and the code silently drops it.
  isArray: (name) => ['entry', 'author', 'category', 'link'].includes(name),
});

function text(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return text((value as Record<string, unknown>)['#text']);
  }
  return '';
}

function stripVersion(id: string): string {
  return id.replace(/v\d+$/, '');
}

export function parseAtom(xml: string): ArxivResult[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const entries: any[] = doc?.feed?.entry ?? [];

  return entries
    .map((e) => {
      const rawId: string = text(e.id);
      const id = stripVersion(rawId.split('/abs/').pop() ?? rawId);
      if (!id) return null;

      const categories: string[] = (e.category ?? [])
        .map((c: any) => text(c?.['@_term']))
        .filter(Boolean);
      const primary = text(e['arxiv:primary_category']?.['@_term']);

      const links: any[] = e.link ?? [];
      const pdf =
        links.find((l) => l?.['@_title'] === 'pdf')?.['@_href'] ??
        `https://arxiv.org/pdf/${id}`;

      const result: ArxivResult = {
        id,
        title: text(e.title),
        abstract: text(e.summary),
        published: text(e.published) || null,
        category: primary || categories[0] || '',
        categories,
        authors: (e.author ?? []).map((a: any) => text(a?.name)).filter(Boolean),
        // The API does not say whether HTML exists; the reader probes that itself and falls
        // back to the PDF. Assume yes so the paper is openable.
        html: true,
        pdf: text(pdf),
      };
      return result;
    })
    .filter((r): r is ArxivResult => r !== null);
}

export async function searchArxiv(query: string, maxResults = 25): Promise<ArxivResult[]> {
  const q = query.trim();
  if (!q) return [];

  const params = new URLSearchParams({
    // `all:` searches title, abstract, authors and comments.
    search_query: `all:${q}`,
    start: '0',
    max_results: String(maxResults),
    sortBy: 'relevance',
    sortOrder: 'descending',
  });

  const res = await fetch(`${endpoint()}?${params.toString()}`);
  if (!res.ok) throw new Error(`arXiv search failed (${res.status})`);
  return parseAtom(await res.text());
}
