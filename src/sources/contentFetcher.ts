import { SourceDocumentSchema } from "../types";
import type { SourceDocument } from "../types";

export function fromUserInput(content: string, title = "用户输入", localPath?: string, localSelection = false): SourceDocument {
  const text = content;
  if (!text.trim()) throw new Error("没有可检索的正文，请输入文字或选择一篇有内容的 Markdown 笔记");
  return SourceDocumentSchema.parse({
    id: localPath ? `local:${localPath}` : crypto.randomUUID(),
    sourceType: "user_note",
    title,
    localPath,
    ...(localSelection ? { localSelection: true } : {}),
    url: "",
    evidenceCompleteness: "full",
    contentSnippet: text.slice(0, 500),
    fullContent: text
  });
}
