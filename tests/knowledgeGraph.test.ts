import assert from "node:assert/strict";
import test from "node:test";
import type { ModelClient } from "../src/agent/modelClient";
import { buildKnowledgeGraph, renderFindings, validateFindings } from "../src/evolution/knowledgeGraph";
import type { Finding, KnowledgeGraph, KnowledgeUnit } from "../src/evolution/knowledgeGraph";

const units: KnowledgeUnit[] = [
  { id: "a:0", sourceId: "a", title: "Author A", path: "Wiki/Knowledge/A.md", origin: "https://example.com/a",
    snapshot: "Wiki/Evidence/A.md", completeness: "snippet", statement: "Remote work helps focused work.",
    conditions: ["Individual work"], quote: "Remote work helps focused work." },
  { id: "b:0", sourceId: "b", title: "Author B", path: "Wiki/Knowledge/B.md", origin: "https://example.com/b",
    snapshot: "Wiki/Evidence/B.md", completeness: "snippet", statement: "Remote work delays team feedback.",
    conditions: ["Team work"], quote: "Remote work delays team feedback." }
];
const finding: Finding = { kind: "conditions", statement: "Benefits depend on the work setting.",
  reasoning: "Individual focus and team feedback are different conditions.",
  citations: units.map((unit) => ({ id: unit.id, quote: unit.quote })), question: "What team practices were used?" };

test("cross-source synthesis validates quotes against their own claims and links both positions", async () => {
  let calls = 0;
  const model = { fits: () => true, json: async (_: string, input: { units: unknown[] }) => {
    calls++;
    assert.equal(input.units.length, 2);
    return { findings: [finding] };
  } } as unknown as ModelClient;
  let saved: KnowledgeGraph | undefined;
  const persist = async (graph: KnowledgeGraph) => { saved = structuredClone(graph); };
  const result = await buildKnowledgeGraph(model, units, undefined, persist);
  assert.equal(result.state, "done");
  assert.equal(saved?.completed.length, 1);
  const body = renderFindings(result.findings, units);
  assert.match(body, /条件差异/);
  assert.match(body, /\[\[Wiki\/Knowledge\/A\|Author A\]\]/);
  assert.match(body, /摘要证据/);
  assert.ok(body.includes(units[1]!.quote));
  await buildKnowledgeGraph(model, units, saved, persist);
  assert.equal(calls, 1, "unchanged complete graph is reused");
  assert.throws(() => validateFindings([{ ...finding, citations: [
    finding.citations[0]!, { id: "b:0", quote: units[0]!.quote }
  ] }], units), /不一致/);
  assert.throws(() => validateFindings([finding], units.map((unit) => ({ ...unit, sourceId: "a" }))), /不同来源/);
});

test("invalid model output becomes a resumable user-facing error", async () => {
  const model = {
    fits: () => true,
    json: async () => { throw new Error("模型结果不是有效的结构化数据；未生成可写入操作"); }
  } as unknown as ModelClient;
  let saved: KnowledgeGraph | undefined;
  const result = await buildKnowledgeGraph(model, units, undefined, async (graph) => { saved = structuredClone(graph); });
  assert.equal(result.state, "pending");
  assert.equal(result.error, "模型返回格式不符合预期；已完成批次保留，可以重试");
  assert.equal(saved?.error, result.error);
});

test("all groups meet across the whole vault; failed batches resume without repeating finished calls", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    ...units[i % 2]!, id: `${i}:0`, sourceId: String(i), path: `Wiki/Knowledge/${i}.md`
  }));
  const pairs = new Set<string>();
  let calls = 0, fail = true, saved: KnowledgeGraph | undefined;
  const model = { fits: (_: string, input: { units: unknown[] }) => input.units.length <= 8,
    json: async (_: string, input: { units: KnowledgeUnit[] }) => {
      calls++;
      if (calls === 2 && fail) throw new Error("temporary outage");
      for (const a of input.units) for (const b of input.units) if (a.id < b.id) pairs.add(`${a.id}|${b.id}`);
      return { findings: [] };
    } } as unknown as ModelClient;
  const persist = async (graph: KnowledgeGraph) => { saved = structuredClone(graph); };
  await buildKnowledgeGraph(model, many, undefined, persist);
  assert.equal(saved?.state, "pending");
  assert.equal(saved?.completed.length, 1);
  const total = saved!.total;
  fail = false;
  const done = await buildKnowledgeGraph(model, many, saved, persist);
  assert.equal(done.state, "done");
  assert.equal(calls, total + 1);
  assert.equal(pairs.size, 30 * 29 / 2, "no keyword or top-K prefilter hides claim pairs");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buildKnowledgeGraph(model, many, undefined, persist, controller.signal), /abort/i);
});
