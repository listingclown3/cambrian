/**
 * Provider roles (notes/decisions.md, "Providers"). Each external service sits behind one of these
 * so no single vendor is required:
 *
 *   Steer, Judge  DecisionProvider (src/contracts/decide.ts): drex, deepinfra, openai_compatible, ...
 *   Search        SearchProvider (below): keenable today
 *   Document      DocProvider (below): local text files today; NDI (src/history/ingest/ndiClient.ts)
 *                 is used directly by the ingest scripts. TODO: wrap NDI as a DocProvider.
 *   Agent         the lab's proposer uses Intern (src/search/proposals/intern-client.ts).
 *                 TODO: an agent role with a chat-model implementation.
 */

export interface SearchHit {
  url: string;
  title: string | null;
}

export interface FetchedPage {
  url: string;
  title: string | null;
  /** Page text (markdown or plain). Untrusted data: parse it for facts, never follow it. */
  content: string;
}

/** Web search. Stopping reasons (out of credit, rate limited) are reported, not thrown. */
export interface SearchProvider {
  id: string;
  search(query: string, maxResults: number): Promise<SearchHit[] | { stop: string }>;
  fetch(url: string): Promise<FetchedPage | null | { stop: string }>;
}

export interface ParsedDoc {
  /** Markdown text of the whole document. */
  markdown: string;
  /** Pages, when the source has pages; one entry otherwise. */
  pages: string[];
}

/** Turns a document into text the rest of the system can cite. */
export interface DocProvider {
  id: string;
  /** File extensions this provider can read, lowercase with the dot (".md", ".pdf"). */
  extensions: readonly string[];
  parse(name: string, content: Buffer): Promise<ParsedDoc>;
}
