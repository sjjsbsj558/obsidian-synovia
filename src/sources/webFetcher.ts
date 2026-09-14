import { Readability } from "@mozilla/readability";
import { SourceDocumentSchema } from "../types";
import type { SourceDocument } from "../types";
import { requestChecked } from "../utils/http";
import type { Request } from "../utils/http";
import { htmlToMarkdown } from "./markdownFormat";

export async function fetchWebContent(request: Request, url: string, timeout: number, signal?: AbortSignal): Promise<SourceDocument> {
  const response = await requestChecked(request, { url, method: "GET" }, timeout, signal);
  const contentType = response.headers["content-type"] ?? response.headers["Content-Type"] ?? "";
  let title = new URL(url).hostname;
  let text = response.text;
  if (contentType.includes("html")) {
    const document = new DOMParser().parseFromString(response.text, "text/html");
    const article = new Readability(document).parse();
    if (!article?.textContent?.trim()) throw new Error("页面没有可提取的正文，请手动粘贴内容");
    title = article.title ?? title;
    text = htmlToMarkdown(article.content ?? "", url);
  } else if (!/text\/|application\/(?:x-)?markdown/iu.test(contentType)) {
    throw new Error("目前仅支持 HTML、Markdown 和纯文本网页");
  }
  return SourceDocumentSchema.parse({
    id: crypto.randomUUID(), sourceType: "web_page", title: title.slice(0, 300), url,
    evidenceCompleteness: "full", contentSnippet: text.trim().slice(0, 500), fullContent: text
  });
}
