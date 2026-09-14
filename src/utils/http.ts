import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

export type Request = (options: RequestUrlParam) => Promise<RequestUrlResponse>;

export class HttpError extends Error {
  constructor(readonly status: number, readonly detail: string, message: string) { super(message); }
}

export function validateRemoteUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("仅允许不含用户名、密码或片段的 HTTPS 地址");
  }
  return url;
}

export function redact(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu, "[phone]")
    .replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_-]{12,}\b/giu, "[secret]");
}

export async function withDeadline<T>(
  work: Promise<T>, milliseconds: number, signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    // The caller may already have started the request before cancellation.
    void work.catch(() => {});
    signal.throwIfAborted();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("请求超时，请稍后重试")), milliseconds);
        abort = () => reject(new Error("任务已取消"));
        signal?.addEventListener("abort", abort, { once: true });
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export async function requestChecked(
  request: Request, options: RequestUrlParam, timeout: number, signal?: AbortSignal
): Promise<RequestUrlResponse> {
  signal?.throwIfAborted();
  validateRemoteUrl(options.url);
  const response = await withDeadline(request({ ...options, throw: false }), timeout, signal);
  signal?.throwIfAborted();
  if (response.status < 200 || response.status >= 300) {
    const reason = response.status === 401 || response.status === 403 ? "鉴权失败，请检查密钥和权限"
      : response.status === 429 ? "请求过于频繁或配额不足，请稍后重试" : "远程服务请求失败";
    let detail = "";
    try {
      const body = response.json as { error?: { message?: string }; message?: string };
      detail = typeof body.error?.message === "string" ? body.error.message
        : typeof body.message === "string" ? body.message : "";
    } catch { /* non-JSON service errors keep the status */ }
    detail = redact(detail).replace(/[\r\n]+/gu, " ").slice(0, 500);
    throw new HttpError(response.status, detail, `${reason} (HTTP ${response.status})${detail ? `：${detail}` : ""}`);
  }
  if (response.text.length > 2_000_000) throw new Error("响应过大，请缩小输入范围");
  return response;
}
