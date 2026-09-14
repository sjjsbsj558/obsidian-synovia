import { z } from "zod";
import { SourceDocumentSchema } from "../types";
import type { SourceDocument } from "../types";
import { HttpError, requestChecked } from "../utils/http";
import type { Request } from "../utils/http";

export const SearchInputSchema = z.object({
  query: z.string().trim().min(2).max(100),
  count: z.number().int().min(1).max(10)
});

const HitSchema = z.object({
  Title: z.string().min(1),
  ContentType: z.string(),
  ContentID: z.string(),
  ContentText: z.string(),
  Url: z.string(),
  AuthorName: z.string().optional(),
  AuthorBadgeText: z.string().optional(),
  VoteUpCount: z.number().int().nonnegative().optional(),
  EditTime: z.number().int().nonnegative().optional()
});

export function zhihuError(code: unknown, fallback: string): Error {
  const reasons: Record<string, string> = {
    AUTH_REQUIRED: "知乎未配置认证，请在开放平台个人中心申请 Access Secret 并配置官方 CLI",
    AUTH_INVALID: "知乎鉴权失败，请检查密钥和权限",
    KEYCHAIN_UNAVAILABLE: "知乎系统凭据库不可用，请检查凭据库或宿主注入的 ZHIHU_ACCESS_SECRET",
    ENV_SHADOWS_KEYCHAIN: "ZHIHU_ACCESS_SECRET 正在覆盖系统凭据库，请检查认证来源",
    NETWORK_ERROR: "知乎网络请求失败，请检查网络",
    TIMEOUT: "知乎请求超时，请稍后重试",
    UPSTREAM_ERROR: "知乎服务端返回错误",
    20001: "知乎鉴权失败，请检查密钥和权限",
    30001: "知乎请求过于频繁，已停止调用，请稍后重试",
    30002: "知乎配额耗尽，已停止调用，请等待额度恢复",
    401: "知乎鉴权失败，请检查密钥和权限",
    403: "知乎鉴权失败，请检查密钥和权限",
    429: "知乎频率或配额限制，已停止调用，请稍后重试"
  };
  // Only known codes are echoed: upstream messages and even arbitrary code strings may contain credentials.
  const key = typeof code === "number" || typeof code === "string" ? String(code) : "";
  const known = Object.hasOwn(reasons, key);
  return Object.assign(new Error(known ? `${reasons[key]} (${key})` : fallback), {
    code: known ? key : "ZHIHU_ERROR"
  });
}

export function zhihuRequestError(error: unknown): Error {
  if (error instanceof HttpError) return zhihuError(error.status, "知乎远程服务请求失败");
  if (error instanceof Error && ["请求超时，请稍后重试", "任务已取消", "响应过大，请缩小输入范围"].includes(error.message)) {
    return new Error(error.message);
  }
  return zhihuError("NETWORK_ERROR", "");
}

export function normalizeSearchResponse(input: unknown, maxItems = 10): SourceDocument[] {
  const envelope = z.object({ Code: z.number(), Message: z.string().optional(), Data: z.unknown().optional() }).parse(input);
  if (envelope.Code !== 0) throw zhihuError(envelope.Code, "知乎服务错误");
  const items = z.object({ Items: z.array(z.unknown()) }).parse(envelope.Data).Items;
  return items.flatMap((item) => {
    const hit = HitSchema.safeParse(item).data;
    if (!hit || !hit.ContentText.trim()) return [];
    const source = SourceDocumentSchema.safeParse({
      id: `zhihu:${hit.ContentType}:${hit.ContentID}`,
      sourceType: "zhihu_search_hit",
      contentType: hit.ContentType,
      title: hit.Title.replace(/<\/?em>/giu, ""),
      url: hit.Url,
      author: hit.AuthorName ? { name: hit.AuthorName, badge: hit.AuthorBadgeText } : undefined,
      upvotes: hit.VoteUpCount,
      editedAt: hit.EditTime,
      evidenceCompleteness: "snippet",
      contentSnippet: hit.ContentText.replace(/<\/?em>/giu, "")
    });
    return source.success ? [source.data] : [];
  }).slice(0, maxItems);
}

export class ZhihuSearchApiClient {
  private lastRequest = 0;

  constructor(private readonly request: Request) {}

  async search(query: string, count: number, secret: string, timeout: number, signal?: AbortSignal): Promise<SourceDocument[]> {
    signal?.throwIfAborted();
    const input = SearchInputSchema.parse({ query, count });
    if (!secret.trim()) throw zhihuError("AUTH_REQUIRED", "");
    if (Date.now() - this.lastRequest < 1000) throw new Error("请至少间隔一秒再搜索");
    this.lastRequest = Date.now();
    const url = new URL("https://developer.zhihu.com/api/v1/content/zhihu_search");
    url.search = new URLSearchParams({ Query: input.query, Count: String(input.count) }).toString();
    const response = await requestChecked(this.request, {
      url: url.href, method: "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
        "Content-Type": "application/json"
      }
    }, timeout, signal).catch((error: unknown) => {
      signal?.throwIfAborted();
      throw zhihuRequestError(error);
    });
    return normalizeSearchResponse(response.json);
  }
}
