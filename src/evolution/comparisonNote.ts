import { relationLabels } from "./comparator";
import type { Comparison } from "./comparator";
import type { ExtractedClaim } from "./claimExtractor";
import type { SourceDocument } from "../types";
import { managedSection, wikiLink } from "../utils/wikiStructure";

export function comparisonNote(
  source: SourceDocument, claims: ExtractedClaim[], comparisons: Comparison[],
  resource: string, snapshot: string, paths: string[], topics: string[], message: string, before: string | null = null
): string {
  const initial = [
    "---", "type: comparison", "status: needs-review", "tags: [synovia/comparison]",
    `title: ${JSON.stringify(`对比：${source.title}`)}`,
    `topics: ${JSON.stringify(topics.map((path) => wikiLink(path)))}`, "---", "",
    `# 对比：${source.title}`, "", "## 我的判断", "", ""
  ].join("\n");
  return managedSection(before ?? initial, "comparison", [
    "> [!info] 对比记录", `> ${message.replace(/\r?\n/gu, "\n> ")}`, "",
    `来源：${wikiLink(resource)} · 证据：${wikiLink(snapshot)}`, "",
    ...claims.flatMap((claim, index) => [
      `## ${index + 1}. ${claim.statement.replace(/[\r\n]/gu, " ").slice(0, 100)}`, "",
      paths[index] ? wikiLink(paths[index]!) : claim.statement, "",
      ...comparisons.filter((item) => item.claim === index).flatMap((item) => [
        `### ${relationLabels[item.relation]}`, "",
        wikiLink(item.path), "", item.reason, "", "> [!quote] 已有笔记证据",
        ...item.quote.split(/\r?\n/u).map((line) => `> ${line}`), ""
      ]),
      ...(comparisons.some((item) => item.claim === index) ? [] : ["尚未找到可判断关系的已有证据；不等于已经证实为新知识。", ""])
    ])
  ].join("\n"));
}
