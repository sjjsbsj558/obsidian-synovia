import { z } from "zod";

export const VaultPathSchema = z.string().trim().min(1).max(1024).refine(
  (path) => !/[\\:*?"<>|\u0000-\u001f]/u.test(path)
    && path.split("/").every((part) => part.length > 0 && !part.startsWith(".") && part === part.trim()),
  "Use a vault-relative path without hidden folders, backslashes or traversal."
);

const HttpUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Expected an HTTP(S) URL without credentials.");

export const SourceDocumentSchema = z.object({
  id: z.string().min(1),
  sourceType: z.enum(["zhihu_search_hit", "zhihu_answer", "zhihu_article", "zhida_answer", "web_page", "user_note"]),
  title: z.string().trim().min(1).max(300),
  localPath: VaultPathSchema.optional(),
  localSelection: z.boolean().optional(),
  contentType: z.string().optional(),
  author: z.object({
    name: z.string().min(1),
    badge: z.string().optional(),
    followers: z.number().int().nonnegative().optional()
  }).optional(),
  url: z.union([HttpUrlSchema, z.literal("")]),
  evidenceCompleteness: z.enum(["snippet", "full"]),
  editedAt: z.number().int().nonnegative().optional(),
  upvotes: z.number().int().nonnegative().optional(),
  contentSnippet: z.string().trim().min(1).max(100_000),
  fullContent: z.string().min(1).max(100_000).refine((text) => Boolean(text.trim()), "Empty content").optional()
}).superRefine((source, context) => {
  if (!new Set(["user_note", "zhida_answer"]).has(source.sourceType) && !source.url) {
    context.addIssue({ code: "custom", path: ["url"], message: "External sources require a URL." });
  }
  if ((source.evidenceCompleteness === "full") !== Boolean(source.fullContent)) {
    context.addIssue({
      code: "custom",
      path: ["fullContent"],
      message: "Full evidence requires fullContent; snippet evidence must not include it."
    });
  }
});

export const TextEditSchema = z.object({
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  replacement: z.string()
}).refine((edit) => edit.endOffset >= edit.startOffset, "Invalid edit range.");

export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export type TextEdit = z.infer<typeof TextEditSchema>;

export interface WikiDocument {
  path: string;
  title: string;
  content: string;
}

export interface WikiMatch {
  path: string;
  title: string;
  score: number;
  snippet: string;
}
