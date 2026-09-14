import assert from "node:assert/strict";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection, createServer } from "node:net";

const execFileAsync = promisify(execFile);
const executable = process.env.OBSIDIAN_EXE;
if (!executable) throw new Error("Set OBSIDIAN_EXE to the installed Obsidian executable.");
const { chromium } = await import("playwright");
const root = resolve("output/playwright");
const run = join(root, `run-${Date.now()}`);
const profile = join(run, "profile");
const vault = join(run, "vault");
await mkdir(profile, { recursive: true });
await mkdir(join(vault, ".obsidian/plugins/synovia"), { recursive: true });
for (const name of ["main.js", "manifest.json", "styles.css"]) await copyFile(name, join(vault, ".obsidian/plugins/synovia", name));
await writeFile(join(profile, "obsidian.json"), JSON.stringify({
  vaults: { "aaaaaaaaaaaaaaaa": { path: vault, ts: Date.now(), open: true } }, cli: true
}));
await writeFile(join(vault, ".obsidian/community-plugins.json"), JSON.stringify(["synovia"]));
await writeFile(join(vault, ".obsidian/app.json"), JSON.stringify({}));
await writeFile(join(vault, "甲的观点.md"), "远程工作减少打断，有利于需要持续专注的个人任务。");
await writeFile(join(vault, "乙的观点.md"), "远程工作增加沟通等待，对需要频繁同步的团队任务未必有利。");
await writeFile(join(vault, "公式与表格.md"),
  `# 验证样本

$$
f(x)=x^2
$$

| 指标 | 结果 |
| --- | --- |
| 准确率 | 0.8 |
`);
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(selected));
  });
});
const launchArgs = [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  "--remote-debugging-address=127.0.0.1",
  "--new-instance",
  "--disable-update",
  "--no-first-run",
  "--disable-gpu"
];
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
const launch = `$p = Start-Process -FilePath ${psQuote(executable)} -ArgumentList @(${launchArgs.map(psQuote).join(",")}) -WindowStyle Hidden -PassThru; $p.Id`;
let appPid = 0;
const startApp = async () => {
  const { stdout: pidText } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", launch
  ], { windowsHide: true });
  appPid = Number(pidText.trim());
};
await startApp();
let browser;
try {
  const end = Date.now() + 180000;
  while (!browser && Date.now() < end) {
    try {
      await new Promise((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("error", (error) => { socket.destroy(); reject(error); });
      });
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!browser) {
    const logPath = join(profile, "obsidian.log");
    const log = await readFile(logPath, "utf8").catch(() => "");
    throw new Error([
      "Obsidian CDP did not start",
      `appPid=${appPid}`,
      `port=${port}`,
      `profile=${profile}`,
      log ? `obsidian.log:\n${log.slice(-6000)}` : "obsidian.log: unavailable"
    ].join("\n"));
  }
  let page;
  while (Date.now() < end) {
    for (const candidate of browser.contexts()[0]?.pages() ?? []) {
      if (!candidate.url().startsWith("app://obsidian.md")) continue;
      if (await candidate.evaluate((expected) => window.app?.vault?.adapter?.basePath === expected, vault).catch(() => false)) {
        page = candidate;
        break;
      }
    }
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!page) {
    const logPath = join(profile, "obsidian.log");
    const log = await readFile(logPath, "utf8").catch(() => "");
    throw new Error([
      "Obsidian vault window did not open",
      `appPid=${appPid}`,
      `port=${port}`,
      `profile=${profile}`,
      log ? `obsidian.log:\n${log.slice(-6000)}` : "obsidian.log: unavailable"
    ].join("\n"));
  }
  await page.waitForFunction(() => window.app?.workspace?.layoutReady, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.app.vault.getName()), "vault");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  console.log((await page.locator("body").innerText()).slice(0, 1800));
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
  const enable = page.getByRole("button", { name: "开启", exact: true });
  if (await enable.count()) await enable.last().click();
  await page.evaluate(async () => {
    localStorage.setItem(`enable-plugin-${window.app.appId}`, "true");
    await window.app.plugins.enablePluginAndSave("synovia");
    const plugin = window.app.plugins.getPlugin("synovia");
    if (!plugin) throw new Error("Synovia 插件未加载");
    await plugin.activateView();
  });
  await page.locator('.workspace-tab-header[data-type="synovia-workbench"]').waitFor();
  await page.screenshot({ path: join(root, "workbench-desktop.png") });
  const result = await page.evaluate(async () => {
    const plugin = window.app.plugins.getPlugin("synovia");
    const calls = [];
    plugin.settings.modelName = "offline-ui-fixture";
    plugin.model = () => ({
      identity: "offline-ui-fixture", fits: () => true,
      evidenceQuote: (quote, original) => original.includes(quote) ? quote : undefined,
      async json(system, input, schema) {
        calls.push(input);
        const result = input.blocks ? { claims: input.blocks.filter((block) => block.type === "paragraph").slice(0, 2).map((block) => ({
          statement: block.text, stance: "neutral", preconditions: [], quote: block.text,
          evidenceBlockIds: [block.id], confidence: 0.7
        })) } : { findings: [{
          kind: "conditions", statement: "远程工作的收益取决于个人专注和团队同步的不同条件。",
          reasoning: "甲强调减少打断，乙强调反馈延迟。二者讨论不同任务，不能直接归为普遍支持或反对。",
          citations: input.units.slice(0, 2).map((unit) => ({ id: unit.id, quote: unit.quote })),
          question: "团队的同步频率和沟通制度是什么？"
        }] };
        return schema.parse(result);
      }
    });
    await plugin.optimizeVault(() => {});
    const first = calls.length;
    await plugin.optimizeVault(() => {});
    return { graph: plugin.graph, first, repeated: calls.length, jobs: [...plugin.jobs.values()].map((job) => job.state) };
  });
  assert.equal(result.graph.state, "done");
  assert.equal(result.graph.findings.length, 1);
  assert.ok(result.jobs.every((state) => state === "done"));
  assert.equal(result.first, result.repeated);
  assert.ok(result.graph.sourceCount >= 2);
  assert.ok(result.graph.findings.every((finding) => finding.citations.length >= 2));
  await page.locator(".synovia-agent").waitFor();
  const input = page.getByLabel("你想判断什么？", { exact: true });
  await input.fill("远程工作适合什么任务？");
  await page.evaluate(() => {
    const plugin = window.app.plugins.getPlugin("synovia");
    plugin.settings.allowRemote = true;
    plugin.settings.modelName = "offline-ui-agent";
    plugin.model = () => ({
      identity: "offline-ui-agent",
      fits: () => true,
      evidenceQuote: (quote, original) => original.includes(quote) ? quote : undefined,
      async json(system, input, schema) {
        return schema.parse(input.sources ? {
          title: "远程工作适用边界",
          stance: "取决于条件",
          answer: "远程工作更适合需要持续专注、同步频率较低的任务；高频协作任务需要额外沟通机制。",
          evidence: [
            { source: 1, quote: "远程工作减少打断，有利于需要持续专注的个人任务。" },
            { source: 2, quote: "远程工作增加沟通等待，对需要频繁同步的团队任务未必有利。" }
          ],
          tensions: ["个人专注和团队同步之间存在条件差异"],
          questions: ["团队同步频率是否足以抵消反馈延迟？"]
        } : {});
      }
    });
  });
  await page.getByRole("button", { name: "形成观点", exact: true }).click();
  await page.getByText("远程工作适用边界", { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByText("取决于条件", { exact: true }).count(), 1);
  assert.equal(await page.getByText("远程工作减少打断，有利于需要持续专注的个人任务。", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "保存到 Wiki", exact: true }).click();
  await page.getByRole("link", { name: "打开已保存的观点", exact: true }).waitFor();
  const evidencePath = await page.evaluate(() => window.app.vault.getMarkdownFiles()
    .map((file) => file.path).find((path) => path.startsWith("Wiki/Opinions/")));
  assert.ok(evidencePath?.startsWith("Wiki/Opinions/"));
  await page.screenshot({ path: join(root, "opinion-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.app.workspace.leftSplit.collapse();
    window.app.workspace.rightSplit.expand();
    window.app.workspace.rightSplit.setSize(330);
  });
  await page.screenshot({ path: join(root, "network-narrow.png") });
  const overflow = await page.locator(".synovia-agent").evaluate((element) => ({
    width: element.clientWidth, content: element.scrollWidth
  }));
  assert.ok(overflow.content <= overflow.width + 2, JSON.stringify(overflow));
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.evaluate(async () => {
    await window.app.workspace.openLinkText("公式与表格.md", "", false);
    const leaf = window.app.workspace.getMostRecentLeaf();
    await leaf.setViewState({ type: "markdown", state: { file: "公式与表格.md", mode: "preview" } });
  });
  await page.locator(".markdown-preview-view .math-block").waitFor();
  assert.ok(await page.locator(".markdown-preview-view table").count());
  await page.screenshot({ path: join(root, "native-math-table.png") });
  assert.deepEqual(errors, []);
  await writeFile(join(root, "qa-result.json"), JSON.stringify({
    environment: "Installed Obsidian with isolated synthetic vault and offline model fixture",
    sources: 3, modelCalls: result.first, repeatCalls: result.repeated - result.first,
    evidencePath, overflow, errors
  }, null, 2));
  console.log(await readFile(join(root, "qa-result.json"), "utf8"));
} finally {
  if (browser) {
    await browser.close();
  }
  if (Number.isInteger(appPid) && appPid > 0) {
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Stop-Process -Id ${appPid} -Force -ErrorAction SilentlyContinue`
    ], { windowsHide: true }).catch(() => {});
  }
}
