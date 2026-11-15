/**
 * Document provider with no external service: reads Markdown and plain text as-is. Form feeds
 * (\f, as written by `pdftotext`) split pages, so a PDF converted locally keeps its page numbers.
 * PDFs themselves need a parsing service (NDI) or a local converter first.
 */
import path from "node:path";
import type { DocProvider, ParsedDoc } from "./roles";

export const localTextDocProvider: DocProvider = {
  id: "local_text",
  extensions: [".md", ".markdown", ".txt"],
  async parse(name: string, content: Buffer): Promise<ParsedDoc> {
    const ext = path.extname(name).toLowerCase();
    if (!this.extensions.includes(ext)) throw new Error(`local_text cannot read ${ext || "files without an extension"}; convert it to text first (for PDFs: pdftotext, or NDI)`);
    const text = content.toString("utf8").replaceAll("\r\n", "\n");
    const pages = text.split("\f");
    return { markdown: pages.join("\n\n"), pages };
  },
};
