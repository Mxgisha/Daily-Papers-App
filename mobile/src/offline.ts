/**
 * Offline copies of papers.
 *
 * What is stored is the article HTML, not the figures. That is a deliberate, honest scope:
 * the HTML is the paper — text, equations, section structure — and it is what you want on a
 * train. Figures are the overwhelming majority of a paper's bytes (28 MB against 388 KB of
 * text, measured earlier), so storing them would turn "save for later" into a download
 * manager with progress, cancellation and cache eviction.
 *
 * A `<base>` element is injected into the saved page so its relative figure URLs still
 * resolve against arXiv when there is a connection. Offline, the text renders and the images
 * do not; online, everything does.
 */

import * as FileSystem from 'expo-file-system/legacy';

import { prepareArticleHtml } from './articleHtml';

const DIR = `${FileSystem.documentDirectory}offline/`;

/** Ids can contain a slash (math.GT/0309136), which is not a legal file name. */
function fileName(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.html`;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
  }
}

export function articleUrl(id: string): string {
  return `https://arxiv.org/html/${id}`;
}

export interface SaveResult {
  ok: boolean;
  bytes: number;
  error?: string;
}

export async function saveArticle(id: string): Promise<SaveResult> {
  try {
    const response = await fetch(articleUrl(id));
    if (!response.ok) {
      return { ok: false, bytes: 0, error: `arXiv returned ${response.status}` };
    }
    // Saved through the same preparation as the live path, so an offline copy is lazy too.
    const html = prepareArticleHtml(await response.text(), id);
    await ensureDir();
    await FileSystem.writeAsStringAsync(DIR + fileName(id), html, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    return { ok: true, bytes: html.length };
  } catch (e) {
    return { ok: false, bytes: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The saved HTML, or null when this paper has not been saved. */
export async function readArticle(id: string): Promise<string | null> {
  try {
    const info = await FileSystem.getInfoAsync(DIR + fileName(id));
    if (!info.exists) return null;
    return await FileSystem.readAsStringAsync(DIR + fileName(id), {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch {
    return null;
  }
}

export async function removeArticle(id: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(DIR + fileName(id), { idempotent: true });
  } catch {
    // Nothing to remove is not an error.
  }
}

/** Everything stored, by id. Used by the diagnostics screen. */
export async function listArticles(): Promise<string[]> {
  try {
    const info = await FileSystem.getInfoAsync(DIR);
    if (!info.exists) return [];
    const names = await FileSystem.readDirectoryAsync(DIR);
    return names.map((n) => n.replace(/\.html$/, ''));
  } catch {
    return [];
  }
}
