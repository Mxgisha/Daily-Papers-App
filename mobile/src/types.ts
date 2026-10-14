/** The shape both the bundled list and arXiv search results are normalised into. */
export interface PaperItem {
  id: string;
  title: string;
  abstract: string;
  category: string;
  published: string | null;
  authors: string[];
}
