import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const { OBSIDIAN_EXE, PLAYWRIGHT_MODULE, SYNOVIA_VAULT_PATH } = process.env;
if (!OBSIDIAN_EXE || !PLAYWRIGHT_MODULE || !SYNOVIA_VAULT_PATH) throw new Error("Set runtime paths and the existing configured vault path.");
const { chromium } = await import(pathToFileURL(PLAYWRIGHT_MODULE));
const profile = resolve("output/playwright/live-model-profile");
await mkdir(profile, { recursive: true });
await writeFile(join(profile, "obsidian.json"), JSON.stringify({
  vaults: { "cccccccccccccccc": { path: SYNOVIA_VAULT_PATH, ts: Date.now(), open: true } }, cli: true
}));
const { outputFiles } = await build({
  stdin: { contents: `
    export { ModelClient } from "./src/agent/modelClient";
    export { extractClaims } from "./src/evolution/claimExtractor";
    export { buildKnowledgeGraph } from "./src/evolution/knowledgeGraph";
    export { fromUserInput } from "./src/sources/contentFetcher";
    export { requestUrl } from "obsidian";
  `, resolveDir: process.cwd() },
  bundle: true, write: false, format: "cjs", platform: "browser", logLevel: "silent",
  plugins: [{
    name: "obsidian-runtime-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian-runtime-shim", namespace: "shim" }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        contents: "export const requestUrl = undefined;", loader: "js"
      }));
    }
  }]
});
const appProcess = spawn(OBSIDIAN_EXE, [
  `--user-data-dir=${profile}`, "--remote-debugging-port=19362",
  "--remote-debugging-address=127.0.0.1", "--new-instance", "--disable-update", "--no-first-run", "--disable-gpu"
], { windowsHide: true, stdio: "ignore" });
let browser;
try {
  const end = Date.now() + 45000;
  while (!browser && Date.now() < end) {
    try { browser = await chromium.connectOverCDP("http://127.0.0.1:19362"); }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.ok(browser);
  let page;
  while (Date.now() < end) {
    for (const candidate of browser.contexts()[0].pages()) {
      if (await candidate.evaluate(() => window.app?.vault?.adapter?.basePath).catch(() => "") === SYNOVIA_VAULT_PATH) page = candidate;
    }
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(page, "Configured vault window not found");
  const trust = page.getByRole("button", { name: "信任仓库作者并启用插件", exact: true });
  if (await trust.count()) {
    await trust.last().click({ force: true });
    await trust.last().waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
  }
  while (await page.locator(".modal-container").count()) {
    const modal = page.locator(".modal-container").last();
    const close = modal.locator(".modal-close-button");
    if (!(await close.count())) break;
    await close.last().click({ force: true });
    await modal.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  }
  await page.waitForFunction(() => window.app?.plugins);
  await page.evaluate(async () => {
    localStorage.setItem(`enable-plugin-${window.app.appId}`, "true");
    await window.app.plugins.enablePluginAndSave("synovia");
  });
  await page.waitForFunction(() => window.app?.plugins?.getPlugin("synovia"));
  const result = await page.evaluate(async (code) => {
    const installed = window.app.plugins.getPlugin("synovia");
    const settings = { ...installed.settings, autoOptimize: false };
    if (!settings.allowRemote) throw new Error("Configured remote processing is not authorized");
    const module = { exports: {} };
    new Function("module", "exports", "require", code)(module, module.exports, window.require);
    const { ModelClient, extractClaims, buildKnowledgeGraph, fromUserInput } = module.exports;
    const model = installed.model();
    if (!model) throw new Error("Configured model credential is unavailable");
    // Only these synthetic public-domain samples are transmitted. No vault notes are read.
    const samples = [
      ["独立任务记录", "合成测试材料：在每周三天远程、任务可独立完成的小型软件团队里，成员报告受到的打断更少，完成深度工作的时间更多。但这份记录没有对照组，不能证明所有岗位都应远程。"],
      ["团队协作记录", "合成测试材料：在需要每天跨部门实时讨论的新项目里，异步远程沟通让决策等待变长。记录支持在高同步需求阶段增加面对面沟通，但没有否定个人独立任务中远程工作的专注收益。"]
    ];
    const units = [], counts = [];
    for (const [title, text] of samples) {
      const source = fromUserInput(text, title);
      const claims = await extractClaims(model, source);
      counts.push(claims.length);
      for (const [index, claim] of claims.entries()) units.push({
        id: `${source.id}:${index}`, sourceId: source.id, title, path: `Synthetic/${title}-${index}.md`,
        snapshot: `Synthetic/Evidence/${title}.md`, origin: "", completeness: "full",
        statement: claim.statement, conditions: claim.preconditions, quote: claim.quote
      });
    }
    const graph = await buildKnowledgeGraph(model, units, undefined, async () => {});
    const requests = model.usage.requests;
    await buildKnowledgeGraph(model, units, graph, async () => {});
    return { model: settings.modelName, extractionCounts: counts, state: graph.state, error: graph.error,
      findings: graph.findings, usage: model.usage, repeatedRequests: model.usage.requests - requests };
  }, outputFiles[0].text);
  await mkdir(resolve("output/playwright"), { recursive: true });
  await writeFile(resolve("output/playwright/live-model-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.state, "done");
  assert.ok(result.extractionCounts.every((count) => count > 0));
  assert.ok(result.findings.some((finding) => finding.kind === "conditions" || finding.kind === "consensus"));
  assert.equal(result.repeatedRequests, 0);
} finally {
  await browser?.close();
  appProcess.kill();
}
