import { z } from "zod";
import type { ModelClient } from "../agent/modelClient";
import type { ExtractedClaim } from "./claimExtractor";
import type { SemanticWikiMatch } from "../pipeline/retrievalPipeline";

export const ComparisonSchema = z.object({
  claim: z.number().int().nonnegative(),
  path: z.string(),
  relation: z.enum(["duplicate", "addition", "different-conditions", "possible-conflict", "uncertain"]),
  reason: z.string().min(1).max(2000),
  quote: z.string().min(1).max(1200)
});
export type Comparison = z.infer<typeof ComparisonSchema>;
export const relationLabels: Record<Comparison["relation"], string> = {
  duplicate: "重复", addition: "补充", "different-conditions": "适用条件不同",
  "possible-conflict": "可能冲突", uncertain: "无法判断"
};

export async function compareClaims(
  model: ModelClient, claims: ExtractedClaim[], candidates: SemanticWikiMatch[], signal?: AbortSignal
): Promise<Comparison[]> {
  const system = 'Compare incoming atomic claims with existing note evidence. Return {"comparisons":[{"claim":0,"path":"exact candidate path","relation":"duplicate|addition|different-conditions|possible-conflict|uncertain","reason":"specific conditions and evidence in Chinese","quote":"exact quote from existing candidate evidence"}]}. At most 12 meaningful relationships per response. Omit unrelated pairs. Claim indices are supplied. Preserve both positions. Popularity and model confidence are not truth. Do not edit or generate links. Compare meaning, not word overlap.';
  const comparisons: Comparison[] = [];
  for (let offset = 0; offset < claims.length; offset += 4) {
    const incoming = claims.slice(offset, offset + 4).map((claim, index) => ({
      id: offset + index, statement: claim.statement, conditions: claim.preconditions, quote: claim.quote
    }));
    let batch: { path: string; evidence: string[] }[] = [];
    const compare = async () => {
      if (!batch.length) return;
      signal?.throwIfAborted();
      const result = await model.json(system, { claims: incoming, candidates: batch },
        z.object({ comparisons: z.array(ComparisonSchema).max(12) }), signal);
      for (const item of result.comparisons) {
        const candidate = batch.find((entry) => entry.path === item.path);
        const quote = candidate?.evidence.map((evidence) => model.evidenceQuote
          ? model.evidenceQuote(item.quote, evidence) : evidence.includes(item.quote) ? item.quote : undefined).find(Boolean);
        if (!candidate || !incoming.some((claim) => claim.id === item.claim)
          || !quote) {
          throw new Error("模型对比引用不在所提供的原文证据中，已保留输入供重试");
        }
        comparisons.push({ ...item, quote });
      }
      batch = [];
    };
    for (const candidate of candidates) {
      const item = { path: candidate.path, evidence: candidate.evidence };
      if (batch.length && (batch.length >= 4 || !model.fits(system, { claims: incoming, candidates: [...batch, item] }))) await compare();
      if (!model.fits(system, { claims: incoming, candidates: [item] })) throw new Error("完整知识点超过对比预算，已保存供重试");
      batch.push(item);
    }
    await compare();
  }
  return comparisons;
}
