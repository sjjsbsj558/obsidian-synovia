import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCliInvocation, ZhihuCliClient, resolveCliCommand } from "../src/sources/zhihuCliClient";

async function withCliFixture(fixture: string, check: (client: ZhihuCliClient) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "synovia-cli-"));
  const original = process.env.NODE_OPTIONS;
  try {
    const file = join(directory, "fixture.cjs");
    await writeFile(file, fixture);
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(file)}`;
    await check(new ZhihuCliClient(process.execPath));
  } finally {
    if (original === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = original;
    await rm(directory, { recursive: true, force: true });
  }
}

test("CLI adapter uses current flags and model names without a shell", async () => {
  // A Node executable stub validates arguments without network requests or credentials.
  const fixture = `
const assert = require("node:assert/strict");
const args = process.argv.slice(1);
args[0] = require("node:path").basename(args[0]);
assert.ok(args.includes("--timeout"));
if (args[0] === "search") {
  assert.equal(args[2], "--query");
  assert.equal(args[3], "test & query");
  if (args[1] === "global") assert.ok(args.includes("--search-db"));
  console.log(JSON.stringify({Code:0, Data:{Items:[]}}));
} else if (args[0] === "answer") {
  assert.equal(args[1], "--query");
  assert.equal(args[4], "zhida-thinking-1p5");
  console.log(JSON.stringify({choices:[{message:{content:"ok"}}]}));
} else if (args[0] === "hot") {
  console.log(JSON.stringify({Code:0, Data:{Items:[]}}));
} else throw new Error("Unexpected command");
process.exit(0);
`;
  await withCliFixture(fixture, async (client) => {
    assert.deepEqual(await client.searchZhihu("test & query", 3, "", 5000), []);
    assert.deepEqual(await client.searchGlobal("test & query", 3, "", "all", "", 5000), []);
    assert.equal((await client.ask("test & query", "thinking", "", 5000)).source.fullContent, "ok");
    assert.deepEqual(await client.hot(1, "", 5000), []);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.searchZhihu("test & query", 3, "", 5000, controller.signal));
  });
});

test("CLI discovery follows official user directories and never falls back to PATH", async () => {
  const home = await mkdtemp(join(tmpdir(), "synovia-path-"));
  try {
    const relative = process.platform === "win32" ? ["AppData", "Local", "ZhihuCLI"]
      : process.platform === "darwin" ? ["Library", "Application Support", "zhihu-cli"] : [".local", "share", "zhihu-cli"];
    const cliHome = join(home, ...relative);
    const binary = process.platform === "win32" ? "zhihu-cli.exe" : "zhihu-cli";
    await mkdir(join(cliHome, "current"), { recursive: true });
    const installed = join(cliHome, "current", binary);
    await writeFile(installed, "");
    assert.equal(resolveCliCommand("zhihu-cli", {}, home), installed);
    assert.equal(resolveCliCommand(' "zhihu" ', {}, home), installed);
    assert.equal(resolveCliCommand("zhihu-cli", { ZHIHU_CLI_HOME: cliHome }, home), installed);
    assert.equal(resolveCliCommand(`"${process.execPath}"`, {}, home), process.execPath);
    assert.throws(() => resolveCliCommand("zhihu-cli", { ZHIHU_CLI_HOME: join(home, "missing") }, home), /binary_path/u);
    assert.throws(() => resolveCliCommand("zhihu-cli", { ZHIHU_CLI_HOME: "relative" }, home), /绝对路径/u);
    await mkdir(join(home, "directory", "current", binary), { recursive: true });
    assert.throws(() => resolveCliCommand("zhihu-cli", { ZHIHU_CLI_HOME: join(home, "directory") }, home), /找不到/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI normalizers keep valid results when one item is dirty", async () => {
  await withCliFixture(`
const args = process.argv.slice(1);
const command = require("node:path").basename(args[0] ?? "");
if (command === "search") console.log(JSON.stringify({Code:0, Data:{Items:[
  {Title:"ok", ContentType:"answer", ContentID:"1", ContentText:"摘要", Url:"https://www.zhihu.com/answer/1"},
  {Title:null}
]}}));
else if (command === "question") console.log(JSON.stringify({Code:0, Data:{Items:[
  null, {Url:"javascript:alert(1)", Summary:"unsafe"}, {Url:"https://www.zhihu.com/answer/1", Summary:"valid summary"}
]}}));
else console.log(JSON.stringify({Code:0, Data:{Items:[]}}));
process.exit(0);
`, async (client) => {
    const results = await client.searchZhihu("知识管理", 2, "", 5000);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "ok");
    const answers = await client.answers("https://www.zhihu.com/question/42", "", 5000);
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.contentSnippet, "valid summary");
  });
});

test("CLI preserves metacharacters literally and rejects cmd/bat wrappers", async () => {
  for (const command of ['"C:\\Program Files\\zhihu.cmd"', "wrapper.BAT"]) {
    assert.throws(() => buildCliInvocation(command, ["%ZHIHU_ACCESS_SECRET% & echo"], "win32"), /包装脚本/u);
  }
  const query = 'test "%ZHIHU_ACCESS_SECRET%" !secret! & | < > ^ $(echo) \n tail';
  assert.deepEqual(buildCliInvocation(process.execPath, [query]).args, [query]);
  await withCliFixture(`
const assert = require("node:assert/strict");
assert.equal(process.argv[4], ${JSON.stringify(query)});
assert.ok(!process.argv.includes("fixture-secret"));
assert.equal(process.env.ZHIHU_ACCESS_SECRET, "fixture-secret");
console.log('{"Code":0,"Data":{"Items":[]}}');
process.exit(0);
`, async (client) => {
    assert.deepEqual(await client.searchZhihu(query, 1, "fixture-secret", 5000), []);
  });
});

test("CLI auth diagnostics use explicit credentials and do not claim online verification", async () => {
  await withCliFixture(`
const assert = require("node:assert/strict");
assert.equal(require("node:path").basename(process.argv[1]), "auth");
assert.equal(process.argv[2], "status");
assert.ok(!process.argv.includes("--verify"));
const explicit = process.env.ZHIHU_ACCESS_SECRET === "fixture-secret";
console.log(JSON.stringify({ok:true, source:explicit ? "environment" : "keychain",
  environment_shadows_keychain:explicit, masked:"fixture-secret", verification:"not_performed"}));
process.exit(0);
`, async (client) => {
    assert.match(await client.connection(5000), /仅本地检查，未在线验证/u);
    const result = await client.connection(5000, "fixture-secret");
    assert.match(result, /插件设置/u);
    assert.match(result, /覆盖系统凭据库/u);
    assert.doesNotMatch(result, /fixture-secret/u);
  });
});

test("CLI errors read stable codes without exposing stdout, stderr, query, or secrets", async () => {
  const fixtures = [
    { output: { ok: false, error: { code: "AUTH_INVALID", message: "fixture-secret" } }, exit: 3, match: /AUTH_INVALID/u },
    { output: { Code: 30002, Message: "fixture-secret" }, exit: 4, match: /30002/u },
    { output: { Code: 20001, Message: "fixture-secret" }, exit: 0, match: /20001/u },
    { output: { ok: false, error: { code: "ENV_SHADOWS_KEYCHAIN", message: "fixture-secret" } }, exit: 3, match: /ENV_SHADOWS_KEYCHAIN/u },
    { output: { ok: false, error: { code: "fixture-secret", message: "fixture-secret" } }, exit: 6, match: /请求失败/u },
    { output: undefined, exit: 4, match: /频率或配额/u }
  ];
  for (const fixture of fixtures) {
    await withCliFixture(`
console.error("Bearer fixture-secret; private-query");
${fixture.output === undefined ? "" : `console.log(${JSON.stringify(JSON.stringify(fixture.output))});`}
process.exit(${fixture.exit});
`, async (client) => {
      await assert.rejects(client.searchZhihu("private-query", 1, "fixture-secret", 5000), (error: Error) => {
        assert.match(error.message, fixture.match);
        assert.doesNotMatch(error.message, /fixture-secret|private-query|Bearer/u);
        return true;
      });
    });
  }
  await withCliFixture('console.log("not-json fixture-secret"); process.exit(0);', async (client) => {
    await assert.rejects(client.hot(1, "", 5000), /有效 JSON/u);
  });
});

test("CLI aborts running work and bounds hung processes by timeout", async () => {
  await withCliFixture('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);', async (client) => {
    const controller = new AbortController();
    const work = client.searchZhihu("cancel query", 1, "", 5000, controller.signal);
    const timer = setTimeout(() => controller.abort(), 200);
    try { await assert.rejects(work, { name: "AbortError" }); }
    finally { clearTimeout(timer); }
    await assert.rejects(client.hot(1, "", 200), /超时/u);
    await assert.rejects(client.hot(1, "", Number.NaN), /正数/u);
  });
});
