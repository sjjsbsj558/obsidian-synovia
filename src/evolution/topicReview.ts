import { z } from "zod";
import type { ModelClient } from "../agent/modelClient";
import { relevantExcerpt } from "../pipeline/retrievalPipeline";
import type { WikiDocument } from "../types";

const TopicReviewSchema = z.object({
  status: z.enum(["covered", "gaps", "uncertain"]),
  gaps: z.array(z.object({
    topic: z.string().min(1).max(160),
    reason: z.string().min(1).max(1000),
    suggestedQuery: z.string().min(1).max(160),
    evidence: z.array(z.string().min(1).max(1000)).max(3),
    confidence: z.number().min(0).max(1)
  })).max(4),
  opinion: z.object({
    text: z.string().min(1).max(1200),
    weight: z.number().min(0).max(0.35),
    basis: z.array(z.string().min(1).max(1000)).max(3)
  }).nullable().optional()
});

export type TopicReview = z.infer<typeof TopicReviewSchema>;

export async function reviewTopicCoverage(
  model: ModelClient, topic: string, documents: WikiDocument[], signal?: AbortSignal,
  progress: (message: string) => void = () => {}
): Promise<TopicReview> {
  const system = [
    "Review whether the supplied local notes cover the confirmed topic.",
    "Check both explicit content and implicit prerequisites or missing dimensions.",
    "Return {\"status\":\"covered|gaps|uncertain\",\"gaps\":[{\"topic\":\"...\",\"reason\":\"...\",\"suggestedQuery\":\"...\",\"evidence\":[\"exact supplied quote\"],\"confidence\":0.0}],\"opinion\":{\"text\":\"...\",\"weight\":0.2,\"basis\":[\"exact supplied quote\"]}}.",
    "A gap is a plausible missing dimension, not a claim that the notes are wrong.",
    "The opinion is allowed as a model interpretation, but its weight must be at most 0.35.",
    "Never put an unsupported fact into an opinion. Evidence quotes must be exact substrings of supplied excerpts.",
    "Use at most 4 gaps. Do not turn gaps or opinions into atomic facts."
  ].join(" ");
  const candidates = documents.slice(0, 16).map((document) => ({
    path: document.path,
    title: document.title,
    full: document.content,
    excerpt: relevantExcerpt(document, [topic], 2400)
  }));
  const supplied: { path: string; title: string; excerpt: string }[] = [];
  for (const candidate of candidates) {
    const full = { path: candidate.path, title: candidate.title, excerpt: candidate.full };
    const excerpt = { path: candidate.path, title: candidate.title, excerpt: candidate.excerpt };
    if (model.fits(system, { topic, notes: [...supplied, full] })) supplied.push(full);
    else if (model.fits(system, { topic, notes: [...supplied, excerpt] })) supplied.push(excerpt);
  }
  if (!supplied.length) {
    return { status: "uncertain", gaps: [], opinion: null };
  }
  progress("核查本地笔记是否覆盖主题");
  const result = await model.json(system, { topic, notes: supplied }, TopicReviewSchema, signal);
  const excerpts = supplied.map((item) => item.excerpt);
  const validEvidence = (quotes: string[]) => quotes.flatMap((quote) => {
    const restored = excerpts.map((excerpt) => model.evidenceQuote
      ? model.evidenceQuote(quote, excerpt) : excerpt.includes(quote) ? quote : undefined).find(Boolean);
    return restored ? [restored] : [];
  });
  return {
    ...result,
    status: result.status === "covered" && (supplied.length < documents.length
      || supplied.some((item) => item.excerpt !== documents.find((document) => document.path === item.path)?.content))
      ? "uncertain" : result.status,
    gaps: result.gaps.map((gap) => ({ ...gap, evidence: validEvidence(gap.evidence) })),
    opinion: result.opinion
      ? { ...result.opinion, basis: validEvidence(result.opinion.basis) }
      : null
  };
}
