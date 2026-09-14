import { SourceDocumentSchema } from "../types";
import type { SourceDocument } from "../types";
import { wikiLink } from "../utils/wikiStructure";
import { getMarkdownBlocks } from "../evolution/astPatcher";

export function sourceNote(input: SourceDocument, topics: string[] = [], root = "Wiki"): string {
  const source = SourceDocumentSchema.parse(input);
  const text = source.fullContent ?? source.contentSnippet;
  const yaml = getMarkdownBlocks(text).find((block) => block.type === "yaml");
  const body = yaml ? text.slice(yaml.endOffset).trimStart() : text;
  return [
    "---", `title: ${JSON.stringify(source.title)}`, `aliases: ${JSON.stringify([source.title])}`,
    "type: source", "status: inbox", "tags: [synovia/source]",
    `topics: ${JSON.stringify(topics.map((path) => wikiLink(path)))}`,
    `source_id: ${JSON.stringify(source.id)}`,
    ...(source.localPath ? [`local_path: ${JSON.stringify(source.localPath)}`] : []),
    `source_url: ${JSON.stringify(source.url)}`, `source_type: ${source.sourceType}`,
    `evidence_completeness: ${source.evidenceCompleteness}`,
    `author: ${JSON.stringify(source.author?.name ?? "")}`, "---", "",
    `# ${source.title}`, "", wikiLink(`${root}/知识库首页`), "",
    "## 所属主题", "", ...(topics.length ? topics.map((path) => `- ${wikiLink(path)}`) : ["尚未分类"]), "",
    "> [!quote] 来源说明",
    source.sourceType === "zhida_answer" ? "> AI 综合回答，不是原始证据。"
      : source.evidenceCompleteness === "snippet" ? "> 搜索或接口摘录，不是全文；内容未经独立核实。" : "> 用户提供的完整输入。",
    ...(source.localPath ? ["", wikiLink(source.localPath, "本地原笔记")] : []),
    "", source.evidenceCompleteness === "full" ? "## 原始正文" : "## 原始摘录", "", body, "",
    ...(yaml ? ["## 原文属性", "", "````yaml", yaml.text.slice(4).replace(/\r?\n---\s*$/u, ""), "````", ""] : []),
    "## 我的笔记", "", "",
    ...(source.url ? [`来源：<${source.url}>`, ""] : [])
  ].join("\n");
}
