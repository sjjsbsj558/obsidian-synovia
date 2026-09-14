import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpSearchText } from "../src/sources/zhihuMcpSseClient";
import { normalizeSearchResponse } from "../src/sources/zhihuSearchApiClient";
import { buildCliInvocation, normalizeHotResponse, normalizeZhidaResponse } from "../src/sources/zhihuCliClient";
import { previewTextEdits } from "../src/evolution/astPatcher";
import { tokenize } from "../src/search/miniSearchAdapter";
import { detectAutoInputKind } from "../src/pipeline/autoInput";
import { reviewTopicCoverage } from "../src/evolution/topicReview";
import { comparisonReadyMatches } from "../src/pipeline/retrievalPipeline";

test("tokenize keeps Chinese words and drops punctuation", () => {
  assert.deepEqual(tokenize("中文检索测试，BM25!"), ["中文", "检索", "测试", "bm25"]);
});

test("previewTextEdits applies non-overlapping offsets and rejects overlaps", () => {
  assert.equal(previewTextEdits("abcdef", [{ startOffset: 1, endOffset: 3, replacement: "X" }]), "aXdef");
  assert.throws(
    () => previewTextEdits("abcdef", [
      { startOffset: 1, endOffset: 4, replacement: "X" },
      { startOffset: 3, endOffset: 5, replacement: "Y" }
    ]),
    /overlap/i
  );
});

test("automatic input routing keeps the main workflow small", () => {
  assert.equal(detectAutoInputKind("https://example.com/article"), "web");
  assert.equal(detectAutoInputKind("# A note\n\n$$x^2$$"), "text");
  assert.equal(detectAutoInputKind("特征值"), "query");
  assert.equal(detectAutoInputKind("How does remote work affect focus?"), "query");
  assert.equal(detectAutoInputKind("A plain paragraph. ".repeat(8)), "text");
  assert.equal(detectAutoInputKind("First line\nSecond line"), "text");
});

test("topic coverage review keeps model opinions low-weight and evidence-bounded", async () => {
  const model = {
    fits: () => true,
    json: async () => ({
      status: "gaps",
      gaps: [{
        topic: "边界条件", reason: "笔记没有讨论边界条件", suggestedQuery: "边界条件",
        evidence: ["已有定义"], confidence: 0.7
      }],
      opinion: { text: "建议先补充边界条件", weight: 0.25, basis: ["已有定义"] }
    })
  } as never;
  const result = await reviewTopicCoverage(model, "特征值", [{
    path: "Notes/Linear.md", title: "Linear", content: "已有定义"
  }]);
  assert.equal(result.gaps[0]?.evidence[0], "已有定义");
  assert.equal(result.opinion?.weight, 0.25);
  assert.equal(result.opinion?.basis[0], "已有定义");
});

test("lexical retrieval candidates can still provide evidence for comparison", () => {
  const [match] = comparisonReadyMatches([{
    path: "Notes/Linear.md",
    title: "Linear",
    score: 1,
    snippet: "已有定义",
    relation: "lexical",
    reason: "关键词候选",
    evidence: []
  }]);
  assert.deepEqual(match?.evidence, ["已有定义"]);
});

test("normalizeSearchResponse maps API hits to snippet sources", () => {
  const [source] = normalizeSearchResponse({
    Code: 0,
    Data: {
      Items: [{
        Title: "<em>标题</em>",
        ContentType: "answer",
        ContentID: "42",
        ContentText: "<em>摘要</em>",
        Url: "https://www.zhihu.com/question/42/answer/7",
        AuthorName: "作者",
        VoteUpCount: 3
      }]
    }
  });
  assert.equal(source?.title, "标题");
  assert.equal(source?.contentSnippet, "摘要");
  assert.equal(source?.evidenceCompleteness, "snippet");
});

test("CLI normalizers map hot list and Zhida output", () => {
  const [hot] = normalizeHotResponse({
    Code: 0,
    Data: { Items: [{ Title: "热榜标题", Url: "https://www.zhihu.com/question/1", Summary: "热榜摘要" }] }
  });
  assert.equal(hot?.contentSnippet, "热榜摘要");

  const answer = normalizeZhidaResponse({
    model: "zhida-thinking-1p5",
    choices: [{ message: { content: "直答内容", reasoning_content: "推理摘要" } }]
  }, "测试问题");
  assert.equal(answer.source.sourceType, "zhida_answer");
  assert.equal(answer.source.fullContent, "直答内容");
  assert.equal(answer.reasoning, "推理摘要");
});

test("Windows CLI rejects shell wrappers and preserves executable arguments", () => {
  assert.throws(() => buildCliInvocation(
    '"C:\\Program Files\\zhihu.cmd"',
    ["search", "global", "a&b", 'host=="example.com"'],
    "win32"
  ), /包装脚本/u);
  const args = ["search", "global", "a&b", 'host=="example.com"'];
  assert.deepEqual(buildCliInvocation('"C:\\Program Files\\zhihu-cli.exe"', args), {
    file: "C:\\Program Files\\zhihu-cli.exe", args
  });
});

test("parseMcpSearchText maps search_item XML", () => {
  const original = globalThis.DOMParser;
  class ElementStub {
    constructor(private readonly attrs: Record<string, string>, public readonly textContent: string) {}
    getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  }
  class DocumentStub {
    documentElement = { tagName: "zhihu_search" };
    private readonly item = new ElementStub({
      content_type: "answer",
      title: "标题",
      url: "https://www.zhihu.com/question/42/answer/7",
      author_name: "作者"
    }, "摘要");
    querySelector(selector: string): null { return selector === "parsererror" ? null : null; }
    querySelectorAll(selector: string): ElementStub[] { return selector === "search_item" ? [this.item] : []; }
  }
  class ParserStub {
    parseFromString(_text: string, _type: string): DocumentStub { return new DocumentStub(); }
  }
  Object.assign(globalThis, { DOMParser: ParserStub });
  try {
    const [source] = parseMcpSearchText(
      '<zhihu_search><search_item title="标题" url="https://www.zhihu.com/question/42/answer/7">摘要</search_item></zhihu_search>'
    );
    assert.equal(source?.title, "标题");
    assert.equal(source?.contentSnippet, "摘要");
  } finally {
    if (original) Object.assign(globalThis, { DOMParser: original });
    else Reflect.deleteProperty(globalThis, "DOMParser");
  }
});
