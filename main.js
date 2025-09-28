class CanvasEditor {
  constructor(canvas, textarea) {
    this.canvas = canvas;
    this.textarea = textarea;
    this.ctx = canvas.getContext("2d");

    // --- 設定 ---
    this.font = '22px "Space Mono", "Noto Sans JP", monospace';
    this.padding = 10;
    this.lineHeight = 30;
    // ★★★ 追加: インデント幅（スペースの数）を定義 ★★★
    this.indentSize = 2;
    this.colors = {
      background: "#282c34",
      text: "#abb2bf",
      cursor: "#528bff",
      selection: "rgba(58, 67, 88, 0.8)",
      imeUnderline: "#abb2bf",
    };

    // --- データ構造 ---
    this.text = "Tabキーでインデントできます。\n" +
      "  Shift+Tabでデインデントします。\n" +
      "複数行を選択して、\n" +
      "まとめてインデントすることも可能です。";
    this.lines = [];

    this.cursor = 0;
    this.selectionStart = 0;
    this.selectionEnd = 0;

    // --- 状態管理 ---
    this.isFocused = false;
    this.isComposing = false;
    this.compositionText = "";
    this.isDragging = false;
    this.cursorBlinkState = true;
    this.lastBlinkTime = 0;
    this.blinkInterval = 500;

    this.init();
  }

  init() {
    this.ctx.font = this.font;
    this.textarea.style.font = this.font;
    this.updateLines();
    this.bindEvents();
    requestAnimationFrame(this.renderLoop.bind(this));
  }

  // --- イベント関連 ---
  bindEvents() {
    this.canvas.addEventListener("mousedown", this.onMouseDown.bind(this));
    this.canvas.addEventListener("mousemove", this.onMouseMove.bind(this));
    window.addEventListener("mouseup", this.onMouseUp.bind(this));
    document.addEventListener("click", (e) => {
      if (e.target !== this.canvas) this.blur();
    });

    this.textarea.addEventListener("input", this.onInput.bind(this));
    this.textarea.addEventListener("keydown", this.onKeydown.bind(this));
    this.textarea.addEventListener("compositionstart", () => { this.isComposing = true; });
    this.textarea.addEventListener("compositionupdate", (e) => { this.compositionText = e.data; });
    this.textarea.addEventListener("compositionend", (e) => {
      this.isComposing = false;
      this.compositionText = "";
      this.onInput({ target: { value: e.data } });
    });
  }

  onMouseDown(e) {
    e.preventDefault();
    this.focus();
    this.isDragging = true;
    const pos = this.getCursorIndexFromCoords(e.offsetX, e.offsetY);
    this.setCursor(pos);
    this.selectionStart = this.cursor;
    this.selectionEnd = this.cursor;
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
  }

  onInput(e) {
    if (this.isComposing) return;
    const newText = e.target.value;
    if (newText) {
      this.insertText(newText);
      this.textarea.value = "";
    }
  }


  onKeydown(e) {
    if (this.isComposing) return;

    if (e.metaKey || e.ctrlKey) { return; }

    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown":
        e.preventDefault();
        this.handleArrowKeys(e);
        break;
      case "Backspace":
        e.preventDefault();
        if (this.hasSelection()) {
          this.deleteSelection();
        } else if (this.cursor > 0) {
          const prevCursor = this.cursor - 1;
          this.text = this.text.slice(0, prevCursor) + this.text.slice(this.cursor);
          this.setCursor(prevCursor);
          this.selectionStart = this.selectionEnd = this.cursor;
          this.updateLines();
        }
        break;
      case "Delete":
        e.preventDefault();
        if (this.hasSelection()) {
          this.deleteSelection();
        } else if (this.cursor < this.text.length) {
          this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
          this.updateLines();
        }
        break;
      case "Enter":
        e.preventDefault();
        this.insertText("\n");
        break;

      // ★★★ 変更: Tab と Shift+Tab の処理を追加 ★★★
      case "Tab":
        e.preventDefault();
        this.modifyIndent(!e.shiftKey); // shiftキーが押されていなければインデント
        break;

      default:
        break;
    }
  }

  // --- 描画関連 ---

  renderLoop(timestamp) {
    this.updateCursorBlink(timestamp);
    this.render();
    this.updateTextareaPosition();
    requestAnimationFrame(this.renderLoop.bind(this));
  }

  render() {
    this.ctx.fillStyle = this.colors.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const selection = this.getSelectionRange();
    const cursorPosition = this.getPosFromIndex(this.cursor);

    this.lines.forEach((line, i) => {
      const y = this.padding + i * this.lineHeight;
      const textY = y + this.lineHeight / 2;
      let currentX = this.padding;

      // 選択範囲の描画
      const lineStartIndex = this.getIndexFromPos(i, 0);
      for (let j = 0; j < line.length; j++) {
        const charIndex = lineStartIndex + j;
        const charWidth = this.ctx.measureText(line[j]).width;
        if (charIndex >= selection.start && charIndex < selection.end) {
          this.ctx.fillStyle = this.colors.selection;
          this.ctx.fillRect(currentX, y, charWidth, this.lineHeight);
        }
        currentX += charWidth;
      }

      // テキストの描画
      this.ctx.fillStyle = this.colors.text;
      this.ctx.textBaseline = "middle";
      this.ctx.fillText(line, this.padding, textY);

      // IME入力中の描画
      if (this.isFocused && this.isComposing && cursorPosition.row === i) {
        const lineBefore = line.substring(0, cursorPosition.col);
        const imeRenderX = this.padding + this.ctx.measureText(lineBefore).width;
        this.ctx.fillText(this.compositionText, imeRenderX, textY);
        const compositionWidth = this.ctx.measureText(this.compositionText).width;

        this.ctx.strokeStyle = this.colors.imeUnderline;
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(imeRenderX, y + this.lineHeight - 2);
        this.ctx.lineTo(imeRenderX + compositionWidth, y + this.lineHeight - 2);
        this.ctx.stroke();
      }
    });

    // カーソルの描画
    if (this.isFocused && !this.isComposing && this.cursorBlinkState) {
      const cursorPos = this.getCursorCoords(this.cursor);
      this.ctx.fillStyle = this.colors.cursor;
      this.ctx.fillRect(cursorPos.x, cursorPos.y, 2, this.lineHeight);
    }
  }

  // --- 状態更新・ヘルパー関数 ---

  focus() {
    if (this.isFocused) return;
    this.isFocused = true;
    this.lastBlinkTime = performance.now();
    this.cursorBlinkState = true;
    this.textarea.focus();
  }

  blur() {
    this.isFocused = false;
    this.textarea.blur();
  }

  insertText(newText) {
    if (this.hasSelection()) {
      this.deleteSelection();
    }
    const prevCursor = this.cursor;
    this.text = this.text.slice(0, prevCursor) + newText + this.text.slice(prevCursor);
    this.setCursor(prevCursor + newText.length);
    this.selectionStart = this.selectionEnd = this.cursor;
    this.updateLines();
  }

  deleteSelection() {
    if (!this.hasSelection()) return;
    const { start, end } = this.getSelectionRange();
    this.text = this.text.slice(0, start) + this.text.slice(end);
    this.setCursor(start);
    this.selectionStart = this.selectionEnd = this.cursor;
    this.updateLines();
  }

  updateLines() {
    this.lines = this.text.split('\n');
  }

  updateCursorBlink(timestamp) {
    if (!this.isFocused) return;
    if (timestamp - this.lastBlinkTime > this.blinkInterval) {
      this.cursorBlinkState = !this.cursorBlinkState;
      this.lastBlinkTime = timestamp;
    }
  }

  setCursor(index) {
    this.cursor = Math.max(0, Math.min(this.text.length, index));
  }

  handleArrowKeys(e) {
    const currentPos = this.getPosFromIndex(this.cursor);
    switch (e.key) {
      case "ArrowLeft":
        if (this.cursor > 0) this.setCursor(this.cursor - 1);
        break;
      case "ArrowRight":
        if (this.cursor < this.text.length) this.setCursor(this.cursor + 1);
        break;
      case "ArrowUp":
        if (currentPos.row > 0) {
          const targetCol = currentPos.col;
          const newIndex = this.getIndexFromPos(currentPos.row - 1, targetCol);
          // 移動先の行が短い場合、行末に合わせる
          const targetLineLength = this.lines[currentPos.row - 1].length;
          if (targetCol > targetLineLength) {
            this.setCursor(this.getIndexFromPos(currentPos.row - 1, targetLineLength));
          } else {
            this.setCursor(newIndex);
          }
        }
        break;
      case "ArrowDown":
        if (currentPos.row < this.lines.length - 1) {
          const targetCol = currentPos.col;
          const newIndex = this.getIndexFromPos(currentPos.row + 1, targetCol);
          // 移動先の行が短い場合、行末に合わせる
          const targetLineLength = this.lines[currentPos.row + 1].length;
          if (targetCol > targetLineLength) {
            this.setCursor(this.getIndexFromPos(currentPos.row + 1, targetLineLength));
          } else {
            this.setCursor(newIndex);
          }
        }
        break;
    }
    if (!e.shiftKey) {
      this.selectionStart = this.selectionEnd = this.cursor;
    } else {
      this.selectionEnd = this.cursor;
    }
  }

  // ★★★ 改善点: 座標と文字インデックスを相互変換する重要な関数 ★★★
  getPosFromIndex(index) {
    let count = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const lineLength = this.lines[i].length + 1; // +1 for newline char
      if (count + lineLength > index) {
        return { row: i, col: index - count };
      }
      count += lineLength;
    }
    const lastLine = this.lines[this.lines.length - 1];
    return { row: this.lines.length - 1, col: lastLine.length };
  }

  getIndexFromPos(row, col) {
    let index = 0;
    for (let i = 0; i < row; i++) {
      index += this.lines[i].length + 1; // +1 for newline char
    }
    return index + col;
  }

  getCursorCoords(index) {
    const { row, col } = this.getPosFromIndex(index);
    const textBefore = this.lines[row].substring(0, col);
    const x = this.padding + this.ctx.measureText(textBefore).width;
    const y = this.padding + row * this.lineHeight;
    return { x, y };
  }

  getCursorIndexFromCoords(x, y) {
    const row = Math.max(0, Math.min(this.lines.length - 1, Math.floor((y - this.padding) / this.lineHeight)));
    const line = this.lines[row];
    let minDelta = Infinity;
    let col = 0;
    // クリックされたX座標に最も近い文字位置を探す
    for (let i = 0; i <= line.length; i++) {
      const w = this.ctx.measureText(line.substring(0, i)).width;
      const delta = Math.abs(x - (this.padding + w));
      if (delta < minDelta) {
        minDelta = delta;
        col = i;
      }
    }
    return this.getIndexFromPos(row, col);
  }

  updateTextareaPosition() {
    if (!this.isFocused) return;
    const coords = this.getCursorCoords(this.cursor);
    this.textarea.style.left = `${this.canvas.offsetLeft + coords.x}px`;
    this.textarea.style.top = `${this.canvas.offsetTop + coords.y}px`;
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

  // ★★★ 追加: インデント操作のメインロジック ★★★
  modifyIndent(isIndent) {
    const selection = this.getSelectionRange();
    const startPos = this.getPosFromIndex(selection.start);
    const endPos = this.getPosFromIndex(selection.end);

    const lines = this.text.split('\n');
    let charsChanged = 0; // テキスト全体の文字数変化を追跡

    // 選択範囲の開始行から終了行までをループ
    for (let i = startPos.row; i <= endPos.row; i++) {
      const originalLine = lines[i];
      if (isIndent) {
        // インデントを追加
        lines[i] = ' '.repeat(this.indentSize) + originalLine;
        charsChanged += this.indentSize;
      } else {
        // デインデント（インデントを削除）
        const indentRegex = new RegExp(`^ {1,${this.indentSize}}`);
        lines[i] = originalLine.replace(indentRegex, '');
        charsChanged -= (originalLine.length - lines[i].length);
      }
    }

    // 変更後のテキストで全体を更新
    this.text = lines.join('\n');
    this.updateLines();

    // 選択範囲を更新
    // 開始位置は変わらないが、終了位置は文字数変化の影響を受ける
    this.selectionEnd += charsChanged;
  }
}

new CanvasEditor(
  document.getElementById("editor-canvas"),
  document.getElementById("hidden-input")
);