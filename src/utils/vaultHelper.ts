import { z } from "zod";
import type { Vault } from "obsidian";
import { previewTextEdits } from "../evolution/astPatcher";
import { isWikiPath } from "../settings/settings";
import { TextEditSchema, VaultPathSchema } from "../types";
import type { SourceDocument, TextEdit } from "../types";

export interface PatchChunk {
  id: string;
  label: string;
  edits: TextEdit[];
}

export interface PatchProposal {
  id: string;
  path: string;
  action: string;
  rationale: string;
  before: string | null;
  baseFileHash: string | null;
  chunks: PatchChunk[];
  sources: SourceDocument[];
}

export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function renderProposal(proposal: PatchProposal, approved: readonly string[]): string {
  if (!approved.length || new Set(approved).size !== approved.length
    || approved.some((id) => !proposal.chunks.some((chunk) => chunk.id === id))) {
    throw new Error("请选择有效且不重复的修改块");
  }
  return previewTextEdits(proposal.before ?? "", proposal.chunks
    .filter((chunk) => approved.includes(chunk.id)).flatMap((chunk) => chunk.edits));
}

const JournalSchema = z.object({
  id: z.uuid(),
  path: VaultPathSchema,
  createdAt: z.string(),
  state: z.enum(["prepared", "applied", "undone"]),
  before: z.string().nullable(),
  after: z.string(),
  beforeHash: z.string().nullable(),
  afterHash: z.string(),
  edits: z.array(TextEditSchema)
});

export type Transaction = z.infer<typeof JournalSchema>;
export type HistoryEntry = Transaction & { recovery: "applied" | "not-applied" | "conflict" | "undone" };

export class SafeVaultWriter {
  private busy = false;
  readonly journalRoot = ".synovia/transactions";

  constructor(private readonly vault: Vault, private readonly getRoot: () => string) {}

  private assertScope(path: string): void {
    if (!isWikiPath(path, this.getRoot())) throw new Error("目标不在允许的 Wiki 目录中");
  }

  private async folders(path: string): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const part = parts.slice(0, i).join("/");
      if (!await this.vault.adapter.exists(part)) {
        try { await this.vault.createFolder(part); } catch (error) {
          if (!await this.vault.adapter.exists(part)) throw error;
        }
      }
    }
  }

  private async record(transaction: Transaction): Promise<void> {
    await this.vault.adapter.write(`${this.journalRoot}/${transaction.id}.json`, JSON.stringify(transaction));
  }

  async apply(proposal: PatchProposal, approved: readonly string[]): Promise<string> {
    if (this.busy) throw new Error("另一项写入尚未完成");
    this.busy = true;
    try {
      this.assertScope(proposal.path);
      const after = renderProposal(proposal, approved);
      const beforeHash = proposal.before === null ? null : await hashText(proposal.before);
      if (beforeHash !== proposal.baseFileHash) throw new Error("补丁基线校验失败");
      if (after === proposal.before || !after.trim()) throw new Error("没有有效变更");
      const existing = this.vault.getFileByPath(proposal.path);
      if (proposal.before === null ? existing !== null : existing === null) throw new Error("文件存在状态已变化，请重新生成建议");
      const transaction: Transaction = {
        id: crypto.randomUUID(), path: proposal.path, createdAt: new Date().toISOString(),
        state: "prepared", before: proposal.before, after, beforeHash,
        afterHash: await hashText(after),
        edits: proposal.chunks.filter((chunk) => approved.includes(chunk.id)).flatMap((chunk) => chunk.edits)
      };
      await this.folders(this.journalRoot);
      // Persist recovery information before touching the note.
      await this.record(transaction);
      this.assertScope(proposal.path);
      if (existing) {
        await this.vault.process(existing, (current) => {
          this.assertScope(existing.path);
          if (existing.path !== proposal.path || current !== proposal.before) {
            throw new Error("笔记已被修改或移动，已拒绝覆盖；请重新生成建议");
          }
          return after;
        });
      } else {
        await this.folders(proposal.path.slice(0, proposal.path.lastIndexOf("/")));
        this.assertScope(proposal.path);
        await this.vault.create(proposal.path, after);
      }
      transaction.state = "applied";
      try { await this.record(transaction); } catch {
        throw new Error("内容已写入，但日志状态未更新；可在历史记录中恢复或撤销");
      }
      return transaction.id;
    } finally {
      this.busy = false;
    }
  }

  async history(): Promise<HistoryEntry[]> {
    if (!await this.vault.adapter.exists(this.journalRoot)) return [];
    const listing = await this.vault.adapter.list(this.journalRoot);
    const records: HistoryEntry[] = [];
    for (const path of listing.files.filter((value) => /\/[a-f0-9-]+\.json$/u.test(value))) {
      try {
        const entry = JournalSchema.parse(JSON.parse(await this.vault.adapter.read(path)));
        if (path !== `${this.journalRoot}/${entry.id}.json`) continue;
        if (await hashText(entry.after) !== entry.afterHash
          || (entry.before === null ? entry.beforeHash !== null : await hashText(entry.before) !== entry.beforeHash)) continue;
        const file = this.vault.getFileByPath(entry.path);
        const current = file ? await this.vault.read(file) : null;
        const recovery = entry.state === "undone" ? "undone"
          : current === entry.after ? "applied"
            : current === entry.before ? "not-applied" : "conflict";
        records.push({ ...entry, recovery });
      } catch {
        // A corrupt log must never authorize a write.
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async undo(id: string): Promise<void> {
    if (this.busy) throw new Error("另一项写入尚未完成");
    this.busy = true;
    try {
      const entry = (await this.history()).find((record) => record.id === id);
      if (!entry || entry.recovery !== "applied") throw new Error("内容已改变或事务不可撤销");
      this.assertScope(entry.path);
      const file = this.vault.getFileByPath(entry.path);
      if (!file) throw new Error("目标文件不存在");
      await this.vault.process(file, (current) => {
        this.assertScope(file.path);
        if (file.path !== entry.path || current !== entry.after) throw new Error("笔记已改变，拒绝撤销覆盖");
        // Keep a newly created file empty: deleting it outside process() races with edits.
        return entry.before ?? "";
      });
      await this.record({ ...entry, state: "undone" });
    } finally {
      this.busy = false;
    }
  }
}
