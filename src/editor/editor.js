import CanvasRenderer from "../renderer/canvas-renderer.js";
import SearchController from "../dom-ui/search-controller.js";
import { handleCtrlShortcuts as handleCtrlShortcutsCommand } from "../input-handler/keyboard-shortcuts.js";
import {
  handleLeadingSpaceIndentInput as handleLeadingSpaceIndentInputCommand,
  processCommittedText as processCommittedTextCommand,
} from "../input-handler/text-input.js";
import { findWordBoundary as findWordBoundaryPoint } from "../input-handler/word-boundary.js";
import { clamp, normalizeNewlines } from "../util/index.js";

class CanvasEditor extends CanvasRenderer {
  constructor(canvas, textarea) {
    super(canvas);
    this.textarea = textarea;
    this.container = canvas ? canvas.parentElement : null;

    this.config = {
      padding: 12,
      blinkInterval: 500,
      historyLimit: 200,
      colors: {
        background: "#282c34",
        text: "#abb2bf",
        quoteText: "#6b717d",
        cursor: "#528bff",
        selection: "rgba(58, 67, 88, 0.8)",
        imeUnderline: "#abb2bf",
        indentation: "rgba(255, 255, 255, 0.08)",
        trailingSpace: "rgba(255, 82, 82, 0.3)",
        link: "#61afef",
        relativeLink: "#98c379",
        overwriteCursor: "rgba(82, 139, 255, 0.5)",
        searchMatch: "rgba(229, 192, 123, 0.35)",
        searchActiveMatch: "rgba(229, 192, 123, 0.6)",
      },
      search: {
        regexTimeoutMs: 1500,
      },
    };

    this.state = this.createInitialState();

    this.isFocused = false;
    this.isDragging = false;
    this.isComposing = false;
    this.compositionText = "";
    this.cursorBlinkState = true;
    this.lastBlinkTime = 0;
    this.selectionAnchor = null;
    this.preferredCursorX = -1;

    this.visibleLinesCache = null;
    this.ignoreNextClick = false;
    this.draggedDuringClick = false;

    this.documentVersion = 0;
    this.searchController = new SearchController(this);
    this.skipNextInputCommit = false;

    this.activeImageResize = null;
    this.isResizingImage = false;
    this.currentCursorStyle = "";

    this.handleWindowResize = this.handleWindowResize.bind(this);

    this.init();
  }

    createInitialState() {
      const lines = [
        this.createLine({
          type: "text",
          text: "インデントが1の次に3になる場合もあります。",
          indent: 0,
        }),
        this.createLine({
          type: "text",
          text: "Shift + Tabでインデントを戻せます。",
          indent: 1,
        }),
        this.createLine({
          type: "text",
          text: "選択範囲の描画も丁寧に行います。",
          indent: 3,
        }),
      ];
      return {
        lines,
        cursor: { lineIndex: 0, charIndex: 0 },
        selection: null,
        history: { undoStack: [], redoStack: [] },
        view: {
          scrollTop: 0,
          scrollLeft: 0,
          font: '22px "Space Mono", "Noto Sans JP", monospace',
          lineHeight: 30,
          indentWidth: 24,
        },
      };
    }

    createLine(input, indent = 0, collapsed = false) {
      const base = {
        id: CanvasEditor.generateId(),
        indent,
        collapsed,
      };

      if (typeof input === "object" && input !== null) {
        const {
          type = "text",
          text = "",
          image = null,
          indent: customIndent,
          collapsed: customCollapsed,
        } = input;
        const line = {
          ...base,
          indent: customIndent ?? indent,
          collapsed: customCollapsed ?? collapsed,
          type,
          text: type === "text" ? `${text}` : "",
        };
        if (type === "image" && image) {
          line.image = this.createImagePayload(image);
        }
        return line;
      }

      return {
        ...base,
        type: "text",
        text: typeof input === "string" ? input : "",
      };
    }

    createImagePayload(image) {
      const {
        src,
        width,
        height,
        naturalWidth = width,
        naturalHeight = height,
        name = "",
        mimeType = "",
      } = image;
      return {
        src,
        width,
        height,
        naturalWidth,
        naturalHeight,
        name,
        mimeType,
      };
    }

    isImageLine(line) {
      return line && line.type === "image";
    }

    isTextLine(line) {
      return line && line.type !== "image";
    }

    getLineLength(line) {
      if (!line) return 0;
      if (this.isImageLine(line)) {
        return 1;
      }
      return line.text.length;
    }

    getLineContentWidth(line) {
      if (!line) return 0;
      if (this.isImageLine(line)) {
        return line.image?.width ?? 0;
      }
      return this.measureText(line.text);
    }

    getLineDisplayHeight(line) {
      if (!line) return this.state.view.lineHeight;
      if (this.isImageLine(line)) {
        const imageHeight = line.image?.height ?? this.state.view.lineHeight;
        return Math.max(this.state.view.lineHeight, imageHeight);
      }
      return this.state.view.lineHeight;
    }

    cleanupImageCache() {
      if (!this.imageLayoutsCache) return;
      const validIds = new Set(this.state.lines.map((line) => line.id));
      this.imageLayoutsCache.forEach((_, key) => {
        if (!validIds.has(key)) {
          this.imageLayoutsCache.delete(key);
        }
      });
    }

    setCanvasCursor(style) {
      if (!this.canvas) return;
      if (this.currentCursorStyle === style) return;
      this.canvas.style.cursor = style;
      this.currentCursorStyle = style;
    }

    findImageHandle(worldX, worldY) {
      const lineIndex = this.state.cursor.lineIndex;
      const layout = this.imageLayouts?.get(lineIndex);
      if (!layout) return null;
      const handleSize = 12;
      const handleX = layout.x + layout.width;
      const handleY = layout.y + layout.height;
      if (
        worldX >= handleX - handleSize &&
        worldX <= handleX + handleSize &&
        worldY >= handleY - handleSize &&
        worldY <= handleY + handleSize
      ) {
        return {
          lineIndex,
          handle: "bottom-right",
        };
      }
      return null;
    }

    startImageResize(target, worldX, worldY) {
      if (!target) return;
      const line = this.state.lines[target.lineIndex];
      if (!line || !this.isImageLine(line)) return;
      const layout = this.imageLayouts?.get(target.lineIndex);
      const startWidth = line.image?.width ?? layout?.width ?? this.state.view.lineHeight;
      const startHeight = line.image?.height ?? layout?.height ?? this.state.view.lineHeight;
      this.saveHistory();
      this.activeImageResize = {
        lineIndex: target.lineIndex,
        handle: target.handle,
        startPointerX: worldX,
        startPointerY: worldY,
        startWidth,
        startHeight,
        aspectRatio:
          startHeight > 0 ? startWidth / startHeight : 1,
      };
      this.isResizingImage = true;
      this.setCanvasCursor("nwse-resize");
    }

    updateActiveImageResize(worldX, worldY) {
      if (!this.activeImageResize) return;
      const state = this.activeImageResize;
      const line = this.state.lines[state.lineIndex];
      if (!line || !this.isImageLine(line)) return;
      const deltaX = worldX - state.startPointerX;
      const deltaY = worldY - state.startPointerY;
      const minSize = 24;
      const maxSize = 4096;
      const aspect = state.aspectRatio || 1;
      let newWidth = state.startWidth;
      let newHeight = state.startHeight;
      if (Math.abs(deltaX) >= Math.abs(deltaY)) {
        newWidth = clamp(state.startWidth + deltaX, minSize, maxSize);
        newHeight = clamp(Math.round(newWidth / aspect), minSize, maxSize);
      } else {
        newHeight = clamp(state.startHeight + deltaY, minSize, maxSize);
        newWidth = clamp(Math.round(newHeight * aspect), minSize, maxSize);
      }
      if (!line.image) return;
      line.image.width = newWidth;
      line.image.height = newHeight;
      this.invalidateLayout();
    }

    finishImageResize() {
      if (!this.activeImageResize) return;
      this.isResizingImage = false;
      this.activeImageResize = null;
      this.markDocumentVersion();
      this.setCanvasCursor(this.isFocused ? "text" : "default");
    }

    getWorldLineTop(targetLineIndex) {
      if (this.lineTops && this.lineTops.has(targetLineIndex)) {
        return this.lineTops.get(targetLineIndex);
      }
      let currentY = this.config.padding;
      const visibleLines = this.getVisibleLines();
      for (let i = 0; i < visibleLines.length; i += 1) {
        const lineIndex = visibleLines[i];
        if (lineIndex === targetLineIndex) {
          return currentY;
        }
        const line = this.state.lines[lineIndex];
        currentY += this.getLineDisplayHeight(line);
      }
      return currentY;
    }
    static generateId() {
      if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
      }
      return `line-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    }

    init() {
      this.ctx.font = this.state.view.font;
      this.ctx.textBaseline = "alphabetic";
      this.updateTypographyMetrics();
      this.visibleLineCapacity = Math.max(
        1,
        Math.floor(
          (this.canvas.height - this.config.padding * 2) /
          this.state.view.lineHeight
        )
      );
      this.bindEvents();
      this.searchController.init();
      if (document.fonts && document.fonts.ready) {
        document.fonts
          .ready
          .then(() => {
            this.updateTypographyMetrics();
            this.invalidateLayout();
          })
          .catch(() => {});
      }
      requestAnimationFrame(this.renderLoop.bind(this));
    }

    getFontPixelSize() {
      const match = /([0-9]+(?:\.[0-9]+)?)px/.exec(this.state.view.font);
      if (!match) return 16;
      return parseFloat(match[1]);
  }

    bindEvents() {
      this.canvas.addEventListener("mousedown", this.onMouseDown.bind(this));
      this.canvas.addEventListener("mousemove", this.onMouseMove.bind(this));
      window.addEventListener("mouseup", this.onMouseUp.bind(this));
      this.canvas.addEventListener("click", this.onClick.bind(this));
      this.canvas.addEventListener("wheel", this.onWheel.bind(this), {
        passive: false,
      });
      this.canvas.addEventListener("dragover", this.onDragOver.bind(this));
      this.canvas.addEventListener("drop", this.onDrop.bind(this));
      window.addEventListener("resize", this.handleWindowResize);
      document.addEventListener("click", (e) => {
        if (e.target !== this.canvas && e.target !== this.textarea) {
          this.blur();
        }
      });

      this.textarea.addEventListener("focus", () => this.focus());
      this.textarea.addEventListener("blur", () => this.blur());
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
        if (e.data) {
          const handled = this.processCommittedText(e.data);
          this.skipNextInputCommit = handled;
        } else {
          this.skipNextInputCommit = false;
        }
        this.textarea.value = "";
      });
      this.textarea.addEventListener("copy", this.onCopy.bind(this));
      this.textarea.addEventListener("cut", this.onCut.bind(this));
      this.textarea.addEventListener("paste", this.onPaste.bind(this));
    }

    handleWindowResize() {
      this.searchController.scheduleLayoutUpdate();
    }

    openSearchPanel(options = {}) {
      this.searchController.open(options);
    }

    closeSearchPanel() {
      this.searchController.close();
    }

    toggleReplacePanel() {
      this.searchController.toggle();
    }

    scheduleSearchPanelLayoutUpdate() {
      this.searchController.scheduleLayoutUpdate();
    }

    updateSearchPanelLayout() {
      this.searchController.updateLayout();
    }

    updateSearchResults(options = {}) {
      this.searchController.updateResults(options);
    }

    stepSearchMatch(direction) {
      this.searchController.step(direction);
    }

    replaceCurrentMatch() {
      this.searchController.replaceCurrent();
    }

    replaceAllMatches() {
      this.searchController.replaceAll();
    }
    getSegmentColor(segment) {
      if (segment.isQuote) return this.config.colors.quoteText;
      if (segment.isLink) return this.config.colors.link;
      if (segment.isRelativeLink) return this.config.colors.relativeLink;
      return this.config.colors.text;
    }

    getRenderedSegments(line, lineIndex) {
      const isActiveLine = lineIndex === this.state.cursor.lineIndex;
      const segments = [];
      if (this.isImageLine(line)) {
        return segments;
      }
      const text = line.text;
      const trimmed = text.trimStart();
      const isQuote = trimmed.startsWith(">");
      let i = 0;

      while (i < text.length) {
        const nextLinkIndex = text.indexOf("https://", i);
        const nextBracketIndex = text.indexOf("[", i);
        let nextIndex = text.length;
        let tokenType = null;

        if (nextLinkIndex !== -1 && nextLinkIndex < nextIndex) {
          nextIndex = nextLinkIndex;
          tokenType = "link";
        }
        if (nextBracketIndex !== -1 && nextBracketIndex < nextIndex) {
          nextIndex = nextBracketIndex;
          tokenType = "relative";
        }

        if (nextIndex > i) {
          const displayText = text.slice(i, nextIndex);
          segments.push({ displayText, isQuote });
          i = nextIndex;
        } else {
          if (!tokenType) break;
          if (tokenType === "link") {
            const match = text.slice(i).match(/^https:\/\/\S+/);
            const linkText = match ? match[0] : "https://";
            segments.push({
              displayText: linkText,
              isLink: true,
              isQuote,
              target: linkText,
            });
            i += linkText.length;
          } else if (tokenType === "relative") {
            const closingIndex = text.indexOf("]", i + 1);
            if (closingIndex === -1) {
              segments.push({ displayText: text.slice(i), isQuote });
              break;
            }
            const label = text.slice(i + 1, closingIndex);
            const segment = {
              displayText: isActiveLine ? `[${label}]` : label,
              isQuote,
              target: label,
            };
            if (!isActiveLine) {
              segment.isRelativeLink = true;
            }
            segments.push(segment);
            i = closingIndex + 1;
          }
        }
      }

      if (segments.length === 0) {
        segments.push({ displayText: text, isQuote });
      }

      return segments;
    }

    updateCursorBlink(timestamp) {
      if (!this.isFocused) return;
      if (timestamp - this.lastBlinkTime > this.config.blinkInterval) {
        this.cursorBlinkState = !this.cursorBlinkState;
        this.lastBlinkTime = timestamp;
      }
    }

    resetCursorBlink() {
      this.cursorBlinkState = true;
      this.lastBlinkTime = performance.now();
    }

    focus() {
      if (this.isFocused) return;
      this.isFocused = true;
      this.textarea.focus();
      this.resetCursorBlink();
      this.setCanvasCursor("text");
    }

    blur() {
      this.isFocused = false;
      this.textarea.blur();
      this.setCanvasCursor("default");
    }

    onMouseDown(e) {
      e.preventDefault();
      this.focus();
      this.draggedDuringClick = false;
      this.ignoreNextClick = false;
      const worldX = e.offsetX + this.state.view.scrollLeft;
      const worldY = e.offsetY + this.state.view.scrollTop;
      const resizeTarget = this.findImageHandle(worldX, worldY);
      if (resizeTarget) {
        this.startImageResize(resizeTarget, worldX, worldY);
        this.draggedDuringClick = true;
        this.ignoreNextClick = true;
        return;
      }
      const { lineIndex, charIndex, clickedIcon } = this.hitTest(
        e.offsetX,
        e.offsetY
      );
      if (lineIndex === null) return;
      if (clickedIcon) {
        this.ignoreNextClick = true;
        this.toggleCollapse(lineIndex);
        return;
      }
      this.setCursor(lineIndex, charIndex);
      this.selectionAnchor = { ...this.state.cursor };
      this.isDragging = true;
    }

    onMouseMove(e) {
      const worldX = e.offsetX + this.state.view.scrollLeft;
      const worldY = e.offsetY + this.state.view.scrollTop;

      if (this.activeImageResize) {
        e.preventDefault();
        this.updateActiveImageResize(worldX, worldY);
        return;
      }

      if (!this.isDragging) {
        const handle = this.findImageHandle(worldX, worldY);
        if (handle) {
          this.setCanvasCursor("nwse-resize");
        } else {
          this.setCanvasCursor(this.isFocused ? "text" : "default");
        }
        return;
      }

      e.preventDefault();
      this.draggedDuringClick = true;
      const hit = this.hitTest(e.offsetX, e.offsetY);
      if (hit.lineIndex === null) return;
      this.setCursor(hit.lineIndex, hit.charIndex, {
        resetSelection: false,
        scrollIntoView: false,
      });
      if (this.selectionAnchor) {
        this.state.selection = {
          start: { ...this.selectionAnchor },
          end: { ...this.state.cursor },
        };
      }
      this.ensureCursorVisibleWhileDragging(e.offsetX, e.offsetY);
    }

    onMouseUp() {
      this.isDragging = false;
      this.preferredCursorX = -1;
      if (this.activeImageResize) {
        this.finishImageResize();
      }
    }

    onClick(e) {
      if (this.ignoreNextClick) {
        this.ignoreNextClick = false;
        this.draggedDuringClick = false;
        return;
      }
      if (this.draggedDuringClick) {
        this.draggedDuringClick = false;
        return;
      }
      const hit = this.hitTest(e.offsetX, e.offsetY);
      if (hit.lineIndex === null) {
        this.draggedDuringClick = false;
        return;
      }
      if (this.openLinkAt(hit.lineIndex, e.offsetX)) {
        e.preventDefault();
      }
      this.draggedDuringClick = false;
    }

    onWheel(e) {
      e.preventDefault();
      const maxScrollY = this.getMaxScroll();
      const nextY = this.state.view.scrollTop + e.deltaY;
      this.state.view.scrollTop = clamp(nextY, 0, maxScrollY);

      const maxScrollX = this.getMaxHorizontalScroll();
      const nextX = this.state.view.scrollLeft + e.deltaX;
      this.state.view.scrollLeft = clamp(nextX, 0, maxScrollX);
    }

    onInput(e) {
      if (e.isComposing) return;
      const value = e.target.value;
      if (!value) return;
      e.target.value = "";
      if (this.skipNextInputCommit) {
        this.skipNextInputCommit = false;
        return;
      }
      this.processCommittedText(value);
    }

    processCommittedText(text) {
      return processCommittedTextCommand(this, text);
    }

    handleLeadingSpaceIndentInput(text) {
      return handleLeadingSpaceIndentInputCommand(this, text);
    }

    onKeydown(e) {
      if (this.isComposing) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const alt = e.altKey;
      const key = e.key;

      if (key === "Escape" && this.search && this.search.isOpen) {
        e.preventDefault();
        this.closeSearchPanel();
        return;
      }

      if (ctrl && this.handleCtrlShortcuts(e, key, shift)) {
        return;
      }

      if (alt && !ctrl) {
        if (key === "ArrowLeft" || key === "ArrowRight") {
          e.preventDefault();
          const delta = key === "ArrowLeft" ? -1 : 1;
          this.changeIndent(delta, {
            applyToSelection: this.hasSelection(),
            includeChildren: true,
          });
          return;
        }
        if (key === "ArrowUp" || key === "ArrowDown") {
          e.preventDefault();
          this.moveBlock(key === "ArrowUp" ? -1 : 1);
          return;
        }
      }

      switch (key) {
        case "ArrowLeft":
          e.preventDefault();
          this.moveCursorHorizontal(-1, shift);
          break;
        case "ArrowRight":
          e.preventDefault();
          this.moveCursorHorizontal(1, shift);
          break;
        case "ArrowUp":
          e.preventDefault();
          this.moveCursorVertical(-1, shift);
          break;
        case "ArrowDown":
          e.preventDefault();
          this.moveCursorVertical(1, shift);
          break;
        case "Home":
          e.preventDefault();
          this.moveCursorToLineEdge("start", shift);
          break;
        case "End":
          e.preventDefault();
          this.moveCursorToLineEdge("end", shift);
          break;
        case "PageUp":
          e.preventDefault();
          this.moveCursorVertical(-this.visibleLineCapacity, shift);
          break;
        case "PageDown":
          e.preventDefault();
          this.moveCursorVertical(this.visibleLineCapacity, shift);
          break;
        case "Enter":
          e.preventDefault();
          if (shift) {
            this.insertLineBreak({ indent: 0 });
          } else {
            this.insertLineBreak();
          }
          break;
        case "Tab":
          e.preventDefault();
          if (shift) {
            this.changeIndent(-1, {
              applyToSelection: this.hasSelection(),
              includeChildren: false,
            });
          } else {
            this.changeIndent(1, {
              applyToSelection: this.hasSelection(),
              includeChildren: false,
            });
          }
          break;
        case "Backspace":
          e.preventDefault();
          this.handleBackspace();
          break;
        case "Delete":
          e.preventDefault();
          this.handleDelete();
          break;
        case " ":
          if (this.state.cursor.charIndex === 0) {
            e.preventDefault();
            this.changeIndent(1, {
              applyToSelection: this.hasSelection(),
              includeChildren: false,
            });
          }
          break;
        case "　":
          if (this.state.cursor.charIndex === 0) {
            e.preventDefault();
            this.changeIndent(1, {
              applyToSelection: this.hasSelection(),
              includeChildren: false,
            });
          }
          break;
        case "[":
          e.preventDefault();
          this.insertBracketPair();
          break;
        default:
          this.preferredCursorX = -1;
          break;
      }
    }

    handleCtrlShortcuts(e, key, shift) {
      return handleCtrlShortcutsCommand(this, e, key, shift);
    }
    onCopy(e) {
      const text = this.getSelectedText();
      if (!text) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
    }

    onCut(e) {
      const text = this.getSelectedText();
      if (!text) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
      this.deleteSelection();
    }

    onPaste(e) {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.type && item.type.startsWith("image/"));
      if (imageItem) {
        const file = imageItem.getAsFile();
        if (file) {
          e.preventDefault();
          this.insertImageFromFile(file, { source: "clipboard" }).catch((error) => {
            console.error("Failed to insert image from clipboard", error);
          });
          return;
        }
      }

      const paste = e.clipboardData.getData("text/plain");
      if (!paste) return;
      e.preventDefault();
      this.insertText(normalizeNewlines(paste));
    }

    onDragOver(e) {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    }

    onDrop(e) {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []).filter((file) =>
        file.type && file.type.startsWith("image/")
      );
      if (files.length === 0) return;
      this.focus();
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this.hitTest(x, y);
      if (hit.lineIndex !== null) {
        this.setCursor(hit.lineIndex, hit.charIndex);
      } else if (this.state.lines.length > 0) {
        const lastLineIndex = this.state.lines.length - 1;
        this.setCursor(
          lastLineIndex,
          this.getLineLength(this.state.lines[lastLineIndex])
        );
      }

      files
        .reduce(
          (promise, file) =>
            promise.then(() => this.insertImageFromFile(file, { source: "drop" })),
          Promise.resolve()
        )
        .catch((error) => {
          console.error("Failed to insert dropped image", error);
        });
    }

    insertText(text) {
      if (!text) return;
      this.saveHistory();
      if (this.state.selection) {
        this.collapseSelectionWithoutHistory();
      }
      const cursor = this.state.cursor;
      const line = this.state.lines[cursor.lineIndex];
      if (this.isImageLine(line)) {
        const indent = line.indent;
        const parts = normalizeNewlines(text).split("\n");
        const insertBeforeImage = cursor.charIndex === 0;
        let insertIndex = insertBeforeImage
          ? cursor.lineIndex
          : cursor.lineIndex + 1;
        parts.forEach((part) => {
          const newLine = this.createLine({
            type: "text",
            text: part,
            indent,
          });
          this.state.lines.splice(insertIndex, 0, newLine);
          insertIndex += 1;
        });
        const lastPart = parts[parts.length - 1] ?? "";
        this.markDocumentVersion();
        this.setCursor(insertIndex - 1, lastPart.length);
        this.invalidateLayout();
        return;
      }
      const tail = line.text.slice(cursor.charIndex);
      const head = line.text.slice(0, cursor.charIndex);
      const parts = text.split("\n");

      if (parts.length === 1) {
        line.text = head + text + tail;
        this.markDocumentVersion();
        this.setCursor(cursor.lineIndex, cursor.charIndex + text.length);
        return;
      }

      line.text = head + parts[0];
      let insertIndex = cursor.lineIndex + 1;
      const indent = line.indent;
      for (let i = 1; i < parts.length; i += 1) {
        const part = parts[i];
        const newLineText =
          i === parts.length - 1 ? part + tail : part;
        const newLine = this.createLine(newLineText, indent, false);
        this.state.lines.splice(insertIndex, 0, newLine);
        insertIndex += 1;
      }
      this.markDocumentVersion();
      this.setCursor(insertIndex - 1, parts[parts.length - 1].length);
      this.invalidateLayout();
    }

    insertImageFromFile(file, options = {}) {
      if (!file) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result !== "string") {
            resolve();
            return;
          }
          const image = new Image();
          image.onload = () => {
            this.insertImageLine(
              {
                src: result,
                width: image.width,
                height: image.height,
                naturalWidth: image.naturalWidth || image.width,
                naturalHeight: image.naturalHeight || image.height,
                name: file.name,
                mimeType: file.type,
              },
              options
            );
            resolve();
          };
          image.onerror = (error) => {
            reject(error);
          };
          image.src = result;
        };
        reader.onerror = (error) => {
          reject(error);
        };
        reader.readAsDataURL(file);
      });
    }

    insertImageLine(imageData, options = {}) {
      if (!imageData || !imageData.src) return;
      if (this.state.lines.length === 0) {
        const placeholder = this.createLine({ type: "text", text: "", indent: 0 });
        this.state.lines.push(placeholder);
        this.state.cursor = { lineIndex: 0, charIndex: 0 };
      }

      this.saveHistory();
      if (this.state.selection) {
        this.collapseSelectionWithoutHistory();
      }

      const cursor = this.state.cursor;
      const currentLine = this.state.lines[cursor.lineIndex];
      let insertIndex = cursor.lineIndex + 1;
      let tailLine = null;
      let targetIndent = currentLine ? currentLine.indent : 0;
      let imageLine = null;

      if (!currentLine) {
        insertIndex = this.state.lines.length;
      } else if (this.isTextLine(currentLine)) {
        const head = currentLine.text.slice(0, cursor.charIndex);
        const tail = currentLine.text.slice(cursor.charIndex);
        if (head.length === 0 && tail.length === 0) {
          imageLine = this.createLine({
            type: "image",
            indent: currentLine.indent,
            image: imageData,
          });
          this.state.lines.splice(cursor.lineIndex, 1, imageLine);
          this.markDocumentVersion();
          this.setCursor(cursor.lineIndex, this.getLineLength(imageLine));
          this.invalidateLayout();
          return;
        }
        currentLine.text = head;
        if (tail.length > 0) {
          tailLine = this.createLine({
            type: "text",
            text: tail,
            indent: currentLine.indent,
          });
        }
        insertIndex = cursor.lineIndex + 1;
      } else if (this.isImageLine(currentLine)) {
        insertIndex = cursor.charIndex === 0
          ? cursor.lineIndex
          : cursor.lineIndex + 1;
        targetIndent = currentLine.indent;
      } else {
        insertIndex = cursor.lineIndex + 1;
      }

      if (!imageLine) {
        imageLine = this.createLine({
          type: "image",
          indent: targetIndent,
          image: imageData,
        });
        this.state.lines.splice(insertIndex, 0, imageLine);
      } else {
        insertIndex = cursor.lineIndex;
      }
      if (tailLine) {
        this.state.lines.splice(insertIndex + 1, 0, tailLine);
      }

      this.markDocumentVersion();
      const nextCursorLine = tailLine ? insertIndex + 1 : insertIndex;
      const nextCursorChar = tailLine ? 0 : this.getLineLength(imageLine);
      this.setCursor(nextCursorLine, nextCursorChar);
      this.invalidateLayout();
    }

    insertLineBreak(options = {}) {
      const { indent } = options;
      this.saveHistory();
      if (this.state.selection) {
        this.collapseSelectionWithoutHistory();
      }
      const cursor = this.state.cursor;
      const line = this.state.lines[cursor.lineIndex];
      if (this.isImageLine(line)) {
        const newIndent =
          typeof indent === "number" ? indent : line.indent;
        const insertIndex = cursor.charIndex === 0
          ? cursor.lineIndex
          : cursor.lineIndex + 1;
        const newLine = this.createLine({
          type: "text",
          text: "",
          indent: newIndent,
        });
        this.state.lines.splice(insertIndex, 0, newLine);
        this.markDocumentVersion();
        this.setCursor(insertIndex, 0);
        this.invalidateLayout();
        return;
      }
      const tail = line.text.slice(cursor.charIndex);
      const head = line.text.slice(0, cursor.charIndex);
      line.text = head;
      const newIndent =
        typeof indent === "number" ? indent : line.indent;
      const newLine = this.createLine(tail, newIndent, false);
      this.state.lines.splice(cursor.lineIndex + 1, 0, newLine);
      this.markDocumentVersion();
      this.setCursor(cursor.lineIndex + 1, 0);
      this.invalidateLayout();
    }

    insertBracketPair() {
      this.saveHistory();
      if (this.state.selection) {
        const selection = this.getNormalizedSelection();
        const extracted = this.getSelectedText();
        this.collapseSelectionWithoutHistory();
        const line = this.state.lines[this.state.cursor.lineIndex];
        if (this.isImageLine(line)) {
          return;
        }
        const cursor = this.state.cursor;
        const head = line.text.slice(0, cursor.charIndex);
        const tail = line.text.slice(cursor.charIndex);
        line.text = `${head}[${extracted}]${tail}`;
        this.markDocumentVersion();
        this.setCursor(cursor.lineIndex, cursor.charIndex + extracted.length + 2);
      } else {
        const cursor = this.state.cursor;
        const line = this.state.lines[cursor.lineIndex];
        if (this.isImageLine(line)) {
          return;
        }
        const head = line.text.slice(0, cursor.charIndex);
        const tail = line.text.slice(cursor.charIndex);
        line.text = `${head}[]${tail}`;
        this.markDocumentVersion();
        this.setCursor(cursor.lineIndex, cursor.charIndex + 1);
      }
    }

    handleBackspace() {
      if (this.deleteSelection()) return;
      const cursor = this.state.cursor;
      const line = this.state.lines[cursor.lineIndex];
      if (this.isImageLine(line)) {
        if (cursor.charIndex === 0 && line.indent > 0) {
          this.changeIndent(-1);
          return;
        }
        if (cursor.lineIndex === 0) {
          return;
        }
        this.saveHistory();
        this.state.lines.splice(cursor.lineIndex, 1);
        this.markDocumentVersion();
        const targetIndex = Math.max(0, cursor.lineIndex - 1);
        const targetLine = this.state.lines[targetIndex];
        const targetChar = this.getLineLength(targetLine);
        this.setCursor(targetIndex, targetChar);
        this.invalidateLayout();
        return;
      }
      if (cursor.charIndex > 0) {
        this.saveHistory();
        line.text =
          line.text.slice(0, cursor.charIndex - 1) +
          line.text.slice(cursor.charIndex);
        this.markDocumentVersion();
        this.setCursor(cursor.lineIndex, cursor.charIndex - 1);
        return;
      }
      if (cursor.lineIndex > 0) {
        const previousIndex = cursor.lineIndex - 1;
        const previousLine = this.state.lines[previousIndex];
        if (this.isImageLine(previousLine)) {
          this.saveHistory();
          this.state.lines.splice(previousIndex, 1);
          this.markDocumentVersion();
          this.setCursor(previousIndex, 0);
          this.invalidateLayout();
          return;
        }
      }
      if (line.indent > 0) {
        this.changeIndent(-1);
        return;
      }
      if (cursor.lineIndex === 0) return;
      this.saveHistory();
      const prevLineIndex = cursor.lineIndex - 1;
      const prevLine = this.state.lines[prevLineIndex];
      const prevLength = this.getLineLength(prevLine);
      if (this.isTextLine(prevLine)) {
        prevLine.text += line.text;
      }
      const blockEnd = this.getDescendantEnd(cursor.lineIndex);
      const hasChildren = blockEnd > cursor.lineIndex + 1;
      this.state.lines.splice(cursor.lineIndex, hasChildren ? 1 : blockEnd - cursor.lineIndex);
      this.markDocumentVersion();
      this.setCursor(prevLineIndex, prevLength);
      this.invalidateLayout();
    }

    handleDelete() {
      if (this.deleteSelection()) return;
      const cursor = this.state.cursor;
      const line = this.state.lines[cursor.lineIndex];
      if (this.isImageLine(line)) {
        this.saveHistory();
        this.state.lines.splice(cursor.lineIndex, 1);
        this.markDocumentVersion();
        const targetIndex = Math.min(cursor.lineIndex, this.state.lines.length - 1);
        if (this.state.lines.length === 0) {
          const newLine = this.createLine({ type: "text", text: "", indent: 0 });
          this.state.lines.push(newLine);
          this.setCursor(0, 0);
        } else {
          const targetLine = this.state.lines[targetIndex];
          const targetChar = Math.min(
            cursor.charIndex,
            this.getLineLength(targetLine)
          );
          this.setCursor(targetIndex, targetChar);
        }
        this.invalidateLayout();
        return;
      }
      if (cursor.charIndex < line.text.length) {
        this.saveHistory();
        line.text =
          line.text.slice(0, cursor.charIndex) +
          line.text.slice(cursor.charIndex + 1);
        this.markDocumentVersion();
        return;
      }
      if (cursor.lineIndex >= this.state.lines.length - 1) return;
      this.saveHistory();
      const nextLineIndex = cursor.lineIndex + 1;
      const nextLine = this.state.lines[nextLineIndex];
      if (this.isImageLine(nextLine)) {
        this.state.lines.splice(nextLineIndex, 1);
        this.markDocumentVersion();
        this.invalidateLayout();
        return;
      }
      if (nextLine.indent > line.indent) {
        nextLine.indent = line.indent;
      }
      line.text += nextLine.text;
      const blockLength = this.getDescendantEnd(nextLineIndex) - nextLineIndex;
      this.state.lines.splice(nextLineIndex, blockLength);
      this.markDocumentVersion();
      this.invalidateLayout();
    }

    deleteSelection() {
      if (!this.state.selection) return false;
      this.saveHistory();
      this.collapseSelectionWithoutHistory();
      return true;
    }

    collapseSelectionWithoutHistory() {
      const range = this.getNormalizedSelection();
      if (!range) return null;
      const { start, end } = range;
      const startLine = this.state.lines[start.lineIndex];
      const endLine = this.state.lines[end.lineIndex];
      if (start.lineIndex === end.lineIndex) {
        startLine.text =
          startLine.text.slice(0, start.charIndex) +
          startLine.text.slice(end.charIndex);
      } else {
        startLine.text =
          startLine.text.slice(0, start.charIndex) +
          endLine.text.slice(end.charIndex);
        const removeCount = end.lineIndex - start.lineIndex;
        this.state.lines.splice(start.lineIndex + 1, removeCount);
      }
      this.markDocumentVersion();
      this.setCursor(start.lineIndex, start.charIndex);
      this.state.selection = null;
      this.selectionAnchor = null;
      this.invalidateLayout();
      return start;
    }

    selectAll() {
      if (this.state.lines.length === 0) return;
      const lastLineIndex = this.state.lines.length - 1;
      const lastChar = this.getLineLength(this.state.lines[lastLineIndex]);
      this.state.selection = {
        start: { lineIndex: 0, charIndex: 0 },
        end: { lineIndex: lastLineIndex, charIndex: lastChar },
      };
      this.setCursor(lastLineIndex, lastChar, { resetSelection: false });
    }
    moveCursorHorizontal(direction, extendSelection = false) {
      if (this.state.selection && !extendSelection) {
        const target =
          direction < 0
            ? this.getNormalizedSelection().start
            : this.getNormalizedSelection().end;
        this.setCursor(target.lineIndex, target.charIndex);
        this.state.selection = null;
        return;
      }

      const cursor = this.state.cursor;
      const line = this.state.lines[cursor.lineIndex];
      const lineLength = this.getLineLength(line);
      let newLineIndex = cursor.lineIndex;
      let newCharIndex = cursor.charIndex + direction;

      if (newCharIndex < 0) {
        const prevVisible = this.getPreviousVisibleLine(cursor.lineIndex);
        if (prevVisible === null) {
          newCharIndex = 0;
        } else {
          newLineIndex = prevVisible;
          newCharIndex = this.getLineLength(this.state.lines[prevVisible]);
        }
      } else if (newCharIndex > lineLength) {
        const nextVisible = this.getNextVisibleLine(cursor.lineIndex);
        if (nextVisible === null) {
          newCharIndex = lineLength;
        } else {
          newLineIndex = nextVisible;
          newCharIndex = 0;
        }
      }

      if (extendSelection) {
        this.ensureSelectionAnchor();
        this.setCursor(newLineIndex, newCharIndex, {
          resetSelection: false,
        });
        this.state.selection = {
          start: { ...this.selectionAnchor },
          end: { ...this.state.cursor },
        };
      } else {
        this.setCursor(newLineIndex, newCharIndex);
      }
    }

    moveCursorVertical(visibleDelta, extendSelection = false) {
      const visibleLines = this.getVisibleLines();
      if (visibleLines.length === 0) return;
      const currentVisibleIndex = this.getVisibleIndex(
        this.state.cursor.lineIndex
      );
      if (currentVisibleIndex === -1) return;

      if (this.preferredCursorX < 0) {
        const line = this.getCurrentLine();
        if (this.isImageLine(line)) {
          const imageWidth = line.image?.width ?? 0;
          this.preferredCursorX =
            this.state.cursor.charIndex >= 1 ? imageWidth : 0;
        } else {
          this.preferredCursorX = this.measureText(
            line.text.slice(0, this.state.cursor.charIndex)
          );
        }
      }

      const targetVisibleIndex = Math.max(
        0,
        Math.min(visibleLines.length - 1, currentVisibleIndex + visibleDelta)
      );
      const targetLineIndex = visibleLines[targetVisibleIndex];
      const targetLine = this.state.lines[targetLineIndex];
      let targetCharIndex;
      if (this.isImageLine(targetLine)) {
        const imageWidth = targetLine.image?.width ?? 0;
        targetCharIndex = this.preferredCursorX > imageWidth / 2 ? 1 : 0;
      } else {
        targetCharIndex = this.getCharIndexForX(
          targetLine.text,
          this.preferredCursorX
        );
      }

      if (extendSelection) {
        this.ensureSelectionAnchor();
        this.setCursor(targetLineIndex, targetCharIndex, {
          resetSelection: false,
        });
        this.state.selection = {
          start: { ...this.selectionAnchor },
          end: { ...this.state.cursor },
        };
      } else {
        this.setCursor(targetLineIndex, targetCharIndex);
      }
    }

    moveCursorToLineEdge(direction, extendSelection) {
      const targetChar =
        direction === "start"
          ? 0
          : this.getLineLength(this.getCurrentLine());
      if (extendSelection) {
        this.ensureSelectionAnchor();
        this.setCursor(this.state.cursor.lineIndex, targetChar, {
          resetSelection: false,
        });
        this.state.selection = {
          start: { ...this.selectionAnchor },
          end: { ...this.state.cursor },
        };
      } else {
        this.setCursor(this.state.cursor.lineIndex, targetChar);
      }
    }

    moveCursorToDocumentEdge(direction, extendSelection) {
      const lineIndex =
        direction === "start" ? 0 : this.state.lines.length - 1;
      const charIndex =
        direction === "start"
          ? 0
          : this.getLineLength(this.state.lines[lineIndex]);
      if (extendSelection) {
        this.ensureSelectionAnchor();
        this.setCursor(lineIndex, charIndex, { resetSelection: false });
        this.state.selection = {
          start: { ...this.selectionAnchor },
          end: { ...this.state.cursor },
        };
      } else {
        this.setCursor(lineIndex, charIndex);
      }
    }

    moveCursorByWord(direction, extendSelection) {
      const line = this.getCurrentLine();
      const cursor = this.state.cursor;
      let lineIndex = cursor.lineIndex;
      let charIndex = cursor.charIndex;

      if (this.isImageLine(line)) {
        if (direction < 0) {
          if (charIndex > 0) {
            charIndex = 0;
          } else {
            const prev = this.getPreviousVisibleLine(lineIndex);
            if (prev === null) return;
            lineIndex = prev;
            charIndex = this.getLineLength(this.state.lines[prev]);
          }
        } else {
          const lineLength = this.getLineLength(line);
          if (charIndex < lineLength) {
            charIndex = lineLength;
          } else {
            const next = this.getNextVisibleLine(lineIndex);
            if (next === null) return;
            lineIndex = next;
            charIndex = 0;
          }
        }

        if (extendSelection) {
          this.ensureSelectionAnchor();
          this.setCursor(lineIndex, charIndex, { resetSelection: false });
          this.state.selection = {
            start: { ...this.selectionAnchor },
            end: { ...this.state.cursor },
          };
        } else {
          this.setCursor(lineIndex, charIndex);
        }
        return;
      }

      if (direction < 0) {
        if (charIndex === 0) {
          const prev = this.getPreviousVisibleLine(lineIndex);
          if (prev === null) return;
          lineIndex = prev;
          charIndex = this.getLineLength(this.state.lines[prev]);
        }
        charIndex = this.findWordBoundary(
          this.state.lines[lineIndex].text,
          charIndex,
          -1
        );
      } else {
        const lineLength = this.getLineLength(line);
        if (charIndex === lineLength) {
          const next = this.getNextVisibleLine(lineIndex);
          if (next === null) return;
          lineIndex = next;
          charIndex = 0;
        }
        charIndex = this.findWordBoundary(
          this.state.lines[lineIndex].text,
          charIndex,
          1
        );
      }

      if (extendSelection) {
        this.ensureSelectionAnchor();
        this.setCursor(lineIndex, charIndex, { resetSelection: false });
        this.state.selection = {
          start: { ...this.selectionAnchor },
          end: { ...this.state.cursor },
        };
      } else {
        this.setCursor(lineIndex, charIndex);
      }
    }

    ensureSelectionAnchor() {
      if (!this.selectionAnchor) {
        if (this.state.selection) {
          this.selectionAnchor = { ...this.getNormalizedSelection().start };
        } else {
          this.selectionAnchor = { ...this.state.cursor };
        }
      }
    }

    findWordBoundary(text, index, direction) {
      return findWordBoundaryPoint(text, index, direction);
    }

    changeIndent(delta, options = {}) {
      const { applyToSelection = false, includeChildren = false } = options;
      const range = applyToSelection
        ? this.getSelectionLineRange()
        : { start: this.state.cursor.lineIndex, end: this.state.cursor.lineIndex };
      if (!range) return;
      this.saveHistory();
      if (includeChildren) {
        let index = range.start;
        while (index <= range.end && index < this.state.lines.length) {
          const blockEnd = this.getDescendantEnd(index);
          for (let i = index; i < blockEnd; i += 1) {
            const line = this.state.lines[i];
            line.indent = Math.max(0, line.indent + delta);
          }
          index = blockEnd;
        }
      } else {
        for (let i = range.start; i <= range.end && i < this.state.lines.length; i += 1) {
          const line = this.state.lines[i];
          if (!line) continue;
          line.indent = Math.max(0, line.indent + delta);
        }
      }
      this.markDocumentVersion();
      this.invalidateLayout();
    }

    toggleCollapse(lineIndex) {
      const line = this.state.lines[lineIndex];
      if (!this.hasChildren(lineIndex)) return;
      this.saveHistory();
      line.collapsed = !line.collapsed;
      this.invalidateLayout();
      if (line.collapsed && !this.isVisible(this.state.cursor.lineIndex)) {
        this.setCursor(
          lineIndex,
          Math.min(
            this.state.cursor.charIndex,
            this.getLineLength(line)
          )
        );
      }
    }

    moveLine(delta) {
      if (delta === 0) return;
      const range = this.getSelectionLineRange();
      const hasSelection = Boolean(range);
      const start = hasSelection
        ? range.start
        : this.state.cursor.lineIndex;
      const end = hasSelection
        ? range.end
        : this.state.cursor.lineIndex;
      if (delta < 0 && start + delta < 0) return;
      if (delta > 0 && end + delta >= this.state.lines.length) return;

      const originalCursor = { ...this.state.cursor };
      const originalSelection = this.state.selection
        ? {
          start: { ...this.state.selection.start },
          end: { ...this.state.selection.end },
        }
        : null;
      const originalAnchor = this.selectionAnchor
        ? { ...this.selectionAnchor }
        : null;

      this.saveHistory();

      const blockLength = end - start + 1;
      const lines = this.state.lines;
      const block = lines.splice(start, blockLength);
      const insertIndex = start + delta;
      lines.splice(insertIndex, 0, ...block);

      const shiftPoint = (point) => {
        if (!point) return null;
        if (point.lineIndex < start || point.lineIndex > end) {
          return { ...point };
        }
        return { ...point, lineIndex: point.lineIndex + delta };
      };

      const newCursor = shiftPoint(originalCursor) || {
        lineIndex: originalCursor.lineIndex,
        charIndex: originalCursor.charIndex,
      };

      if (originalSelection) {
        const newSelection = {
          start: shiftPoint(originalSelection.start) || {
            ...originalSelection.start,
          },
          end: shiftPoint(originalSelection.end) || {
            ...originalSelection.end,
          },
        };
        this.state.selection = newSelection;
      }

      if (originalAnchor) {
        this.selectionAnchor = shiftPoint(originalAnchor) || {
          ...originalAnchor,
        };
      }

      this.setCursor(newCursor.lineIndex, newCursor.charIndex, {
        resetSelection: !originalSelection,
      });

      if (originalSelection && this.state.selection) {
        this.state.selection = {
          start: {
            lineIndex: this.state.selection.start.lineIndex,
            charIndex: this.state.selection.start.charIndex,
          },
          end: {
            lineIndex: this.state.selection.end.lineIndex,
            charIndex: this.state.selection.end.charIndex,
          },
        };
      }

      this.markDocumentVersion();
      this.invalidateLayout();
    }

    moveBlock(direction) {
      const start = this.state.cursor.lineIndex;
      const end = this.getDescendantEnd(start);
      const blockLength = end - start;
      const baseIndent = this.state.lines[start].indent;
      if (blockLength <= 0) return;

      if (direction < 0) {
        let prev = start - 1;
        while (prev >= 0 && this.state.lines[prev].indent > baseIndent) {
          prev -= 1;
        }
        if (prev < 0 || this.state.lines[prev].indent !== baseIndent) return;
        this.saveHistory();
        const block = this.state.lines.splice(start, blockLength);
        const insertIndex = prev;
        this.state.lines.splice(insertIndex, 0, ...block);
        this.setCursor(insertIndex, this.state.cursor.charIndex);
      } else {
        if (end >= this.state.lines.length) return;
        if (this.state.lines[end].indent !== baseIndent) return;
        const nextBlockEnd = this.getDescendantEnd(end);
        this.saveHistory();
        const block = this.state.lines.splice(start, blockLength);
        const insertIndex = nextBlockEnd - blockLength;
        this.state.lines.splice(insertIndex, 0, ...block);
        this.setCursor(insertIndex, this.state.cursor.charIndex);
      }
      this.markDocumentVersion();
      this.invalidateLayout();
    }
    setCursor(lineIndex, charIndex, options = {}) {
      const { resetSelection = true, scrollIntoView = true } = options;
      const maxLineIndex = Math.max(0, this.state.lines.length - 1);
      lineIndex = clamp(lineIndex, 0, maxLineIndex);
      const line = this.state.lines[lineIndex];
      charIndex = clamp(charIndex, 0, this.getLineLength(line));
      this.state.cursor = { lineIndex, charIndex };
      if (resetSelection) {
        this.state.selection = null;
        this.selectionAnchor = null;
      }
      if (scrollIntoView) {
        this.scrollToCursor();
      }
      this.resetCursorBlink();
      this.preferredCursorX = -1;
    }

    getCursorCoords() {
      const lineIndex = this.state.cursor.lineIndex;
      const visibleIndex = this.getVisibleIndex(lineIndex);
      if (visibleIndex === -1) {
        return {
          x: 0,
          worldX: 0,
          screenX: 0,
          worldLineTop: 0,
          screenLineTop: 0,
          worldCursorTop: 0,
          screenCursorTop: 0,
          worldBaseline: 0,
          line: null,
        };
      }
      const line = this.state.lines[lineIndex];
      const indentX =
        this.config.padding + line.indent * this.state.view.indentWidth;
      const cursorCharIndex = this.state.cursor.charIndex;
      let relativeX = 0;
      if (this.isImageLine(line)) {
        const imageWidth = line.image?.width ?? 0;
        relativeX = cursorCharIndex >= 1 ? imageWidth : 0;
      } else {
        const textBefore = line.text.slice(0, cursorCharIndex);
        relativeX = this.measureText(textBefore);
      }
      const lineTop = this.getWorldLineTop(lineIndex);
      const lineHeight = this.getLineDisplayHeight(line);
      const worldX = indentX + relativeX;
      const worldLineTop = lineTop;
      const worldCursorTop = this.isImageLine(line)
        ? worldLineTop
        : worldLineTop + this.typography.paddingTop;
      const worldBaseline = this.isImageLine(line)
        ? Math.min(worldLineTop + lineHeight - 2, worldLineTop + this.typography.baselineOffset)
        : worldLineTop + this.typography.baselineOffset;
      const screenX = worldX - this.state.view.scrollLeft;
      const screenLineTop = worldLineTop - this.state.view.scrollTop;
      const screenCursorTop = worldCursorTop - this.state.view.scrollTop;
      return {
        x: worldX,
        worldX,
        screenX,
        worldLineTop,
        screenLineTop,
        worldCursorTop,
        screenCursorTop,
        worldBaseline,
        line,
      };
    }

    updateTextareaPosition() {
      if (!this.isFocused) return;
      const { screenX, screenCursorTop } = this.getCursorCoords();
      this.textarea.style.left = `${screenX}px`;
      this.textarea.style.top = `${screenCursorTop}px`;
    }

    ensureCursorVisibleWhileDragging(mouseX, mouseY) {
      const threshold = 20;
      if (mouseY < threshold) {
        this.state.view.scrollTop = Math.max(
          0,
          this.state.view.scrollTop - this.state.view.lineHeight
        );
      } else if (mouseY > this.canvas.height - threshold) {
        this.state.view.scrollTop = Math.min(
          this.getMaxScroll(),
          this.state.view.scrollTop + this.state.view.lineHeight
        );
      }

      if (mouseX < threshold) {
        this.state.view.scrollLeft = Math.max(
          0,
          this.state.view.scrollLeft - this.state.view.indentWidth
        );
      } else if (mouseX > this.canvas.width - threshold) {
        this.state.view.scrollLeft = Math.min(
          this.getMaxHorizontalScroll(),
          this.state.view.scrollLeft + this.state.view.indentWidth
        );
      }
    }

    getCurrentLine() {
      return this.state.lines[this.state.cursor.lineIndex];
    }

    getSelectionLineRange() {
      const selection = this.getNormalizedSelection();
      if (!selection) return null;
      return {
        start: selection.start.lineIndex,
        end: selection.end.lineIndex,
      };
    }

    getNormalizedSelection() {
      if (!this.state.selection) return null;
      const { start, end } = this.state.selection;
      const comparison = this.comparePoints(start, end);
      if (comparison <= 0) {
        return {
          start: { ...start },
          end: { ...end },
        };
      }
      return {
        start: { ...end },
        end: { ...start },
      };
    }

    comparePoints(a, b) {
      if (a.lineIndex !== b.lineIndex) {
        return a.lineIndex - b.lineIndex;
      }
      return a.charIndex - b.charIndex;
    }

    hasSelection() {
      const selection = this.state.selection;
      if (!selection) return false;
      return this.comparePoints(selection.start, selection.end) !== 0;
    }

    hitTest(offsetX, offsetY) {
      const x = offsetX + this.state.view.scrollLeft;
      const y = offsetY + this.state.view.scrollTop;
      const visibleLines = this.getVisibleLines();
      let lineIndex = null;
      for (let i = 0; i < visibleLines.length; i += 1) {
        const candidateIndex = visibleLines[i];
        const lineTop = this.lineTops?.get(candidateIndex) ?? this.getWorldLineTop(candidateIndex);
        const lineHeight =
          this.lineHeights?.get(candidateIndex) ??
          this.getLineDisplayHeight(this.state.lines[candidateIndex]);
        if (y >= lineTop && y <= lineTop + lineHeight) {
          lineIndex = candidateIndex;
          break;
        }
      }
      if (lineIndex === null) {
        return { lineIndex: null, charIndex: null, clickedIcon: false };
      }
      const line = this.state.lines[lineIndex];
      const indentWidth = this.state.view.indentWidth;
      const indentX =
        this.config.padding + line.indent * indentWidth;
      const iconAreaEnd = indentX - indentWidth * 0.2;
      if (x < iconAreaEnd && this.hasChildren(lineIndex)) {
        return { lineIndex, charIndex: 0, clickedIcon: true };
      }
      const relativeX = Math.max(0, x - indentX);
      let charIndex;
      if (this.isImageLine(line)) {
        const imageWidth = line.image?.width ?? 0;
        charIndex = relativeX > imageWidth / 2 ? 1 : 0;
      } else {
        charIndex = this.getCharIndexForX(line.text, relativeX);
      }
      return { lineIndex, charIndex, clickedIcon: false };
    }

    getCharIndexForX(text, targetX) {
      let minDelta = Infinity;
      let bestIndex = 0;
      for (let i = 0; i <= text.length; i += 1) {
        const width = this.measureText(text.slice(0, i));
        const delta = Math.abs(targetX - width);
        if (delta < minDelta) {
          minDelta = delta;
          bestIndex = i;
        }
      }
      return bestIndex;
    }

    openLinkAt(lineIndex, offsetX) {
      const segments = this.lineLayouts.get(lineIndex);
      if (!segments || segments.length === 0) return false;
      const worldX = offsetX + this.state.view.scrollLeft;
      const targetSegment = segments.find(
        (segment) => worldX >= segment.startX && worldX <= segment.endX
      );
      if (!targetSegment || !targetSegment.target) return false;
      const target = targetSegment.target.trim();
      if (!target) return false;

      if (targetSegment.type === "absolute") {
        window.open(target, "_blank", "noopener");
        return true;
      }

      try {
        const resolved = new URL(target, window.location.href).toString();
        window.open(resolved, "_blank", "noopener");
        return true;
      } catch (error) {
        return false;
      }
    }

    getVisibleLines() {
      if (this.visibleLinesCache) return this.visibleLinesCache;
      const result = [];
      this.state.lines.forEach((line, index) => {
        if (this.isVisible(index)) {
          result.push(index);
        }
      });
      this.visibleLinesCache = result;
      return result;
    }

    invalidateLayout() {
      this.visibleLinesCache = null;
    }

    isVisible(lineIndex) {
      let current = lineIndex;
      while (current > 0) {
        const parent = this.getParent(current);
        if (parent === null) break;
        if (this.state.lines[parent].collapsed) return false;
        current = parent;
      }
      return true;
    }

    getParent(lineIndex) {
      const indent = this.state.lines[lineIndex].indent;
      for (let i = lineIndex - 1; i >= 0; i -= 1) {
        if (this.state.lines[i].indent < indent) {
          return i;
        }
      }
      return null;
    }

    hasChildren(lineIndex) {
      const next = lineIndex + 1;
      if (next >= this.state.lines.length) return false;
      return this.state.lines[next].indent > this.state.lines[lineIndex].indent;
    }

    getDescendantEnd(lineIndex) {
      const baseIndent = this.state.lines[lineIndex].indent;
      let index = lineIndex + 1;
      while (
        index < this.state.lines.length &&
        this.state.lines[index].indent > baseIndent
      ) {
        index += 1;
      }
      return index;
    }

    getPreviousVisibleLine(lineIndex) {
      const visibleIndex = this.getVisibleIndex(lineIndex);
      if (visibleIndex <= 0) return null;
      const visibleLines = this.getVisibleLines();
      return visibleLines[visibleIndex - 1];
    }

    getNextVisibleLine(lineIndex) {
      const visibleLines = this.getVisibleLines();
      const visibleIndex = this.getVisibleIndex(lineIndex);
      if (visibleIndex === -1 || visibleIndex >= visibleLines.length - 1) {
        return null;
      }
      return visibleLines[visibleIndex + 1];
    }

    getVisibleIndex(lineIndex) {
      const visibleLines = this.getVisibleLines();
      return visibleLines.indexOf(lineIndex);
    }

    getMaxScroll() {
      const visibleLines = this.getVisibleLines();
      let totalHeight = this.config.padding * 2;
      visibleLines.forEach((lineIndex) => {
        totalHeight += this.getLineDisplayHeight(
          this.state.lines[lineIndex]
        );
      });
      return Math.max(0, totalHeight - this.canvas.height);
    }

    getMaxHorizontalScroll() {
      const visibleLines = this.getVisibleLines();
      const indentWidth = this.state.view.indentWidth;
      let maxX = 0;
      for (let i = 0; i < visibleLines.length; i += 1) {
        const index = visibleLines[i];
        const line = this.state.lines[index];
        if (!line) continue;
        const indentX =
          this.config.padding + line.indent * indentWidth;
        const contentWidth = this.isImageLine(line)
          ? line.image?.width ?? this.state.view.lineHeight
          : this.measureText(line.text);
        const lineWidth = indentX + contentWidth;
        if (lineWidth > maxX) {
          maxX = lineWidth;
        }
      }
      const contentWidth = maxX + this.config.padding;
      return Math.max(0, contentWidth - this.canvas.width);
    }

    scrollToCursor() {
      const visibleIndex = this.getVisibleIndex(this.state.cursor.lineIndex);
      if (visibleIndex === -1) return;
      const coords = this.getCursorCoords();
      const lineTop = coords.worldLineTop;
      const lineHeight = this.getLineDisplayHeight(coords.line);
      const lineBottom = lineTop + lineHeight;
      const viewTop = this.state.view.scrollTop;
      const viewBottom = viewTop + this.canvas.height;
      if (lineTop < viewTop + this.config.padding) {
        this.state.view.scrollTop = Math.max(
          0,
          lineTop - this.config.padding
        );
      } else if (lineBottom > viewBottom - this.config.padding) {
        this.state.view.scrollTop = Math.min(
          this.getMaxScroll(),
          lineBottom - this.canvas.height + this.config.padding
        );
      }

      const viewLeft = this.state.view.scrollLeft;
      const viewRight = viewLeft + this.canvas.width;
      const caretWidth = Math.max(2, this.typography.spaceWidth);
      const cursorLeft = coords.x;
      const cursorRight = cursorLeft + caretWidth;
      if (cursorLeft < viewLeft + this.config.padding) {
        this.state.view.scrollLeft = Math.max(
          0,
          cursorLeft - this.config.padding
        );
      } else if (cursorRight > viewRight - this.config.padding) {
        const maxScrollLeft = this.getMaxHorizontalScroll();
        this.state.view.scrollLeft = Math.min(
          maxScrollLeft,
          cursorRight - this.canvas.width + this.config.padding
        );
      }
    }

    getSelectedText() {
      const range = this.getNormalizedSelection();
      if (!range) return "";
      const { start, end } = range;
      if (start.lineIndex === end.lineIndex) {
        const line = this.state.lines[start.lineIndex];
        return line.text.slice(start.charIndex, end.charIndex);
      }
      const parts = [];
      const firstLine = this.state.lines[start.lineIndex];
      parts.push(firstLine.text.slice(start.charIndex));
      for (let i = start.lineIndex + 1; i < end.lineIndex; i += 1) {
        parts.push(this.state.lines[i].text);
      }
      const lastLine = this.state.lines[end.lineIndex];
      parts.push(lastLine.text.slice(0, end.charIndex));
      return parts.join("\n");
    }
    saveHistory() {
      const snapshot = this.createStateSnapshot();
      this.state.history.undoStack.push(snapshot);
      if (this.state.history.undoStack.length > this.config.historyLimit) {
        this.state.history.undoStack.shift();
      }
      this.state.history.redoStack = [];
    }

    createStateSnapshot() {
      return {
        lines: this.state.lines.map((line) => ({
          ...line,
          image: line.image ? { ...line.image } : undefined,
        })),
        cursor: { ...this.state.cursor },
        selection: this.state.selection
          ? {
            start: { ...this.state.selection.start },
            end: { ...this.state.selection.end },
          }
          : null,
        scrollTop: this.state.view.scrollTop,
        scrollLeft: this.state.view.scrollLeft,
      };
    }

    applySnapshot(snapshot) {
      this.state.lines = snapshot.lines.map((line) => ({
        ...line,
        image: line.image ? { ...line.image } : undefined,
      }));
      this.state.cursor = { ...snapshot.cursor };
      this.state.selection = snapshot.selection
        ? {
          start: { ...snapshot.selection.start },
          end: { ...snapshot.selection.end },
        }
        : null;
      this.state.view.scrollTop = snapshot.scrollTop;
      this.state.view.scrollLeft = snapshot.scrollLeft ?? this.state.view.scrollLeft;
      this.invalidateLayout();
      this.resetCursorBlink();
      this.markDocumentVersion();
      this.cleanupImageCache();
    }

    undo() {
      if (this.state.history.undoStack.length === 0) return;
      const current = this.createStateSnapshot();
      const snapshot = this.state.history.undoStack.pop();
      this.state.history.redoStack.push(current);
      this.applySnapshot(snapshot);
    }

    redo() {
      if (this.state.history.redoStack.length === 0) return;
      const current = this.createStateSnapshot();
      const snapshot = this.state.history.redoStack.pop();
      this.state.history.undoStack.push(current);
      this.applySnapshot(snapshot);
    }

    markDocumentVersion() {
      this.documentVersion += 1;
      if (this.search) {
        this.search.needsUpdate = true;
      }
      this.cleanupImageCache();
    }
  }

export default CanvasEditor;
