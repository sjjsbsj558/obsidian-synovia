import type { TAbstractFile, TFile, Vault } from "obsidian";
import { LocalWikiIndex } from "./miniSearchAdapter";

export class VaultIndex {
  private index?: LocalWikiIndex;
  private generation = 0;
  private updates: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly vault: Vault) {}

  invalidate(): void {
    this.generation++;
    this.index = undefined;
  }

  dispose(): void {
    this.closed = true;
    this.invalidate();
  }

  changed(file: TAbstractFile, removed = false, oldPath?: string): void {
    if (!this.isSearchable(file.path) && (!oldPath || !this.isSearchable(oldPath))) return;
    this.generation++;
    const index = this.index;
    if (!index) return;
    const path = file.path;
    this.updates = this.updates.then(async () => {
      if (this.closed || this.index !== index) return;
      if (oldPath) index.remove(oldPath);
      if (removed || !this.isSearchable(path)) {
        index.remove(path);
      } else {
        const current = this.vault.getFileByPath(path);
        if (current) index.upsert({ path, title: current.basename, content: await this.vault.cachedRead(current) });
        else index.remove(path);
      }
    }).catch(() => { this.invalidate(); });
  }

  async get(): Promise<LocalWikiIndex> {
    await this.updates;
    if (this.closed) throw new Error("Synovia 已关闭");
    if (this.index) return this.index;
    const generation = this.generation;
    const index = new LocalWikiIndex();
    const files: TFile[] = this.vault.getMarkdownFiles().filter((file) => this.isSearchable(file.path));
    for (const [number, file] of files.entries()) {
      index.upsert({ path: file.path, title: file.basename, content: await this.vault.cachedRead(file) });
      if (this.closed || generation !== this.generation) throw new Error("索引期间笔记发生变化，请重试");
      if (number % 25 === 24) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.index = index;
    return index;
  }

  private isSearchable(path: string): boolean {
    // Index everything first; each workflow decides which generated notes are
    // eligible. This keeps implicit knowledge available to semantic retrieval.
    return path.toLowerCase().endsWith(".md")
      && !/(^|\/)\.synovia\//u.test(path);
  }
}
