import { describe, expect, it } from "vitest";
import { loadConfig } from "../util/config";
import { keenableProvider } from "./keenable";
import { localTextDocProvider } from "./localDoc";

const cfg = loadConfig();
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("keenable search provider", () => {
  it("is absent without a key", () => {
    expect(keenableProvider(cfg, { env: {} })).toBeNull();
  });

  it("searches, fetches, retries after 429 and records each success", async () => {
    const calls: string[] = [];
    let first = true;
    const fake = (async (url: string) => {
      calls.push(url);
      if (url.includes(cfg.research.searchPath)) {
        if (first) {
          first = false;
          return json(429, {}, { "retry-after": "1" });
        }
        return json(200, { results: [{ url: "https://example.org/a", title: "A" }, { title: "no url" }] });
      }
      return json(200, { title: "A", content: "page text" });
    }) as unknown as typeof fetch;
    const ledger: unknown[] = [];
    const p = keenableProvider(cfg, { env: { [cfg.research.apiKeyEnv]: "test-keenable-key-0000" }, fetch: fake, record: ((_c: unknown, e: unknown) => ledger.push(e)) as any, sleep: async () => {} })!; // secret-scan:allow (fake test value)
    expect(await p.search("q", 5)).toEqual([{ url: "https://example.org/a", title: "A" }]);
    expect(await p.fetch("https://example.org/a")).toEqual({ url: "https://example.org/a", title: "A", content: "page text" });
    expect(calls).toHaveLength(3);
    expect(ledger).toHaveLength(2);
  });

  it("reports running out of credit as a stop", async () => {
    const p = keenableProvider(cfg, { env: { [cfg.research.apiKeyEnv]: "test-keenable-key-0000" }, fetch: (async () => json(402, {})) as unknown as typeof fetch, record: (() => {}) as any })!; // secret-scan:allow (fake test value)
    expect(await p.search("q", 5)).toEqual({ stop: "402 insufficient credits" });
  });
});

describe("local text document provider", () => {
  it("splits pages on form feeds and refuses formats it cannot read", async () => {
    const doc = await localTextDocProvider.parse("manual.txt", Buffer.from("page one\fpage two"));
    expect(doc.pages).toEqual(["page one", "page two"]);
    await expect(localTextDocProvider.parse("manual.pdf", Buffer.from(""))).rejects.toThrow(/pdftotext/);
  });
});
