import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { createParser } from "eventsource-parser";
import { z } from "zod";
import { SourceDocumentSchema } from "../types";
import type { SourceDocument } from "../types";
import { requestChecked, withDeadline } from "../utils/http";
import type { Request } from "../utils/http";
import { SearchInputSchema, zhihuError, zhihuRequestError } from "./zhihuSearchApiClient";

const SSE_URL = "https://developer.zhihu.com/api/mcp/zhihu_search/v1/sse";

export function validateMessageEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value, SSE_URL); }
  catch { throw new Error("MCP 返回了无效的会话地址"); }
  if (url.origin !== new URL(SSE_URL).origin
    || url.pathname !== "/api/mcp/zhihu_search/v1/message"
    || url.searchParams.getAll("sessionId").length !== 1
    || !url.searchParams.get("sessionId")?.trim() || url.username || url.password || url.hash) {
    throw new Error("MCP 返回了无效的会话地址");
  }
  return url.href;
}

export function parseMcpSearchText(text: string, maxItems = 10): SourceDocument[] {
  if (text.length > 1_000_000 || /<!DOCTYPE|<!ENTITY/iu.test(text)) throw new Error("MCP XML 内容无效");
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.querySelector("parsererror") || document.documentElement?.tagName !== "zhihu_search") {
    throw new Error("MCP 返回的搜索 XML 无法解析");
  }
  return Array.from(document.querySelectorAll("search_item")).flatMap((item) => {
    const edited = Date.parse(item.getAttribute("edit_time") ?? "");
    const source = SourceDocumentSchema.safeParse({
      id: `zhihu:mcp:${item.getAttribute("url")}`,
      sourceType: "zhihu_search_hit",
      contentType: item.getAttribute("content_type") ?? "unknown",
      title: item.getAttribute("title"),
      url: item.getAttribute("url"),
      author: item.getAttribute("author_name") ? { name: item.getAttribute("author_name") } : undefined,
      editedAt: Number.isFinite(edited) && edited >= 0 ? Math.floor(edited / 1000) : undefined,
      evidenceCompleteness: "snippet",
      contentSnippet: item.textContent?.trim()
    });
    return source.success ? [source.data] : [];
  }).slice(0, maxItems);
}

export async function searchZhihuMcp(
  request: Request, query: string, count: number, secret: string, timeout: number, signal?: AbortSignal
): Promise<SourceDocument[]> {
  signal?.throwIfAborted();
  const input = SearchInputSchema.parse({ query, count });
  if (!secret.trim()) throw zhihuError("AUTH_REQUIRED", "");
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("知乎 MCP 超时必须为正数");
  let endpoint = "";
  let nextId = 0;
  let failure: Error | undefined;
  let connection: ClientRequest | undefined;
  let stream: IncomingMessage | undefined;
  const controller = new AbortController();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {}); // The stream may fail before the handshake starts awaiting ready.
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    readyReject(error);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    controller.abort();
    stream?.destroy();
    connection?.destroy();
  };
  const parser = createParser({
    maxBufferSize: 1_000_000,
    onEvent(event) {
      try {
        if (event.event === "endpoint") {
          if (endpoint) throw new Error("MCP 会话地址发生变化");
          endpoint = validateMessageEndpoint(event.data);
          readyResolve();
        } else if (event.event === "message") {
          const message = z.object({
            id: z.number().int().nullish(),
            result: z.unknown().optional(),
            error: z.unknown().optional()
          }).parse(JSON.parse(event.data));
          const item = message.id == null ? undefined : pending.get(message.id);
          if (item) {
            if (message.error) {
              const error = z.object({
                code: z.union([z.number(), z.string()]).optional()
              }).safeParse(message.error).data;
              item.reject(zhihuError(error?.code, "MCP 工具调用失败"));
            }
            else item.resolve(message.result);
            pending.delete(message.id!);
          }
        }
      } catch { fail(new Error("MCP 数据或会话地址无效")); }
    },
    onError() { fail(new Error("MCP 事件格式无效")); }
  });
  const abort = () => fail(new Error("任务已取消"));
  const send = async (body: unknown) => {
    if (failure) throw failure;
    return requestChecked(request, {
      url: endpoint, method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, timeout, controller.signal).catch((error: unknown) => {
      const safeError = failure ?? zhihuRequestError(error);
      fail(safeError);
      throw safeError;
    });
  };
  const rpc = async (method: string, params: unknown = {}) => {
    if (failure) throw failure;
    const id = ++nextId;
    const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    try {
      const [, result] = await Promise.all([
        send({ jsonrpc: "2.0", id, method, params }), response
      ]);
      return result;
    } finally { pending.delete(id); }
  };
  try {
    // requestUrl buffers responses; desktop HTTPS is needed for the long-lived SSE stream.
    try {
      connection = httpsRequest(SSE_URL, {
        headers: { Authorization: `Bearer ${secret}`, Accept: "text/event-stream" }
      }, (response) => {
        stream = response;
        if (failure) { response.destroy(); return; }
        if (response.statusCode !== 200) {
          fail(zhihuError(response.statusCode, "MCP 连接失败"));
          return;
        }
        if (!/^text\/event-stream(?:;|$)/iu.test(response.headers["content-type"] ?? "")) {
          fail(new Error("MCP 未返回 SSE 事件流"));
          return;
        }
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (failure) return;
          try { parser.feed(chunk); } catch { fail(new Error("MCP 事件过大或格式无效")); }
        });
        response.on("end", () => fail(new Error("MCP 会话已结束")));
        response.on("close", () => fail(new Error("MCP 会话已关闭")));
        response.on("error", () => fail(zhihuError("NETWORK_ERROR", "")));
      });
      connection.on("error", () => fail(zhihuError("NETWORK_ERROR", "")));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else connection.end();
    } catch { throw zhihuError("NETWORK_ERROR", ""); }
    return await withDeadline((async () => {
      await ready;
      await rpc("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "synovia", version: "0.2.0" }, capabilities: {} });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = z.object({ tools: z.array(z.object({ name: z.string() })) }).parse(await rpc("tools/list"));
      if (!tools.tools.some((tool) => tool.name === "zhihu_search")) throw new Error("MCP 未提供知乎搜索工具");
      const result = z.object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() }))
      }).parse(await rpc("tools/call", { name: "zhihu_search", arguments: input }));
      if (result.isError) throw new Error("MCP 搜索失败，已停止调用，请检查鉴权、频率或配额");
      const text = result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      return parseMcpSearchText(text, input.count);
    })(), timeout, signal);
  } finally {
    signal?.removeEventListener("abort", abort);
    fail(new Error("MCP 会话已结束"));
  }
}
