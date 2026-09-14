import test from "node:test";
import assert from "node:assert/strict";
import { evidenceSnapshot, formatWarnings, noteStem, selectedBlocks } from "../src/evolution/knowledgeTools";
import { getMarkdownBlocks } from "../src/evolution/astPatcher";
import rules from "../skills/obsidian-markdown/rules.json";

test("selection expands complete tables and math without altering evidence", () => {
  const text = "---\ntitle: Example\n---\n\n# Topic\n\n$$\nx^2\n$$\n\n| A | B |\n| --- | --- |\n| x | y |\n";
  assert.equal(selectedBlocks(text, text.indexOf("x^2"), text.indexOf("x^2") + 1), "$$\nx^2\n$$");
  assert.ok(selectedBlocks(text, text.lastIndexOf("y"), text.lastIndexOf("y") + 1).startsWith("| A | B |"));
  assert.throws(() => selectedBlocks(text, 1, 1));
  assert.equal(getMarkdownBlocks("**Inline $x$**")[0]?.type, "mathParagraph");
  const snapshot = evidenceSnapshot(text);
  for (const block of getMarkdownBlocks(text).filter((block) => block.type !== "yaml")) {
    assert.ok(snapshot.includes(block.text));
    assert.ok(snapshot.includes(`^synovia-${block.startOffset}-${block.endOffset}`));
  }
});

test("format diagnostics preserve valid code and flag unsupported or malformed input", () => {
  assert.deepEqual(formatWarnings("```tex\n\\(x\\)\n$$\n```\n\n$$\nx^2\n$$"), []);
  assert.ok(formatWarnings("$$\nx^2").length);
  assert.ok(formatWarnings("\\(x\\)").length);
  assert.ok(formatWarnings("<table><tr></tr></table>").length);
  assert.ok(formatWarnings("| A | B |\n| --- | --- |\n| x |").length);
  assert.deepEqual(formatWarnings("| A | B |\n| --- | --- |\n| x\\|y | z |"), []);
});

test("readable filenames remain safe and the bundled skill is nonempty", () => {
  assert.equal(noteStem("CON"), "Knowledge");
  assert.equal(noteStem("标题 / 链接 # 内容"), "标题 链接 内容");
  assert.ok(noteStem("x".repeat(200)).length <= 64);
  assert.ok(rules.length >= 5);
});
