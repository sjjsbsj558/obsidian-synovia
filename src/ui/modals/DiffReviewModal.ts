import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { ButtonComponent, Component, MarkdownRenderer, Modal, Notice, Setting } from "obsidian";
import type { App } from "obsidian";
import { renderProposal } from "../../utils/vaultHelper";
import type { PatchProposal } from "../../utils/vaultHelper";

export class DiffReviewModal extends Modal {
  private mergeView?: MergeView;
  private previewComponent?: Component;

  constructor(
    app: App, private readonly before: string, private readonly after: string,
    private readonly proposal?: PatchProposal,
    private readonly apply?: (ids: string[]) => Promise<unknown>
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("synovia-diff-modal");
    this.titleEl.setText(this.proposal ? `审核变更 · ${this.proposal.path}` : "差异预览 · 只读示例");
    const selected = new Set(this.proposal?.chunks.map((chunk) => chunk.id) ?? []);
    const controls = this.contentEl.createDiv();
    if (this.proposal) {
      controls.createEl("p", { text: this.proposal.rationale });
      for (const source of this.proposal.sources) {
        const line = controls.createEl("p", { cls: "synovia-result-meta" });
        if (source.url) line.createEl("a", { text: source.title, href: source.url, attr: { target: "_blank", rel: "noopener noreferrer" } });
        else line.createSpan({ text: source.title });
        line.createSpan({ text: ` · ${source.evidenceCompleteness === "full" ? "完整输入" : "摘要证据"}` });
      }
    }
    const headings = this.contentEl.createDiv({ cls: "synovia-diff-headings" });
    headings.createEl("strong", { text: "原文" });
    headings.createEl("strong", { text: "拟议文本" });
    const parent = this.contentEl.createDiv({ cls: "synovia-diff-editor" });
    const preview = this.contentEl.createEl("details");
    preview.createEl("summary", { text: "渲染对比（公式 / 表格）" });
    const rendered = preview.createDiv({ cls: "synovia-rendered-diff" });
    const extensions = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping];
    const render = () => {
      this.mergeView?.destroy();
      parent.empty();
      const after = this.proposal
        ? selected.size ? renderProposal(this.proposal, [...selected]) : this.before
        : this.after;
      this.previewComponent?.unload();
      this.previewComponent = new Component();
      this.previewComponent.load();
      rendered.empty();
      for (const text of [this.before, after]) {
        const pane = rendered.createDiv({ cls: "markdown-rendered synovia-markdown" });
        void MarkdownRenderer.render(this.app, text, pane, this.proposal?.path ?? "", this.previewComponent)
          .catch(() => pane.setText("渲染失败，请检查源码"));
      }
      this.mergeView = new MergeView({
        parent,
        a: { doc: this.before, extensions },
        b: { doc: after, extensions },
        highlightChanges: true,
        gutter: true
      });
    };
    render();
    if (this.proposal && this.apply) {
      const choices = this.contentEl.createDiv({ cls: "synovia-chunk-choices" });
      const actions = this.contentEl.createDiv({ cls: "synovia-actions" });
      const apply = new ButtonComponent(actions).setButtonText("应用已选修改").setCta();
      const inputs: HTMLInputElement[] = [];
      for (const chunk of this.proposal.chunks) {
        const label = choices.createEl("label", { cls: "synovia-chunk" });
        const input = label.createEl("input", { type: "checkbox" });
        input.checked = true;
        inputs.push(input);
        label.createSpan({ text: chunk.label });
        input.addEventListener("change", () => {
          if (input.checked) selected.add(chunk.id);
          else selected.delete(chunk.id);
          apply.setDisabled(selected.size === 0);
          render();
        });
      }
      apply.onClick(async () => {
        apply.setDisabled(true);
        inputs.forEach((input) => { input.disabled = true; });
        try {
          await this.apply!([...selected]);
          new Notice("已应用修改，可从历史记录撤销");
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "写入失败");
          inputs.forEach((input) => { input.disabled = false; });
          apply.setDisabled(selected.size === 0);
        }
      });
      new ButtonComponent(actions).setButtonText("取消").onClick(() => this.close());
    }
  }

  override onClose(): void {
    this.mergeView?.destroy();
    this.mergeView = undefined;
    this.previewComponent?.unload();
    this.contentEl.empty();
  }
}

export function confirmRemote(app: App, destination: string, sourceCount: number, details = "本次任务所需的笔记内容和证据"): Promise<boolean> {
  return new Promise((resolve) => {
    class Confirmation extends Modal {
      private accepted = false;
      override onOpen(): void {
        this.titleEl.setText("确认发送到模型");
        this.contentEl.createEl("p", { text: `服务：${destination}` });
        if (sourceCount > 0) this.contentEl.createEl("p", { text: `输入来源：${sourceCount} 个` });
        this.contentEl.createEl("p", { text: `本次发送：${details}。` });
        this.contentEl.createEl("p", { text: "原始笔记不会被模型自动覆盖；可随时停止后续请求。" });
        new Setting(this.contentEl).addButton((button) => button.setButtonText("开始处理").setCta()
          .onClick(() => { this.accepted = true; this.close(); }))
          .addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
      }
      override onClose(): void { resolve(this.accepted); }
    }
    new Confirmation(app).open();
  });
}
