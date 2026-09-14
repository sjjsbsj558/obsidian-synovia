import MiniSearch from "minisearch";
import { z } from "zod";
import type { WikiDocument, WikiMatch } from "../types";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });

export function tokenize(text: string): string[] {
  return Array.from(segmenter.segment(text.normalize("NFKC").toLowerCase()))
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);
}

const SearchOptionsSchema = z.object({
  topK: z.number().int().min(1).max(64),
  minScore: z.number().finite().nonnegative()
});

export class LocalWikiIndex {
  private readonly documents = new Map<string, WikiDocument>();
  private readonly index = new MiniSearch<WikiDocument>({
    idField: "path",
    fields: ["title", "content"],
    storeFields: ["title", "content"],
    tokenize,
    searchOptions: { boost: { title: 2 }, combineWith: "OR" }
  });

  get size(): number {
    return this.index.documentCount;
  }

  upsert(document: WikiDocument): void {
    if (this.index.has(document.path)) this.index.discard(document.path);
    this.index.add(document);
    this.documents.set(document.path, document);
  }

  remove(path: string): void {
    if (this.index.has(path)) this.index.discard(path);
    this.documents.delete(path);
  }

  all(): WikiDocument[] {
    return [...this.documents.values()];
  }

  search(query: string, options: { topK: number; minScore: number }): WikiMatch[] {
    const { topK, minScore } = SearchOptionsSchema.parse(options);
    if (!query.trim()) return [];
    return this.index.search(query)
      .filter((result) => typeof result.content === "string" && result.content.trim().length > 0)
      .filter((result) => result.score >= minScore)
      .slice(0, topK)
      .map((result) => ({
        path: String(result.id),
        title: String(result.title),
        score: result.score,
        snippet: String(result.content).slice(0, 240)
      }));
  }
}
