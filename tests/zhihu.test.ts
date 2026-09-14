import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { normalizeSearchResponse, ZhihuSearchApiClient, zhihuError } from "../src/sources/zhihuSearchApiClient";
import { normalizeHotResponse } from "../src/sources/zhihuCliClient";
import { parseMcpSearchText, searchZhihuMcp, validateMessageEndpoint } from "../src/sources/zhihuMcpSseClient";
import type { Request } from "../src/utils/http";

const hit = {
  Title: "<em>Title</em>", ContentType: "answer", ContentID: "42", ContentText: "<em>Snippet</em>",
  Url: "https://www.zhihu.com/answer/42"
};

function reply(json: unknown, status = 200): Awaited<ReturnType<Request>> {
  return { status, headers: {}, json, text: JSON.stringify(json), arrayBuffer: new ArrayBuffer(0) };
}

test("search and hot normalization skip dirty entries without weakening envelope validation", () => {
  const result = normalizeSearchResponse({ Code: 0, Data: { Items: [
    null, {}, { ...hit, Url: "javascript:alert(1)" }, { ...hit, Url: "https://user:password@example.com" },
    { ...hit, Title: " " }, { ...hit, ContentText: "<em> </em>" }, hit,
    { ...hit, ContentID: "43" }, { ...hit, Title: "x".repeat(301) }
  ] } }, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.title, "Title");
  assert.equal(result[0]?.contentSnippet, "Snippet");
  assert.equal(result[0]?.evidenceCompleteness, "snippet");
  assert.throws(() => normalizeSearchResponse({ Code: 0, Data: { Items: null } }));
  assert.throws(() => normalizeSearchResponse({ Data: { Items: [] } }));
  assert.deepEqual(normalizeSearchResponse({ Code: 0, Data: { Items: [] } }), []);
  const hot = normalizeHotResponse({ Code: 0, Data: { Items: [
    null, { Title: "Unsafe", Url: "file:///secret" }, { Title: "Hot", Url: hit.Url }
  ] } });
  assert.equal(hot.length, 1);
  assert.equal(hot[0]?.contentSnippet, "Hot");
  for (const code of [20001, 30001, 30002]) {
    assert.throws(() => normalizeSearchResponse({ Code: code, Message: "opaque-fixture-secret" }), new RegExp(String(code)));
    assert.throws(() => normalizeHotResponse({ Code: code }), new RegExp(String(code)));
  }
  assert.doesNotMatch(zhihuError("opaque-fixture-secret", "Service failed").message, /opaque-fixture-secret/u);
});

test("API validates inputs, encodes query, preserves auth headers, and honors cancellation", async () => {
  let calls = 0;
  const client = new ZhihuSearchApiClient(async (options) => {
    calls++;
    assert.equal(new URL(options.url).searchParams.get("Query"), "test & query");
    assert.equal(options.headers?.Authorization, "Bearer opaque-fixture-secret");
    assert.match(options.headers?.["X-Request-Timestamp"] ?? "", /^\d+$/u);
    assert.equal(options.throw, false);
    return reply({ Code: 0, Data: { Items: [hit] } });
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.search("test & query", 1, "opaque-fixture-secret", 1000, controller.signal), { name: "AbortError" });
  await assert.rejects(client.search("x", 1, "opaque-fixture-secret", 1000));
  await assert.rejects(client.search("test", 1, "", 1000), /AUTH_REQUIRED/u);
  assert.equal(calls, 0);
  assert.equal((await client.search("test & query", 1, "opaque-fixture-secret", 1000)).length, 1);
  await assert.rejects(client.search("test & query", 1, "opaque-fixture-secret", 1000), /间隔一秒/u);
  assert.equal(calls, 1);
  const active = new AbortController();
  const waiting = new ZhihuSearchApiClient(async () => new Promise(() => {}))
    .search("test", 1, "opaque-fixture-secret", 1000, active.signal);
  active.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("API auth and quota errors are not retried or exposed as empty results", async () => {
  for (const [status, code] of [[401, 0], [403, 0], [429, 0], [200, 20001], [200, 30001], [200, 30002]]) {
    let calls = 0;
    const client = new ZhihuSearchApiClient(async () => {
      calls++;
      return reply({ Code: code, error: { message: "opaque-fixture-secret" }, Message: "opaque-fixture-secret" }, status);
    });
    await assert.rejects(client.search("test", 1, "opaque-fixture-secret", 1000), (error: Error) => {
      assert.doesNotMatch(error.message, /opaque-fixture-secret/u);
      assert.match(error.message, /鉴权|频率|配额|频繁/u);
      return true;
    });
    assert.equal(calls, 1);
  }
  const client = new ZhihuSearchApiClient(async () => { throw new Error("opaque-fixture-secret"); });
  await assert.rejects(client.search("test", 1, "opaque-fixture-secret", 1000), /NETWORK_ERROR/u);
});

const endpoint = "/api/mcp/zhihu_search/v1/message?sessionId=fixture-session";
function event(stream: PassThrough, name: string, data: unknown): void {
  stream.write(`event: ${name}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

async function withMcp(
  options: {
    status?: number;
    contentType?: string;
    onOpen?: (stream: PassThrough) => void;
    onPost?: (body: { id?: number; method: string }, stream: PassThrough) => void;
  },
  check: (request: Request, posts: string[], destroyed: () => boolean) => Promise<void>
): Promise<void> {
  const original = https.request;
  const stream = Object.assign(new PassThrough(), {
    statusCode: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "text/event-stream" }
  });
  let closed = false;
  const connection = Object.assign(new EventEmitter(), {
    end() {},
    destroy() { closed = true; stream.destroy(); return connection; }
  });
  https.request = ((_url: unknown, headers: https.RequestOptions, callback: (value: unknown) => void) => {
    assert.equal((headers.headers as Record<string, string>).Authorization, "Bearer opaque-fixture-secret");
    queueMicrotask(() => {
      callback(stream);
      if (options.onOpen) options.onOpen(stream);
      else event(stream, "endpoint", endpoint);
    });
    return connection;
  }) as typeof https.request;
  syncBuiltinESMExports();
  const posts: string[] = [];
  const request: Request = async (options_) => {
    assert.equal(options_.headers?.Authorization, "Bearer opaque-fixture-secret");
    assert.equal(new URL(options_.url).origin, "https://developer.zhihu.com");
    const body = JSON.parse(String(options_.body)) as { id?: number; method: string };
    posts.push(body.method);
    if (options.onPost) options.onPost(body, stream);
    else if (body.id !== undefined) queueMicrotask(() => event(stream, "message", {
      id: body.id,
      result: body.method === "tools/list" ? { tools: [{ name: "zhihu_search" }] }
        : body.method === "tools/call" ? { content: [{ type: "text", text: "<zhihu_search/>" }] } : {}
    }));
    return reply({}, 202);
  };
  try { await check(request, posts, () => closed); }
  finally {
    https.request = original;
    syncBuiltinESMExports();
    stream.destroy();
  }
}

test("MCP validates endpoints, rejects entities and skips malformed search items", async () => {
  assert.equal(validateMessageEndpoint(endpoint), `https://developer.zhihu.com${endpoint}`);
  for (const url of [
    "https://example.com" + endpoint, endpoint + "&sessionId=another",
    endpoint + "#fragment", "/api/mcp/zhihu_search/v1/message", "https://[invalid"
  ]) assert.throws(() => validateMessageEndpoint(url), /无效/u);
  assert.throws(() => parseMcpSearchText('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///secret">]><zhihu_search/>'), /无效/u);
  assert.throws(() => parseMcpSearchText("x".repeat(1_000_001)), /无效/u);
  const original = globalThis.DOMParser;
  const values = [
    { title: null, url: hit.Url, text: "broken" },
    { title: "bad", url: "javascript:alert(1)", text: "unsafe" },
    { title: "Title", url: hit.Url, text: "Snippet" },
    { title: "Other", url: hit.Url, text: "Other snippet" }
  ];
  Object.assign(globalThis, { DOMParser: class {
    parseFromString() {
      return {
        documentElement: { tagName: "zhihu_search" },
        querySelector: () => null,
        querySelectorAll: () => values.map(({ title, url, text }) => ({
          getAttribute: (key: string) => key === "title" ? title : key === "url" ? url : null,
          textContent: text
        }))
      };
    }
  } });
  try {
    assert.equal(parseMcpSearchText("<zhihu_search/>", 1).length, 1);
    await withMcp({}, async (request, posts, destroyed) => {
      const result = await searchZhihuMcp(request, "test", 1, "opaque-fixture-secret", 1000);
      assert.equal(result.length, 1);
      assert.deepEqual(posts, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
      assert.equal(destroyed(), true);
    });
  } finally {
    if (original) Object.assign(globalThis, { DOMParser: original });
    else Reflect.deleteProperty(globalThis, "DOMParser");
  }
});

test("MCP stops on HTTP auth/quota errors, bad content types and unsafe endpoints", async () => {
  for (const status of [401, 403, 429]) {
    await withMcp({ status }, async (request, posts, destroyed) => {
      await assert.rejects(searchZhihuMcp(request, "test", 1, "opaque-fixture-secret", 1000), new RegExp(String(status)));
      assert.deepEqual(posts, []);
      assert.equal(destroyed(), true);
    });
  }
  await withMcp({ contentType: "text/html" }, async (request, posts) => {
    await assert.rejects(searchZhihuMcp(request, "test", 1, "opaque-fixture-secret", 1000), /SSE/u);
    assert.deepEqual(posts, []);
  });
  await withMcp({ onOpen: (stream) => event(stream, "endpoint", "https://example.com" + endpoint) }, async (request, posts) => {
    await assert.rejects(searchZhihuMcp(request, "test", 1, "opaque-fixture-secret", 1000), /无效/u);
    assert.deepEqual(posts, []);
  });
});

test("MCP closes on mid-session disconnect, cancellation and overall timeout", async () => {
  await withMcp({ onOpen: (stream) => stream.destroy() }, async (request, posts, destroyed) => {
    await assert.rejects(searchZhihuMcp(request, "test", 1, "opaque-fixture-secret", 1000), /关闭/u);
    assert.deepEqual(posts, []);
    assert.equal(destroyed(), true);
  });
  await withMcp({ onPost: () => {} }, async (request, posts, destroyed) => {
    await assert.rejects(searchZhihuMcp(request, "test", 1, "opaque-fixture-secret", 30), /超时/u);
    assert.deepEqual(posts, ["initialize"]);
    assert.equal(destroyed(), true);
  });
  await withMcp({ onOpen: () => {} }, async (request, posts, destroyed) => {
    const controller = new AbortController();
    const work = searchZhihuMcp(request, "test", 1, "opaque-fixture-secret", 1000, controller.signal);
    controller.abort();
    await assert.rejects(work, /取消|abort/iu);
    assert.deepEqual(posts, []);
    assert.equal(destroyed(), true);
  });
});

test("MCP RPC and POST errors stop the session without credential disclosure or retries", async () => {
  await withMcp({
    onPost(body, stream) { event(stream, "message", { id: body.id, error: { code: 30002, message: "opaque-fixture-secret" } }); }
  }, async (request, posts, destroyed) => {
    await assert.rejects(searchZhihuMcp(request, "test", 1, "opaque-fixture-secret", 1000), /30002/u);
    assert.deepEqual(posts, ["initialize"]);
    assert.equal(destroyed(), true);
  });
  await withMcp({ onPost() { throw new Error("opaque-fixture-secret"); } }, async (request, posts, destroyed) => {
    await assert.rejects(searchZhihuMcp(request, "test", 1, "opaque-fixture-secret", 1000), /NETWORK_ERROR/u);
    assert.deepEqual(posts, ["initialize"]);
    assert.equal(destroyed(), true);
  });
});
