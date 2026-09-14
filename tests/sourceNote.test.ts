import test from "node:test";
import assert from "node:assert/strict";
import { sourceNote } from "../src/sources/sourceNote";

test("saved search notes preserve provenance and snippet classification", () => {
  const note = sourceNote({
    id: "test", title: "标题: test", url: "https://www.zhihu.com/question/42",
    author: { name: "作者" }, sourceType: "zhihu_search_hit",
    evidenceCompleteness: "snippet", contentSnippet: "检索摘录"
  });
  assert.match(note, /evidence_completeness: snippet/);
  assert.match(note, /source_url: "https:\/\/www.zhihu.com\/question\/42"/);
  assert.match(note, /不是全文/);
  assert.match(note, /author: "作者"/);
});
