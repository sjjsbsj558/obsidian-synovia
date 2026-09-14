import { z } from "zod";
import { VaultPathSchema } from "../types";

export const SettingsSchema = z.object({
  wikiRoot: VaultPathSchema.default("Wiki"),
  topK: z.number().int().min(1).max(20).default(5),
  minScore: z.number().finite().min(0).max(1000).default(1),
  modelBaseUrl: z.union([z.url({ protocol: /^https$/u }), z.literal("")]).default(""),
  modelName: z.string().trim().max(200).default(""),
  modelSecretName: z.string().trim().max(200).default(""),
  zhihuSecretName: z.string().trim().max(200).default(""),
  allowRemote: z.boolean().default(false),
  autoOptimize: z.boolean().default(false),
  redactSensitive: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(10).max(300).default(90),
  maxInputChars: z.number().int().min(1000).max(100_000).default(30_000),
  maxOutputTokens: z.number().int().min(512).max(16_000).default(4096),
  zhihuMode: z.enum(["cli", "api", "mcp"]).default("cli"),
  zhihuCommand: z.string().trim().min(1).max(300).default("zhihu-cli"),
  zhihuCount: z.number().int().min(1).max(10).default(5),
  zhihuGlobalCount: z.number().int().min(1).max(20).default(10),
  zhihuHotCount: z.number().int().min(1).max(30).default(10),
  zhihuGlobalFilter: z.string().trim().max(500).default(""),
  zhihuGlobalDb: z.enum(["all", "realtime", "static"]).default("all"),
  zhidaModel: z.enum(["fast", "thinking", "agent"]).default("thinking")
});

export type SynoviaSettings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS = SettingsSchema.parse({});

export function isWikiPath(path: string, root: string): boolean {
  return VaultPathSchema.safeParse(path).success
    && VaultPathSchema.safeParse(root).success
    && path.startsWith(`${root}/`)
    && path.toLowerCase().endsWith(".md");
}
