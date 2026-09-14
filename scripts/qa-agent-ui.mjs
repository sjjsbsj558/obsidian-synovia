import assert from "node:assert/strict";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";

const execFileAsync = promisify(execFile);
const executable = process.env.OBSIDIAN_EXE ?? "E:\\Program Files (x86)\\obsidian\\Obsidian.exe";
const { chromium } = await import("playwright");
const root = resolve("output/playwright");
const run = join(root, `agent-${Date.now()}`);
const profile = join(run, "profile");
const vault = join(run, "vault");
const pluginPath = join(vault, ".obsidian/plugins/synovia");
await mkdir(profile, { recursive: true });
await mkdir(pluginPath, { recursive: true });
for (const name of ["main.js", "manifest.json", "styles.css"]) {
  await copyFile(name, join(pluginPath, name));
}
await writeFile(join(vault, "专注.md"), "远程工作减少打断，有利于需要持续专注的个人任务。");
await writeFile(join(vault, "同步.md"), "远程工作增加沟通等待，对需要频繁同步的团队任务未必有利。");
await writeFile(join(profile, "obsidian.json"), JSON.stringify({
  vaults: { "bbbbbbbbbbbbbbbb": { path: vault, ts: Date.now(), open: true } }, cli: true
}));
await writeFile(join(vault, ".obsidian/community-plugins.json"), JSON.stringify(["synovia"]));
await writeFile(join(vault, ".obsidian/app.json"), "{}");

const port = 19371;
const args = [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  "--remote-debugging-address=127.0.0.1", "--new-instance", "--disable-update", "--no-first-run", "--disable-gpu"
];
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const launch = `$p = Start-Process -FilePath ${quote(executable)} -ArgumentList @(${args.map(quote).join(",")}) -WindowStyle Hidden -PassThru; $p.Id`;
let appPid = 0;
let browser;
let page;
const hostDialogs = [];
try {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", launch], { windowsHide: true });
  appPid = Number(stdout.trim());
  const deadline = Date.now() + 120000;
  while (!browser && Date.now() < deadline) {
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
  assert.ok(browser, "Obsidian CDP did not start");
  const pageDeadline = Date.now() + 30000;
  while (Date.now() < pageDeadline && !page) {
    for (const entry of browser.contexts()[0]?.pages() ?? []) {
      if (!entry.url().startsWith("app://obsidian.md")) continue;
      if (await entry.evaluate((expected) => window.app?.vault?.adapter?.basePath === expected, vault).catch(() => false)) {
        page = entry;
        break;
      }
    }
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(page, "Obsidian vault window did not open");
  await page.waitForFunction(() => window.app?.workspace?.layoutReady, { timeout: 30000 });
  await page.addLocatorHandler(page.locator(".modal-container:has(.setting-item)").last(), async (modal) => {
    hostDialogs.push((await modal.innerText()).slice(0, 3000));
    await modal.locator(".modal-close-button").click();
  });
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
  await page.evaluate(async () => {
    localStorage.setItem(`enable-plugin-${window.app.appId}`, "true");
    await window.app.plugins.enablePluginAndSave("synovia");
    await window.app.plugins.getPlugin("synovia").activateView();
  });
  await page.locator(".synovia-agent").waitFor();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const input = page.getByLabel("你想判断什么？", { exact: true });
  await input.fill("远程工作适合什么任务？");
  await page.evaluate(() => {
    const plugin = window.app.plugins.getPlugin("synovia");
    plugin.settings.allowRemote = true;
    plugin.settings.modelName = "offline-ui-agent";
    plugin.searchZhihu = async () => [];
    plugin.model = () => ({
      identity: "offline-ui-agent",
      fits: () => true,
      evidenceQuote: (quote, original) => original.includes(quote) ? quote : undefined,
      async json(system, input, schema) {
        return schema.parse({
          title: "远程工作适用边界",
          stance: "取决于条件",
          answer: "远程工作更适合需要持续专注、同步频率较低的任务；高频协作任务需要额外沟通机制。",
          evidence: [
            { source: 1, quote: "远程工作减少打断，有利于需要持续专注的个人任务。" },
            { source: 2, quote: "远程工作增加沟通等待，对需要频繁同步的团队任务未必有利。" }
          ],
          tensions: ["个人专注和团队同步之间存在条件差异"],
          questions: ["团队同步频率是否足以抵消反馈延迟？"]
        });
      }
    });
  });
  await page.getByRole("button", { name: "形成观点", exact: true }).click();
  const confirm = page.getByRole("button", { name: "开始处理", exact: true });
  if (await confirm.count()) await confirm.click();
  await page.getByText("远程工作适用边界", { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByText("取决于条件", { exact: true }).count(), 1);
  assert.ok(await page.getByText("远程工作减少打断，有利于需要持续专注的个人任务。", { exact: true }).count());
  await page.getByRole("button", { name: "保存到 Wiki", exact: true }).click();
  await page.getByRole("link", { name: "打开已保存的观点", exact: true }).waitFor();
  const saved = await page.evaluate(() => window.app.vault.getMarkdownFiles()
    .map((file) => file.path).find((path) => path.startsWith("Wiki/Opinions/")));
  assert.match(saved ?? "", /^Wiki\/Opinions\//u);
  await page.getByRole("link", { name: "打开已保存的观点", exact: true }).click();
  await page.waitForFunction((path) => window.app.workspace.getActiveFile()?.path === path, saved);
  while (await page.locator(".modal-container").count()) {
    const modal = page.locator(".modal-container").last();
    const close = modal.locator(".modal-close-button");
    if (!(await close.count())) break;
    await close.last().click({ force: true });
    await modal.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  }

  await page.evaluate(() => {
    const plugin = window.app.plugins.getPlugin("synovia");
    const model = plugin.model();
    window.synoviaQa = { delay: true, started: false, failure: false, calls: 0 };
    plugin.model = () => ({
      ...model,
      async json(system, input, schema, signal) {
        const qa = window.synoviaQa;
        qa.calls++;
        qa.started = true;
        if (qa.delay) await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 60000);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
        signal.throwIfAborted();
        if (qa.failure) throw new Error("QA 模型暂时不可用");
        if (input.sources) {
          return schema.parse({
            title: "远程工作适用边界",
            stance: "取决于条件",
            answer: "远程工作更适合需要持续专注、同步频率较低的任务；高频协作任务需要额外沟通机制。",
            evidence: input.sources.slice(0, 2).map((source) => ({
              source: source.id,
              quote: source.content
            })),
            tensions: ["个人专注和团队同步之间存在条件差异"],
            questions: ["团队同步频率是否足以抵消反馈延迟？"]
          });
        }
        return model.json(system, input, schema, signal);
      }
    });
  });
  await input.fill("高频沟通的团队也适合远程工作吗？");
  await page.getByRole("button", { name: "形成观点", exact: true }).click();
  await page.waitForFunction(() => window.synoviaQa.started);
  const stop = page.getByRole("button", { name: "停止任务", exact: true });
  assert.equal(await stop.isEnabled(), true, "Stop must remain enabled during a request");
  assert.equal(await input.isDisabled(), true);
  await stop.click();
  await page.locator(".synovia-agent-status").filter({ hasText: "已停止" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "形成观点", exact: true }).isEnabled(), true);
  assert.equal(await page.locator(".synovia-agent-result").count(), 0, "Cancelled question must not display the previous answer");

  await page.evaluate(() => Object.assign(window.synoviaQa, { delay: false, failure: true }));
  await page.getByRole("button", { name: "形成观点", exact: true }).click();
  await page.locator(".synovia-agent-status").filter({ hasText: "QA 模型暂时不可用" }).waitFor();
  assert.equal(await page.locator(".synovia-agent-result").count(), 0);
  await page.evaluate(() => { window.synoviaQa.failure = false; });
  await page.getByRole("button", { name: "形成观点", exact: true }).click();
  await page.getByRole("button", { name: "保存到 Wiki", exact: true }).waitFor();
  await page.getByRole("button", { name: "保存到 Wiki", exact: true }).click();
  await page.getByRole("link", { name: "打开已保存的观点", exact: true }).waitFor();
  const savedPaths = await page.evaluate(() => window.app.vault.getMarkdownFiles()
    .map((file) => file.path).filter((path) => path.startsWith("Wiki/Opinions/")));
  assert.equal(savedPaths.length, 2, "A second answer must not overwrite the first saved note");
  assert.equal(await readFile(join(vault, "专注.md"), "utf8"), "远程工作减少打断，有利于需要持续专注的个人任务。");
  assert.equal(await readFile(join(vault, "同步.md"), "utf8"), "远程工作增加沟通等待，对需要频繁同步的团队任务未必有利。");
  assert.deepEqual(errors, []);
  const overflow = await page.locator(".synovia-agent").evaluate((element) => ({
    width: element.clientWidth, content: element.scrollWidth
  }));
  assert.ok(overflow.content <= overflow.width + 2, JSON.stringify(overflow));
  await page.screenshot({ path: join(root, "agent-desktop.png") });
  await writeFile(join(run, "qa-result.json"), JSON.stringify({
    environment: "Isolated Obsidian vault; synthetic notes; offline model and search fixtures",
    saved, savedPaths, cancellation: true, failureRecovery: true, originalsUnchanged: true, overflow, errors, hostDialogs
  }, null, 2));
  console.log(await readFile(join(run, "qa-result.json"), "utf8"));
} catch (error) {
  const state = page && await page.evaluate(() => ({
    text: document.body.innerText,
    modals: [...document.querySelectorAll(".modal-container")].map((modal) => modal.innerText),
    status: document.querySelector(".synovia-agent-status")?.textContent,
    busy: window.app?.plugins?.getPlugin("synovia")?.isBusy(),
    fixture: window.synoviaQa
  })).catch(() => undefined);
  if (page) await page.screenshot({ path: join(run, "failure.png") }).catch(() => {});
  await writeFile(join(run, "failure.json"), JSON.stringify({ failure: String(error), state, hostDialogs }, null, 2));
  console.error("Failure evidence:", run);
  throw error;
} finally {
  if (browser) await browser.close();
  if (appPid > 0) await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Stop-Process -Id ${appPid} -Force -ErrorAction SilentlyContinue`
  ], { windowsHide: true }).catch(() => {});
}
