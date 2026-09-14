import { getMarkdownBlocks } from "./astPatcher";

export function noteStem(title: string): string {
  const clean = title.replace(/[<>:"/\\|?*#^[\]\u0000-\u001f]/gu, " ").replace(/\s+/gu, " ").trim()
    .slice(0, 64).replace(/[. ]+$/u, "");
  return !clean || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(clean) ? "Knowledge" : clean;
}

export function selectedBlocks(text: string, start: number, end: number): string {
  if (start < 0 || end > text.length || end <= start) throw new Error("请先选中需要提取的内容");
  const blocks = getMarkdownBlocks(text).filter((block) => block.endOffset > start && block.startOffset < end && block.type !== "yaml");
  if (!blocks.length) throw new Error("选区没有可提取正文");
  return text.slice(blocks[0]!.startOffset, blocks.at(-1)!.endOffset);
}

export function evidenceSnapshot(text: string): string {
  let snapshot = text;
  for (const block of getMarkdownBlocks(text).filter((block) => block.type !== "yaml").reverse()) {
    snapshot = `${snapshot.slice(0, block.endOffset)}\n\n^synovia-${block.startOffset}-${block.endOffset}\n${snapshot.slice(block.endOffset)}`;
  }
  const yaml = getMarkdownBlocks(text).find((block) => block.type === "yaml");
  if (yaml) snapshot = snapshot.slice(0, yaml.startOffset) + snapshot.slice(yaml.endOffset);
  return snapshot;
}

export function formatWarnings(text: string): string[] {
  const warnings = new Set<string>();
  const blocks = getMarkdownBlocks(text);
  const body = blocks.filter((block) => block.type !== "code" && block.type !== "yaml").map((block) => block.text).join("\n\n");
  if (/\\[([]|\\[)\]]/u.test(body)) warnings.add("检测到非标准数学分隔符，请核对原文与预览");
  if (/<(?:table|img|math)\b/iu.test(body)) warnings.add("HTML 表格、图片或公式需人工核对，尚未保证转换保真");
  if ((body.match(/^\s*\$\$\s*$/gmu)?.length ?? 0) % 2) warnings.add("块公式分隔符可能未闭合");
  for (const block of blocks.filter((entry) => entry.type === "table")) {
    const widths = block.text.split(/\r?\n/u).map((line) => line.replace(/\\\|/gu, "").replace(/^\s*\||\|\s*$/gu, "").split("|").length);
    if (new Set(widths).size > 1) warnings.add("表格列数不一致，请检查竖线转义或缺失单元格");
  }
  return [...warnings];
}
