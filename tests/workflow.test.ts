import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import type SynoviaPlugin from "../src/main";
import { ModelClient } from "../src/agent/modelClient";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import type { Request } from "../src/utils/http";
import { fromUserInput } from "../src/sources/contentFetcher";
import type { SourceDocument } from "../src/types";

const notices: string[] = [];
class Component {
  constructor(public app?: unknown, public manifest?: unknown) {}
  async loadData() { return {}; }
  registerView() {}
  addSettingTab() {}
  addRibbonIcon() {}
  addCommand() {}
  registerEvent() {}
  addStatusBarItem() { return { setText() {} }; }
}
const bundled = await build({
  entryPoints: ["src/main.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  external: ["obsidian", "node:*", "@codemirror/state", "@codemirror/view"], logLevel: "silent"
});
const compiled = { exports: {} as { default: typeof SynoviaPlugin } };
const nativeRequire = createRequire(import.meta.url);
new Function("module", "exports", "require", bundled.outputFiles[0]!.text)(compiled, compiled.exports, (id: string) => {
  if (id === "obsidian") return {
    Plugin: Component, PluginSettingTab: Component, ItemView: Component, Modal: Component,
    Component, MarkdownView: Component, Notice: class { constructor(message: string) { notices.push(message); } },
    parseYaml: (text: string) => ({ status: /^status:\s*(.*)$/mu.exec(text)?.[1] }),
    requestUrl: () => { throw new Error("Network is forbidden in workflow regression"); }
  };
  return nativeRequire(id);
});

function memoryVault() {
  const contents = new Map<string, string>();
  const folders = new Set<string>();
  const file = (path: string) => contents.has(path) ? {
    path, basename: path.split("/").at(-1)!.replace(/\.md$/u, ""), extension: path.split(".").at(-1)
  } : null;
  const adapter = {
    exists: async (path: string) => contents.has(path) || folders.has(path),
    read: async (path: string) => { if (!contents.has(path)) throw new Error("Missing file"); return contents.get(path)!; },
    write: async (path: string, text: string) => { contents.set(path, text); },
    remove: async (path: string) => { contents.delete(path); },
    list: async (path: string) => ({ files: [...contents.keys()].filter((item) => item.startsWith(`${path}/`)), folders: [] })
  };
  const vault = {
    adapter,
    getFileByPath: file,
    getAbstractFileByPath: (path: string) => file(path) ?? (folders.has(path) ? { path } : null),
    getMarkdownFiles: () => [...contents.keys()].filter((path) => path.endsWith(".md")).map((path) => file(path)!),
    read: async (entry: { path: string }) => adapter.read(entry.path),
    cachedRead: async (entry: { path: string }) => adapter.read(entry.path),
    create: async (path: string, text: string) => { assert.ok(!contents.has(path)); contents.set(path, text); return file(path); },
    process: async (entry: { path: string }, fn: (text: string) => string) => contents.set(entry.path, fn(await adapter.read(entry.path))),
    createFolder: async (path: string) => { folders.add(path); },
    on() {}
  };
  return { contents, vault };
}

async function fixture() {
  const store = memoryVault();
  const workspace = { getLeavesOfType: () => [], onLayoutReady() {} };
  const app = { vault: store.vault, workspace, secretStorage: { getSecret: () => "fixture-key" } };
  const manifest = { dir: ".obsidian/plugins/synovia", version: "test" };
  const plugin = new compiled.exports.default(app as never, manifest as never);
  await plugin.onload();
  const settings = { ...DEFAULT_SETTINGS, allowRemote: true, modelBaseUrl: "https://example.com/v1", modelName: "fixture", modelSecretName: "fixture" };
  plugin.settings = settings;
  const requests: Record<string, any>[] = [];
  let failExtraction = false;
  let cancelOnExtraction = false;
  let invalidOpinionEvidence = false;
  let duringSynthesis: (() => void) | undefined;
  const request: Request = async (options) => {
    const input = JSON.parse(JSON.parse(String(options.body)).messages[1].content);
    requests.push(input);
    if (input.blocks && cancelOnExtraction) { cancelOnExtraction = false; plugin.cancel(); throw new Error("cancelled"); }
    if (input.blocks && failExtraction) throw new Error("fixture outage");
    if (input.units) duringSynthesis?.();
    const result = input.sources ? {
      title: "远程工作适用边界",
      stance: "取决于条件",
      answer: "远程工作更适合需要持续专注、同步频率较低的任务；高频协作任务需要额外沟通机制。",
      evidence: [
        { source: 1, quote: invalidOpinionEvidence ? "模型编造的依据" : "Remote work improves individual focus." },
        { source: 2, quote: "Remote work delays team feedback." }
      ],
      tensions: ["个人专注和团队同步之间存在条件差异"],
      questions: ["团队同步频率是否足以抵消反馈延迟？"]
    } : input.blocks ? { claims: input.blocks.slice(0, 2).map((block: any) => ({
      statement: block.text, stance: "neutral", preconditions: [], quote: block.text,
      evidenceBlockIds: [block.id], confidence: 0.7
    })) } : { findings: new Set(input.units.map((unit: any) => unit.sourceId)).size > 1 ? [{
      kind: "disagreement", statement: "The sources disagree on remote work.",
      reasoning: "One source supports focus; the other reports delayed feedback.",
      citations: [input.units[0], input.units.find((unit: any) => unit.sourceId !== input.units[0].sourceId)]
        .map((unit: any) => ({ id: unit.id, quote: unit.quote })),
      question: "Do the team conditions differ?"
    }] : [] };
    return { status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0),
      json: { choices: [{ message: { content: JSON.stringify(result) } }] } };
  };
  const model = new ModelClient(request, settings, "fixture-key");
  Object.assign(plugin, { model: () => model });
  return { ...store, plugin, requests, fail: (value: boolean) => { failExtraction = value; },
    invalidOpinion: (value: boolean) => { invalidOpinionEvidence = value; },
    duringSynthesis: (work: () => void) => { duringSynthesis = work; },
    cancelNext: () => { cancelOnExtraction = true; } };
}

test("opinion agent forms an evidence-backed judgment and saves it under Opinions", async () => {
  const { plugin, contents } = await fixture();
  contents.set("Notes/A.md", "Remote work improves individual focus.");
  contents.set("Notes/B.md", "Remote work delays team feedback.");
  const result = await plugin.askOpinion("远程工作适合什么任务？", () => {});
  assert.equal(result.stance, "取决于条件");
  assert.equal(result.evidence.length, 2);
  const path = await plugin.saveOpinion(result);
  assert.match(path, /^Wiki\/Opinions\//u);
  assert.match(contents.get(path)!, /远程工作更适合需要持续专注/u);
  assert.match(contents.get(path)!, /Remote work improves individual focus\./u);
  assert.match(contents.get(path)!, /\[\[Notes\/A(?:\|A)?\]\]/u);
  plugin.onunload();
});

test("opinion agent refuses fabricated evidence", async () => {
  const { plugin, contents, invalidOpinion } = await fixture();
  contents.set("Notes/A.md", "Remote work improves individual focus.");
  invalidOpinion(true);
  await assert.rejects(plugin.askOpinion("远程工作适合什么任务？", () => {}), /无法在《A》中核对/u);
  assert.equal(contents.has("Wiki/Opinions/远程工作适用边界.md"), false);
  plugin.onunload();
});

test("opinion agent supplements missing local evidence with Zhihu and preserves the external source", async () => {
  const { plugin, contents, requests } = await fixture();
  const remoteSources: SourceDocument[] = [
    {
      id: "zhihu-1",
      sourceType: "zhihu_search_hit",
      title: "远程工作与专注",
      url: "https://www.zhihu.com/question/1",
      evidenceCompleteness: "full",
      contentSnippet: "Remote work improves individual focus.",
      fullContent: "Remote work improves individual focus."
    },
    {
      id: "zhihu-2",
      sourceType: "zhihu_answer",
      title: "远程协作的反馈成本",
      url: "https://www.zhihu.com/question/2",
      evidenceCompleteness: "full",
      contentSnippet: "Remote work delays team feedback.",
      fullContent: "Remote work delays team feedback."
    }
  ];
  let searched = 0;
  Object.assign(plugin, {
    searchZhihu: async () => { searched++; return remoteSources; }
  });
  const result = await plugin.askOpinion("远程工作适合什么任务？", () => {});
  assert.equal(searched, 1);
  assert.deepEqual(requests.at(-1)?.sources.map((source: { url?: string }) => source.url), [
    "https://www.zhihu.com/question/1",
    "https://www.zhihu.com/question/2"
  ]);
  const path = await plugin.saveOpinion(result);
  assert.match(contents.get(path)!, /\[远程工作与专注\]\(https:\/\/www\.zhihu\.com\/question\/1\)/u);
  assert.doesNotMatch(contents.get(path)!, /\[\[https:\/\/www\.zhihu\.com/u);
  plugin.onunload();
});

test("opinion agent always compares local evidence with Zhihu when remote calls are enabled", async () => {
  const { plugin, contents, requests } = await fixture();
  contents.set("Notes/A.md", "Remote work improves individual focus.");
  contents.set("Notes/B.md", "Remote work delays team feedback.");
  const source: SourceDocument = {
    id: "zhihu-local-comparison",
    sourceType: "zhihu_answer",
    title: "知乎中的远程工作观点",
    url: "https://www.zhihu.com/question/3",
    evidenceCompleteness: "full",
    contentSnippet: "Remote work needs explicit communication agreements.",
    fullContent: "Remote work needs explicit communication agreements."
  };
  let searched = 0;
  Object.assign(plugin, {
    searchZhihu: async () => { searched++; return [source]; }
  });
  const result = await plugin.askOpinion("远程工作适合什么任务？", () => {});
  assert.equal(searched, 1);
  assert.equal(result.sources[0]?.path, "Notes/A.md");
  assert.ok(result.sources.some((item) => item.url === source.url));
  const opinionRequest = requests.at(-1)!;
  assert.deepEqual(opinionRequest.sources.map((item: { url?: string; path: string }) => item.url ?? item.path), [
    "Notes/A.md",
    source.url,
    "Notes/B.md"
  ]);
  assert.equal(opinionRequest.sources.filter((item: { url?: string }) => item.url).length, 1);
  plugin.onunload();
});

test("opinion agent keeps Zhihu sources when local budget fitting rejects candidates", async () => {
  const { plugin, requests } = await fixture();
  const sources: SourceDocument[] = [{
    id: "zhihu-budget-regression",
    sourceType: "zhihu_answer",
    title: "知乎中的远程工作观点",
    url: "https://www.zhihu.com/question/4",
    evidenceCompleteness: "full",
    contentSnippet: "Remote work improves individual focus.",
    fullContent: "Remote work improves individual focus."
  }, {
    id: "zhihu-budget-regression-2",
    sourceType: "zhihu_answer",
    title: "知乎中的反馈成本观点",
    url: "https://www.zhihu.com/question/5",
    evidenceCompleteness: "full",
    contentSnippet: "Remote work delays team feedback.",
    fullContent: "Remote work delays team feedback."
  }];
  const model = (plugin as any).model() as ModelClient;
  model.fits = (_system: string, input: { sources: { url?: string }[] }) =>
    Boolean(input.sources.at(-1)?.url);
  Object.assign(plugin, {
    model: () => model,
    searchZhihu: async () => sources
  });
  await plugin.askOpinion("远程工作适合什么任务？", () => {});
  assert.deepEqual(requests.at(-1)?.sources.map((item: { url?: string }) => item.url), sources.map((source) => source.url));
  plugin.onunload();
});

test("opinion agent reserves budget for remote viewpoints before adding local notes", async () => {
  const { plugin, requests } = await fixture();
  plugin.settings.maxInputChars = 4000;
  for (const [index, text] of [
    "Remote work improves individual focus.",
    "Remote work delays team feedback.",
    ...Array.from({ length: 20 }, (_, index) => `Remote work note ${index} with supporting context.`)
  ].entries()) {
    (plugin as any).app.vault.create(`Notes/Budget-${index}.md`, text);
  }
  const sources: SourceDocument[] = [0, 1].map((index) => ({
    id: `zhihu-budget-${index}`,
    sourceType: "zhihu_answer",
    title: `知乎预算观点 ${index}`,
    url: `https://www.zhihu.com/question/${10 + index}`,
    evidenceCompleteness: "full",
    contentSnippet: `Remote work viewpoint ${index} with enough context to compare local claims.`,
    fullContent: `Remote work viewpoint ${index} with enough context to compare local claims.`
  }));
  Object.assign(plugin, { searchZhihu: async () => sources });
  await plugin.askOpinion("远程工作适合什么任务？", () => {});
  const opinionRequest = requests.at(-1)!;
  assert.equal(
    opinionRequest.sources.filter((item: { url?: string }) => item.url).length,
    2,
    JSON.stringify(opinionRequest.sources.map((item: { path: string; url?: string }) => item.url ?? item.path))
  );
  assert.ok(opinionRequest.sources.length < 22);
  plugin.onunload();
});

test("opinion agent keeps the combined local and Zhihu input within budget", async () => {
  const { plugin, requests, contents } = await fixture();
  plugin.settings.maxInputChars = 9000;
  contents.set("Notes/Focus.md", "Remote work improves individual focus.");
  contents.set("Notes/Feedback.md", "Remote work delays team feedback.");
  const remoteSources: SourceDocument[] = Array.from({ length: 5 }, (_, index) => ({
    id: `zhihu-long-${index}`,
    sourceType: "zhihu_answer",
    title: `知乎长观点 ${index}`,
    url: `https://www.zhihu.com/question/${20 + index}`,
    evidenceCompleteness: "full",
    contentSnippet: `Remote work viewpoint ${index}.`,
    fullContent: `${index === 0 ? "Remote work improves individual focus." : "Remote work viewpoint."} ${"Long context for budget testing. ".repeat(140)}`
  }));
  Object.assign(plugin, { searchZhihu: async () => remoteSources });
  const result = await plugin.askOpinion("远程工作适合什么任务？", () => {});
  const request = requests.at(-1)!;
  assert.ok(request.sources.some((source: { path: string }) => source.path === "Notes/Focus.md"));
  assert.ok(request.sources.some((source: { path: string }) => source.path === "Notes/Feedback.md"));
  assert.ok(request.sources.some((source: { url?: string }) => source.url));
  assert.equal(result.sources.length, request.sources.length);
  plugin.onunload();
});

test("whole-vault workflow connects opposing notes, reuses work and retires changed or deleted evidence", async () => {
  const { plugin, contents, requests } = await fixture();
  contents.set("Notes/A.md", "Remote work improves individual focus.");
  contents.set("Notes/B.md", "Remote work delays team feedback.");
  await plugin.optimizeVault(() => {});
  assert.equal(plugin.graph?.state, "done");
  assert.equal(plugin.graph?.sourceCount, 2);
  assert.equal(plugin.graph?.findings[0]?.kind, "disagreement");
  assert.match(contents.get("Wiki/观点网络.md")!, /明确分歧/);
  const paths = [...plugin.jobs.values()].flatMap((job) => job.paths);
  assert.equal(paths.length, 2);
  assert.ok(paths.every((path) => contents.get(path)!.includes("语义关联")));
  const graphPath = "Wiki/观点网络.md";
  contents.set(graphPath, contents.get(graphPath)! + "\nMy manual decision.\n");
  const calls = requests.length;
  const count = contents.size;
  await plugin.optimizeVault(() => {});
  assert.equal(requests.length, calls, "unchanged input sends no model requests");
  assert.equal(contents.size, count, "unchanged run creates no new note or transaction");
  assert.match(contents.get(graphPath)!, /My manual decision/);
  await plugin.clearCompletedJobs();
  await plugin.optimizeVault(() => {});
  assert.equal(requests.length, calls, "archived receipts remain reusable");

  contents.set("Notes/A.md", contents.get("Notes/A.md")! + "\n\nThis changed note limits the original claim.");
  await plugin.optimizeVault(() => {});
  assert.equal(plugin.graph?.sourceCount, 2);
  assert.match(contents.get(paths[0]!)!, /未纳入当前观点网络/);
  const previousCalls = requests.length;
  contents.delete("Notes/B.md");
  await plugin.optimizeVault(() => {});
  assert.equal(plugin.graph?.sourceCount, 1);
  assert.equal(plugin.graph?.findings.length, 0);
  assert.equal(requests.length, previousCalls, "single-source graph needs no cross-source model request");
  assert.match(contents.get(paths[1]!)!, /未纳入当前观点网络/);
  assert.match(contents.get(graphPath)!, /My manual decision/);
  plugin.onunload();
});

test("plain paragraphs are saved locally and question punctuation is not used in filenames", async () => {
  const { plugin, contents } = await fixture();
  const queries: string[] = [];
  Object.assign(plugin, {
    model: () => undefined,
    searchZhihu: async (query: string) => { queries.push(query); return []; }
  });
  const text = "A synthetic plain paragraph without Markdown syntax. ".repeat(6);
  const material = await plugin.smartProcess(text, () => {});
  assert.equal(material.kind, "text");
  assert.equal(material.jobs[0]?.source.fullContent, text.trim());
  assert.ok(contents.has(material.jobs[0]!.snapshot!));
  assert.equal(queries.length, 0);
  const question = "How does remote work affect focus?";
  const result = await plugin.smartProcess(question, () => {});
  assert.equal(result.kind, "topic");
  assert.doesNotMatch(result.path!, /\?/u);
  assert.match(contents.get(result.path!)!, /How does remote work affect focus\?/u);
  assert.deepEqual(queries, [question]);
  plugin.onunload();
});

test("an oversized note does not block other sources, and mid-inference edits invalidate publication", async () => {
  const { plugin, contents, duringSynthesis } = await fixture();
  contents.set("Notes/A.md", "Remote work improves focus.");
  contents.set("Notes/B.md", "Remote work delays feedback.");
  contents.set("Notes/Large.md", "x".repeat(100001));
  duringSynthesis(() => { contents.set("Notes/A.md", "Remote work changed during inference."); });
  const jobs = await plugin.optimizeVault(() => {});
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.state === "done"));
  assert.equal(plugin.localReadErrors.size, 1);
  assert.equal(plugin.graph?.pendingSources.length, 1);
  assert.equal(plugin.graph?.state, "pending");
  assert.equal(plugin.graph?.findings.length, 0);
  assert.match(contents.get("Wiki/观点网络.md")!, /过期结论未发布/);
  plugin.onunload();
});

test("imports read untouched local notes too; failure is resumable and never labeled full coverage", async () => {
  const { plugin, contents, requests, fail } = await fixture();
  contents.set("Notes/Existing.md", "Remote work can improve focus.");
  fail(true);
  const source = fromUserInput("Remote work delays feedback.", "New source");
  const result = await plugin.ingestSources([source], () => {});
  assert.equal(result.length, 2);
  assert.ok(result.every((job) => job.state === "failed"));
  assert.equal(plugin.graph?.pendingSources.length, 2);
  assert.equal(plugin.graph?.state, "pending");
  const sourcePaths = result.map((job) => job.resource);
  const failedRetry = await plugin.retryPendingJobs(() => {});
  assert.equal(failedRetry.filter((job) => job.state === "done").length, 0);
  fail(false);
  const resumed = await plugin.retryPendingJobs(() => {});
  assert.equal(resumed.filter((job) => job.state === "done").length, 2);
  assert.equal(plugin.graph?.sourceCount, 2);
  assert.equal(plugin.graph?.pendingSources.length, 0);
  assert.deepEqual([...plugin.jobs.values()].map((job) => job.resource), sourcePaths);
  const calls = requests.length;
  await plugin.retryPendingJobs(() => {});
  assert.equal(requests.length, calls);
  plugin.onunload();
});

test("queued sources invalidate completed synthesis even when cancelled or no model is configured", async () => {
  const { plugin, contents, cancelNext } = await fixture();
  contents.set("Notes/A.md", "Remote work improves focus.");
  contents.set("Notes/B.md", "Remote work delays feedback.");
  await plugin.optimizeVault(() => {});
  assert.equal(plugin.graph?.state, "done");
  cancelNext();
  await assert.rejects(plugin.ingestSources([fromUserInput("A queued source.", "Cancelled source")], () => {}), /abort/i);
  assert.equal(plugin.graph?.state, "pending");
  assert.ok(plugin.graph?.pendingSources.includes("Cancelled source"));
  assert.equal(JSON.parse(contents.get(".synovia/knowledge-graph.json")!).state, "pending");
  await plugin.retryPendingJobs(() => {});
  assert.equal(plugin.graph?.state, "done");
  Object.assign(plugin, { model: () => undefined });
  const jobs = await plugin.ingestSources([fromUserInput("Saved without a model.", "Offline source")], () => {});
  assert.equal(jobs.find((job) => job.source.title === "Offline source")?.state, "pending");
  assert.equal(plugin.graph?.state, "pending");
  assert.ok(plugin.graph?.pendingSources.includes("Offline source"));
  assert.equal(JSON.parse(contents.get(".synovia/knowledge-graph.json")!).state, "pending");
  plugin.onunload();
});

test("cancellation preserves saved sources; corrupt job journals block all further writes", async () => {
  const { plugin, contents, cancelNext } = await fixture();
  contents.set("Notes/A.md", "A synthetic note to cancel.");
  cancelNext();
  await assert.rejects(plugin.optimizeVault(() => {}), /abort/i);
  assert.equal(plugin.isBusy(), false);
  assert.equal([...plugin.jobs.values()][0]?.state, "failed");
  assert.ok([...contents.keys()].some((path) => path.startsWith("Wiki/Resources/")));
  plugin.onunload();
  contents.set(".obsidian/plugins/synovia/extraction-jobs.json", "{corrupted");
  contents.delete(".obsidian/plugins/synovia/extraction-jobs.json.bak");
  const second = new compiled.exports.default(plugin.app, plugin.manifest);
  await second.onload();
  const before = new Map(contents);
  await assert.rejects(second.optimizeVault(() => {}), /任务记录需要恢复/);
  assert.deepEqual(contents, before);
  second.onunload();
});

test("topic results preserve remote failure details and can retry the same topic without losing evidence", async () => {
  const { plugin, contents } = await fixture();
  Object.assign(plugin, {
    model: () => undefined,
    searchZhihu: async () => { throw new Error("找不到知乎 CLI，请检查绝对路径"); }
  });
  const failed = await plugin.smartProcess("Rain garden maintenance", () => {});
  assert.equal(failed.kind, "topic");
  assert.equal(failed.jobs.length, 0);
  assert.match(failed.message!, /知乎自动补充失败.*绝对路径/u);
  assert.match(contents.get(failed.path!)!, /知乎自动补充失败/u);
  const source = fromUserInput("Synthetic rain garden evidence.", "Rain garden sample");
  Object.assign(plugin, { searchZhihu: async () => [source] });
  const resumed = await plugin.smartProcess("Rain garden maintenance", () => {});
  assert.equal(resumed.path, failed.path);
  assert.match(resumed.message!, /已自动补充 1 条知乎来源/u);
  assert.equal(resumed.jobs.length, 1);
  assert.equal(resumed.jobs[0]?.state, "pending");
  assert.ok(contents.has(resumed.jobs[0]!.resource!));
  assert.ok(contents.has(resumed.jobs[0]!.snapshot!));
  assert.doesNotMatch(contents.get(resumed.path!)!, /知乎自动补充失败/u);
  const repeated = await plugin.smartProcess("Rain garden maintenance", () => {});
  assert.equal(repeated.jobs[0]?.source.id, resumed.jobs[0]?.source.id);
  plugin.onunload();
});

test("topic results explain when remote search is disabled", async () => {
  const { plugin, contents } = await fixture();
  Object.assign(plugin, {
    model: () => undefined,
    settings: { ...plugin.settings, allowRemote: false },
    searchZhihu: async () => { throw new Error("must not be called"); }
  });
  const result = await plugin.smartProcess(`No local match ${Date.now()}`, () => {});
  assert.match(result.message!, /远程调用未授权，未检索知乎/u);
  assert.match(contents.get(result.path!)!, /远程调用未授权，未检索知乎/u);
  plugin.onunload();
});
