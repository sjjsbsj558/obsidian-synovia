import { remark } from "remark";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { TextEditSchema } from "../types";
import type { TextEdit } from "../types";

const parser = remark().use(remarkFrontmatter).use(remarkGfm).use(remarkMath);

function containsMath(node: { type: string; children?: readonly { type: string }[] }): boolean {
  return node.type === "inlineMath" || Boolean(node.children?.some(containsMath));
}

export interface MarkdownBlock {
  id: string;
  type: string;
  startOffset: number;
  endOffset: number;
  text: string;
}

export function getMarkdownBlocks(markdown: string): MarkdownBlock[] {
  return parser.parse(markdown).children.flatMap((node) => {
    const startOffset = node.position?.start.offset;
    const endOffset = node.position?.end.offset;
    if (startOffset === undefined || endOffset === undefined) return [];
    return [{
      id: `${node.type}:${startOffset}:${endOffset}`,
      type: node.type === "paragraph" && containsMath(node) ? "mathParagraph" : node.type,
      startOffset,
      endOffset,
      text: markdown.slice(startOffset, endOffset)
    }];
  });
}

export function previewTextEdits(markdown: string, input: readonly TextEdit[]): string {
  const edits = input.map((edit) => TextEditSchema.parse(edit))
    .sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
  let previous: TextEdit | undefined;
  for (const edit of edits) {
    if (edit.endOffset > markdown.length
      || (previous && (edit.startOffset < previous.endOffset || edit.startOffset === previous.startOffset))) {
      throw new Error("Edits overlap or extend beyond the source.");
    }
    previous = edit;
  }
  let result = markdown;
  for (const edit of edits.reverse()) {
    result = result.slice(0, edit.startOffset) + edit.replacement + result.slice(edit.endOffset);
  }
  return result;
}

export function previewBlockReplacement(markdown: string, blockId: string, replacement: string): string {
  const block = getMarkdownBlocks(markdown).find((entry) => entry.id === blockId);
  if (!block || block.type !== "paragraph") {
    throw new Error("The scaffold only previews top-level paragraph replacements.");
  }
  return previewTextEdits(markdown, [{ ...block, replacement }]);
}
