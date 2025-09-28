document.addEventListener("DOMContentLoaded", () => {
  class CanvasEditor {
    constructor(canvas, textarea) {
      // --- コア要素とコンテキスト ---
      this.canvas = canvas;
      this.textarea = textarea;
      this.ctx = canvas.getContext("2d");

      // --- エディタ設定 ---
      this.config = {
        font: '22px "Space Mono", "Noto Sans JP", monospace',
        padding: 10,
        lineHeight: 30,
        indentSize: 1,
        bulletChar: "•",
        blinkInterval: 500,
        historyLimit: 100,
        colors: {
          background: "#282c34",
          text: "#abb2bf",
          cursor: "#528bff",
          selection: "rgba(58, 67, 88, 0.8)",
          imeUnderline: "#abb2bf",
          indentation: "rgba(255, 255, 255, 0.08)",
          trailingSpace: "rgba(255, 82, 82, 0.3)",
          overwriteCursor: "rgba(82, 139, 255, 0.5)",
        },
      };

      // --- エディタの状態 ---
      this.text =
        "インデントが1文字になりました。\n" +
        " ".repeat(this.config.indentSize * 1) +
        "Shift + Tabでデインデントします。\n" +
        " ".repeat(this.config.indentSize * 2) +
        "選択範囲の描画も改善されています。\n";
      this.lines = [];
      this.cursor = 0;
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.isFocused = false;
      this.isDragging = false;
      this.isOverwriteMode = false;
      this.isComposing = false;
      this.compositionText = "";
      this.scrollY = 0;
      this.visibleLines = 0;
      this.preferredCursorX = -1; // 上下移動時のカーソルX座標を保持
      this.cursorBlinkState = true;
      this.lastBlinkTime = 0;
      this.charWidthCache = new Map();

      // --- 履歴 (Undo/Redo) ---
      this.undoStack = [];
      this.redoStack = [];
      this.isUndoingOrRedoing = false;

      this.init();
    }

    // =========================================================================
    // 初期化
    // =========================================================================
    init() {
      this.ctx.font = this.config.font;
      this.visibleLines = Math.floor(
        (this.canvas.height - this.config.padding * 2) / this.config.lineHeight
      );
      this.updateLines();
      this.bindEvents();
      requestAnimationFrame(this.renderLoop.bind(this));
    }

    bindEvents() {
      this.canvas.addEventListener("mousedown", this.onMouseDown.bind(this));
      this.canvas.addEventListener("mousemove", this.onMouseMove.bind(this));
      window.addEventListener("mouseup", this.onMouseUp.bind(this));
      this.canvas.addEventListener("wheel", this.onWheel.bind(this));
      document.addEventListener("click", (e) => {
        if (e.target !== this.canvas) this.blur();
      });
      this.textarea.addEventListener("input", this.onInput.bind(this));
      this.textarea.addEventListener("keydown", this.onKeydown.bind(this));
      this.textarea.addEventListener("compositionstart", () => {
        this.isComposing = true;
      });
      this.textarea.addEventListener("compositionupdate", (e) => {
        this.compositionText = e.data;
      });
      this.textarea.addEventListener("compositionend", (e) => {
        this.isComposing = false;
        this.compositionText = "";
        this.onInput({ target: { value: e.data } });
      });
      this.textarea.addEventListener("copy", this.onCopy.bind(this));
      this.textarea.addEventListener("paste", this.onPaste.bind(this));
    }

    // =========================================================================
    // イベントハンドラ
    // =========================================================================
    onMouseDown(e) {
      e.preventDefault();
      this.focus();
      this.isDragging = true;
      const pos = this.getCursorIndexFromCoords(e.offsetX, e.offsetY);
      this.setCursor(pos);
      this.selectionStart = this.cursor;
      this.selectionEnd = this.cursor;
      this.preferredCursorX = -1;
    }

    onMouseMove(e) {
      if (this.isDragging) {
        const pos = this.getCursorIndexFromCoords(e.offsetX, e.offsetY);
        this.setCursor(pos);
        this.selectionEnd = this.cursor;
      }
    }

    onMouseUp() {
      this.isDragging = false;
      this.preferredCursorX = -1;
    }

    onWheel(e) {
      e.preventDefault();
      const newScrollY = this.scrollY + e.deltaY;
      const maxScrollY = Math.max(
        0,
        this.lines.length * this.config.lineHeight +
        this.config.padding * 2 -
        this.canvas.height
      );
      this.scrollY = Math.max(0, Math.min(newScrollY, maxScrollY));
    }

    onInput(e) {
      if (this.isComposing) return;
      let newText = e.target.value;
      if (newText) {
        const { row, col } = this.getPosFromIndex(this.cursor);
        const line = this.lines[row];
        if (newText === "　" && line.substring(0, col).trim() === "") {
          newText = " ".repeat(this.config.indentSize);
        }
        this.insertText(newText);
        this.textarea.value = "";
      }
    }

    onKeydown(e) {
      if (this.isComposing) return;
      if (e.ctrlKey || e.metaKey) {
        return this.handleCommandKeys(e);
      }
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown":
          e.preventDefault();
          this.handleArrowKeys(e);
          break;
        case "Home":
        case "End":
          e.preventDefault();
          this.handleHomeEndKeys(e);
          break;
        case "PageUp":
        case "PageDown":
          e.preventDefault();
          this.handlePageKeys(e);
          break;
        case "Insert":
          e.preventDefault();
          this.isOverwriteMode = !this.isOverwriteMode;
          this.resetCursorBlink();
          break;
        case "Backspace":
          e.preventDefault();
          this.handleBackspace();
          break;
        case "Delete":
          e.preventDefault();
          this.handleDelete();
          break;
        case "Enter":
          e.preventDefault();
          this.insertText("\n");
          break;
        case "Tab":
          e.preventDefault();
          this.insertText("\t");
          break;
        default:
          this.preferredCursorX = -1;
          break;
      }
    }

    onCopy(e) {
      e.preventDefault();
      if (!this.hasSelection()) return;
      const { start, end } = this.getSelectionRange();
      e.clipboardData.setData("text/plain", this.text.substring(start, end));
    }

    onPaste(e) {
      e.preventDefault();
      const pasteText = e.clipboardData.getData("text/plain");
      if (pasteText) {
        this.insertText(pasteText);
      }
    }

    // =========================================================================
    // キー入力処理のヘルパー
    // =========================================================================
    handleCommandKeys(e) {
      switch (e.key.toLowerCase()) {
        case "a": // 全選択
          e.preventDefault();
          this.selectionStart = 0;
          this.selectionEnd = this.text.length;
          this.setCursor(this.text.length);
          break;
        case "z": // 元に戻す
          e.preventDefault();
          this.undo();
          break;
        case "y": // やり直し
          e.preventDefault();
          this.redo();
          break;
      }
    }

    handleBackspace() {
      if (this.hasSelection()) {
        return this.deleteSelection();
      }
      if (this.cursor === 0) return;

      this.saveState();
      const { row, col } = this.getPosFromIndex(this.cursor);
      const line = this.lines[row];
      const isAtIndentBoundary =
        col > 0 &&
        col % this.config.indentSize === 0 &&
        line.substring(0, col).trim() === "";

      const deleteSize = isAtIndentBoundary ? this.config.indentSize : 1;
      const prevCursor = this.cursor;
      this.text =
        this.text.slice(0, prevCursor - deleteSize) +
        this.text.slice(prevCursor);
      this.setCursor(prevCursor - deleteSize);
      this.selectionStart = this.selectionEnd = this.cursor;
      this.updateLines();
    }

    handleDelete() {
      if (this.hasSelection()) {
        return this.deleteSelection();
      }
      if (this.cursor < this.text.length) {
        this.saveState();
        this.text =
          this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
        this.updateLines();
      }
    }

    // =========================================================================
    // 描画処理
    // =========================================================================
    renderLoop(timestamp) {
      this.updateCursorBlink(timestamp);
      this.render();
      this.updateTextareaPosition();
      requestAnimationFrame(this.renderLoop.bind(this));
    }

    render() {
      this.ctx.fillStyle = this.config.colors.background;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.save();
      this.ctx.translate(0, -this.scrollY);

      const selection = this.getSelectionRange();
      this.lines.forEach((line, i) => {
        const y = this.config.padding + i * this.config.lineHeight;
        if (
          y + this.config.lineHeight < this.scrollY ||
          y > this.scrollY + this.canvas.height
        )
          return;

        this.renderLineBackground(line, i, y, selection);
        this.renderLineText(line, i, y);
      });
      this.renderCursor();
      this.ctx.restore();
    }

    renderLineBackground(line, lineIndex, y, selection) {
      const lineStartIndex = this.getIndexFromPos(lineIndex, 0);
      let currentX = this.config.padding;
      const lastNonSpaceIndex = (line.match(/\s*$/)?.index ?? line.length) - 1;

      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        const charWidth = this.getCharWidth(char);
        const charIndex = lineStartIndex + j;

        if (charIndex >= selection.start && charIndex < selection.end) {
          this.ctx.fillStyle = this.config.colors.selection;
          this.ctx.fillRect(currentX, y, charWidth, this.config.lineHeight);
        } else if (char === " " && line.substring(0, j + 1).trim() === "") {
          this.ctx.fillStyle = this.config.colors.indentation;
          this.ctx.fillRect(currentX, y, charWidth, this.config.lineHeight);
        } else if (char === " " && j > lastNonSpaceIndex) {
          this.ctx.fillStyle = this.config.colors.trailingSpace;
          this.ctx.fillRect(currentX, y, charWidth, this.config.lineHeight);
        }
        currentX += charWidth;
      }
    }

    renderLineText(line, lineIndex, y) {
      const textY = y + this.config.lineHeight / 2;
      this.ctx.fillStyle = this.config.colors.text;
      this.ctx.textBaseline = "middle";

      const leadingSpaces = line.search(/\S|$/);
      if (leadingSpaces >= this.config.indentSize) {
        const bulletX =
          this.config.padding +
          this.measureText(line.substring(0, leadingSpaces)) -
          this.measureText(" ".repeat(this.config.indentSize)) / 2;
        this.ctx.fillText(
          this.config.bulletChar,
          bulletX - this.measureText(this.config.bulletChar) / 2,
          textY
        );
      }

      this.drawTextWithKerning(line, this.config.padding, textY);

      if (
        this.isFocused &&
        this.isComposing &&
        this.getPosFromIndex(this.cursor).row === lineIndex
      ) {
        this.renderCompositionText(line, y);
      }
    }

    renderCompositionText(line, y) {
      const { col } = this.getPosFromIndex(this.cursor);
      const textY = y + this.config.lineHeight / 2;
      const imeRenderX =
        this.config.padding + this.measureText(line.substring(0, col));
      this.drawTextWithKerning(this.compositionText, imeRenderX, textY);
      const compositionWidth = this.measureText(this.compositionText);
      this.ctx.strokeStyle = this.config.colors.imeUnderline;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(imeRenderX, y + this.config.lineHeight - 2);
      this.ctx.lineTo(
        imeRenderX + compositionWidth,
        y + this.config.lineHeight - 2
      );
      this.ctx.stroke();
    }

    renderCursor() {
      if (!this.isFocused || this.isComposing) return;
      const cursorPos = this.getCursorCoords(this.cursor);
      if (this.isOverwriteMode) {
        const char = this.text[this.cursor] || " ";
        const charWidth = this.getCharWidth(char);
        this.ctx.fillStyle = this.config.colors.overwriteCursor;
        this.ctx.fillRect(cursorPos.x, cursorPos.y, charWidth, this.config.lineHeight);
      } else if (this.cursorBlinkState) {
        this.ctx.fillStyle = this.config.colors.cursor;
        this.ctx.fillRect(cursorPos.x, cursorPos.y, 2, this.config.lineHeight);
      }
    }

    // =========================================================================
    // テキストと状態の操作
    // =========================================================================
    focus() {
      if (this.isFocused) return;
      this.isFocused = true;
      this.textarea.focus();
      this.resetCursorBlink();
    }

    blur() {
      this.isFocused = false;
      this.textarea.blur();
    }

    insertText(newText) {
      this.saveState();
      if (this.hasSelection()) {
        this.deleteSelection(false); // 履歴の二重保存を防ぐ
      }
      const prevCursor = this.cursor;
      if (
        this.isOverwriteMode &&
        this.cursor < this.text.length &&
        newText !== "\n"
      ) {
        const end = prevCursor + newText.length;
        this.text = this.text.slice(0, prevCursor) + newText + this.text.slice(end);
      } else {
        this.text =
          this.text.slice(0, prevCursor) + newText + this.text.slice(prevCursor);
      }
      this.setCursor(prevCursor + newText.length);
      this.selectionStart = this.selectionEnd = this.cursor;
      this.updateLines();
      this.preferredCursorX = -1;
    }

    deleteSelection(save = true) {
      if (!this.hasSelection()) return;
      if (save) this.saveState();
      const { start, end } = this.getSelectionRange();
      this.text = this.text.slice(0, start) + this.text.slice(end);
      this.setCursor(start);
      this.selectionStart = this.selectionEnd = this.cursor;
      this.updateLines();
    }

    updateLines() {
      this.lines = this.text.split("\n");
    }

    updateCursorBlink(timestamp) {
      if (!this.isFocused) return;
      if (timestamp - this.lastBlinkTime > this.config.blinkInterval) {
        this.cursorBlinkState = !this.cursorBlinkState;
        this.lastBlinkTime = timestamp;
      }
    }

    resetCursorBlink() {
      this.lastBlinkTime = performance.now();
      this.cursorBlinkState = true;
    }

    // =========================================================================
    // カーソルと選択範囲の移動
    // =========================================================================
    setCursor(index, resetX = true) {
      this.cursor = Math.max(0, Math.min(this.text.length, index));
      if (resetX) {
        this.preferredCursorX = -1;
      }
      this.scrollToCursor();
      this.resetCursorBlink();
    }

    handleArrowKeys(e) {
      const originalCursor = this.cursor;
      switch (e.key) {
        case "ArrowLeft":
          this.setCursor(this.cursor > 0 ? this.cursor - 1 : 0);
          break;
        case "ArrowRight":
          this.setCursor(
            this.cursor < this.text.length ? this.cursor + 1 : this.text.length
          );
          break;
        case "ArrowUp":
          this.moveCursorLine(-1);
          break;
        case "ArrowDown":
          this.moveCursorLine(1);
          break;
      }
      if (e.shiftKey) {
        this.selectionEnd = this.cursor;
      } else {
        this.selectionStart = this.selectionEnd = this.cursor;
      }
    }

    moveCursorLine(direction) {
      const { row, col } = this.getPosFromIndex(this.cursor);
      if (this.preferredCursorX < 0) {
        this.preferredCursorX = this.measureText(this.lines[row].substring(0, col));
      }
      const newRow = Math.max(0, Math.min(this.lines.length - 1, row + direction));
      if (newRow === row) return;
      const newCol = this.getColFromX(this.lines[newRow], this.preferredCursorX);
      this.setCursor(this.getIndexFromPos(newRow, newCol), false);
    }

    handleHomeEndKeys(e) {
      const { row } = this.getPosFromIndex(this.cursor);
      const newCol = e.key === "Home" ? 0 : this.lines[row].length;
      const newCursorPos = this.getIndexFromPos(row, newCol);
      if (e.shiftKey) {
        this.selectionEnd = newCursorPos;
      } else {
        this.selectionStart = this.selectionEnd = newCursorPos;
      }
      this.setCursor(newCursorPos);
    }

    handlePageKeys(e) {
      const direction = e.key === "PageUp" ? -1 : 1;
      const { row, col } = this.getPosFromIndex(this.cursor);
      if (this.preferredCursorX < 0) {
        this.preferredCursorX = this.measureText(this.lines[row].substring(0, col));
      }
      const newRow = Math.max(
        0,
        Math.min(this.lines.length - 1, row + direction * this.visibleLines)
      );
      const newCol = this.getColFromX(this.lines[newRow], this.preferredCursorX);
      const newCursorPos = this.getIndexFromPos(newRow, newCol);
      if (e.shiftKey) {
        this.selectionEnd = newCursorPos;
      } else {
        this.selectionStart = this.selectionEnd = newCursorPos;
      }
      this.setCursor(newCursorPos, false);
    }

    scrollToCursor() {
      const { y: cursorY } = this.getCursorCoords(this.cursor);
      const visibleTop = this.scrollY;
      const visibleBottom =
        this.scrollY + this.canvas.height - this.config.padding * 2;
      if (cursorY < visibleTop) {
        this.scrollY = cursorY - this.config.padding;
      } else if (cursorY + this.config.lineHeight > visibleBottom) {
        this.scrollY =
          cursorY +
          this.config.lineHeight -
          (this.canvas.height - this.config.padding * 2) +
          this.config.padding;
      }
    }

    // =========================================================================
    // 履歴 (Undo/Redo)
    // =========================================================================
    saveState() {
      if (this.isUndoingOrRedoing) return;
      const state = {
        text: this.text,
        cursor: this.cursor,
        selectionStart: this.selectionStart,
        selectionEnd: this.selectionEnd,
      };
      this.undoStack.push(state);
      if (this.undoStack.length > this.config.historyLimit) {
        this.undoStack.shift();
      }
      this.redoStack = [];
    }

    applyState(state) {
      this.text = state.text;
      this.selectionStart = state.selectionStart;
      this.selectionEnd = state.selectionEnd;
      this.updateLines();
      this.setCursor(state.cursor);
    }

    undo() {
      if (this.undoStack.length === 0) return;
      this.isUndoingOrRedoing = true;
      const currentState = {
        text: this.text,
        cursor: this.cursor,
        selectionStart: this.selectionStart,
        selectionEnd: this.selectionEnd,
      };
      this.redoStack.push(currentState);
      this.applyState(this.undoStack.pop());
      this.isUndoingOrRedoing = false;
    }

    redo() {
      if (this.redoStack.length === 0) return;
      this.isUndoingOrRedoing = true;
      const currentState = {
        text: this.text,
        cursor: this.cursor,
        selectionStart: this.selectionStart,
        selectionEnd: this.selectionEnd,
      };
      this.undoStack.push(currentState);
      this.applyState(this.redoStack.pop());
      this.isUndoingOrRedoing = false;
    }

    // =========================================================================
    // ユーティリティ
    // =========================================================================
    getCharWidth(char) {
      if (this.charWidthCache.has(char)) {
        return this.charWidthCache.get(char);
      }
      const width = this.ctx.measureText(char).width;
      this.charWidthCache.set(char, width);
      return width;
    }

    measureText(text) {
      let totalWidth = 0;
      for (const char of text) totalWidth += this.getCharWidth(char);
      return totalWidth;
    }

    drawTextWithKerning(text, startX, y) {
      let currentX = startX;
      for (const char of text) {
        this.ctx.fillText(char, currentX, y);
        currentX += this.getCharWidth(char);
      }
    }

    hasSelection() {
      return this.selectionStart !== this.selectionEnd;
    }

    getSelectionRange() {
      return {
        start: Math.min(this.selectionStart, this.selectionEnd),
        end: Math.max(this.selectionStart, this.selectionEnd),
      };
    }

    getPosFromIndex(index) {
      let count = 0;
      for (let i = 0; i < this.lines.length; i++) {
        const lineLength = this.lines[i].length + 1;
        if (count + lineLength > index) {
          return { row: i, col: index - count };
        }
        count += lineLength;
      }
      return {
        row: this.lines.length - 1,
        col: this.lines[this.lines.length - 1].length,
      };
    }

    getIndexFromPos(row, col) {
      let index = 0;
      for (let i = 0; i < row; i++) {
        index += this.lines[i].length + 1;
      }
      return index + col;
    }

    getCursorCoords(index) {
      const { row, col } = this.getPosFromIndex(index);
      const textBefore = this.lines[row].substring(0, col);
      const x = this.config.padding + this.measureText(textBefore);
      const y = this.config.padding + row * this.config.lineHeight;
      return { x, y };
    }

    getCursorIndexFromCoords(x, y) {
      const row = Math.max(
        0,
        Math.min(
          this.lines.length - 1,
          Math.floor(
            (y + this.scrollY - this.config.padding) / this.config.lineHeight
          )
        )
      );
      const col = this.getColFromX(this.lines[row], x - this.config.padding);
      return this.getIndexFromPos(row, col);
    }

    getColFromX(line, targetX) {
      let minDelta = Infinity;
      let col = 0;
      for (let i = 0; i <= line.length; i++) {
        const w = this.measureText(line.substring(0, i));
        const delta = Math.abs(targetX - w);
        if (delta < minDelta) {
          minDelta = delta;
          col = i;
        }
      }
      return col;
    }

    updateTextareaPosition() {
      if (!this.isFocused) return;
      const coords = this.getCursorCoords(this.cursor);
      this.textarea.style.left = `${coords.x}px`;
      this.textarea.style.top = `${coords.y - this.scrollY}px`;
    }
  }

  new CanvasEditor(
    document.getElementById("editor-canvas"),
    document.getElementById("hidden-input")
  );
});