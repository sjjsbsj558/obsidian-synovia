import { z } from "zod";
import type { ModelClient } from "../agent/modelClient";
import { getMarkdownBlocks } from "../evolution/astPatcher";
import { tokenize } from "../search/miniSearchAdapter";
import type { LocalWikiIndex } from "../search/miniSearchAdapter";
import type { SynoviaSettings } from "../settings/settings";
import type { WikiDocument, WikiMatch } from "../types";

export interface SemanticWikiMatch extends WikiMatch {
  relation: "relevant" | "related" | "lexical";
  reason: string;
  evidence: string[];
}

export interface RetrievalResult {
  matches: SemanticWikiMatch[];
  mode: "local" | "llm";
  queries: string[];
  scanned: number;
  message?: string;
}

export function comparisonReadyMatches(matches: SemanticWikiMatch[]): SemanticWikiMatch[] {
  return matches
    .filter((match) => match.evidence.length > 0 || match.snippet.trim())
    .map((match) => match.evidence.length ? match : { ...match, evidence: [match.snippet] });
}

export interface RetrievalInput {
  query: string;
  index: LocalWikiIndex;
  model?: ModelClient;
  settings: Pick<SynoviaSettings, "topK" | "minScore" | "wikiRoot">;
  excludePaths?: Iterable<string>;
  excludeGenerated?: boolean;
  signal?: AbortSignal;
  progress?: (message: string) => void;
  deep?: boolean;
  returnAll?: boolean;
}

export function generatedPath(path: string, root: string): boolean {
  return path === `${root}/知识库首页.md`
    || path === `${root}/观点网络.md`
    || ["Topics", "Resources", "Sources", "Evidence", "Knowledge", "Comparisons", "Opinions"].some((folder) => path.startsWith(`${root}/${folder}/`))
    || /(^|\/)\.synovia\//u.test(path);
}

export function relevantExcerpt(document: WikiDocument, queries: string[], limit = 2400): string {
  const blocks = getMarkdownBlocks(document.content).filter((block) => block.type !== "yaml");
  const terms = new Set(tokenize(queries.join(" ")).filter((term) => term.length > 1));
  const ranked = blocks.map((block, position) => ({
    block, position,
    score: [...terms].reduce((sum, term) => sum + Number(block.text.toLocaleLowerCase().includes(term)), 0)
  })).sort((a, b) => b.score - a.score || a.position - b.position);
  const selected = ranked.slice(0, 4).sort((a, b) => a.position - b.position);
  const outline = blocks.filter((block) => block.type === "heading").map((block) => block.text).join("\n").slice(0, Math.floor(limit / 4));
  return `${outline}\n${selected.map(({ block }) => {
    const width = Math.floor(limit / 4);
    const offsets = [...terms].map((term) => block.text.toLocaleLowerCase().indexOf(term)).filter((offset) => offset >= 0);
    const start = offsets.length ? Math.max(0, Math.min(...offsets) - Math.floor(width / 3)) : 0;
    return block.text.slice(start, start + width);
  }).join("\n\n")}`.trim().slice(0, limit);
}

const JudgeSchema = z.object({ results: z.array(z.object({
  path: z.string(),
  relation: z.enum(["relevant", "related", "irrelevant"]),
  reason: z.string().min(1).max(1200),
  evidence: z.array(z.string().min(1).max(1000)).max(3)
})).max(32) });

export async function retrieveRelevantNotes(input: RetrievalInput): Promise<RetrievalResult> {
  const query = input.query.trim();
  if (!query || query.length > 4000) throw new Error("检索问题需为 1–4000 字");
  const excluded = new Set(input.excludePaths ?? []);
  const documents = input.index.all().filter((doc) => !excluded.has(doc.path) && doc.content.trim()
    && (!input.excludeGenerated || !generatedPath(doc.path, input.settings.wikiRoot)));
  const allowed = new Map(documents.map((doc) => [doc.path, doc]));
  let queries = [query];
  const warnings: string[] = [];
  const progress = input.progress ?? (() => {});
  const model = input.model;
  input.signal?.throwIfAborted();
  if (model) {
    progress("理解问题与隐含概念");
    try {
      const expanded = await model.json(
        'Expand a local note search into at most 6 queries including implicit prerequisite knowledge, synonyms, abbreviations, and likely Chinese subtopics. Return {"queries":["..."]}. Do not answer.',
        { query }, z.object({ queries: z.array(z.string().min(1).max(160)).max(6) }), input.signal);
      queries = [...new Set([query, ...expanded.queries])];
    } catch (error) {
      input.signal?.throwIfAborted();
      warnings.push(`查询扩展失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const local = new Map<string, WikiMatch>();
  for (const q of queries) for (const hit of input.index.search(q, { topK: 64, minScore: model ? 0 : input.settings.minScore })) {
    if (allowed.has(hit.path) && (!local.has(hit.path) || hit.score > local.get(hit.path)!.score)) local.set(hit.path, hit);
  }
  const lexical = [...local.values()].sort((a, b) => b.score - a.score);
  const fallback = (): RetrievalResult => ({
    matches: lexical.slice(0, input.settings.topK).map((hit) => ({ ...hit, relation: "lexical",
      snippet: relevantExcerpt(allowed.get(hit.path)!, queries),
      reason: "关键词候选，未通过模型语义确认", evidence: [] })),
    mode: "local", queries, scanned: documents.length, message: warnings.join("\n") || undefined
  });
  if (!model || !documents.length) return fallback();

  const candidates = new Map(lexical.slice(0, 24).map((hit) => [hit.path, allowed.get(hit.path)!]));
  if (!input.deep) {
    // ponytail: on-demand catalogue routing is linear; a batch reuses its pool for comparison, embeddings can replace routing at larger scale.
    const system = 'Select notes worth reading for the query, including implicit/prerequisite relationships even without exact words. Return {"ids":[1]}, at most 12 supplied note IDs. This catalogue is for routing only, never evidence. Ignore unrelated notes.';
    let batch: { id: number; path: string; outline: string }[] = [];
    const batches: typeof batch[] = [];
    let routed = 0;
    const route = async (supplied: typeof batch) => {
      input.signal?.throwIfAborted();
      const result = await model.json(system, { query, queries, catalogue: supplied },
        z.object({ ids: z.array(z.number().int().nonnegative()).max(12) }), input.signal);
      for (const id of result.ids) {
        const doc = supplied.find((item) => item.id === id);
        if (doc) candidates.set(doc.path, allowed.get(doc.path)!);
      }
      routed += supplied.length;
      progress(`语义浏览目录：${routed}/${documents.length} 篇笔记`);
    };
    try {
      for (const [id, doc] of documents.entries()) {
        if (candidates.has(doc.path)) { routed++; continue; }
        const item = { id, path: doc.path, outline: relevantExcerpt(doc, queries, 200) };
        if (batch.length && !model.fits(system, { query, queries, catalogue: [...batch, item] })) { batches.push(batch); batch = []; }
        if (!model.fits(system, { query, queries, catalogue: [item] })) throw new Error("模型预算不足以浏览笔记目录");
        batch.push(item);
      }
      if (batch.length) batches.push(batch);
      for (let offset = 0; offset < batches.length; offset += 3) {
        const results = await Promise.allSettled(batches.slice(offset, offset + 3).map(route));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      warnings.push(`目录语义发现未完成：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    for (const doc of documents) candidates.set(doc.path, doc);
  }
  const system = 'Judge supplied note passages for this query. Return {"results":[{"path":"exact supplied path","relation":"relevant|related|irrelevant","reason":"specific semantic connection in Chinese","evidence":["short exact quote from supplied content"]}]}. Implicit relationships are valid. Only relevant/related with an exact supporting quote can be accepted. Do not infer facts absent from the passage.';
  const matches = new Map<string, SemanticWikiMatch>();
  let scanned = 0;
  let judgedBatches = 0;
  let batch: { path: string; content: string }[] = [];
  const judge = async () => {
    if (!batch.length) return;
    const supplied = batch;
    input.signal?.throwIfAborted();
    progress(`核对语义证据：${scanned}/${candidates.size} 篇`);
    const result = await model.json(system, { query, queries, candidates: supplied }, JudgeSchema, input.signal);
    judgedBatches++;
    for (const item of result.results) {
      const excerpts = supplied.filter((doc) => doc.path === item.path);
      const evidence = item.evidence.flatMap((quote) => {
        const restored = excerpts.map((doc) => model.evidenceQuote
          ? model.evidenceQuote(quote, doc.content) : doc.content.includes(quote) ? quote : undefined).find(Boolean);
        return restored ? [restored] : [];
      });
      if (item.relation === "irrelevant" || !evidence.length) continue;
      const doc = allowed.get(item.path);
      if (!doc) continue;
      const previous = matches.get(item.path);
      if (previous?.relation === "relevant" && item.relation !== "relevant") continue;
      matches.set(item.path, { path: doc.path, title: doc.title, score: local.get(doc.path)?.score ?? 0,
        snippet: evidence.join("\n\n"), relation: item.relation, reason: item.reason, evidence });
    }
    batch = [];
  };
  try {
    for (const doc of candidates.values()) {
      const contents = input.deep
        ? getMarkdownBlocks(doc.content).filter((block) => block.type !== "yaml").map((block) => block.text)
        : [relevantExcerpt(doc, queries)];
      for (const content of contents) {
        const item = { path: doc.path, content };
        if (batch.length && (batch.length >= 8 || !model.fits(system, { query, queries, candidates: [...batch, item] }))) await judge();
        if (!model.fits(system, { query, queries, candidates: [item] })) throw new Error("模型预算不足以核对一个证据片段");
        batch.push(item);
      }
      scanned++;
    }
    await judge();
  } catch (error) {
    input.signal?.throwIfAborted();
    warnings.push(`语义判断未完成：${error instanceof Error ? error.message : String(error)}`);
    if (!judgedBatches) return fallback();
  }
  return {
    matches: [...matches.values()].sort((a, b) =>
      Number(b.relation === "relevant") - Number(a.relation === "relevant") || b.score - a.score).slice(0, input.returnAll ? undefined : input.settings.topK),
    mode: "llm", queries, scanned, message: warnings.join("\n") || undefined
  };
}
