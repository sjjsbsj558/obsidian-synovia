import { MarkdownView, Notice, Plugin, parseYaml, requestUrl } from "obsidian";
import { z } from "zod";
import { ModelClient } from "./agent/modelClient";
import { VaultIndex } from "./search/vaultIndex";
import { DEFAULT_SETTINGS, SettingsSchema, isWikiPath } from "./settings/settings";
import type { SynoviaSettings } from "./settings/settings";
import { SynoviaSettingsTab } from "./settings/settingsTab";
import { SourceDocumentSchema } from "./types";
import type { SourceDocument } from "./types";
import { SYNOVIA_VIEW_TYPE, SynoviaSidebarView } from "./ui/SynoviaSidebarView";
import { SafeVaultWriter, hashText } from "./utils/vaultHelper";
import type { PatchProposal } from "./utils/vaultHelper";
import { ZhihuSearchApiClient } from "./sources/zhihuSearchApiClient";
import { searchZhihuMcp } from "./sources/zhihuMcpSseClient";
import { ZhihuCliClient } from "./sources/zhihuCliClient";
import { fetchWebContent } from "./sources/webFetcher";
import { inspectWiki } from "./maintenance/wikiMaintenance";
import type { MaintenanceIssue } from "./maintenance/wikiMaintenance";
import { fromUserInput } from "./sources/contentFetcher";
import { sourceNote } from "./sources/sourceNote";
import { managedSection, topicNote, topicPath, wikiLink } from "./utils/wikiStructure";
import { extractClaims, ExtractedClaimSchema } from "./evolution/claimExtractor";
import { knowledgeNote } from "./evolution/knowledgeNote";
import { evidenceSnapshot, noteStem, selectedBlocks } from "./evolution/knowledgeTools";
import { ComparisonSchema } from "./evolution/comparator";
import { comparisonNote } from "./evolution/comparisonNote";
import { reviewTopicCoverage } from "./evolution/topicReview";
import type { TopicReview } from "./evolution/topicReview";
import { generatedPath, relevantExcerpt, retrieveRelevantNotes } from "./pipeline/retrievalPipeline";
import type { RetrievalResult } from "./pipeline/retrievalPipeline";
import { detectAutoInputKind } from "./pipeline/autoInput";
import { htmlToMarkdown, normalizeMarkdown } from "./sources/markdownFormat";
import { buildKnowledgeGraph, findingLabels, GraphSchema, renderFindings } from "./evolution/knowledgeGraph";
import type { KnowledgeGraph, KnowledgeUnit } from "./evolution/knowledgeGraph";
import { readJournal, writeJournal } from "./utils/journal";

const SavedClaimSchema = ExtractedClaimSchema.extend({
  sourceId: z.string(), evidenceBlocks: z.array(z.object({
    id: z.string(), type: z.string(), text: z.string(), startOffset: z.number(), endOffset: z.number()
  }))
});
export const JobSchema = z.object({
  source: SourceDocumentSchema,
  state: z.enum(["pending", "done", "failed"]),
  comparisonState: z.enum(["pending", "done"]).default("pending"),
  error: z.string().optional(),
  topics: z.array(z.string()).default([]),
  resource: z.string().optional(), snapshot: z.string().optional(), comparison: z.string().optional(),
  claims: z.array(SavedClaimSchema).optional(),
  partialClaims: z.array(SavedClaimSchema).default([]),
  extractionNext: z.number().int().nonnegative().default(0),
  extractionKey: z.string().optional(),
  comparisons: z.array(ComparisonSchema).optional(),
  paths: z.array(z.string()).default([]),
  next: z.number().int().nonnegative().default(0)
});
export type IngestionJob = z.infer<typeof JobSchema>;
type Progress = (message: string) => void;
export interface SmartProcessResult {
  kind: "note" | "web" | "text" | "zhihu" | "topic";
  topic?: string;
  path?: string;
  message?: string;
  jobs: IngestionJob[];
}

const OpinionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  stance: z.enum(["支持", "反对", "取决于条件", "证据不足"]),
  answer: z.string().trim().min(1).max(12000),
  evidence: z.array(z.object({
    source: z.number().int().nonnegative(),
    quote: z.string().trim().min(1).max(800)
  })).max(16),
  tensions: z.array(z.string().trim().min(1).max(800)).max(8),
  questions: z.array(z.string().trim().min(1).max(800)).max(8)
});
export type OpinionSource = {
  id: number;
  path: string;
  title: string;
  content: string;
  url?: string;
  sourceType?: SourceDocument["sourceType"];
};
export type OpinionResult = z.infer<typeof OpinionSchema> & { sources: OpinionSource[] };

const OPINION_SYSTEM = [
  "你是 Synovia，一个面向个人知识库的观点型 Agent。",
  "你的任务不是整理格式、抽取原子知识或罗列摘要，而是针对用户问题形成有立场、有条件、有证据边界的判断。",
  "把所有 supplied sources 当作同一组平等的知识材料整体阅读；本地笔记、知乎内容和其他来源没有默认的可信度等级，也不能因为来源类型不同而先验选边。",
  "先从全部来源中提取彼此支持、补充或冲突的主张，再让这些主张统一碰撞、比较，最后回答问题；不要把某一类来源当作结论、另一类来源当作补充。",
  "第一句必须给出直接判断。区分来源明确说了什么、你基于多条来源碰撞后推导出的判断，以及目前无法确认的部分。",
  "如果来源之间冲突，必须保留互相冲突的立场，解释冲突来自定义、范围、目标、时间或前提条件，并说明在什么条件下哪一方更有解释力，而不是强行选边。",
  "不要把来源数量、重复出现、模型自信或常识当作事实证明。证据不足时明确说证据不足。",
  "只使用 supplied sources 和用户问题，不编造事实、数字、链接、作者观点或引用。",
  "evidence.quote 必须是对应 source.content 中连续出现的原文短句；每条引用只保留支撑判断所需的最短片段。",
  "返回一个 JSON 对象：{\"title\":\"短标题\",\"stance\":\"支持|反对|取决于条件|证据不足\",\"answer\":\"面向用户的 Markdown 判断与论证\",\"evidence\":[{\"source\":1,\"quote\":\"原文连续短句\"}],\"tensions\":[\"分歧或边界\"],\"questions\":[\"值得继续验证的问题\"]}。",
  "answer 要具体、克制，优先给出可执行的判断标准；没有依据的建议不要写成事实。"
].join("\n");

export default class SynoviaPlugin extends Plugin {
  override settings: SynoviaSettings = { ...DEFAULT_SETTINGS };
  index!: VaultIndex;
  writer!: SafeVaultWriter;
  readonly jobs = new Map<string, IngestionJob>();
  graph?: KnowledgeGraph;
  activity = "";
  private readonly completed = new Map<string, IngestionJob>();
  private journalReadable = true;
  private readonly zhihu = new ZhihuSearchApiClient(requestUrl);
  private activeTask?: AbortController;
  private status?: HTMLElement;
  private autoTimer?: ReturnType<typeof setTimeout>;
  private autoDirty = false;
  private autoPaused = false;
  readonly localReadErrors = new Map<string, string>();

  override async onload(): Promise<void> {
    const parsed = SettingsSchema.safeParse(await this.loadData() ?? {});
    this.settings = parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
    if (!parsed.success) new Notice("Synovia 配置无效，当前使用默认值；请检查设置。");
    this.index = new VaultIndex(this.app.vault);
    this.writer = new SafeVaultWriter(this.app.vault, () => this.settings.wikiRoot);
    const journal = `${this.manifest.dir}/extraction-jobs.json`;
    if (this.manifest.dir) {
      try {
        for (const job of await readJournal(this.app.vault.adapter, journal, z.array(JobSchema)) ?? []) {
          if (!job.resource) job.state = "pending";
          this.jobs.set(job.source.id, job);
        }
      } catch { this.journalReadable = false; new Notice("任务记录无法读取，已禁止覆盖；请检查 extraction-jobs.json"); }
    }
    {
      try {
        for (const job of await readJournal(this.app.vault.adapter, ".synovia/ingested-sources.json", z.array(JobSchema)) ?? []) {
          this.completed.set(job.source.id, job);
        }
      } catch { this.journalReadable = false; new Notice("原文归档无法读取，已禁止覆盖；请检查 .synovia/ingested-sources.json"); }
    }
    try {
      this.graph = await readJournal(this.app.vault.adapter, ".synovia/knowledge-graph.json", GraphSchema);
      if (this.graph?.error && /\bexpected\b|\binvalid_type\b|received undefined|Invalid input/iu.test(this.graph.error)) {
        this.graph.error = "模型返回格式不符合预期；已完成批次保留，可以重试";
      }
    }
    catch { this.journalReadable = false; new Notice("观点网络记录无法读取，已禁止覆盖；请检查 .synovia/knowledge-graph.json"); }
    this.registerView(SYNOVIA_VIEW_TYPE, (leaf) => new SynoviaSidebarView(leaf, this));
    this.addSettingTab(new SynoviaSettingsTab(this.app, this));
    this.addRibbonIcon("network", "打开 Synovia", () => { void this.activateView(); });
    this.addCommand({ id: "open-workbench", name: "打开工作台", callback: () => this.activateView() });
    this.addCommand({ id: "collect-selection", name: "用选区形成观点", editorCallback: async (editor, view) => {
      try {
        const text = selectedBlocks(editor.getValue(), editor.posToOffset(editor.getCursor("from")), editor.posToOffset(editor.getCursor("to")));
        await this.activateView();
        const sidebar = this.app.workspace.getLeavesOfType(SYNOVIA_VIEW_TYPE)[0]?.view;
        if (sidebar instanceof SynoviaSidebarView) await sidebar.collect(fromUserInput(text, `${view.file?.basename ?? "笔记"}选区`, view.file?.path, true));
      } catch (error) { new Notice(String(error)); }
    } });
    this.addCommand({ id: "reset-local-index", name: "清除检索缓存", callback: () => this.index.invalidate() });
    this.status = this.addStatusBarItem();
    this.status.setText(`Synovia ${this.manifest.version}`);
    this.registerEvent(this.app.vault.on("create", (file) => { this.index.changed(file); }));
    this.registerEvent(this.app.vault.on("modify", (file) => { this.index.changed(file); }));
    this.registerEvent(this.app.vault.on("delete", (file) => { this.index.changed(file, true); }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.index.changed(file, false, oldPath);
    }));
  }

  override onunload(): void { this.cancel(); this.index.dispose(); }
  cancel(): void {
    this.autoPaused = true;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.activeTask?.abort();
  }
  isBusy(): boolean { return Boolean(this.activeTask); }
  private report(message: string, progress: Progress): void {
    this.activity = message;
    this.status?.setText(`Synovia · ${message}`);
    progress(message);
    this.refreshViews();
  }
  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SYNOVIA_VIEW_TYPE)) {
      if (leaf.view instanceof SynoviaSidebarView) leaf.view.refreshStatus();
    }
  }
  private queueOptimization(path?: string): void {
    if (path && (!path.endsWith(".md") || generatedPath(path, this.settings.wikiRoot))) return;
    if (path && this.graph) {
      this.graph.state = "pending";
      this.graph.error = "原笔记已变化，观点网络待重新核对";
      this.refreshViews();
    }
  }
  invalidateIndex(): void { this.index.invalidate(); }
  private secret(name: string): string { return name ? this.app.secretStorage.getSecret(name) ?? "" : ""; }
  private model(): ModelClient | undefined {
    return this.settings.allowRemote && this.settings.modelBaseUrl && this.settings.modelName && this.secret(this.settings.modelSecretName)
      ? new ModelClient(requestUrl, this.settings, this.secret(this.settings.modelSecretName)) : undefined;
  }
  modelStatus(): string {
    return this.model()
      ? `模型：${this.settings.modelName}`
      : "模型未就绪，资料仍可保存；需要整理时请到 Synovia 设置检查远程调用、模型名称和密钥";
  }
  async askOpinion(question: string, progress: Progress): Promise<OpinionResult> {
    const value = question.trim();
    if (!value || value.length > 4000) throw new Error("问题需为 1–4000 字");
    return this.operation(async (signal) => {
      const model = this.model();
      if (!model) throw new Error(this.modelStatus());
      const index = await this.index.get();
      const documents = index.all().filter((document) =>
        document.content.trim() && !generatedPath(document.path, this.settings.wikiRoot));
      const scores = new Map(index.search(value, { topK: 64, minScore: 0 }).map((hit) => [hit.path, hit.score]));
      const ordered = documents.sort((a, b) => (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0));
      let remoteOpinionSources: OpinionSource[] = [];
      let remoteError: unknown;
      if (this.settings.allowRemote) {
        progress("正在联动知乎观点，并为本地资料预留输入预算");
        try {
          const remoteSources = await this.searchZhihu(value, signal);
          remoteOpinionSources = remoteSources.reduce<OpinionSource[]>((accepted, source, index) => {
            const content = source.fullContent?.trim() || source.contentSnippet;
            if (!content.trim()) return accepted;
            accepted.push({
              id: documents.length + index + 1,
              path: source.localPath ?? (source.url || source.title),
              title: source.title,
              content: content.slice(0, 2400),
              url: source.url || undefined,
              sourceType: source.sourceType
            });
            return accepted;
          }, []);
        } catch (error) {
          signal.throwIfAborted();
          remoteError = error;
        }
      }
      const localCandidates = ordered.map((document, number) => {
        const full = { id: number + 1, path: document.path, title: document.title, content: document.content };
        return {
          full,
          excerpt: { ...full, content: relevantExcerpt(document, [value], 2400) || document.content.slice(0, 2400) }
        };
      });
      const remoteCandidates = remoteOpinionSources.map((source) => ({ full: source, excerpt: source }));
      const candidates: { full: OpinionSource; excerpt: OpinionSource }[] = [];
      for (let index = 0; index < Math.max(localCandidates.length, remoteCandidates.length); index++) {
        const local = localCandidates[index];
        const remote = remoteCandidates[index];
        if (local) candidates.push(local);
        if (remote) candidates.push(remote);
      }
      const sources: OpinionSource[] = [];
      for (const candidate of candidates) {
        signal.throwIfAborted();
        if (model.fits(OPINION_SYSTEM, { question: value, sources: [...sources, candidate.full] })) sources.push(candidate.full);
        else if (candidate.excerpt !== candidate.full
          && model.fits(OPINION_SYSTEM, { question: value, sources: [...sources, candidate.excerpt] })) sources.push(candidate.excerpt);
      }
      if (this.settings.allowRemote) {
        if (remoteError) {
          if (!sources.length) throw new Error(`知乎自动补充失败：${remoteError instanceof Error ? remoteError.message : String(remoteError)}`);
          progress(`知乎联动失败，继续使用本地资料：${remoteError instanceof Error ? remoteError.message : String(remoteError)}`);
        } else {
          progress(remoteOpinionSources.length
            ? `已联动 ${sources.filter((source) => source.url).length}/${remoteOpinionSources.length} 条知乎来源与本地资料，交给 Agent 综合`
            : "知乎没有返回可处理来源，交给 Agent 综合现有本地资料");
        }
      } else {
        progress(`已准备 ${sources.length}/${documents.length} 篇本地笔记；远程调用未授权，未联动知乎`);
      }
      const result = await model.json(OPINION_SYSTEM, { question: value, sources }, OpinionSchema, signal);
      const evidence = result.evidence.map((item) => {
        const source = sources.find((entry) => entry.id === item.source);
        if (!source) throw new Error("模型引用了不存在的来源，未生成观点");
        const quote = model.evidenceQuote(item.quote, source.content)
          ?? (source.content.includes(item.quote) ? item.quote : undefined);
        if (!quote) throw new Error(`模型引用无法在《${source.title}》中核对，未生成观点`);
        return { ...item, quote };
      });
      return { ...result, evidence, sources };
    });
  }
  async saveOpinion(result: OpinionResult): Promise<string> {
    const path = this.availablePath("Opinions", result.title);
    const byId = new Map(result.sources.map((source) => [source.id, source]));
    const body = [
      "---", "type: opinion", "tags: [synovia/opinion]", `title: ${JSON.stringify(result.title)}`, "---", "",
      `# ${result.title}`, "", `> **判断：${result.stance}**`, "",
      result.answer, "",
      ...(result.evidence.length ? ["## 依据", "", ...result.evidence.flatMap((item) => {
        const source = byId.get(item.source);
        return source ? [`- ${source.url ? `[${source.title}](${source.url})` : wikiLink(source.path, source.title)}`, `  > ${item.quote}`, ""] : [];
      })] : ["## 依据", "", "Agent 未找到可精确核对的来源依据。", ""]),
      ...(result.tensions.length ? ["## 分歧与边界", "", ...result.tensions.map((item) => `- ${item}`), ""] : []),
      ...(result.questions.length ? ["## 待验证", "", ...result.questions.map((item) => `- ${item}`), ""] : []),
      `> 生成时间：${new Date().toLocaleString()}`, ""
    ].join("\n");
    await this.writeWiki(path, body, null);
    return path;
  }
  automationStatus(): string {
    return !this.settings.autoOptimize ? "自动整理未授权"
      : !this.settings.allowRemote ? "自动整理未生效：未允许远程调用"
      : !this.model() ? "自动整理等待模型配置"
      : this.autoPaused ? "自动整理已暂停" : this.isBusy() ? "正在整理" : "自动整理已授权";
  }
  async updateSettings(input: SynoviaSettings): Promise<void> {
    if (this.activeTask) throw new Error("请先停止当前任务，再修改设置");
    const settings = SettingsSchema.parse(input);
    await this.saveData(settings);
    this.settings = settings;
    this.index.invalidate();
    this.autoPaused = false;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.queueOptimization();
    this.refreshViews();
  }
  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SYNOVIA_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: SYNOVIA_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
  private async operation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.activeTask) throw new Error("已有任务正在运行，请等待或取消");
    const controller = new AbortController();
    this.activeTask = controller;
    try { return await work(controller.signal); }
    finally {
      this.activeTask = undefined;
      this.status?.setText(`Synovia ${this.manifest.version}`);
      this.refreshViews();
      if (this.autoDirty) this.queueOptimization();
    }
  }
  async searchNotes(query: string, progress: Progress, deep = false): Promise<RetrievalResult> {
    return this.operation(async (signal) => retrieveRelevantNotes({
      query, index: await this.index.get(), model: this.model(), settings: this.settings,
      excludeGenerated: true, signal, progress, deep
    }));
  }
  async writeWiki(path: string, content: string, before: string | null): Promise<void> {
    if (content === before) return;
    const id = crypto.randomUUID();
    await this.writer.apply({
      id, path, action: before === null ? "CREATE" : "LINK", rationale: "更新知识库结构，保留原始材料及手写内容",
      before, baseFileHash: before === null ? null : await hashText(before),
      chunks: [{ id, label: "更新知识与关联", edits: [{ startOffset: 0, endOffset: before?.length ?? 0, replacement: content }] }],
      sources: []
    }, [id]);
  }
  private availablePath(folder: string, title: string): string {
    const stem = noteStem(title);
    const reserved = new Set([...this.jobs.values(), ...this.completed.values()].flatMap((job) => [job.resource, job.snapshot, job.comparison, ...job.paths]));
    let path = `${this.settings.wikiRoot}/${folder}/${stem}.md`;
    for (let suffix = 2; this.app.vault.getAbstractFileByPath(path) || reserved.has(path); suffix++) path = `${this.settings.wikiRoot}/${folder}/${stem} ${suffix}.md`;
    return path;
  }
  private async saveJobs(jobs = [...this.jobs.values()]): Promise<void> {
    if (!this.journalReadable) throw new Error("任务记录需要恢复，已停止写入，原文件未覆盖");
    if (!this.manifest.dir) throw new Error("插件目录不可用，无法保存任务进度");
    await writeJournal(this.app.vault.adapter, `${this.manifest.dir}/extraction-jobs.json`, jobs);
  }
  async clearCompletedJobs(): Promise<number> {
    if (this.activeTask) throw new Error("请等待当前任务完成");
    const remaining = [...this.jobs.values()].filter((job) => job.state !== "done");
    const count = this.jobs.size - remaining.length;
    if (!this.journalReadable) throw new Error("任务记录需要恢复，不能清理");
    const archive = new Map(this.completed);
    for (const job of this.jobs.values()) if (job.state === "done") archive.set(job.source.id, job);
    if (!await this.app.vault.adapter.exists(".synovia")) await this.app.vault.createFolder(".synovia");
    await writeJournal(this.app.vault.adapter, ".synovia/ingested-sources.json", [...archive.values()]);
    await this.saveJobs(remaining);
    for (const [id, job] of this.jobs) if (job.state === "done") {
      this.completed.set(id, job);
      this.jobs.delete(id);
    }
    return count;
  }
  async rebuildWiki(): Promise<void> {
    const root = this.settings.wikiRoot;
    const files = this.app.vault.getMarkdownFiles().filter((file) => isWikiPath(file.path, root));
    const groups = [
      ["Topics", "主题"], ["Resources", "原始材料"], ["Knowledge", "原子知识"],
      ["Comparisons", "知识对比"], ["Evidence", "证据快照"]
    ];
    const topics = files.filter((file) => file.path.startsWith(`${root}/Topics/`));
    const bodies = new Map(await Promise.all(files.map(async (file) => [file.path, await this.app.vault.read(file)] as const)));
    for (const topic of topics) {
      const before = bodies.get(topic.path)!;
      const sections = groups.slice(1).flatMap(([folder, label]) => [
        `## ${label}`, "",
        ...files.filter((file) => file.path.startsWith(`${root}/${folder}/`)
          && bodies.get(file.path)!.includes(wikiLink(topic.path))).map((file) => `- ${wikiLink(file.path, file.basename)}`), ""
      ]).join("\n");
      await this.writeWiki(topic.path, managedSection(before, "sources", sections), before);
    }
    const path = `${root}/知识库首页.md`;
    const before = bodies.get(path) ?? null;
    const body = [`${wikiLink(`${root}/观点网络.md`, "观点网络：共识、分歧与待验证问题")}`, "",
      ...groups.flatMap(([folder, label]) => [
      `## ${label}`, "", ...files.filter((file) => file.path.startsWith(`${root}/${folder}/`))
        .map((file) => `- ${wikiLink(file.path, file.basename)}`), ""
    ])].join("\n");
    await this.writeWiki(path, managedSection(before ?? "---\ntype: index\ntags: [synovia/index]\n---\n\n# 知识库首页\n", "catalog", body), before);
  }
  localNoteCount(): number {
    return this.app.vault.getMarkdownFiles().filter((file) => !generatedPath(file.path, this.settings.wikiRoot)).length;
  }
  private async localSources(signal: AbortSignal): Promise<SourceDocument[]> {
    const sources: SourceDocument[] = [];
    this.localReadErrors.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      signal.throwIfAborted();
      if (generatedPath(file.path, this.settings.wikiRoot)) continue;
      try {
        const text = await this.app.vault.read(file);
        if (text.length > 100000) throw new Error("超过 100,000 字符，请分篇后重试；未截断原文");
        if (text.trim()) sources.push(fromUserInput(text, file.basename, file.path));
      } catch (error) {
        signal.throwIfAborted();
        this.localReadErrors.set(file.path, error instanceof Error ? error.message : String(error));
      }
    }
    return sources;
  }
  async optimizeVault(progress: Progress): Promise<IngestionJob[]> {
    this.autoPaused = false;
    return this.operation(async (signal) => {
      const report = (message: string) => this.report(message, progress);
      report("读取全库原笔记，核对已处理版本");
      const sources = await this.localSources(signal);
      const pending = [...this.jobs.values()].filter((job) => job.state !== "done" && !job.source.localPath);
      const jobs = await this.processSources([...sources, ...pending.map((job) => job.source)], report, signal);
      signal.throwIfAborted();
      await this.synthesizeKnowledge(report, signal);
      await this.rebuildWiki();
      const failed = jobs.filter((job) => job.state !== "done").length + this.localReadErrors.size;
      report(`已核对 ${sources.length} 篇原笔记 · ${failed} 项待处理 · ${this.graph?.state === "done" ? "观点网络已更新" : "观点网络待继续"}`);
      if (failed || this.graph?.state !== "done") this.autoPaused = true;
      return jobs;
    });
  }
  private async currentJobs(): Promise<IngestionJob[]> {
    const jobs = [...new Map([...this.completed, ...this.jobs]).values()];
    const latest = new Map<string, IngestionJob>();
    const contents = new Map<string, string | undefined>();
    for (const job of jobs) {
      const source = job.source;
      if (source.localPath) {
        if (!contents.has(source.localPath)) {
          const file = this.app.vault.getFileByPath(source.localPath);
          contents.set(source.localPath, file ? await this.app.vault.read(file) : undefined);
        }
        const current = contents.get(source.localPath);
        const original = source.fullContent ?? source.contentSnippet;
        if (current === undefined || (source.localSelection ? !current.includes(original) : current !== original)) continue;
      }
      latest.set(source.localSelection ? source.id : source.localPath ?? (source.url || source.id), job);
    }
    return [...latest.values()];
  }
  private async knowledgeUnits(jobs?: IngestionJob[]): Promise<KnowledgeUnit[]> {
    const units: KnowledgeUnit[] = [];
    for (const job of jobs ?? await this.currentJobs()) for (const [index, claim] of (job.claims ?? []).entries()) {
      const path = job.paths[index];
      const file = path && this.app.vault.getFileByPath(path);
      if (!file || !job.snapshot || !this.app.vault.getFileByPath(job.snapshot)) continue;
      const text = await this.app.vault.read(file);
      let meta: { status?: string } | undefined;
      try { meta = parseYaml(/^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? ""); }
      catch { continue; }
      if (meta?.status === "ignored") continue;
      if (units.some((unit) => unit.sourceId === (job.source.localPath ?? (job.source.url || job.source.id))
        && unit.statement === claim.statement && unit.quote === claim.quote)) continue;
      units.push({
        id: `${job.source.id}:${index}`, sourceId: job.source.localPath ?? (job.source.url || job.source.id),
        title: job.source.title, path: file.path, snapshot: job.snapshot,
        origin: job.source.localPath ?? job.source.url, completeness: job.source.evidenceCompleteness,
        statement: claim.statement, conditions: claim.preconditions, quote: claim.quote
      });
    }
    return units.sort((a, b) => a.id.localeCompare(b.id));
  }
  citationTarget(id: string): { path: string; title: string; snapshot?: string } | undefined {
    for (const job of [...this.jobs.values(), ...this.completed.values()]) {
      const index = (job.claims ?? []).findIndex((_, index) => `${job.source.id}:${index}` === id);
      const path = job.paths[index];
      if (path) return { path, title: job.source.title, snapshot: job.snapshot };
    }
    return undefined;
  }
  private async synthesizeKnowledge(progress: Progress, signal: AbortSignal): Promise<void> {
    const model = this.model();
    const root = this.settings.wikiRoot;
    const graphPath = `${root}/观点网络.md`;
    if (!model) {
      progress(this.modelStatus());
      if (!this.app.vault.getFileByPath(graphPath)) await this.writeWiki(graphPath,
        "---\ntype: synthesis\nstatus: needs-review\n---\n\n# 观点网络\n\n模型未就绪；材料已保存，跨来源综合尚未运行。\n", null);
      return;
    }
    const jobs = await this.currentJobs();
    let units = await this.knowledgeUnits(jobs);
    const pendingSources = jobs.filter((job) => job.state !== "done").map((job) => job.source.title);
    for (const source of await this.localSources(signal)) {
      if (!jobs.some((job) => !job.source.localSelection && job.source.localPath === source.localPath)) pendingSources.push(source.title);
    }
    pendingSources.push(...[...this.localReadErrors].map(([path, error]) => `${path}：${error}`));
    const persist = async (graph: KnowledgeGraph) => {
      graph.pendingSources = pendingSources;
      if (!this.journalReadable) throw new Error("任务记录需要恢复，已停止写入");
      if (!await this.app.vault.adapter.exists(".synovia")) await this.app.vault.createFolder(".synovia");
      await writeJournal(this.app.vault.adapter, ".synovia/knowledge-graph.json", graph);
      this.graph = graph;
    };
    const graph = await buildKnowledgeGraph(model, units, this.graph, persist, signal, progress);
    const currentUnits = await this.knowledgeUnits();
    if (JSON.stringify(currentUnits) !== JSON.stringify(units)) {
      graph.state = "pending";
      graph.error = "推理期间原文或知识审核状态已改变；过期结论未发布，请继续整理";
      graph.findings = [];
      graph.completed = [];
      units = currentUnits;
    }
    graph.pendingSources = pendingSources;
    if (pendingSources.length && graph.state === "done") {
      graph.state = "pending";
      graph.error ??= "仍有来源未完成原子化，观点网络待继续";
    }
    await persist(graph);
    signal.throwIfAborted();
    const graphFile = this.app.vault.getFileByPath(graphPath);
    const before = graphFile ? await this.app.vault.read(graphFile) : null;
    const status = graph.state === "done" ? `已综合现有观点${pendingSources.length ? `；${pendingSources.length} 个来源尚未完成原子化` : ""}`
      : `部分完成：${graph.error ?? "待继续"}`;
    await this.writeWiki(graphPath, managedSection(before
      ?? "---\ntype: synthesis\nstatus: needs-review\ntags: [synovia/synthesis]\n---\n\n# 观点网络\n\n## 我的判断\n\n",
    "synthesis", [
      `> [!info] ${status}`, `> ${units.length} 个原子观点 · ${new Set(units.map((unit) => unit.sourceId)).size} 个来源 · ${graph.completed.length}/${graph.total} 批`,
      "> 共识仅指所列来源之间的一致意见，不等于事实核实或全社区共识。摘要证据和模型推论均需审核。", "",
      ...(pendingSources.length ? [`原子化待完成：${pendingSources.join("、")}`, ""] : []),
      renderFindings(graph.findings, units)
    ].join("\n")), before);
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const activePaths = new Set(units.map((unit) => unit.path));
    for (const path of new Set([...this.jobs.values(), ...this.completed.values()].flatMap((job) => job.paths))) {
      if (activePaths.has(path)) continue;
      signal.throwIfAborted();
      const file = this.app.vault.getFileByPath(path);
      if (!file) continue;
      const content = await this.app.vault.read(file);
      await this.writeWiki(path, managedSection(content, "semantic",
        "## 语义关联\n\n> [!warning] 未纳入当前观点网络\n> 原文版本已改变、证据缺失或观点被忽略。此历史记录保留，但旧关系不再生效。"), content);
    }
    for (const unit of units) {
      signal.throwIfAborted();
      const links = graph.findings.filter((finding) => finding.citations.some((citation) => citation.id === unit.id))
        .flatMap((finding) => finding.citations.filter((citation) => citation.id !== unit.id).flatMap((citation) => {
          const other = byId.get(citation.id);
          return other ? [`- **${findingLabels[finding.kind]}** · ${wikiLink(other.path, other.statement.slice(0, 80))}：${finding.reasoning}`] : [];
        }));
      const file = this.app.vault.getFileByPath(unit.path)!;
      const content = await this.app.vault.read(file);
      await this.writeWiki(unit.path, managedSection(content, "semantic", [
        "## 语义关联", "", `${wikiLink(graphPath, "全库观点网络")} · ${status}`, "",
        ...new Set(links), ...(links.length ? [] : ["本轮尚未形成有证据支撑的跨来源关系。"])
      ].join("\n")), content);
    }
    for (const topic of this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${root}/Topics/`))) {
      const ids = new Set([...this.jobs.values(), ...this.completed.values()].filter((job) => job.topics.includes(topic.path))
        .flatMap((job) => (job.claims ?? []).map((_, index) => `${job.source.id}:${index}`)));
      const findings = graph.findings.filter((finding) => finding.citations.some((citation) => ids.has(citation.id)));
      const content = await this.app.vault.read(topic);
      await this.writeWiki(topic.path, managedSection(content, "synthesis",
        `${wikiLink(graphPath, "全库观点网络")} · ${status}\n\n${renderFindings(findings, units)}`), content);
    }
    if (graph.error) progress(`综合待继续：${graph.error}`);
  }
  private async completeTopic(
    name: string, progress: Progress, signal: AbortSignal, seedSources: SourceDocument[] = []
  ): Promise<{ path: string; jobs: IngestionJob[]; message?: string }> {
    const topic = name.trim();
    const path = topicPath(this.settings.wikiRoot, topic ? noteStem(topic) : "");
    if (!this.app.vault.getAbstractFileByPath(path)) {
      await this.writeWiki(path, topicNote(topic, this.settings.wikiRoot), null);
    }
    const file = this.app.vault.getFileByPath(path)!;
    try {
      await this.processSources(await this.localSources(signal), progress, signal);
      signal.throwIfAborted();
      const retrieval = await retrieveRelevantNotes({
        query: topic, index: await this.index.get(), model: this.model(), settings: this.settings,
        excludeGenerated: true, progress, signal, deep: true, returnAll: true
      });
      const localDocuments = [];
      const localSources: SourceDocument[] = [];
      for (const match of retrieval.matches) {
        const localFile = this.app.vault.getFileByPath(match.path);
        if (!localFile) continue;
        const content = await this.app.vault.read(localFile);
        localDocuments.push({ path: localFile.path, title: localFile.basename, content });
        localSources.push(fromUserInput(content, localFile.basename, localFile.path));
      }
      for (const source of seedSources.filter((item) => item.localPath)) {
        if (localDocuments.some((document) => document.path === source.localPath)) continue;
        localDocuments.push({
          path: source.localPath!,
          title: source.title,
          content: source.fullContent ?? source.contentSnippet
        });
      }
      const sources = [...seedSources, ...localSources];
      let retrievalMessage = retrieval.message;
      let topicReview: TopicReview | undefined;
      if (this.model() && localDocuments.length) {
        try {
          topicReview = await reviewTopicCoverage(this.model()!, topic, localDocuments, signal, progress);
        } catch (error) {
          signal.throwIfAborted();
          retrievalMessage = `${retrievalMessage ? `${retrievalMessage}\n` : ""}主题覆盖核查未完成：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (!sources.length && this.settings.allowRemote) {
        progress("本地没有直接命中，自动补充知乎来源");
        try {
          const remoteSources = await this.searchZhihu(topic, signal);
          sources.push(...remoteSources);
          if (remoteSources.length) {
            retrievalMessage = `${retrievalMessage ? `${retrievalMessage}\n` : ""}本地未命中，已自动补充 ${remoteSources.length} 条知乎来源。`;
          } else {
            retrievalMessage = `${retrievalMessage ? `${retrievalMessage}\n` : ""}本地与知乎都没有返回可处理来源。`;
          }
        } catch (error) {
          signal.throwIfAborted();
          retrievalMessage = `${retrievalMessage ? `${retrievalMessage}\n` : ""}知乎自动补充失败：${error instanceof Error ? error.message : String(error)}`;
        }
      } else if (!sources.length) {
        retrievalMessage = `${retrievalMessage ? `${retrievalMessage}\n` : ""}本地未命中；远程调用未授权，未检索知乎。可在 Synovia 设置中开启“允许远程调用”后重试。`;
      }
      if (topicReview?.gaps.length && this.settings.allowRemote) {
        progress("根据覆盖缺口自动补充知乎来源");
        try {
          const supplementQuery = [topic, ...topicReview.gaps.slice(0, 2).map((gap) => gap.suggestedQuery)]
            .join("；").slice(0, 100);
          const remoteSources = await this.searchZhihu(supplementQuery, signal);
          const known = new Set(sources.map((source) => source.id));
          const additions = remoteSources.filter((source) => !known.has(source.id));
          sources.push(...additions);
          retrievalMessage = `${retrievalMessage ? `${retrievalMessage}\n` : ""}根据主题覆盖核查自动补充 ${additions.length} 条知乎来源。`;
        } catch (error) {
          signal.throwIfAborted();
          retrievalMessage = `${retrievalMessage ? `${retrievalMessage}\n` : ""}主题缺口补充失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const before = await this.app.vault.read(file);
      const updatedLinks = retrieval.matches.map((match) => `- ${wikiLink(match.path, match.title)}：${match.reason}`);
      const oldLinks = (/<!-- synovia:related:start -->([\s\S]*?)<!-- synovia:related:end -->/u.exec(before)?.[1] ?? "")
        .split("\n").filter((line) => line.startsWith("- [[") && !retrieval.matches.some((match) => line.startsWith(`- [[${match.path.replace(/\.md$/iu, "")}|`)));
      const body = ["## 关联笔记", "", ...oldLinks, ...updatedLinks,
        "", retrievalMessage ?? (retrieval.mode === "llm" ? "已完成模型语义关联。" : "关键词候选关联；模型未完成语义判断。")
      ].join("\n");
      await this.writeWiki(path, managedSection(before, "related", body), before);
      if (topicReview) {
        const coverage = [
          "## 覆盖核查",
          "",
          `状态：${({ covered: "已覆盖", gaps: "发现可能遗漏", uncertain: "无法确定" } as Record<TopicReview["status"], string>)[topicReview.status]}`,
          "",
          ...(topicReview.gaps.length ? [
            "### 可能遗漏",
            "",
            ...topicReview.gaps.flatMap((gap) => [
              `- **${gap.topic}**：${gap.reason}；补充查询：\`${gap.suggestedQuery}\``,
              ...(gap.evidence.length ? gap.evidence.map((quote) => `  - 依据：${quote}`) : [])
            ]),
            ""
          ] : ["暂未发现明确遗漏。", ""]),
          ...(topicReview.opinion ? [
            "> [!hint] 模型观点（低权重）",
            `> 权重：${topicReview.opinion.weight.toFixed(2)}；仅用于发现方向，不进入事实层。`,
            ...topicReview.opinion.text.split(/\r?\n/u).map((line) => `> ${line}`),
            ...(topicReview.opinion.basis.length ? topicReview.opinion.basis.map((quote) => `> 依据：${quote}`) : []),
            ""
          ] : [])
        ].join("\n");
        const current = await this.app.vault.read(file);
        await this.writeWiki(path, managedSection(current, "coverage", coverage), current);
      }
      const jobs = await this.processSources(sources, progress, signal, path);
      await this.synthesizeKnowledge(progress, signal);
      const summary = `关联 ${sources.length} 篇笔记；完成 ${jobs.filter((job) => job.state === "done").length}，待处理 ${jobs.filter((job) => job.state !== "done").length}${retrievalMessage ? `；${retrievalMessage}` : ""}`;
      const current = await this.app.vault.read(file);
      await this.writeWiki(path, managedSection(current, "processing", `## 处理状态\n\n${summary}`), current);
      progress(`主题已保存；${summary}`);
      return { path, jobs, message: retrievalMessage };
    } catch (error) {
      const before = await this.app.vault.read(file);
      await this.writeWiki(path, managedSection(before, "processing", `## 处理状态\n\n${error instanceof Error ? error.message : String(error)}\n\n主题已保留，可继续自动处理。`), before);
      throw error;
    }
  }
  async createTopic(name: string, progress: Progress, _deep = false): Promise<{ path: string; jobs: IngestionJob[]; message?: string }> {
    return this.operation(async (signal) => {
      const result = await this.completeTopic(name, progress, signal);
      await this.rebuildWiki();
      return result;
    });
  }
  async smartProcess(input: string, progress: Progress, topicName = ""): Promise<SmartProcessResult> {
    const value = input.trim();
    const destination = topicName.trim();
    if (!value) {
      const source = await this.activeNote();
      const jobs = await this.ingestSources([source], progress, destination);
      return { kind: "note", topic: destination || undefined, jobs };
    }
    const kind = detectAutoInputKind(value);
    if (kind === "query" && !destination) {
      const result = await this.createTopic(value, progress);
      return { kind: "topic", ...result };
    }
    return this.operation(async (signal) => {
      const url = kind === "web" ? new URL(value) : undefined;
      const question = url?.hostname === "www.zhihu.com" && /^\/question\/\d+\/?$/u.test(url.pathname);
      const sources = question ? await this.questionAnswers(value, signal) : kind === "web"
        ? [await this.fetchWeb(value, signal)]
        : kind === "text"
          ? [fromUserInput(value, value.split("\n")[0]!.replace(/^#+\s*/u, "").slice(0, 100))]
          : await this.searchZhihu(value, signal);
      signal.throwIfAborted();
      if (!sources.length) throw new Error("没有找到可处理的来源");
      const result = destination
        ? await this.completeTopic(destination, progress, signal, sources)
        : { jobs: await this.processSources([...await this.localSources(signal), ...sources], progress, signal) };
      if (!destination) await this.synthesizeKnowledge(progress, signal);
      await this.rebuildWiki();
      return { kind: kind === "query" || question ? "zhihu" : kind, topic: destination || undefined, ...result };
    });
  }
  async ingestSources(sources: SourceDocument[], progress: Progress, topicName = ""): Promise<IngestionJob[]> {
    return this.operation(async (signal) => {
      const topic = topicName.trim();
      if (topic) {
        const result = await this.completeTopic(topic, progress, signal, sources);
        await this.rebuildWiki();
        return result.jobs;
      }
      const result = await this.processSources([...await this.localSources(signal), ...sources], progress, signal);
      await this.synthesizeKnowledge(progress, signal);
      await this.rebuildWiki();
      return result;
    });
  }
  async retryJob(id: string, progress: Progress): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error("任务不存在");
    await this.ingestSources([job.source], progress);
  }
  async retryPendingJobs(progress: Progress): Promise<IngestionJob[]> {
    return this.operation(async (signal) => {
      const jobs = (await this.currentJobs()).filter((job) => job.state !== "done");
      const results = await this.processSources([...await this.localSources(signal), ...jobs.map((job) => job.source)], progress, signal);
      await this.synthesizeKnowledge(progress, signal);
      await this.rebuildWiki();
      return results;
    });
  }
  private async processSources(inputs: SourceDocument[], progress: Progress, signal: AbortSignal, topic?: string): Promise<IngestionJob[]> {
    const model = this.model();
    const results: IngestionJob[] = [];
    for (const input of inputs) {
      signal.throwIfAborted();
      const source = SourceDocumentSchema.parse(input);
      if (source.localPath && generatedPath(source.localPath, this.settings.wikiRoot)) throw new Error("生成笔记不再作为原始材料重复摄取");
      let job = [...this.jobs.values(), ...this.completed.values()].find((item) =>
        (item.source.id === source.id || Boolean(source.url && item.source.url === source.url)
          || Boolean(source.localPath && item.source.localPath === source.localPath))
        && (item.source.fullContent ?? item.source.contentSnippet) === (source.fullContent ?? source.contentSnippet));
      if (!job) {
        if (this.jobs.has(source.id) || this.completed.has(source.id)) source.id = crypto.randomUUID();
        job = JobSchema.parse({ source, state: "pending" });
      }
      this.jobs.set(job.source.id, job);
      if (job.state === "done" && job.paths.some((path) => !this.app.vault.getFileByPath(path))) job.state = "pending";
      if (topic && !job.topics.includes(topic)) job.topics.push(topic);
      if (!results.includes(job)) results.push(job);
    }
    await this.saveJobs();
    if (results.some((job) => job.state !== "done")) {
      this.graph ??= GraphSchema.parse({ key: "", state: "pending", completed: [], total: 0, findings: [] });
      this.graph.state = "pending";
      this.graph.error = "仍有来源未完成原子化，观点网络待继续";
      this.graph.pendingSources = (await this.currentJobs()).filter((job) => job.state !== "done").map((job) => job.source.title);
      if (!await this.app.vault.adapter.exists(".synovia")) await this.app.vault.createFolder(".synovia");
      await writeJournal(this.app.vault.adapter, ".synovia/knowledge-graph.json", this.graph);
    }
    for (const job of results) {
      if (signal.aborted) break;
      const source = job.source;
      try {
        progress(`保存原始材料：${source.title}`);
        job.resource ??= this.availablePath("Resources", source.title);
        job.snapshot ??= this.availablePath("Evidence", source.title);
        job.comparison ??= this.availablePath("Comparisons", source.title);
        await this.saveJobs();
        const original = source.fullContent ?? source.contentSnippet;
        const text = source.sourceType !== "user_note" && /<(?:p|table|img|math|div|h[1-6])\b/iu.test(original)
          ? htmlToMarkdown(original, source.url) : normalizeMarkdown(original);
        const normalized = { ...source, contentSnippet: text.slice(0, 100000), ...(source.fullContent ? { fullContent: text } : {}) };
        if (!this.app.vault.getFileByPath(job.resource)) await this.writeWiki(job.resource, sourceNote(normalized, job.topics, this.settings.wikiRoot), null);
        if (!this.app.vault.getFileByPath(job.snapshot)) await this.writeWiki(job.snapshot,
          `---\ntype: evidence\ntopics: ${JSON.stringify(job.topics.map((path) => wikiLink(path)))}\n---\n\n`
          + `${wikiLink(job.resource)}\n\n${evidenceSnapshot(text)}`, null);
        if (job.state !== "done") {
          job.state = "pending";
          job.error = undefined;
          if (!model) {
            job.error = "原文与证据已保存；请配置模型并授权后重试原子化";
          } else {
            job.claims ??= await extractClaims(model, normalized, signal, progress,
              { next: job.extractionNext, claims: job.partialClaims, key: job.extractionKey },
              async (claims, next, key) => {
                job.partialClaims = claims;
                job.extractionNext = next;
                job.extractionKey = key;
                await this.saveJobs();
              });
            job.partialClaims = [];
            await this.saveJobs();
            for (let i = 0; i < job.claims.length; i++) {
              signal.throwIfAborted();
              job.paths[i] ??= this.availablePath("Knowledge", job.claims[i]!.statement);
              await this.saveJobs();
              if (!this.app.vault.getFileByPath(job.paths[i]!)) await this.writeWiki(job.paths[i]!,
                knowledgeNote(job.claims[i]!, normalized, job.snapshot, job.topics), null);
              job.next = i + 1;
            }
            job.comparisonState = "done";
            job.state = "done";
          }
        }
      } catch (error) {
        job.state = "failed";
        job.error = signal.aborted ? "已取消；保存结果保留，可继续处理" : error instanceof Error ? error.message : String(error);
      }
      try {
      if (job.resource && job.snapshot && job.comparison && this.app.vault.getFileByPath(job.resource) && this.app.vault.getFileByPath(job.snapshot)) {
        const file = this.app.vault.getFileByPath(job.comparison);
        const before = file ? await this.app.vault.read(file) : null;
        const body = comparisonNote(source, job.claims ?? [], job.comparisons ?? [], job.resource,
          job.snapshot, job.paths, job.topics, job.error ?? "原子观点已提取；跨来源关系在观点网络统一核对，原笔记未自动修改。", before);
        await this.writeWiki(job.comparison, managedSection(body, "network",
          `## 跨来源判断\n\n${wikiLink(`${this.settings.wikiRoot}/观点网络.md`, "查看共识、分歧与证据")}`), before);
        for (const path of [job.resource, job.snapshot, ...job.paths]) {
          if (!isWikiPath(path, this.settings.wikiRoot)) throw new Error("任务路径不在当前 Wiki 范围内");
          const file = this.app.vault.getFileByPath(path);
          if (!file) continue;
          const before = await this.app.vault.read(file);
          const links = ["## 处理关联", "", ...job.topics.map((path) => `- ${wikiLink(path)}`),
            `- ${wikiLink(job.comparison, "来源主张与处理状态")}`,
            `- ${wikiLink(`${this.settings.wikiRoot}/观点网络.md`, "跨来源共识与分歧")}`].join("\n");
          await this.writeWiki(path, managedSection(before, "processing", links), before);
        }
      }
      } catch (error) {
        job.state = "failed";
        job.error = `结果关联未完成：${error instanceof Error ? error.message : String(error)}`;
      }
      await this.saveJobs();
      progress(`${source.title}：${job.state === "done" ? `已提取 ${job.paths.length} 个原子观点` : job.error}`);
      if (signal.aborted) break;
    }
    return results;
  }
  private requireRemote(): void {
    if (!this.settings.allowRemote) throw new Error("请先在 Synovia 设置中授权远程请求");
  }
  private cli(): ZhihuCliClient { return new ZhihuCliClient(this.settings.zhihuCommand); }
  async zhihuConnection(signal?: AbortSignal): Promise<string> {
    return this.cli().connection(this.settings.timeoutSeconds * 1000, this.secret(this.settings.zhihuSecretName), signal);
  }
  async zhihuQuota(signal?: AbortSignal): Promise<string> {
    this.requireRemote();
    return this.cli().quota(this.secret(this.settings.zhihuSecretName), this.settings.timeoutSeconds * 1000, signal);
  }
  async searchZhihu(query: string, signal?: AbortSignal): Promise<SourceDocument[]> {
    this.requireRemote();
    const secret = this.secret(this.settings.zhihuSecretName);
    const timeout = this.settings.timeoutSeconds * 1000;
    if (this.settings.zhihuMode === "cli") return this.cli().searchZhihu(query, this.settings.zhihuCount, secret, timeout, signal);
    return this.settings.zhihuMode === "mcp"
      ? searchZhihuMcp(requestUrl, query, this.settings.zhihuCount, secret, timeout, signal)
      : this.zhihu.search(query, this.settings.zhihuCount, secret, timeout, signal);
  }
  async searchGlobal(query: string, signal?: AbortSignal): Promise<SourceDocument[]> {
    this.requireRemote();
    return this.cli().searchGlobal(query, this.settings.zhihuGlobalCount, this.settings.zhihuGlobalFilter,
      this.settings.zhihuGlobalDb, this.secret(this.settings.zhihuSecretName), this.settings.timeoutSeconds * 1000, signal);
  }
  async hotZhihu(signal?: AbortSignal): Promise<SourceDocument[]> {
    this.requireRemote();
    return this.cli().hot(this.settings.zhihuHotCount, this.secret(this.settings.zhihuSecretName), this.settings.timeoutSeconds * 1000, signal);
  }
  async askZhida(query: string, signal?: AbortSignal): Promise<SourceDocument> {
    this.requireRemote();
    return (await this.cli().ask(query, this.settings.zhidaModel, this.secret(this.settings.zhihuSecretName), this.settings.timeoutSeconds * 1000, signal)).source;
  }
  async questionAnswers(url: string, signal?: AbortSignal): Promise<SourceDocument[]> {
    this.requireRemote();
    return this.cli().answers(url, this.secret(this.settings.zhihuSecretName), this.settings.timeoutSeconds * 1000, signal);
  }
  async fetchWeb(url: string, signal?: AbortSignal): Promise<SourceDocument> {
    this.requireRemote();
    return fetchWebContent(requestUrl, url, this.settings.timeoutSeconds * 1000, signal);
  }
  async activeNote(): Promise<SourceDocument> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") throw new Error("请先打开一篇 Markdown 笔记");
    return fromUserInput(await this.app.vault.read(file), file.basename, file.path);
  }
  activeSelection(): SourceDocument {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) throw new Error("请先在编辑器选中笔记内容");
    const editor = view.editor;
    return fromUserInput(selectedBlocks(editor.getValue(), editor.posToOffset(editor.getCursor("from")), editor.posToOffset(editor.getCursor("to"))),
      `${view.file.basename}选区`, view.file.path, true);
  }
  async reviewKnowledge(path: string, state: "accepted" | "ignored" | "needs-review"): Promise<void> {
    if (!path.startsWith(`${this.settings.wikiRoot}/Knowledge/`)) throw new Error("请选择知识点");
    const file = this.app.vault.getFileByPath(path);
    if (!file) throw new Error("笔记不存在");
    await this.app.fileManager.processFrontMatter(file, (meta) => { meta.status = state; });
    if (this.graph) { this.graph.state = "pending"; this.graph.error = "知识点审核状态已改变，请重新整理"; }
    this.queueOptimization();
  }
  async draftKnowledge(paths: string[]): Promise<PatchProposal> {
    return this.operation(async (signal) => {
      const model = this.model();
      if (!model) throw new Error(this.modelStatus());
      if (!paths.length || paths.length > 8) throw new Error("请选择 1–8 个已审核知识点");
      const currentPaths = new Set((await this.knowledgeUnits()).map((unit) => unit.path));
      const evidence: { id: number; path: string; content: string }[] = [];
      for (const path of [...new Set(paths)]) {
        const file = this.app.vault.getFileByPath(path);
        if (!file || !path.startsWith(`${this.settings.wikiRoot}/Knowledge/`)) throw new Error("只能使用知识点");
        if (!currentPaths.has(path)) throw new Error("知识点原文已改变或证据已失效，请先重新整理");
        const content = await this.app.vault.read(file);
        const meta = parseYaml(/^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1] ?? "") as { status?: string };
        if (meta?.status !== "accepted") throw new Error("只能使用已审核知识点");
        evidence.push({ id: evidence.length + 1, path, content });
      }
      const draft = await model.json(
        'Generate a topic draft from accepted knowledge only. Return {"title":"short title","paragraphs":[{"text":"Markdown retaining conditions","citations":[1]}]}. Every paragraph needs supplied evidence IDs; invent no facts or links.',
        { evidence }, z.object({ title: z.string().min(1).max(80), paragraphs: z.array(z.object({
          text: z.string().min(1).max(5000), citations: z.array(z.number().int().positive()).min(1).max(8)
        })).min(1).max(20) }), signal);
      const paragraphs = draft.paragraphs.map((paragraph) => `${paragraph.text}\n\n${paragraph.citations.map((id) => {
        const source = evidence.find((item) => item.id === id);
        if (!source) throw new Error("草稿包含无效证据引用");
        return wikiLink(source.path);
      }).join(" · ")}`);
      const after = topicNote(draft.title, this.settings.wikiRoot) + paragraphs.join("\n\n") + "\n";
      const id = crypto.randomUUID();
      return { id, path: this.availablePath("Topics", draft.title), action: "CREATE", rationale: "基于已审核知识点生成有引用的主题草稿",
        before: null, baseFileHash: null, sources: [], chunks: [{ id, label: "主题草稿", edits: [{ startOffset: 0, endOffset: 0, replacement: after }] }] };
    });
  }
  async maintenance(): Promise<MaintenanceIssue[]> { return inspectWiki(this.app, this.settings.wikiRoot, await this.index.get()); }
  async maintenanceProposal(issue: MaintenanceIssue, target?: string): Promise<PatchProposal> {
    if (!isWikiPath(issue.path, this.settings.wikiRoot)) throw new Error("目标超出 Wiki 范围");
    const file = this.app.vault.getFileByPath(issue.path);
    if (!file) throw new Error("笔记不存在");
    const before = await this.app.vault.read(file);
    const edits = [];
    if (issue.kind === "broken-link") {
      if (!target || !this.app.vault.getFileByPath(target)) throw new Error("请选择有效目标");
      const cache = this.app.metadataCache.getFileCache(file);
      for (const link of [...(cache?.links ?? []), ...(cache?.embeds ?? [])].filter((link) => link.link === issue.link)) {
        const startOffset = link.position.start.offset, endOffset = link.position.end.offset;
        if (before.slice(startOffset, endOffset) !== link.original) throw new Error("链接位置已变化，请重新扫描");
        const alias = link.displayText?.replace(/[\[\]|]/gu, "") ?? "";
        const anchor = link.link.includes("#") ? link.link.slice(link.link.indexOf("#")) : "";
        edits.push({ startOffset, endOffset, replacement: `${link.original.startsWith("!") ? "!" : ""}[[${target.replace(/\.md$/iu, "")}${anchor}${alias ? `|${alias}` : ""}]]` });
      }
      if (!edits.length) throw new Error("没有可修复链接，请重新扫描");
    } else {
      if (issue.kind === "orphan" && (!target || target === file.path || !this.app.vault.getFileByPath(target))) throw new Error("请选择有效关联笔记");
      const addition = issue.kind === "stale"
        ? "\n\n> [!warning] 时效性待复核\n> 请人工核对相关技术规范与结论。\n"
        : `\n\n## 关联笔记\n\n- ${wikiLink(target!)}\n`;
      edits.push({ startOffset: before.length, endOffset: before.length, replacement: addition });
    }
    return { id: crypto.randomUUID(), path: file.path, action: "LINK", rationale: issue.detail, before,
      baseFileHash: await hashText(before), chunks: [{ id: crypto.randomUUID(), label: issue.detail, edits }], sources: [] };
  }
}
