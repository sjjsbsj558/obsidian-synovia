import type { DataAdapter } from "obsidian";
import type { z } from "zod";

type Storage = Pick<DataAdapter, "exists" | "read" | "write" | "remove">;

export async function readJournal<T>(storage: Storage, path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let found = false;
  // A complete staged record is the newest intended checkpoint after an interrupted write.
  for (const candidate of [`${path}.tmp`, path, `${path}.bak`]) {
    if (!await storage.exists(candidate)) continue;
    found = true;
    try { return schema.parse(JSON.parse(await storage.read(candidate))); } catch { /* try the last recoverable record */ }
  }
  if (found) throw new Error(`任务记录损坏，已停止覆盖：${path}`);
  return undefined;
}

export async function writeJournal(storage: Storage, path: string, value: unknown): Promise<void> {
  const content = JSON.stringify(value);
  await storage.write(`${path}.tmp`, content);
  if (await storage.exists(path)) await storage.write(`${path}.bak`, await storage.read(path));
  await storage.write(path, content);
  await storage.remove(`${path}.tmp`);
}
