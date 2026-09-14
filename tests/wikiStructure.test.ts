import test from "node:test";
import assert from "node:assert/strict";
import { managedSection, topicPath, wikiLink } from "../src/utils/wikiStructure";
import { sourceNote } from "../src/sources/sourceNote";

test("wiki structures preserve prose, update idempotently, and reject unsafe names", () => {
  const original = "# 我的主题\n\n个人整理不能丢失。\n";
  const once = managedSection(original, "sources", "- [[Wiki/Sources/example]]");
  assert.equal(managedSection(once, "sources", "- [[Wiki/Sources/example]]"), once);
  assert.ok(once.startsWith(original));
  assert.throws(() => managedSection("<!-- synovia:sources:start -->", "sources", "x"));
  for (const name of ["../bad", "bad|name", "CON", "bad#anchor", ""]) assert.throws(() => topicPath("Wiki", name));
  const path = topicPath("Wiki", "知识管理");
  const note = sourceNote({ id: "demo", title: "知识管理", url: "https://www.zhihu.com/question/42", sourceType: "zhihu_search_hit", evidenceCompleteness: "snippet", contentSnippet: "原始摘录" }, [path]);
  assert.ok(note.includes(wikiLink(path)));
  assert.match(note, /status: inbox/);
  assert.match(note, /aliases:/);
  assert.match(note, /\[\[Wiki\/知识库首页\]\]/);
});
