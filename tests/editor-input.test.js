import test from "node:test";
import assert from "node:assert/strict";
import CanvasEditor from "../editor-core.js";

function createEditorStub(options = {}) {
  const { cursorIndex = 0 } = options;
  const editor = Object.create(CanvasEditor.prototype);
  editor.state = {
    cursor: { lineIndex: 0, charIndex: cursorIndex },
    selection: null,
  };
  editor.hasSelection = () => false;
  editor.changeIndentCalls = [];
  editor.insertedTexts = [];
  editor.changeIndent = (delta, opts) => {
    editor.changeIndentCalls.push({ delta, opts });
  };
  editor.insertText = (text) => {
    editor.insertedTexts.push(text);
  };
  editor.textarea = { value: "" };
  editor.isComposing = false;
  editor.skipNextInputCommit = false;
  return editor;
}

function createInputEvent(value, options = {}) {
  const target = { value };
  return Object.assign({ target, isComposing: false }, options);
}

test("full-width space at line start increases indent", () => {
  const editor = createEditorStub();
  const event = createInputEvent("　");
  CanvasEditor.prototype.onInput.call(editor, event);
  assert.equal(editor.changeIndentCalls.length, 1);
  assert.equal(editor.changeIndentCalls[0].delta, 1);
  assert.equal(editor.insertedTexts.length, 0);
  assert.equal(event.target.value, "");
});

test("multiple leading spaces increase indent by count", () => {
  const editor = createEditorStub();
  const event = createInputEvent(" 　");
  CanvasEditor.prototype.onInput.call(editor, event);
  assert.equal(editor.changeIndentCalls.length, 1);
  assert.equal(editor.changeIndentCalls[0].delta, Array.from(" 　").length);
  assert.equal(editor.insertedTexts.length, 0);
});

test("input ignored while composition is active", () => {
  const editor = createEditorStub();
  const event = createInputEvent("　", { isComposing: true });
  CanvasEditor.prototype.onInput.call(editor, event);
  assert.equal(editor.changeIndentCalls.length, 0);
  assert.equal(editor.insertedTexts.length, 0);
  assert.equal(event.target.value, "　");
});

test("final IME commit handled even if editor is in composing state", () => {
  const editor = createEditorStub();
  editor.isComposing = true;
  const event = createInputEvent("　", { isComposing: false });
  CanvasEditor.prototype.onInput.call(editor, event);
  assert.equal(editor.changeIndentCalls.length, 1);
  assert.equal(editor.changeIndentCalls[0].delta, 1);
});

test("compositionend processes full-width space and skips next input", () => {
  const editor = createEditorStub();
  CanvasEditor.prototype.processCommittedText.call(editor, "　");
  // simulate composition handler effect
  editor.skipNextInputCommit = true;
  assert.equal(editor.changeIndentCalls.length, 1);
  assert.equal(editor.insertedTexts.length, 0);

  const event = createInputEvent("　");
  CanvasEditor.prototype.onInput.call(editor, event);
  assert.equal(editor.skipNextInputCommit, false);
  assert.equal(editor.changeIndentCalls.length, 1);
  assert.equal(editor.insertedTexts.length, 0);
});

test("non-space input inserts text", () => {
  const editor = createEditorStub();
  const event = createInputEvent("abc");
  CanvasEditor.prototype.onInput.call(editor, event);
  assert.equal(editor.changeIndentCalls.length, 0);
  assert.deepEqual(editor.insertedTexts, ["abc"]);
});

test("spaces with additional content are inserted verbatim", () => {
  const editor = createEditorStub();
  const event = createInputEvent("　\nX");
  CanvasEditor.prototype.onInput.call(editor, event);
  assert.equal(editor.changeIndentCalls.length, 0);
  assert.deepEqual(editor.insertedTexts, ["　\nX"]);
});

test("leading spaces do not indent when cursor is not at start", () => {
  const editor = createEditorStub({ cursorIndex: 2 });
  const event = createInputEvent("　");
  CanvasEditor.prototype.onInput.call(editor, event);
  assert.equal(editor.changeIndentCalls.length, 0);
  assert.deepEqual(editor.insertedTexts, ["　"]);
});
