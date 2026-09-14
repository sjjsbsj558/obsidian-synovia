import assert from "node:assert/strict";
import { copyFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve("output/playwright/real-manual");
const vault = join(root, "vault");
const browser = await chromium.connectOverCDP("http://127.0.0.1:19363");
const report = { environment: "Installed Obsidian; isolated vault; real Zhihu CLI; no model", checks: [], errors: [] };
let page, settings;
const record = (name, evidence) => {
  report.checks.push({ name, evidence });
  console.log(name, JSON.stringify(evidence));
};
try {
  page = browser.contexts()[0].pages().find((entry) => entry.url() === "app://obsidian.md/index.html");
  assert.ok(page, "No vault page");
  assert.equal(await page.evaluate(() => app.vault.adapter.basePath), vault, "Refuse production vault");
  assert.equal(await page.evaluate(() => app.plugins.getPlugin("synovia").isBusy()), false);
  settings = await page.evaluate(() => ({ ...app.plugins.getPlugin("synovia").settings }));
  for (const file of ["main.js", "styles.css", "manifest.json"]) {
    await copyFile(file, join(vault, ".obsidian/plugins/synovia", file));
  }
  await page.evaluate(async (expected) => {
    if (app.vault.adapter.basePath !== expected) throw Error("Wrong vault");
    await app.plugins.disablePlugin("synovia");
    await app.plugins.enablePluginAndSave("synovia");
    const plugin = app.plugins.getPlugin("synovia");
    Object.assign(plugin.settings, { allowRemote: true, autoOptimize: false, modelName: "", zhihuMode: "cli", zhihuCommand: "zhihu-cli", zhihuCount: 2 });
    await plugin.activateView();
  }, vault);
  page.on("pageerror", (error) => report.errors.push(error.message));
  const panel = page.locator(".synovia-workbench");
  const idle = () => page.waitForFunction(() => !app.plugins.getPlugin("synovia").isBusy()
    && document.querySelector(".synovia-workbench")?.getAttribute("aria-busy") === "false", null, { timeout: 120000 });
  const submit = async (input) => {
    await panel.getByRole("textbox", { name: "主题、问题、链接或 Markdown", exact: true }).fill(input);
    await panel.getByRole("combobox", { name: "归入主题", exact: true }).fill("");
    await panel.getByRole("button", { name: "开始处理", exact: true }).click();
    await idle();
    return panel.locator(".synovia-progress").innerText();
  };
  const diagnostic = async (name) => {
    await panel.getByText("更多来源与诊断", { exact: true }).click();
    await panel.getByRole("button", { name, exact: true }).click();
    await idle();
    return panel.locator(".synovia-progress").innerText();
  };
  const connection = await diagnostic("检查知乎 CLI");
  assert.match(connection, /CLI 已配置.*仅本地检查，未在线验证/u);
  record("real-cli-diagnostic", connection);
  const quota = await diagnostic("知乎接口额度");
  assert.match(quota, /知乎搜索：\d+ \/ \d+/u);
  record("real-quota", quota);

  await page.evaluate(() => { app.plugins.getPlugin("synovia").settings.zhihuCommand = "C:\\Synovia-QA-Missing\\zhihu-cli.exe"; });
  const failure = await submit("光伏组件 积雪清理");
  assert.match(failure, /知乎自动补充失败.*找不到知乎 CLI/u);
  assert.match(failure, /未取得可处理材料/u);
  assert.doesNotMatch(failure, /完成 0\/0/u);
  assert.equal(await panel.getByRole("button", { name: "开始处理", exact: true }).isEnabled(), true);
  record("missing-cli-visible-and-retryable", failure);
  await page.screenshot({ path: join(root, "zhihu-failure-fixed.png") });

  const text = `QA plain paragraph ${Date.now()}. ` + "This is synthetic material without Markdown markers. ".repeat(5);
  await submit(text);
  const material = await page.evaluate((text) => {
    const job = [...app.plugins.getPlugin("synovia").jobs.values()].find((entry) =>
      entry.source.fullContent?.startsWith(text.slice(0, 48)));
    return job && { state: job.state, saved: !!app.vault.getFileByPath(job.resource) && !!app.vault.getFileByPath(job.snapshot) };
  }, text);
  assert.deepEqual(material, { state: "pending", saved: true });
  record("plain-paragraph-saved", material);
  const question = await submit("How does remote work affect focus?");
  assert.doesNotMatch(question, /主题名需/u);
  const active = await page.evaluate(async () => ({ path: app.workspace.getActiveFile()?.path, content: await app.vault.read(app.workspace.getActiveFile()) }));
  assert.doesNotMatch(active.path, /\?/u);
  assert.match(active.content, /How does remote work affect focus\?/u);
  record("question-punctuation-safe", active.path);

  await page.evaluate(() => { app.plugins.getPlugin("synovia").settings.zhihuCommand = "zhihu-cli"; });
  const success = await submit("光伏组件 积雪清理");
  assert.match(success, /已自动补充 \d+ 条知乎来源/u);
  assert.doesNotMatch(success, /知乎自动补充失败/u);
  const sources = await page.evaluate(() => [...app.plugins.getPlugin("synovia").jobs.values()]
    .filter((job) => job.source.sourceType === "zhihu_search_hit" && job.topics.includes(app.workspace.getActiveFile()?.path))
    .map((job) => ({ id: job.source.id, title: job.source.title, completeness: job.source.evidenceCompleteness,
      saved: !!app.vault.getFileByPath(job.resource) && !!app.vault.getFileByPath(job.snapshot), state: job.state })));
  assert.ok(sources.length > 0);
  assert.ok(sources.every((source) => source.saved && source.completeness === "snippet" && source.state === "pending"));
  record("same-topic-real-recovery", { message: success, sources });
  await page.screenshot({ path: join(root, "zhihu-recovery-fixed.png") });
  for (const width of [330, 480]) {
    await page.evaluate((width) => { app.workspace.rightSplit.expand(); app.workspace.rightSplit.setSize(width); }, width);
    const size = await panel.evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
    assert.ok(size.content <= size.width + 2);
    record(`zhihu-panel-${width}`, size);
    await page.screenshot({ path: join(root, `zhihu-panel-${width}.png`) });
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error);
  throw error;
} finally {
  if (settings && page && await page.evaluate(() => app.vault.adapter.basePath).catch(() => "") === vault) {
    await page.evaluate((settings) => {
      const plugin = app.plugins.getPlugin("synovia");
      plugin.cancel();
      plugin.settings = settings;
      plugin.refreshViews();
    }, settings);
  }
  await writeFile(join(root, "qa-zhihu-result.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
