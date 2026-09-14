import { ButtonComponent, Component, ItemView, MarkdownRenderer, Notice } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type SynoviaPlugin from "../main";
import type { OpinionResult } from "../main";
import type { SourceDocument } from "../types";

export const SYNOVIA_VIEW_TYPE = "synovia-workbench";

export class SynoviaSidebarView extends ItemView {
  private question = "";
  private result?: OpinionResult;
  private savedPath?: string;
  private busy = false;
  private cancelled = false;
  private closed = false;
  private message = "";
  private status?: HTMLElement;
  private preview?: Component;
  private stopButton?: ButtonComponent;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: SynoviaPlugin) { super(leaf); }
  override getViewType(): string { return SYNOVIA_VIEW_TYPE; }
  override getDisplayText(): string { return "Synovia · 观点 Agent"; }
  override getIcon(): string { return "message-circle"; }
  override async onOpen(): Promise<void> { this.closed = false; this.render(); }
  override async onClose(): Promise<void> {
    this.closed = true;
    if (this.busy) { this.cancelled = true; this.plugin.cancel(); }
    if (this.preview) this.removeChild(this.preview);
    this.contentEl.empty();
  }
  refreshStatus(): void {
    if (this.closed) return;
    this.stopButton?.setDisabled(!this.busy && !this.plugin.isBusy());
    if (!this.busy && !this.plugin.isBusy()) this.render();
    else this.status?.setText(this.plugin.activity || this.message);
  }
  private report(message: string): void { this.message = message; this.status?.setText(message); }
  private button(parent: HTMLElement, icon: string, label: string, work: () => void | Promise<void>, text = false, enabledWhileBusy = false): ButtonComponent {
    const button = new ButtonComponent(parent).setTooltip(label).onClick(work);
    if (text) button.setButtonText(label);
    else button.setIcon(icon);
    button.buttonEl.type = "button";
    button.buttonEl.setAttribute("aria-label", label);
    button.setDisabled(!enabledWhileBusy && (this.busy || this.plugin.isBusy()));
    return button;
  }
  private async run(work: () => Promise<void>): Promise<void> {
    if (this.busy || this.plugin.isBusy()) { new Notice("当前任务仍在运行，可使用停止按钮取消"); return; }
    this.busy = true;
    this.cancelled = false;
    this.report("准备中");
    this.render();
    try { await work(); }
    catch (error) {
      this.report(this.cancelled || (error instanceof DOMException && error.name === "AbortError")
        ? "已停止，原笔记未修改"
        : error instanceof Error ? error.message : String(error));
    }
    finally { this.busy = false; if (!this.closed) this.render(); }
  }
  async collect(source: SourceDocument): Promise<void> {
    if (this.busy || this.plugin.isBusy()) { new Notice("请先停止当前任务"); return; }
    this.question = `如何评价以下观点？请结合知识库给出判断、反方理由和适用条件。\n\n${source.fullContent ?? source.contentSnippet}`;
    await this.ask();
  }
  private async ask(): Promise<void> {
    if (!this.question.trim()) { this.report("先写下想判断的问题"); return; }
    this.result = undefined;
    this.savedPath = undefined;
    await this.run(async () => {
      if (!this.plugin.settings.allowRemote) throw new Error("请在 Synovia 设置中配置模型并允许远程调用");
      const result = await this.plugin.askOpinion(this.question, (message) => this.report(message));
      if (this.cancelled || this.closed) return;
      this.result = result;
      this.savedPath = undefined;
      this.report("观点已生成，尚未写入知识库");
    });
  }
  private link(parent: HTMLElement, path: string, title?: string, external = false): void {
    const link = parent.createEl("a", { text: title ?? path.split("/").at(-1)!.replace(/\.md$/iu, ""),
      href: path, cls: external ? undefined : "internal-link" });
    if (external) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return;
    }
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void this.app.workspace.openLinkText(path, "", event.ctrlKey || event.metaKey);
    });
  }
  private openSettings(): void {
    const app = this.app as typeof this.app & { setting?: { open(): void; openTabById(id: string): void } };
    if (app.setting) { app.setting.open(); app.setting.openTabById(this.plugin.manifest.id); }
    else new Notice("请打开 Obsidian 设置 → Synovia");
  }
  private render(): void {
    if (this.closed) return;
    if (this.preview) this.removeChild(this.preview);
    this.preview = this.addChild(new Component());
    const container = this.contentEl;
    container.empty();
    container.addClass("synovia-agent");
    container.setAttribute("aria-busy", String(this.busy || this.plugin.isBusy()));
    const header = container.createDiv({ cls: "synovia-agent-header" });
    header.createEl("h2", { text: "Synovia" });
    header.createSpan({ text: "观点 Agent", cls: "synovia-agent-meta" });
    const tools = header.createDiv({ cls: "synovia-agent-tools" });
    if (this.busy || this.plugin.isBusy()) {
      this.stopButton = this.button(tools, "square", "停止任务", () => {
        this.cancelled = true;
        this.plugin.cancel();
        this.report("正在停止");
      }, false, true);
    } else {
      this.stopButton = undefined;
    }
    this.button(tools, "settings", "设置", () => this.openSettings());
    container.createDiv({ text: this.plugin.modelStatus(), cls: "synovia-agent-meta" });

    const form = container.createEl("form", { cls: "synovia-agent-composer" });
    const label = form.createEl("label", { text: "你想判断什么？" });
    const input = label.createEl("textarea", { attr: {
      rows: "5", maxlength: "4000", placeholder: "远程工作是否适合我们团队？",
      "aria-label": "你想判断什么？"
    } });
    input.value = this.question;
    input.disabled = this.busy || this.plugin.isBusy();
    input.addEventListener("input", () => { this.question = input.value; });
    const actions = form.createDiv({ cls: "synovia-agent-actions" });
    this.button(actions, "arrow-up", "形成观点", () => this.ask(), true).setCta();
    actions.createSpan({ text: `${this.plugin.localNoteCount()} 篇本地笔记`, cls: "synovia-agent-meta" });
    form.addEventListener("submit", (event) => { event.preventDefault(); void this.ask(); });
    this.status = container.createDiv({ text: this.message || (this.plugin.isBusy() ? this.plugin.activity : ""),
      cls: "synovia-agent-status", attr: { role: "status", "aria-live": "polite" } });

    if (this.result) this.renderResult(container, this.result);
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${this.plugin.settings.wikiRoot}/Opinions/`))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    if (files.length) {
      const saved = container.createEl("details", { cls: "synovia-agent-section" });
      saved.createEl("summary", { text: `已保存的观点 · ${files.length}` });
      for (const file of files) this.link(saved.createDiv({ cls: "synovia-agent-saved" }), file.path);
    }
  }
  private renderResult(parent: HTMLElement, result: OpinionResult): void {
    const article = parent.createEl("article", { cls: "synovia-agent-result" });
    const heading = article.createDiv({ cls: "synovia-agent-result-head" });
    heading.createEl("h3", { text: result.title });
    heading.createSpan({ text: result.stance, cls: "synovia-agent-stance" });
    const markdown = article.createDiv({ cls: "synovia-markdown markdown-rendered" });
    void MarkdownRenderer.render(this.app, result.answer, markdown, "", this.preview!)
      .catch(() => { markdown.setText(result.answer); });
    const evidence = article.createEl("details", { cls: "synovia-agent-section" });
    evidence.open = true;
    evidence.createEl("summary", { text: `依据 · ${result.evidence.length} 条` });
    if (!result.evidence.length) evidence.createEl("p", { text: "没有可精确核对的来源依据。", cls: "synovia-agent-meta" });
    for (const item of result.evidence) {
      const source = result.sources.find((entry) => entry.id === item.source);
      if (!source) continue;
      const row = evidence.createDiv({ cls: "synovia-agent-evidence" });
      this.link(row, source.path, source.title, Boolean(source.url));
      row.createEl("blockquote", { text: item.quote });
    }
    for (const [title, items] of [["分歧与边界", result.tensions], ["待验证", result.questions]] as const) {
      if (!items.length) continue;
      const section = article.createEl("details", { cls: "synovia-agent-section" });
      section.createEl("summary", { text: `${title} · ${items.length}` });
      const list = section.createEl("ul");
      for (const item of items) list.createEl("li", { text: item });
    }
    const actions = article.createDiv({ cls: "synovia-agent-actions" });
    if (this.savedPath) this.link(actions, this.savedPath, "打开已保存的观点");
    else this.button(actions, "save", "保存到 Wiki", () => this.run(async () => {
      this.savedPath = await this.plugin.saveOpinion(result);
      this.report("已保存到 Wiki，原笔记未修改");
    }), true);
  }
}
