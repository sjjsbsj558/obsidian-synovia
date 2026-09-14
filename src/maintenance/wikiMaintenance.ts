import type { App } from "obsidian";
import { isWikiPath } from "../settings/settings";
import type { LocalWikiIndex } from "../search/miniSearchAdapter";
import type { WikiMatch } from "../types";

export interface MaintenanceIssue {
  kind: "orphan" | "broken-link" | "stale";
  path: string;
  detail: string;
  link?: string;
  suggestions: WikiMatch[];
}

export function inspectWiki(app: App, root: string, index: LocalWikiIndex, now = Date.now()): MaintenanceIssue[] {
  const files = app.vault.getMarkdownFiles().filter((file) => isWikiPath(file.path, root));
  const incoming = new Set<string>();
  const resolved = app.metadataCache.resolvedLinks;
  for (const [from, destinations] of Object.entries(resolved)) {
    for (const to of Object.keys(destinations)) if (from !== to) incoming.add(to);
  }
  const issues: MaintenanceIssue[] = [];
  for (const file of files) {
    const suggestions = (query: string) => index.search(query, { topK: 5, minScore: 0 })
      .filter((match) => match.path !== file.path).slice(0, 3);
    if (!incoming.has(file.path) && !Object.keys(resolved[file.path] ?? {}).some((path) => path !== file.path)) {
      issues.push({ kind: "orphan", path: file.path, detail: "没有入链或出链", suggestions: suggestions(file.basename) });
    }
    for (const link of Object.keys(app.metadataCache.unresolvedLinks[file.path] ?? {})) {
      if (!link || link.startsWith("#")) continue;
      issues.push({ kind: "broken-link", path: file.path, link, detail: `未解析链接：${link}`, suggestions: suggestions(link.split("#")[0] ?? link) });
    }
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
    const value: unknown = frontmatter?.last_evolved ?? frontmatter?.updated ?? frontmatter?.date;
    const timestamp = typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : NaN;
    if (Number.isFinite(timestamp) && now - timestamp > 2 * 365.25 * 86_400_000) {
      issues.push({ kind: "stale", path: file.path, detail: "记录日期超过两年，建议人工检查时效性（不代表内容错误）", suggestions: [] });
    }
  }
  return issues;
}
