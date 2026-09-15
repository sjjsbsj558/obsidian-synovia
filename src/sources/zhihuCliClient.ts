import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { basename, posix, win32 } from "node:path";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { SourceDocumentSchema } from "../types";
import type { SourceDocument } from "../types";
import { SearchInputSchema, normalizeSearchResponse, zhihuError } from "./zhihuSearchApiClient";

const execFileAsync = promisify(execFile);

export function resolveCliCommand(
  command: string, env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform
): string {
  const normalized = command.trim().replace(/^"(.*)"$/u, "$1");
  const path = platform === "win32" ? win32 : posix;
  const configuredHome = env.ZHIHU_CLI_HOME;
  if (configuredHome && !path.isAbsolute(configuredHome)) {
    throw new Error("知乎 CLI 安装目录必须为绝对路径，请检查 ZHIHU_CLI_HOME 或用户数据目录");
  }
  const homes = platform === "win32"
    ? [configuredHome, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "ZhihuCLI"),
      env.USERPROFILE && path.join(env.USERPROFILE, "AppData", "Local", "ZhihuCLI"),
      path.join(home, "AppData", "Local", "ZhihuCLI")]
    : [configuredHome, platform === "darwin" ? path.join(home, "Library", "Application Support", "zhihu-cli")
      : path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "zhihu-cli")];
  const binary = platform === "win32" ? "zhihu-cli.exe" : "zhihu-cli";
  const installed = homes.filter((value): value is string => Boolean(value)).map((value) =>
    path.join(value, "current", binary)).find((value) => statSync(value, { throwIfNoEntry: false })?.isFile());
  if (["zhihu", "zhihu-cli"].includes(normalized)) {
    if (installed) return installed;
    throw new Error("找不到知乎 CLI。请运行官方 skill 的 status 检查，并在设置中填写返回的 binary_path 绝对路径。");
  }
  if (statSync(normalized, { throwIfNoEntry: false })?.isFile()) return normalized;
  const staleOfficialPath = path.isAbsolute(normalized)
    && basename(normalized).toLowerCase() === binary
    && !statSync(normalized, { throwIfNoEntry: false })?.isFile();
  if (staleOfficialPath && installed) return installed;
  return normalized;
}

export const GlobalSearchInputSchema = z.object({
  query: z.string().trim().min(2).max(100),
  count: z.number().int().min(1).max(20),
  filter: z.string().trim().max(500).default(""),
  searchDb: z.enum(["all", "realtime", "static"]).default("all")
});

export const HotInputSchema = z.object({ limit: z.number().int().min(1).max(30) });
export const ZhidaInputSchema = z.object({
  query: z.string().trim().min(2).max(100_000),
  model: z.enum(["fast", "thinking", "agent"])
});

const HotItemSchema = z.object({
  Title: z.string().trim().min(1),
  Url: z.string().url(),
  Summary: z.string().optional()
});

const ChatResponseSchema = z.object({
  model: z.string().optional(),
  content: z.string().optional(),
  reasoning_content: z.string().optional(),
  choices: z.array(z.object({
    message: z.object({
      content: z.string().optional(),
      reasoning_content: z.string().optional()
    }).optional()
  })).optional()
});

export interface ZhidaResult {
  source: SourceDocument;
  model: string;
  reasoning: string;
}

function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) throw new Error("知乎 CLI 没有返回内容");
  try { return JSON.parse(text); }
  catch { throw new Error("知乎 CLI 返回的不是有效 JSON"); }
}

export function buildCliInvocation(
  command: string, args: readonly string[], _platform = process.platform, _comSpec?: string
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const executable = command.trim().replace(/^"(.*)"$/u, "$1");
  if (/\.(?:cmd|bat)$/iu.test(executable)) {
    throw new Error("知乎 CLI 不支持 .cmd/.bat 包装脚本，请填写官方可执行文件的绝对路径");
  }
  if (!executable || /["\u0000-\u001f]/u.test(executable)) throw new Error("知乎 CLI 命令必须为可执行文件路径，不可包含参数");
  return { file: executable, args: [...args] };
}

function responseError(input: unknown): Error | undefined {
  const details = z.object({
    ok: z.boolean().optional(),
    Code: z.number().optional(),
    error: z.unknown().optional()
  }).safeParse(input).data;
  if (!details || (details.ok !== false && !details.error && !details.Code)) return;
  const code = z.object({ code: z.unknown().optional() }).safeParse(details.error).data?.code;
  return zhihuError(details.Code || code, "知乎 CLI 请求失败，请检查官方 CLI 状态");
}

function cliError(error: unknown, executable: string): Error {
  const value = (error ?? {}) as { code?: unknown; name?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean };
  if (value.code === "ENOENT") {
    return new Error(`知乎 CLI 无法启动：${executable}。请确认文件存在，并重启 Obsidian 后重试。`);
  }
  for (const output of [value.stdout, value.stderr]) {
    if (typeof output !== "string" || !output.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(output); } catch { continue; }
    const failure = responseError(parsed);
    if (failure) return failure;
  }
  if (value.name === "AbortError") return new Error("任务已取消");
  if (value.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return new Error("知乎 CLI 响应过大，请缩小请求范围");
  if (value.code === "ETIMEDOUT" || value.killed) return zhihuError("TIMEOUT", "");
  if (value.code === 3) return zhihuError("AUTH_INVALID", "");
  if (value.code === 4) return zhihuError(429, "");
  if (value.code === 5) return zhihuError("NETWORK_ERROR", "");
  if (value.code === 7) return zhihuError("KEYCHAIN_UNAVAILABLE", "");
  if (value.code === 2) return new Error("知乎 CLI 参数不兼容，请检查当前命令的 help/capabilities");
  return new Error("知乎 CLI 调用失败。请先检查 CLI 状态和认证配置。");
}

export function normalizeHotResponse(input: unknown): SourceDocument[] {
  const envelope = z.object({ Code: z.number(), Message: z.string().optional(), Data: z.unknown().optional() }).parse(input);
  if (envelope.Code !== 0) throw zhihuError(envelope.Code, "知乎热榜请求失败");
  const items = z.object({ Items: z.array(z.unknown()) }).parse(envelope.Data).Items;
  return items.flatMap((item) => {
    const parsed = HotItemSchema.safeParse(item).data;
    if (!parsed) return [];
    const source = SourceDocumentSchema.safeParse({
      id: `zhihu:hot:${parsed.Url}`,
      sourceType: "zhihu_search_hit",
      title: parsed.Title,
      url: parsed.Url,
      evidenceCompleteness: "snippet",
      contentSnippet: parsed.Summary?.trim() || parsed.Title
    });
    return source.success ? [source.data] : [];
  }).slice(0, 30);
}

export function normalizeZhidaResponse(input: unknown, query: string): ZhidaResult {
  const response = ChatResponseSchema.parse(input);
  const choice = response.choices?.[0]?.message;
  const content = (response.content ?? choice?.content ?? "").trim();
  if (!content) throw new Error("知乎直答没有返回正文");
  const reasoning = (response.reasoning_content ?? choice?.reasoning_content ?? "").trim();
  const model = response.model ?? "zhida";
  const source = SourceDocumentSchema.parse({
    id: `zhihu:zhida:${crypto.randomUUID()}`,
    sourceType: "zhida_answer",
    title: `知乎直答：${query.slice(0, 80)}`,
    url: "",
    evidenceCompleteness: "full",
    contentSnippet: content.slice(0, 240),
    fullContent: content
  });
  return { source, model, reasoning };
}

export class ZhihuCliClient {
  constructor(private readonly command = "zhihu-cli", private readonly cwd?: string) {}

  async connection(timeout: number, secret = "", signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const executable = resolveCliCommand(this.command);
    const result = z.object({
      ok: z.boolean(),
      source: z.enum(["environment", "keychain", "none"]),
      environment_shadows_keychain: z.boolean().optional()
    }).safeParse(await this.run(["auth", "status"], secret, timeout, signal));
    if (!result.success) throw new Error("知乎 CLI auth status 返回格式无效，请检查当前 CLI 版本");
    if (!result.data.ok || result.data.source === "none") throw zhihuError("AUTH_REQUIRED", "");
    const override = result.data.environment_shadows_keychain ? " · 环境变量覆盖系统凭据库" : "";
    const source = secret ? "插件设置（进程环境变量）" : result.data.source;
    return `CLI 已配置 · ${executable} · 认证来源：${source}${override} · 仅本地检查，未在线验证`;
  }

  async quota(secret: string, timeout: number, signal?: AbortSignal): Promise<string> {
    const response = z.object({
      Code: z.number(),
      Data: z.array(z.object({ APIName: z.string(), RemainingQuota: z.number(), TotalQuota: z.number() })).optional()
    }).parse(await this.run(["quota"], secret, timeout, signal));
    if (response.Code !== 0 || !response.Data) throw zhihuError(response.Code, "额度查询失败");
    return response.Data.map((item) => `${item.APIName}：${item.RemainingQuota} / ${item.TotalQuota}`).join("\n");
  }

  async answers(url: string, secret: string, timeout: number, signal?: AbortSignal): Promise<SourceDocument[]> {
    const question = new URL(url);
    if (question.protocol !== "https:" || question.hostname !== "www.zhihu.com"
      || !/^\/question\/\d+\/?$/u.test(question.pathname) || question.username || question.password || question.port || question.hash) {
      throw new Error("请输入 https://www.zhihu.com/question/数字 格式的问题链接");
    }
    const response = z.object({
      Code: z.number(),
      Data: z.object({ Items: z.array(z.unknown()) }).optional()
    }).parse(await this.run(["question", "answers", "--question-url", question.href, "--limit", "10"], secret, timeout, signal));
    if (response.Code !== 0 || !response.Data) throw zhihuError(response.Code, "读取回答摘要失败");
    return response.Data.Items.flatMap((value) => {
      const item = z.object({ Url: z.string().url(), Summary: z.string().trim().min(1) }).safeParse(value).data;
      if (!item) return [];
      const source = SourceDocumentSchema.safeParse({
        id: `zhihu:answer:${item.Url}`, sourceType: "zhihu_search_hit", contentType: "回答摘要",
        title: item.Summary.slice(0, 70), url: item.Url, evidenceCompleteness: "snippet", contentSnippet: item.Summary
      });
      return source.success ? [source.data] : [];
    }).slice(0, 10);
  }

  private async run(args: string[], secret: string, timeout: number, signal?: AbortSignal): Promise<unknown> {
    const command = this.command.trim();
    if (!command) throw new Error("请在设置中配置知乎 CLI 命令");
    signal?.throwIfAborted();
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("知乎 CLI 超时必须为正数");
    const env = { ...process.env };
    if (secret) env.ZHIHU_ACCESS_SECRET = secret;
    // Zhihu CLI parses Go-style durations; keep the unit instead of passing a bare integer.
    const duration = `${Math.max(1, Math.ceil(timeout / 1000))}s`;
    const invocation = buildCliInvocation(resolveCliCommand(command), [...args, "--timeout", duration]);
    let stdout: string;
    try {
      const options = {
        cwd: this.cwd || dirname(invocation.file),
        env,
        timeout,
        maxBuffer: 2_000_000,
        windowsHide: true,
        shell: false,
        signal
      };
      let result;
      try {
        result = await execFileAsync(invocation.file, invocation.args, options);
      } catch (error) {
        // Some Obsidian builds report an invalid inherited directory as ENOENT.
        if (process.platform !== "win32" || this.cwd || (error as { code?: unknown }).code !== "ENOENT") throw error;
        result = await execFileAsync(invocation.file, invocation.args, { ...options, cwd: undefined });
      }
      stdout = result.stdout;
    } catch (error) {
      signal?.throwIfAborted();
      throw cliError(error, invocation.file);
    }
    signal?.throwIfAborted();
    const parsed = parseJson(stdout);
    const failure = responseError(parsed);
    if (failure) throw failure;
    return parsed;
  }

  async searchZhihu(query: string, count: number, secret: string, timeout: number, signal?: AbortSignal): Promise<SourceDocument[]> {
    const input = SearchInputSchema.parse({ query, count });
    return normalizeSearchResponse(await this.run(["search", "zhihu", "--query", input.query, "--count", String(input.count)], secret, timeout, signal));
  }

  async searchGlobal(
    query: string, count: number, filter: string, searchDb: "all" | "realtime" | "static",
    secret: string, timeout: number, signal?: AbortSignal
  ): Promise<SourceDocument[]> {
    const input = GlobalSearchInputSchema.parse({ query, count, filter, searchDb });
    const args = ["search", "global", "--query", input.query, "--count", String(input.count), "--search-db", input.searchDb];
    if (input.filter) args.push("--filter", input.filter);
    return normalizeSearchResponse(await this.run(args, secret, timeout, signal), 20);
  }

  async hot(limit: number, secret: string, timeout: number, signal?: AbortSignal): Promise<SourceDocument[]> {
    const input = HotInputSchema.parse({ limit });
    return normalizeHotResponse(await this.run(["hot", "--limit", String(input.limit)], secret, timeout, signal));
  }

  async ask(query: string, model: "fast" | "thinking" | "agent", secret: string, timeout: number, signal?: AbortSignal): Promise<ZhidaResult> {
    const input = ZhidaInputSchema.parse({ query, model });
    const modelName = { fast: "zhida-fast-1p5", thinking: "zhida-thinking-1p5", agent: "zhida-agent" }[input.model];
    return normalizeZhidaResponse(await this.run(["answer", "--query", input.query, "--model", modelName], secret, timeout, signal), input.query);
  }
}
