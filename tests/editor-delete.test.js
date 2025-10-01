import test from "node:test";
import assert from "node:assert/strict";
import CanvasEditor from "../src/editor/index.js";

function createLine(text, indent) {
  return {
    id: `line-${Math.random().toString(36).slice(2, 8)}`,
    type: "text",
    text,
    indent,
    collapsed: false,
  };
}

function createEditor(lines, cursor) {
  const editor = Object.create(CanvasEditor.prototype);
  editor.state = {
    lines: lines.map(({ text, indent }) => createLine(text, indent)),
    cursor: { ...cursor },
    selection: null,
    history: { undoStack: [], redoStack: [] },
    view: {
      scrollTop: 0,
      scrollLeft: 0,
      lineHeight: 30,
      indentWidth: 24,
    },
  };
  editor.saveHistory = () => {};
  editor.markDocumentVersion = () => {};
  editor.invalidateLayout = () => {};
  editor.deleteSelection = () => false;
  return editor;
}

test("delete at line end keeps descendants while merging text", () => {
  const editor = createEditor(
    [
      { text: "Parent", indent: 0 },
      { text: "Child header", indent: 1 },
      { text: "Grandchild", indent: 2 },
    ],
    { lineIndex: 0, charIndex: "Parent".length }
  );

  CanvasEditor.prototype.handleDelete.call(editor);

  assert.equal(editor.state.lines.length, 2);
  assert.equal(editor.state.lines[0].text, "ParentChild header");
  assert.equal(editor.state.lines[1].text, "Grandchild");
  assert.equal(editor.state.lines[1].indent, 2);
});
