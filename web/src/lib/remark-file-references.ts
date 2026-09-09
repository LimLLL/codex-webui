/**
 * Remark plugin that tags inline-code nodes holding a file reference.
 *
 * The node is tagged rather than rewritten: a reference renders as `<code>`
 * either way, so only the renderer needs to know whether it is interactive.
 * Working on the syntax tree is what makes the two structural exclusions
 * reliable — fenced and indented blocks are a different node type and are never
 * visited, and a token inside an existing link is skipped so a code-formatted
 * link label activates once rather than nesting two controls.
 */
import { parseFileReference } from './file-references';

/** Minimal MDAST shape; the full types are not a direct dependency. */
interface MdastNode {
  type: string;
  value?: string;
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
  children?: MdastNode[];
}

/** Attribute carrying the recognised path through to the renderer. */
export const FILE_REFERENCE_PATH_ATTR = 'data-file-reference-path';

/** Attribute carrying the recognised line, absent when the reference had none. */
export const FILE_REFERENCE_LINE_ATTR = 'data-file-reference-line';

/**
 * Walks a subtree tagging qualifying inline-code nodes.
 *
 * @param node - Subtree root
 * @param insideLink - Whether an ancestor is already an interactive link
 */
function tagInlineCode(node: MdastNode, insideLink: boolean): void {
  if (!node.children) return;
  for (const child of node.children) {
    if (child.type === 'inlineCode') {
      if (insideLink) continue;
      const reference = parseFileReference(child.value ?? '', 'inlineCode');
      if (!reference) continue;
      child.data = {
        ...child.data,
        hProperties: {
          ...child.data?.hProperties,
          [FILE_REFERENCE_PATH_ATTR]: reference.path,
          ...(reference.line !== null && {
            [FILE_REFERENCE_LINE_ATTR]: String(reference.line),
          }),
        },
      };
      continue;
    }
    tagInlineCode(
      child,
      insideLink || child.type === 'link' || child.type === 'linkReference',
    );
  }
}

/** Remark plugin tagging inline-code file references for the renderer. */
export function remarkFileReferences() {
  return () => (tree: MdastNode) => {
    tagInlineCode(tree, false);
  };
}
