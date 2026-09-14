import type { ExtractedClaim } from "./claimExtractor";
import type { SourceDocument } from "../types";
import { wikiLink } from "../utils/wikiStructure";

export function knowledgeNote(
  claim: ExtractedClaim, source: SourceDocument, snapshotPath: string, topicPaths: string[] = []
): string {
  return [
    "---", "type: knowledge", "status: needs-review", "tags: [synovia/knowledge]",
    `title: ${JSON.stringify(claim.statement.slice(0, 120))}`,
    `source: ${JSON.stringify(wikiLink(snapshotPath))}`,
    `origin: ${JSON.stringify(source.localPath ?? source.url)}`,
    `topics: ${JSON.stringify(topicPaths.map((path) => wikiLink(path)))}`,
    `evidence_completeness: ${source.evidenceCompleteness}`, "---", "",
    "# " + claim.statement.slice(0, 120), "",
    "> [!warning] 待审核知识点", "> 模型提取不等于事实核实；原始公式、表格及上下文保留在证据中。", "",
    "## 主张", "", claim.statement, "", "## 适用条件", "",
    ...claim.preconditions.map((condition) => `- ${condition}`), "",
    "## 原始证据", "", wikiLink(snapshotPath, source.title), "",
    ...(source.localPath ? [wikiLink(source.localPath, "本地原笔记"), ""] : []),
    ...(topicPaths.length ? ["## 所属主题", "", ...topicPaths.map((path) => `- ${wikiLink(path)}`), ""] : []),
    ...claim.evidenceBlocks.flatMap((block) => [
      `### 证据 ${block.id}`, "", `原文偏移：${block.startOffset}–${block.endOffset}`, "",
      `${wikiLink(snapshotPath).slice(0, -2)}#^synovia-${block.startOffset}-${block.endOffset}|跳转证据块]]`, "",
      block.text, ""
    ]),
    "## 我的整理", "", ""
  ].join("\n");
}
