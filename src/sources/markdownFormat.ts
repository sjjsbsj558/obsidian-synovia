import { getMarkdownBlocks } from "../evolution/astPatcher";

export function normalizeMarkdown(text: string): string {
  let result = text;
  for (const block of getMarkdownBlocks(text).reverse()) {
    if (["code", "yaml", "math"].includes(block.type)) continue;
    const normalized = block.text.replace(/(`+)[\s\S]*?\1|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/gu,
      (original, code: string | undefined, display: string | undefined, inline: string | undefined) =>
        code ? original : display !== undefined ? `\n\n$$\n${display.trim()}\n$$\n\n` : `$${inline!.trim()}$`);
    result = result.slice(0, block.startOffset) + normalized + result.slice(block.endOffset);
  }
  return result;
}

export function htmlToMarkdown(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,form").forEach((node) => node.remove());
  for (const element of doc.querySelectorAll("*")) for (const attribute of [...element.attributes]) {
    if (attribute.name.startsWith("on") || ["style", "srcdoc"].includes(attribute.name)) element.removeAttribute(attribute.name);
  }
  const safeUrl = (value: string): string => {
    try { const url = new URL(value, baseUrl); return /^https?:$/u.test(url.protocol) ? url.href : ""; }
    catch { return ""; }
  };
  const render = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    const text = () => [...el.childNodes].map(render).join("");
    if (tag === "img") {
      const tex = el.getAttribute("data-formula") ?? (/eeimg|equation|math/iu.test(el.getAttribute("class") ?? "") ? el.getAttribute("alt") : null);
      if (tex) return `$${tex}$`;
      const src = safeUrl(el.getAttribute("data-original") ?? el.getAttribute("src") ?? "");
      return src ? `![${(el.getAttribute("alt") ?? "").replace(/[[\]]/gu, "")}](<${src}>)` : "";
    }
    if (tag === "math") {
      const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      return tex ? `$$\n${tex}\n$$` : el.outerHTML;
    }
    if (tag === "pre" || tag === "code") {
      const value = el.textContent ?? "";
      const fence = "`".repeat(Math.max(tag === "pre" ? 3 : 1, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length + 1)));
      return tag === "pre" ? `\n\n${fence}\n${value}\n${fence}\n\n` : `${fence} ${value} ${fence}`;
    }
    if (tag === "table") {
      if (el.querySelector("[rowspan],[colspan]")) {
        for (const link of el.querySelectorAll("[href],[src]")) for (const name of ["href", "src"]) {
          if (link.hasAttribute(name)) link.setAttribute(name, safeUrl(link.getAttribute(name)!));
        }
        return `\n\n${el.outerHTML}\n\n`;
      }
      const rows = [...el.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("th,td")]
        .map((cell) => [...cell.childNodes].map(render).join("").trim().replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>")));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
      return `\n\n${line(rows[0]!)}\n${line(Array(width).fill("---"))}\n${rows.slice(1).map(line).join("\n")}\n\n`;
    }
    if (tag === "a") {
      const url = safeUrl(el.getAttribute("href") ?? "");
      return url ? `[${text()}](<${url}>)` : text();
    }
    if (/^h[1-6]$/u.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${text()}\n\n`;
    if (tag === "br") return "\n";
    if (tag === "li") return `\n- ${text().trim()}`;
    if (tag === "blockquote") return `\n\n${text().trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    if (["b", "strong"].includes(tag)) return `**${text()}**`;
    if (["p", "div", "section", "ul", "ol"].includes(tag)) return `\n\n${text()}\n\n`;
    return text();
  };
  return normalizeMarkdown([...doc.body.childNodes].map(render).join("").trim());
}
