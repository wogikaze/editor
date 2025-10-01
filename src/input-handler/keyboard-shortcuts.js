export function handleCtrlShortcuts(editor, event, key, shift) {
  const lower = key.toLowerCase();
  switch (lower) {
    case "a":
      event.preventDefault();
      editor.selectAll();
      return true;
    case "z":
      event.preventDefault();
      if (shift) {
        editor.redo();
      } else {
        editor.undo();
      }
      return true;
    case "y":
      event.preventDefault();
      editor.redo();
      return true;
    case "home":
      event.preventDefault();
      editor.moveCursorToDocumentEdge("start", shift);
      return true;
    case "end":
      event.preventDefault();
      editor.moveCursorToDocumentEdge("end", shift);
      return true;
    case "arrowup":
      event.preventDefault();
      editor.moveLine(-1);
      return true;
    case "arrowdown":
      event.preventDefault();
      editor.moveLine(1);
      return true;
    case "arrowleft":
      event.preventDefault();
      if (shift) {
        editor.moveCursorByWord(-1, true);
      } else {
        editor.changeIndent(-1, {
          applyToSelection: editor.hasSelection(),
          includeChildren: false,
        });
      }
      return true;
    case "arrowright":
      event.preventDefault();
      if (shift) {
        editor.moveCursorByWord(1, true);
      } else {
        editor.changeIndent(1, {
          applyToSelection: editor.hasSelection(),
          includeChildren: false,
        });
      }
      return true;
    case "enter":
      event.preventDefault();
      editor.toggleCollapse(editor.state.cursor.lineIndex);
      return true;
    case "tab":
      event.preventDefault();
      editor.changeIndent(1, {
        applyToSelection: editor.hasSelection(),
        includeChildren: false,
      });
      return true;
    case "f":
      event.preventDefault();
      editor.openSearchPanel({ prefillSelection: true });
      return true;
    case "x":
    case "c":
    case "v":
      return false;
    default:
      return false;
  }
}
