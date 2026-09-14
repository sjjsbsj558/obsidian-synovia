import assert from "node:assert/strict";
import { copyFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = resolve("output/playwright/real-manual");
const vault = join(root, "vault");
const browser = await chromium.connectOverCDP("http://127.0.0.1:19363");
const report = { environment: "Installed Obsidian, isolated vault, offline model fixture", checks: [], errors: [] };
let page;
const record = (name, evidence) => { report.checks.push({ name, evidence }); console.log(name, JSON.stringify(evidence)); };
try {
  page = browser.contexts()[0].pages().find((entry) => entry.url() === "app://obsidian.md/index.html");
  assert.ok(page, "No Obsidian vault page");
  assert.equal(await page.evaluate(() => app.vault.adapter.basePath), vault, "Refuse production vault");
  assert.equal(await page.evaluate(() => app.plugins.getPlugin("synovia").isBusy()), false);
  for (const file of ["main.js", "styles.css", "manifest.json"]) {
    await copyFile(file, join(vault, ".obsidian/plugins/synovia", file));
  }
  await page.evaluate(async (expected) => {
    if (app.vault.adapter.basePath !== expected) throw Error("Wrong vault");
    await app.plugins.disablePlugin("synovia");
    await app.plugins.enablePluginAndSave("synovia");
    await app.plugins.getPlugin("synovia").activateView();
  }, vault);
  page.on("pageerror", (error) => report.errors.push(error.message));
  const panel = page.locator(".synovia-workbench");
  const idle = () => page.waitForFunction(() => !app.plugins.getPlugin("synovia").isBusy()
    && document.querySelector(".synovia-workbench")?.getAttribute("aria-busy") === "false", null, { timeout: 180000 });
  const tab = (name) => panel.getByRole("tab", { name, exact: true }).click();
  const submit = async (title) => {
    await tab("工作台");
    await panel.getByLabel("主题、问题、链接或 Markdown", { exact: true }).fill(`# ${title}\n\nRemote work helps focus when tasks are independent.`);
    await panel.getByRole("button", { name: "开始处理", exact: true }).click();
  };
  const job = (title) => page.evaluate((title) => {
    const jobs = [...app.plugins.getPlugin("synovia").jobs.values()].filter((entry) => entry.source.title === title);
    return jobs.map((entry) => ({ id: entry.source.id, state: entry.state, claims: entry.claims?.length,
      resource: entry.resource, snapshot: entry.snapshot, paths: entry.paths,
      saved: [entry.resource, entry.snapshot, ...entry.paths].every((path) => path && app.vault.getFileByPath(path)) }));
  }, title);
  const stamp = Date.now();
  const offlineTitle = `QA-offline-${stamp}`;
  await page.evaluate((expected) => {
    if (app.vault.adapter.basePath !== expected) throw Error("Wrong vault");
    const plugin = app.plugins.getPlugin("synovia");
    window.synoviaQaSettings = { ...plugin.settings };
    plugin.settings.autoOptimize = false;
    plugin.settings.allowRemote = false;
    plugin.model = () => undefined;
  }, vault);
  await submit(offlineTitle);
  await idle();
  const offline = (await job(offlineTitle))[0];
  assert.equal(offline.state, "pending");
  assert.equal(offline.saved, true);
  assert.equal(await page.evaluate(() => app.plugins.getPlugin("synovia").graph.state), "pending");
  record("no-model-save", offline);
  await page.screenshot({ path: join(root, "qa-no-model.png") });

  await page.evaluate((expected) => {
    if (app.vault.adapter.basePath !== expected) throw Error("Wrong vault");
    window.synoviaQa = { calls: 0, delay: 0, empty: false, started: false };
    const plugin = app.plugins.getPlugin("synovia");
    plugin.settings.modelName = "offline-ui-qa";
    plugin.model = () => ({
      identity: "offline-ui-qa", fits: () => true,
      evidenceQuote: (quote, original) => original.includes(quote) ? quote : undefined,
      async json(system, input, schema, signal) {
        const qa = window.synoviaQa;
        qa.calls++;
        if (input.blocks) {
          qa.started = true;
          if (qa.delay) await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, qa.delay);
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
          signal?.throwIfAborted();
          return schema.parse({ claims: qa.empty ? [] : input.blocks.filter((block) => block.type === "paragraph").slice(0, 2)
            .map((block) => ({ statement: block.text, stance: "neutral", preconditions: [], quote: block.text,
              evidenceBlockIds: [block.id], confidence: 0.7 })) });
        }
        if (input.units) return schema.parse({ findings: [] });
        throw Error("Unexpected offline fixture request");
      }
    });
  }, vault);
  await panel.getByRole("button", { name: /^继续整理/ }).click();
  await idle();
  assert.equal((await job(offlineTitle))[0].state, "done");
  record("continue-saved-source", (await job(offlineTitle))[0]);

  const stopTitle = `QA-stop-${stamp}`;
  await page.evaluate(() => Object.assign(window.synoviaQa, { delay: 30000, started: false }));
  await submit(stopTitle);
  await page.waitForFunction(() => window.synoviaQa.started);
  assert.equal(await panel.getByRole("button", { name: "停止任务", exact: true }).isEnabled(), true);
  await panel.getByRole("button", { name: "停止任务", exact: true }).click();
  await idle();
  assert.match(await panel.locator(".synovia-progress").innerText(), /已停止/);
  assert.equal(await panel.getByRole("button", { name: "开始处理", exact: true }).isEnabled(), true);
  const stopped = (await job(stopTitle))[0];
  assert.notEqual(stopped.state, "done");
  assert.equal(stopped.saved, true);
  assert.equal(await page.evaluate(async () => JSON.parse(await app.vault.adapter.read(".synovia/knowledge-graph.json")).state), "pending");
  record("stop-control-and-checkpoint", stopped);
  await page.screenshot({ path: join(root, "qa-stopped.png") });
  await page.evaluate(() => { window.synoviaQa.delay = 0; });
  await panel.getByRole("button", { name: /^继续整理/ }).click();
  await idle();
  const resumed = await job(stopTitle);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].id, stopped.id);
  assert.equal(resumed[0].state, "done");
  assert.equal(resumed[0].saved, true);
  record("resume-same-source", resumed[0]);

  const countBefore = await page.evaluate(() => ({ calls: window.synoviaQa.calls, files: app.vault.getMarkdownFiles().length }));
  await panel.getByRole("button", { name: "整理全库", exact: true }).click();
  await idle();
  const countAfter = await page.evaluate(() => ({ calls: window.synoviaQa.calls, files: app.vault.getMarkdownFiles().length }));
  assert.deepEqual(countAfter, countBefore);
  record("unchanged-vault-idempotence", countAfter);
  await page.evaluate(() => { window.synoviaQa.empty = true; });
  const emptyTitle = `QA-empty-${stamp}`;
  await submit(emptyTitle);
  await idle();
  const empty = (await job(emptyTitle))[0];
  assert.equal(empty.state, "done");
  assert.equal(empty.claims, 0);
  assert.equal(empty.saved, true);
  assert.match(await panel.locator(".synovia-progress").innerText(), /仅保留原文/);
  record("empty-extraction-keeps-original", empty);

  await tab("知识库");
  await panel.getByLabel("主题", { exact: true }).fill("QA-NO-SUCH-TOPIC");
  await panel.getByText("此主题暂无这类文件", { exact: true }).waitFor();
  await panel.getByLabel("主题", { exact: true }).fill("");
  await panel.getByLabel("主题", { exact: true }).fill("QA-NO-SUCH-TOPIC");
  await panel.getByText("此主题暂无这类文件", { exact: true }).waitFor();
  assert.equal(await panel.locator('.synovia-library-row a[href^="Wiki/Knowledge/"]').count(), 0);
  record("rapid-topic-filter", "No stale knowledge rows");
  await panel.getByLabel("主题", { exact: true }).fill("");
  const link = panel.locator(`a[href="${resumed[0].paths[0]}"]`);
  await link.waitFor();
  await link.click();
  await page.waitForFunction((path) => app.workspace.getActiveFile()?.path === path, resumed[0].paths[0]);
  await panel.getByRole("tab", { name: "证据", exact: true }).click();
  await panel.locator(`a[href="${resumed[0].snapshot}"]`).click();
  await page.waitForFunction((path) => app.workspace.getActiveFile()?.path === path, resumed[0].snapshot);
  record("knowledge-and-evidence-links", resumed[0].snapshot);

  await tab("维护");
  await panel.locator(".synovia-progress").filter({ hasText: /发现/ }).waitFor();
  await tab("工作台");
  assert.equal(await panel.locator(".synovia-progress").innerText(), "");
  record("tab-status-isolation", "Maintenance status does not leak to home");
  await tab("观点");
  await panel.getByText("当前材料尚未形成有证据支撑的跨来源结论。", { exact: true }).waitFor();
  for (const width of [330, 480]) {
    await page.evaluate(({ expected, width }) => {
      if (app.vault.adapter.basePath !== expected) throw Error("Wrong vault");
      app.workspace.rightSplit.expand();
      app.workspace.rightSplit.setSize(width);
    }, { expected: vault, width });
    await page.screenshot({ path: join(root, `qa-panel-${width}.png`) });
    const size = await panel.evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
    assert.ok(size.content <= size.width + 2, JSON.stringify(size));
    record(`sidebar-overflow-${width}`, size);
  }
  await tab("历史");
  await panel.locator(".synovia-library-row").first().waitFor();
  await tab("工作台");
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error);
  if (page) await page.screenshot({ path: join(root, "qa-failure.png") }).catch(() => {});
  throw error;
} finally {
  if (page && await page.evaluate(() => app.vault.adapter.basePath).catch(() => "") === vault) {
    await page.evaluate(() => {
      const plugin = app.plugins.getPlugin("synovia");
      plugin.cancel();
      if (window.synoviaQaSettings) plugin.settings = window.synoviaQaSettings;
      delete plugin.model;
      delete window.synoviaQaSettings;
      delete window.synoviaQa;
      plugin.refreshViews();
    }).catch(() => {});
  }
  await writeFile(join(root, "qa-attached-result.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
