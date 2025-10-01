import { normalizeNewlines } from "../util/index.js";

export function handleLeadingSpaceIndentInput(editor, text) {
  if (!text) return false;
  const segments = text.split("\n");
  const first = segments[0];
  const hasExtraContent = segments.slice(1).some((segment) => segment.length > 0);
  if (!first || !/^[ \u3000]+$/.test(first)) return false;
  if (hasExtraContent) return false;
  if (editor.state.cursor.charIndex !== 0) return false;
  const count = Array.from(first).length;
  if (count === 0) return false;
  editor.changeIndent(count, {
    applyToSelection: editor.hasSelection(),
    includeChildren: false,
  });
  return true;
}

export function processCommittedText(editor, text) {
  if (!text) return false;
  const normalized = normalizeNewlines(text);
  if (handleLeadingSpaceIndentInput(editor, normalized)) {
    return true;
  }
  editor.insertText(normalized);
  return true;
}
