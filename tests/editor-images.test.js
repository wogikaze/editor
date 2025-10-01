import test from "node:test";
import assert from "node:assert/strict";
import CanvasEditor from "../src/editor/index.js";

function createEditor(lines, cursor = { lineIndex: 0, charIndex: 0 }) {
  const editor = Object.create(CanvasEditor.prototype);
  editor.canvas = { style: {} };
  editor.textarea = { style: {}, focus: () => {}, blur: () => {} };
  editor.imageLayoutsCache = new Map();
  editor.imageLayouts = new Map();
  editor.lineTops = new Map();
  editor.lineHeights = new Map();
  editor.config = { padding: 12 };
  editor.state = {
    lines: [],
    cursor: { ...cursor },
    selection: null,
    view: {
      lineHeight: 30,
      indentWidth: 24,
      scrollTop: 0,
      scrollLeft: 0,
    },
  };
  editor.saveHistory = () => {};
  editor.invalidateLayout = () => {};
  editor.markDocumentVersion = () => {};
  editor.collapseSelectionWithoutHistory = () => null;
  editor.getVisibleLines = () => editor.state.lines.map((_, index) => index);
  editor.getVisibleIndex = (index) => index;
  editor.getWorldLineTop = () => 0;
  editor.setCursor = (lineIndex, charIndex) => {
    editor.state.cursor = { lineIndex, charIndex };
  };
  lines.forEach((line) => {
    editor.state.lines.push(editor.createLine(line));
  });
  return editor;
}

test("insertImageLine replaces empty text line", () => {
  const editor = createEditor([
    { type: "text", text: "", indent: 0 },
  ]);
  editor.insertImageLine({
    src: "data:image/png;base64,aaa",
    width: 100,
    height: 80,
    naturalWidth: 100,
    naturalHeight: 80,
  });
  assert.equal(editor.state.lines.length, 1);
  const line = editor.state.lines[0];
  assert.equal(line.type, "image");
  assert.equal(line.image.width, 100);
  assert.deepEqual(editor.state.cursor, { lineIndex: 0, charIndex: 1 });
});

test("insertImageLine splits text line and preserves trailing text", () => {
  const editor = createEditor([
    { type: "text", text: "HelloWorld", indent: 0 },
  ], { lineIndex: 0, charIndex: 5 });
  editor.insertImageLine({
    src: "data:image/png;base64,bbb",
    width: 60,
    height: 60,
    naturalWidth: 60,
    naturalHeight: 60,
  });
  assert.equal(editor.state.lines.length, 3);
  assert.equal(editor.state.lines[0].text, "Hello");
  assert.equal(editor.state.lines[1].type, "image");
  assert.equal(editor.state.lines[2].text, "World");
  assert.deepEqual(editor.state.cursor, { lineIndex: 2, charIndex: 0 });
});

test("insertImageLine before existing image when cursor at start", () => {
  const editor = createEditor([
    {
      type: "image",
      indent: 0,
      image: {
        src: "data:image/png;base64,orig",
        width: 120,
        height: 90,
        naturalWidth: 120,
        naturalHeight: 90,
      },
    },
  ], { lineIndex: 0, charIndex: 0 });
  editor.insertImageLine({
    src: "data:image/png;base64,new",
    width: 80,
    height: 80,
    naturalWidth: 80,
    naturalHeight: 80,
  });
  assert.equal(editor.state.lines.length, 2);
  assert.equal(editor.state.lines[0].image.src, "data:image/png;base64,new");
  assert.equal(editor.state.lines[1].image.src, "data:image/png;base64,orig");
  assert.deepEqual(editor.state.cursor, { lineIndex: 0, charIndex: 1 });
});
