document.addEventListener("DOMContentLoaded", () => {
  class CanvasEditor {
    constructor(canvas, textarea) {
      this.canvas = canvas;
      this.textarea = textarea;
      this.ctx = canvas.getContext("2d");

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

      this.textWidthCache = new Map();
      this.visibleLinesCache = null;
      this.lineLayouts = new Map();
      this.ignoreNextClick = false;
      this.draggedDuringClick = false;

      this.documentVersion = 0;

      this.init();
    }

    createInitialState() {
      const lines = [
        this.createLine("インデントが1の次に3になる場合もあります。", 0),
        this.createLine("Shift + Tabでインデントを戻せます。", 1),
        this.createLine("選択範囲の描画も丁寧に行います。", 3),
      ];
      return {
        lines,
        cursor: { lineIndex: 0, charIndex: 0 },
        selection: null,
        history: { undoStack: [], redoStack: [] },
        view: {
          scrollTop: 0,
          font: '22px "Space Mono", "Noto Sans JP", monospace',
          lineHeight: 30,
          indentWidth: 24,
        },
      };
    }

    createLine(text, indent = 0, collapsed = false) {
      return {
        id: CanvasEditor.generateId(),
        text,
        indent,
        collapsed,
      };
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
      this.visibleLineCapacity = Math.max(
        1,
        Math.floor(
          (this.canvas.height - this.config.padding * 2) /
          this.state.view.lineHeight
        )
      );
      this.bindEvents();
      this.initSearchUI();
      requestAnimationFrame(this.renderLoop.bind(this));
    }

    bindEvents() {
      this.canvas.addEventListener("mousedown", this.onMouseDown.bind(this));
      this.canvas.addEventListener("mousemove", this.onMouseMove.bind(this));
      window.addEventListener("mouseup", this.onMouseUp.bind(this));
      this.canvas.addEventListener("click", this.onClick.bind(this));
      this.canvas.addEventListener("wheel", this.onWheel.bind(this), {
        passive: false,
      });
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
          this.insertText(e.data);
        }
      });
      this.textarea.addEventListener("copy", this.onCopy.bind(this));
      this.textarea.addEventListener("cut", this.onCut.bind(this));
      this.textarea.addEventListener("paste", this.onPaste.bind(this));
    }

    initSearchUI() {
      const panel = document.getElementById("search-panel");
      if (!panel) {
        this.search = null;
        return;
      }

      const search = {
        panel,
        queryInput: document.getElementById("search-query"),
        replaceInput: document.getElementById("search-replace"),
        toggleReplaceButton: document.getElementById("search-toggle-replace"),
        caseCheckbox: document.getElementById("search-case"),
        regexCheckbox: document.getElementById("search-regex"),
        selectionCheckbox: document.getElementById("search-selection"),
        resultLabel: document.getElementById("search-result"),
        prevButton: document.getElementById("search-prev"),
        nextButton: document.getElementById("search-next"),
        closeButton: document.getElementById("search-close"),
        replaceButton: document.getElementById("search-replace-one"),
        replaceAllButton: document.getElementById("search-replace-all"),
        replaceRow: document.getElementById("search-replace-row"),
        isOpen: false,
        showReplace: false,
        matches: [],
        matchesByLine: new Map(),
        activeIndex: -1,
        selectionScope: null,
        lastEvaluatedVersion: -1,
        needsUpdate: false,
        regexError: null,
        lastSelectionText: "",
      };

      if (
        !search.queryInput ||
        !search.replaceInput ||
        !search.toggleReplaceButton ||
        !search.caseCheckbox ||
        !search.regexCheckbox ||
        !search.selectionCheckbox ||
        !search.resultLabel ||
        !search.prevButton ||
        !search.nextButton ||
        !search.closeButton ||
        !search.replaceButton ||
        !search.replaceAllButton ||
        !search.replaceRow
      ) {
        this.search = null;
        return;
      }

      this.search = search;
      this.bindSearchEvents();
      this.updateSearchPanelVisibility();
      this.updateSearchUIState();
    }

    bindSearchEvents() {
      const search = this.search;
      if (!search) return;

      search.panel.addEventListener("click", (event) => {
        event.stopPropagation();
      });

      search.toggleReplaceButton.addEventListener("click", () => {
        this.toggleReplacePanel();
      });

      search.queryInput.addEventListener("input", () => {
        this.handleSearchQueryInput();
      });

      search.queryInput.addEventListener("keydown", (event) => {
        this.handleSearchQueryKeydown(event);
      });

      search.replaceInput.addEventListener("keydown", (event) => {
        this.handleReplaceInputKeydown(event);
      });

      search.caseCheckbox.addEventListener("change", () => {
        this.handleSearchOptionChange();
      });

      search.regexCheckbox.addEventListener("change", () => {
        this.handleSearchOptionChange();
      });

      search.selectionCheckbox.addEventListener("change", () => {
        this.handleSearchSelectionToggle();
      });

      search.prevButton.addEventListener("click", () => {
        this.stepSearchMatch(-1);
      });

      search.nextButton.addEventListener("click", () => {
        this.stepSearchMatch(1);
      });

      search.closeButton.addEventListener("click", () => {
        this.closeSearchPanel();
      });

      search.replaceButton.addEventListener("click", () => {
        this.replaceCurrentMatch();
      });

      search.replaceAllButton.addEventListener("click", () => {
        this.replaceAllMatches();
      });

      window.addEventListener("keydown", (event) => {
        this.handleGlobalSearchKeydown(event);
      });
    }

    updateSearchPanelVisibility() {
      const search = this.search;
      if (!search) return;
      search.toggleReplaceButton.setAttribute(
        "aria-pressed",
        search.showReplace ? "true" : "false"
      );
      if (search.showReplace) {
        search.replaceRow.classList.remove("hidden");
      } else {
        search.replaceRow.classList.add("hidden");
      }
    }

    updateSearchUIState() {
      const search = this.search;
      if (!search) return;
      this.updateSearchResultLabel();
      this.updateSearchButtonsState();
    }

    updateSearchResultLabel() {
      const search = this.search;
      if (!search) return;
      if (search.regexError) {
        search.resultLabel.textContent = "エラー";
        search.resultLabel.title = search.regexError;
        search.resultLabel.classList.add("error");
        return;
      }
      search.resultLabel.classList.remove("error");
      search.resultLabel.title = "";
      const total = search.matches.length;
      const current = total > 0 && search.activeIndex >= 0 ? search.activeIndex + 1 : 0;
      search.resultLabel.textContent = `${current} / ${total}`;
    }

    updateSearchButtonsState() {
      const search = this.search;
      if (!search) return;
      const hasMatches = search.matches.length > 0 && !search.regexError;
      const navButtons = [search.prevButton, search.nextButton];
      navButtons.forEach((button) => {
        button.disabled = !hasMatches;
        button.setAttribute("aria-disabled", hasMatches ? "false" : "true");
      });
      const replaceButtons = [search.replaceButton, search.replaceAllButton];
      replaceButtons.forEach((button) => {
        const disabled = !hasMatches;
        button.disabled = disabled;
        button.setAttribute("aria-disabled", disabled ? "true" : "false");
      });
    }

    handleSearchQueryInput() {
      const search = this.search;
      if (!search || !search.isOpen) return;
      this.updateSearchResults({ preserveActive: false });
    }

    handleSearchQueryKeydown(event) {
      if (!this.search || !this.search.isOpen) return;
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) {
          this.stepSearchMatch(-1);
        } else {
          this.stepSearchMatch(1);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.closeSearchPanel();
      }
    }

    handleReplaceInputKeydown(event) {
      if (!this.search || !this.search.isOpen) return;
      if (event.key === "Enter") {
        event.preventDefault();
        this.replaceCurrentMatch();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.closeSearchPanel();
      }
    }

    handleSearchOptionChange() {
      const search = this.search;
      if (!search || !search.isOpen) return;
      this.updateSearchResults({ preserveActive: false });
    }

    handleSearchSelectionToggle() {
      const search = this.search;
      if (!search || !search.isOpen) return;
      if (search.selectionCheckbox.checked) {
        search.selectionScope = this.captureSelectionScope();
      } else {
        search.selectionScope = null;
      }
      this.updateSearchResults({ preserveActive: false });
    }

    handleGlobalSearchKeydown(event) {
      const search = this.search;
      if (!search || !search.isOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeSearchPanel();
      }
    }

    openSearchPanel(options = {}) {
      const search = this.search;
      if (!search) return;
      const { prefillSelection = true } = options;

      if (prefillSelection) {
        const selectionText = this.getSelectedText();
        if (selectionText) {
          search.queryInput.value = selectionText;
          search.lastSelectionText = selectionText;
        }
      }

      if (search.selectionCheckbox.checked) {
        search.selectionScope = this.captureSelectionScope();
      } else {
        search.selectionScope = null;
      }

      search.panel.classList.remove("hidden");
      search.panel.setAttribute("aria-hidden", "false");
      search.isOpen = true;
      search.needsUpdate = true;
      this.updateSearchResults({ preserveActive: false });
      setTimeout(() => {
        search.queryInput.focus();
        search.queryInput.select();
      }, 0);
    }

    closeSearchPanel() {
      const search = this.search;
      if (!search || !search.isOpen) return;
      search.isOpen = false;
      search.panel.classList.add("hidden");
      search.panel.setAttribute("aria-hidden", "true");
      search.selectionScope = null;
      this.clearSearchMatches();
      this.focus();
    }

    toggleReplacePanel() {
      const search = this.search;
      if (!search) return;
      search.showReplace = !search.showReplace;
      this.updateSearchPanelVisibility();
      const target = search.showReplace ? search.replaceInput : search.queryInput;
      setTimeout(() => {
        target.focus();
        target.select();
      }, 0);
    }

    captureSelectionScope() {
      const selection = this.getNormalizedSelection();
      if (!selection) {
        return this.search ? this.search.selectionScope : null;
      }
      if (this.comparePoints(selection.start, selection.end) === 0) {
        return this.search ? this.search.selectionScope : null;
      }
      return {
        start: { ...selection.start },
        end: { ...selection.end },
      };
    }

    clearSearchMatches() {
      const search = this.search;
      if (!search) return;
      search.matches = [];
      search.matchesByLine.clear();
      search.activeIndex = -1;
      search.regexError = null;
      search.resultLabel.textContent = "0 / 0";
      search.resultLabel.classList.remove("error");
      search.resultLabel.title = "";
      search.needsUpdate = false;
      search.lastEvaluatedVersion = this.documentVersion;
      this.updateSearchButtonsState();
    }

    updateSearchResults(options = {}) {
      const search = this.search;
      if (!search || !search.isOpen) return;
      const { preserveActive = false, preferredIndex = null } = options;
      const query = search.queryInput.value;

      if (search.selectionCheckbox.checked) {
        const scope = this.captureSelectionScope();
        if (scope) {
          search.selectionScope = scope;
        }
      } else {
        search.selectionScope = null;
      }

      if (!query) {
        this.clearSearchMatches();
        search.lastEvaluatedVersion = this.documentVersion;
        search.needsUpdate = false;
        return;
      }

      const previousActiveMatch =
        preserveActive && search.activeIndex >= 0
          ? search.matches[search.activeIndex]
          : null;

      const result = this.computeMatches({
        query,
        useRegex: search.regexCheckbox.checked,
        caseSensitive: search.caseCheckbox.checked,
        scope: search.selectionScope,
      });

      search.matches = result.matches;
      search.regexError = result.regexError;
      if (search.regexError) {
        search.matches = [];
        search.matchesByLine.clear();
        search.activeIndex = -1;
        this.updateSearchUIState();
        search.lastEvaluatedVersion = this.documentVersion;
        search.needsUpdate = false;
        return;
      }

      search.matchesByLine = this.groupMatchesByLine(search.matches);

      let nextActive = -1;
      if (search.matches.length > 0) {
        if (
          preferredIndex !== null &&
          preferredIndex >= 0 &&
          preferredIndex < search.matches.length
        ) {
          nextActive = preferredIndex;
        } else if (previousActiveMatch) {
          nextActive = search.matches.findIndex(
            (match) =>
              match.lineIndex === previousActiveMatch.lineIndex &&
              match.start === previousActiveMatch.start &&
              match.end === previousActiveMatch.end
          );
        }
        if (nextActive === -1) {
          nextActive = 0;
        }
      }

      this.setActiveMatch(nextActive, { scroll: true });
      search.lastEvaluatedVersion = this.documentVersion;
      search.needsUpdate = false;
      this.updateSearchUIState();
    }

    computeMatches({ query, useRegex, caseSensitive, scope }) {
      const matches = [];
      const lines = this.state.lines;
      if (!query) {
        return { matches, regexError: null };
      }

      const startLine = scope ? scope.start.lineIndex : 0;
      const endLine = scope ? scope.end.lineIndex : lines.length - 1;

      if (useRegex) {
        let regex;
        try {
          regex = new RegExp(query, caseSensitive ? "g" : "gi");
        } catch (error) {
          return { matches: [], regexError: error.message };
        }

        for (
          let lineIndex = startLine;
          lineIndex <= endLine && lineIndex < lines.length;
          lineIndex += 1
        ) {
          const line = lines[lineIndex];
          const limitStart =
            scope && lineIndex === scope.start.lineIndex
              ? scope.start.charIndex
              : 0;
          const limitEnd =
            scope && lineIndex === scope.end.lineIndex
              ? scope.end.charIndex
              : line.text.length;
          if (limitStart >= limitEnd) continue;

          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(line.text)) !== null) {
            const text = match[0] ?? "";
            const matchStart = match.index;
            const matchEnd = matchStart + text.length;
            if (text.length === 0) {
              regex.lastIndex += 1;
              if (regex.lastIndex > line.text.length) break;
              continue;
            }
            if (matchStart < limitStart || matchEnd > limitEnd) {
              continue;
            }
            matches.push({
              lineIndex,
              start: matchStart,
              end: matchEnd,
              text,
              groupValues: match.length > 1 ? match.slice(1) : null,
              namedGroups: match.groups ? { ...match.groups } : null,
            });
          }
        }
      } else {
        const needle = caseSensitive ? query : query.toLowerCase();
        for (
          let lineIndex = startLine;
          lineIndex <= endLine && lineIndex < lines.length;
          lineIndex += 1
        ) {
          const line = lines[lineIndex];
          const haystack = caseSensitive ? line.text : line.text.toLowerCase();
          const limitStart =
            scope && lineIndex === scope.start.lineIndex
              ? scope.start.charIndex
              : 0;
          const limitEnd =
            scope && lineIndex === scope.end.lineIndex
              ? scope.end.charIndex
              : line.text.length;
          if (limitStart >= limitEnd) continue;

          let index = haystack.indexOf(needle, limitStart);
          while (index !== -1 && index + needle.length <= limitEnd) {
            matches.push({
              lineIndex,
              start: index,
              end: index + needle.length,
              text: line.text.slice(index, index + needle.length),
              groupValues: null,
              namedGroups: null,
            });
            if (needle.length === 0) {
              index += 1;
            } else {
              index = haystack.indexOf(needle, index + needle.length);
            }
          }
        }
      }

      return { matches, regexError: null };
    }

    groupMatchesByLine(matches) {
      const map = new Map();
      matches.forEach((match, index) => {
        if (!map.has(match.lineIndex)) {
          map.set(match.lineIndex, []);
        }
        map.get(match.lineIndex).push({
          start: match.start,
          end: match.end,
          index,
        });
      });
      return map;
    }

    setActiveMatch(index, options = {}) {
      const search = this.search;
      if (!search) return;
      const { scroll = true } = options;
      if (
        index === -1 ||
        index === undefined ||
        index < 0 ||
        index >= search.matches.length
      ) {
        search.activeIndex = -1;
        this.updateSearchUIState();
        return;
      }
      search.activeIndex = index;
      this.updateSearchUIState();
      const match = search.matches[index];
      if (match) {
        this.ensureMatchSelection(match, { scroll });
      }
    }

    ensureMatchSelection(match, options = {}) {
      const { scroll = true } = options;
      this.setCursor(match.lineIndex, match.end, {
        resetSelection: true,
        scrollIntoView: scroll,
      });
      this.state.selection = {
        start: { lineIndex: match.lineIndex, charIndex: match.start },
        end: { lineIndex: match.lineIndex, charIndex: match.end },
      };
      this.selectionAnchor = { ...this.state.selection.start };
    }

    stepSearchMatch(direction) {
      const search = this.search;
      if (!search || search.matches.length === 0 || search.regexError) return;
      const length = search.matches.length;
      let nextIndex = search.activeIndex;
      if (nextIndex === -1) {
        nextIndex = direction > 0 ? 0 : length - 1;
      } else {
        nextIndex = (nextIndex + direction + length) % length;
      }
      this.setActiveMatch(nextIndex, { scroll: true });
    }

    applyReplacementPattern(match, pattern, fullText, useRegex) {
      if (!useRegex) return pattern;
      if (!pattern.includes("$")) return pattern;
      const groups = match.groupValues || [];
      const named = match.namedGroups || {};
      let result = "";
      for (let i = 0; i < pattern.length; i += 1) {
        const char = pattern[i];
        if (char === "$" && i < pattern.length - 1) {
          const next = pattern[i + 1];
          if (next === "$") {
            result += "$";
            i += 1;
            continue;
          }
          if (next === "&") {
            result += match.text;
            i += 1;
            continue;
          }
          if (next === "`") {
            result += fullText.slice(0, match.start);
            i += 1;
            continue;
          }
          if (next === "'") {
            result += fullText.slice(match.end);
            i += 1;
            continue;
          }
          if (next === "<") {
            const closing = pattern.indexOf(">", i + 2);
            if (closing !== -1) {
              const name = pattern.slice(i + 2, closing);
              if (Object.prototype.hasOwnProperty.call(named, name)) {
                result += named[name] ?? "";
              }
              i = closing;
              continue;
            }
          }
          if (/\d/.test(next)) {
            let j = i + 1;
            let digits = "";
            while (j < pattern.length && /\d/.test(pattern[j]) && digits.length < 2) {
              digits += pattern[j];
              j += 1;
            }
            if (digits) {
              const index = Number(digits);
              const value = index > 0 && groups[index - 1] !== undefined ? groups[index - 1] : "";
              result += value;
              i += digits.length;
              continue;
            }
          }
        }
        result += char;
      }
      return result;
    }

    replaceCurrentMatch() {
      const search = this.search;
      if (!search || !search.isOpen) return;
      if (search.matches.length === 0 || search.activeIndex === -1) return;
      if (search.regexError) return;
      const match = search.matches[search.activeIndex];
      const line = this.state.lines[match.lineIndex];
      if (!line) return;

      this.saveHistory();
      const originalText = line.text;
      const before = originalText.slice(0, match.start);
      const after = originalText.slice(match.end);
      const replaceValue = search.replaceInput.value ?? "";
      const replacement = this.applyReplacementPattern(
        match,
        replaceValue,
        originalText,
        search.regexCheckbox.checked
      );

      line.text = before + replacement + after;
      this.markDocumentVersion();
      this.invalidateLayout();

      const preferredIndex = Math.min(search.activeIndex, search.matches.length - 1);
      this.updateSearchResults({ preserveActive: false, preferredIndex });
    }

    replaceAllMatches() {
      const search = this.search;
      if (!search || !search.isOpen) return;
      if (search.matches.length === 0 || search.regexError) return;

      this.saveHistory();
      const replaceValue = search.replaceInput.value ?? "";
      const useRegex = search.regexCheckbox.checked;
      const matchesByLine = new Map();
      search.matches.forEach((match) => {
        if (!matchesByLine.has(match.lineIndex)) {
          matchesByLine.set(match.lineIndex, []);
        }
        matchesByLine.get(match.lineIndex).push(match);
      });

      matchesByLine.forEach((lineMatches, lineIndex) => {
        const line = this.state.lines[lineIndex];
        if (!line) return;
        const originalText = line.text;
        const sorted = [...lineMatches].sort((a, b) => a.start - b.start);
        let cursor = 0;
        let result = "";
        sorted.forEach((match) => {
          result += originalText.slice(cursor, match.start);
          const replacement = this.applyReplacementPattern(
            match,
            replaceValue,
            originalText,
            useRegex
          );
          result += replacement;
          cursor = match.end;
        });
        result += originalText.slice(cursor);
        line.text = result;
      });

      this.markDocumentVersion();
      this.invalidateLayout();
      this.updateSearchResults({ preserveActive: false });
    }
    renderLoop(timestamp) {
      if (
        this.search &&
        this.search.isOpen &&
        (this.search.needsUpdate ||
          this.search.lastEvaluatedVersion !== this.documentVersion)
      ) {
        this.updateSearchResults({ preserveActive: true });
      }
      this.updateCursorBlink(timestamp);
      this.render();
      this.updateTextareaPosition();
      requestAnimationFrame(this.renderLoop.bind(this));
    }

    render() {
      this.ctx.fillStyle = this.config.colors.background;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.save();
      this.ctx.translate(0, -this.state.view.scrollTop);

      this.lineLayouts.clear();

      const visibleLines = this.getVisibleLines();
      const lineHeight = this.state.view.lineHeight;
      visibleLines.forEach((lineIndex, visibleIndex) => {
        const line = this.state.lines[lineIndex];
        const y =
          this.config.padding + visibleIndex * lineHeight;
        if (
          y + lineHeight < this.state.view.scrollTop - this.config.padding ||
          y > this.state.view.scrollTop + this.canvas.height
        ) {
          return;
        }
        this.renderLine(line, lineIndex, visibleIndex, y);
      });

      this.renderCursor();

      if (this.isFocused && this.isComposing) {
        this.renderCompositionText();
      }

      this.ctx.restore();
    }

    renderLine(line, lineIndex, visibleIndex, y) {
      this.renderIndentBackground(line, y);
      this.renderSearchHighlights(lineIndex, y);
      this.renderSelection(lineIndex, y);
      this.renderCollapseIcon(line, lineIndex, y);
      this.renderLineText(line, lineIndex, y);
    }

    renderIndentBackground(line, y) {
      const indentWidth = this.state.view.indentWidth;
      for (let level = 0; level < line.indent; level += 1) {
        const x = this.config.padding + level * indentWidth;
        this.ctx.fillStyle = this.config.colors.indentation;
        this.ctx.fillRect(
          x,
          y,
          Math.max(1, indentWidth - 4),
          this.state.view.lineHeight
        );
      }
    }

    renderSearchHighlights(lineIndex, y) {
      const search = this.search;
      if (!search || !search.isOpen || search.matchesByLine.size === 0) return;
      const lineMatches = search.matchesByLine.get(lineIndex);
      if (!lineMatches || lineMatches.length === 0) return;
      const line = this.state.lines[lineIndex];
      if (!line) return;
      const indentWidth = this.state.view.indentWidth;
      const indentX = this.config.padding + line.indent * indentWidth;
      const lineHeight = this.state.view.lineHeight;
      const text = line.text;
      lineMatches.forEach((entry) => {
        const startX = indentX + this.measureText(text.slice(0, entry.start));
        const endX = indentX + this.measureText(text.slice(0, entry.end));
        const width = Math.max(2, endX - startX);
        const isActive = entry.index === search.activeIndex;
        this.ctx.fillStyle = isActive
          ? this.config.colors.searchActiveMatch
          : this.config.colors.searchMatch;
        this.ctx.fillRect(startX, y, width, lineHeight);
      });
    }

    renderSelection(lineIndex, y) {
      const selection = this.getNormalizedSelection();
      if (!selection) return;
      const { start, end } = selection;
      if (lineIndex < start.lineIndex || lineIndex > end.lineIndex) return;

      const line = this.state.lines[lineIndex];
      const lineHeight = this.state.view.lineHeight;
      const indentX =
        this.config.padding + line.indent * this.state.view.indentWidth;
      let selectionStartX = indentX;
      let selectionEndX = indentX;

      const startIndex =
        lineIndex === start.lineIndex ? start.charIndex : 0;
      const endIndex =
        lineIndex === end.lineIndex ? end.charIndex : line.text.length;

      if (startIndex === endIndex && startIndex === 0 && lineIndex !== end.lineIndex) {
        selectionEndX = indentX + this.measureText(line.text);
      } else {
        selectionStartX =
          indentX + this.measureText(line.text.slice(0, startIndex));
        selectionEndX =
          indentX + this.measureText(line.text.slice(0, endIndex));
      }

      this.ctx.fillStyle = this.config.colors.selection;
      this.ctx.fillRect(
        selectionStartX,
        y,
        Math.max(2, selectionEndX - selectionStartX),
        lineHeight
      );
    }

    renderCollapseIcon(line, lineIndex, y) {
      if (!this.hasChildren(lineIndex)) return;
      const indentWidth = this.state.view.indentWidth;
      const iconX =
        this.config.padding +
        line.indent * indentWidth -
        indentWidth * 0.7;
      const iconY = y + this.state.view.lineHeight / 2 + 4;
      this.ctx.fillStyle = this.config.colors.text;
      const icon = line.collapsed ? "▶" : "▼";
      this.ctx.fillText(icon, iconX, iconY);
    }

    renderLineText(line, lineIndex, y) {
      const indentWidth = this.state.view.indentWidth;
      const indentX =
        this.config.padding + line.indent * indentWidth;
      const baseline = y + this.state.view.lineHeight / 2 + 1;
      const segments = this.getRenderedSegments(line, lineIndex);
      let cursorX = indentX;
      const clickableSegments = [];

      segments.forEach((segment) => {
        const startX = cursorX;
        const segmentWidth = this.measureText(segment.displayText);
        this.ctx.fillStyle = this.getSegmentColor(segment);
        this.ctx.fillText(segment.displayText, startX, baseline);
        if (segment.target && (segment.isLink || segment.isRelativeLink)) {
          clickableSegments.push({
            startX,
            endX: startX + segmentWidth,
            target: segment.target,
            type: segment.isLink ? "absolute" : "relative",
          });
        }
        cursorX += segmentWidth;
      });

      if (clickableSegments.length > 0) {
        this.lineLayouts.set(lineIndex, clickableSegments);
      } else {
        this.lineLayouts.delete(lineIndex);
      }
    }
    renderCursor() {
      if (!this.isFocused || this.isComposing) return;
      const { x, y, line } = this.getCursorCoords();
      if (!line) return;
      const lineHeight = this.state.view.lineHeight;
      if (this.cursorBlinkState) {
        this.ctx.fillStyle = this.config.colors.cursor;
        this.ctx.fillRect(x, y, 2, lineHeight);
      }
    }

    renderCompositionText() {
      const { x, y } = this.getCursorCoords();
      const baseline = y + this.state.view.lineHeight / 2 + 1;
      this.ctx.fillStyle = this.config.colors.text;
      this.ctx.fillText(this.compositionText, x, baseline);
      const width = this.measureText(this.compositionText);
      this.ctx.strokeStyle = this.config.colors.imeUnderline;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(x, y + this.state.view.lineHeight - 2);
      this.ctx.lineTo(x + width, y + this.state.view.lineHeight - 2);
      this.ctx.stroke();
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
    }

    blur() {
      this.isFocused = false;
      this.textarea.blur();
    }

    onMouseDown(e) {
      e.preventDefault();
      this.focus();
      this.draggedDuringClick = false;
      this.ignoreNextClick = false;
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
      if (!this.isDragging) return;
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
      this.ensureCursorVisibleWhileDragging(e.offsetY);
    }

    onMouseUp() {
      this.isDragging = false;
      this.preferredCursorX = -1;
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
      const maxScroll = this.getMaxScroll();
      const next = this.state.view.scrollTop + e.deltaY;
      this.state.view.scrollTop = Math.max(0, Math.min(maxScroll, next));
    }

    onInput(e) {
      if (this.isComposing) return;
      const value = e.target.value;
      if (!value) return;
      this.insertText(value.replace(/\r\n/g, "\n"));
      this.textarea.value = "";
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
      const lower = key.toLowerCase();
      switch (lower) {
        case "a":
          e.preventDefault();
          this.selectAll();
          return true;
        case "z":
          e.preventDefault();
          if (shift) {
            this.redo();
          } else {
            this.undo();
          }
          return true;
        case "y":
          e.preventDefault();
          this.redo();
          return true;
        case "home":
          e.preventDefault();
          this.moveCursorToDocumentEdge("start", shift);
          return true;
        case "end":
          e.preventDefault();
          this.moveCursorToDocumentEdge("end", shift);
          return true;
        case "arrowup":
          e.preventDefault();
          this.moveLine(-1);
          return true;
        case "arrowdown":
          e.preventDefault();
          this.moveLine(1);
          return true;
        case "arrowleft":
          e.preventDefault();
          if (shift) {
            this.moveCursorByWord(-1, true);
          } else {
            this.changeIndent(-1, {
              applyToSelection: this.hasSelection(),
              includeChildren: false,
            });
          }
          return true;
        case "arrowright":
          e.preventDefault();
          if (shift) {
            this.moveCursorByWord(1, true);
          } else {
            this.changeIndent(1, {
              applyToSelection: this.hasSelection(),
              includeChildren: false,
            });
          }
          return true;
        case "enter":
          e.preventDefault();
          this.toggleCollapse(this.state.cursor.lineIndex);
          return true;
        case "tab":
          e.preventDefault();
          this.changeIndent(1, {
            applyToSelection: this.hasSelection(),
            includeChildren: false,
          });
          return true;
        case "f":
          e.preventDefault();
          this.openSearchPanel({ prefillSelection: true });
          return true;
        case "x":
        case "c":
        case "v":
          return false;
        default:
          return false;
      }
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
      e.preventDefault();
      const paste = e.clipboardData.getData("text/plain");
      if (!paste) return;
      this.insertText(paste.replace(/\r\n/g, "\n"));
    }

    insertText(text) {
      if (!text) return;
      this.saveHistory();
      if (this.state.selection) {
        this.collapseSelectionWithoutHistory();
      }
      const cursor = this.state.cursor;
      const line = this.state.lines[cursor.lineIndex];
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

    insertLineBreak(options = {}) {
      const { indent } = options;
      this.saveHistory();
      if (this.state.selection) {
        this.collapseSelectionWithoutHistory();
      }
      const cursor = this.state.cursor;
      const line = this.state.lines[cursor.lineIndex];
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
        const cursor = this.state.cursor;
        const head = line.text.slice(0, cursor.charIndex);
        const tail = line.text.slice(cursor.charIndex);
        line.text = `${head}[${extracted}]${tail}`;
        this.markDocumentVersion();
        this.setCursor(cursor.lineIndex, cursor.charIndex + extracted.length + 2);
      } else {
        const cursor = this.state.cursor;
        const line = this.state.lines[cursor.lineIndex];
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
      if (cursor.charIndex > 0) {
        this.saveHistory();
        line.text =
          line.text.slice(0, cursor.charIndex - 1) +
          line.text.slice(cursor.charIndex);
        this.markDocumentVersion();
        this.setCursor(cursor.lineIndex, cursor.charIndex - 1);
        return;
      }
      if (line.indent > 0) {
        this.changeIndent(-1);
        return;
      }
      if (cursor.lineIndex === 0) return;
      this.saveHistory();
      const prevLineIndex = cursor.lineIndex - 1;
      const prevLine = this.state.lines[prevLineIndex];
      const prevLength = prevLine.text.length;
      prevLine.text += line.text;
      const blockLength = this.getDescendantEnd(cursor.lineIndex) - cursor.lineIndex;
      this.state.lines.splice(cursor.lineIndex, blockLength);
      this.markDocumentVersion();
      this.setCursor(prevLineIndex, prevLength);
      this.invalidateLayout();
    }

    handleDelete() {
      if (this.deleteSelection()) return;
      const cursor = this.state.cursor;
      const line = this.state.lines[cursor.lineIndex];
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
      const lastChar = this.state.lines[lastLineIndex].text.length;
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
      let newLineIndex = cursor.lineIndex;
      let newCharIndex = cursor.charIndex + direction;

      if (newCharIndex < 0) {
        const prevVisible = this.getPreviousVisibleLine(cursor.lineIndex);
        if (prevVisible === null) {
          newCharIndex = 0;
        } else {
          newLineIndex = prevVisible;
          newCharIndex = this.state.lines[prevVisible].text.length;
        }
      } else if (newCharIndex > line.text.length) {
        const nextVisible = this.getNextVisibleLine(cursor.lineIndex);
        if (nextVisible === null) {
          newCharIndex = line.text.length;
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
        this.preferredCursorX = this.measureText(
          line.text.slice(0, this.state.cursor.charIndex)
        );
      }

      const targetVisibleIndex = Math.max(
        0,
        Math.min(visibleLines.length - 1, currentVisibleIndex + visibleDelta)
      );
      const targetLineIndex = visibleLines[targetVisibleIndex];
      const targetLine = this.state.lines[targetLineIndex];
      const targetCharIndex = this.getCharIndexForX(
        targetLine.text,
        this.preferredCursorX
      );

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
          : this.getCurrentLine().text.length;
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
          : this.state.lines[lineIndex].text.length;
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

      if (direction < 0) {
        if (charIndex === 0) {
          const prev = this.getPreviousVisibleLine(lineIndex);
          if (prev === null) return;
          lineIndex = prev;
          charIndex = this.state.lines[prev].text.length;
        }
        charIndex = this.findWordBoundary(
          this.state.lines[lineIndex].text,
          charIndex,
          -1
        );
      } else {
        if (charIndex === line.text.length) {
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
      const isWord = (ch) => /[\w_]/.test(ch);
      if (direction < 0) {
        let i = Math.max(0, index - 1);
        const targetType = isWord(text[i]);
        while (i > 0 && isWord(text[i - 1]) === targetType) {
          i -= 1;
        }
        return i;
      }
      let i = Math.min(text.length, index);
      const targetType = isWord(text[i]) || isWord(text[i - 1]);
      while (i < text.length && isWord(text[i]) === targetType) {
        i += 1;
      }
      return i;
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
          Math.min(this.state.cursor.charIndex, line.text.length)
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
      lineIndex = Math.max(0, Math.min(this.state.lines.length - 1, lineIndex));
      const line = this.state.lines[lineIndex];
      charIndex = Math.max(0, Math.min(line.text.length, charIndex));
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
        return { x: 0, y: 0, line: null };
      }
      const line = this.state.lines[lineIndex];
      const textBefore = line.text.slice(0, this.state.cursor.charIndex);
      const indentX =
        this.config.padding + line.indent * this.state.view.indentWidth;
      const x =
        indentX + this.measureText(textBefore);
      const y =
        this.config.padding + visibleIndex * this.state.view.lineHeight - this.state.view.scrollTop;
      return { x, y, line };
    }

    updateTextareaPosition() {
      if (!this.isFocused) return;
      const { x, y } = this.getCursorCoords();
      this.textarea.style.left = `${x}px`;
      this.textarea.style.top = `${y}px`;
    }

    ensureCursorVisibleWhileDragging(mouseY) {
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
      const y = offsetY + this.state.view.scrollTop;
      const lineHeight = this.state.view.lineHeight;
      const visibleLines = this.getVisibleLines();
      const index = Math.floor(
        (y - this.config.padding) / lineHeight
      );
      if (index < 0 || index >= visibleLines.length) {
        return { lineIndex: null, charIndex: null, clickedIcon: false };
      }
      const lineIndex = visibleLines[index];
      const line = this.state.lines[lineIndex];
      const indentWidth = this.state.view.indentWidth;
      const indentX =
        this.config.padding + line.indent * indentWidth;
      const iconAreaEnd = indentX - indentWidth * 0.2;
      if (offsetX < iconAreaEnd && this.hasChildren(lineIndex)) {
        return { lineIndex, charIndex: 0, clickedIcon: true };
      }
      const relativeX = Math.max(0, offsetX - indentX);
      const charIndex = this.getCharIndexForX(line.text, relativeX);
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
      const targetSegment = segments.find(
        (segment) => offsetX >= segment.startX && offsetX <= segment.endX
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
      const totalHeight =
        this.getVisibleLines().length * this.state.view.lineHeight +
        this.config.padding * 2;
      return Math.max(0, totalHeight - this.canvas.height);
    }

    scrollToCursor() {
      const visibleIndex = this.getVisibleIndex(this.state.cursor.lineIndex);
      if (visibleIndex === -1) return;
      const lineTop =
        this.config.padding + visibleIndex * this.state.view.lineHeight;
      const lineBottom = lineTop + this.state.view.lineHeight;
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
        lines: this.state.lines.map((line) => ({ ...line })),
        cursor: { ...this.state.cursor },
        selection: this.state.selection
          ? {
            start: { ...this.state.selection.start },
            end: { ...this.state.selection.end },
          }
          : null,
        scrollTop: this.state.view.scrollTop,
      };
    }

    applySnapshot(snapshot) {
      this.state.lines = snapshot.lines.map((line) => ({ ...line }));
      this.state.cursor = { ...snapshot.cursor };
      this.state.selection = snapshot.selection
        ? {
          start: { ...snapshot.selection.start },
          end: { ...snapshot.selection.end },
        }
        : null;
      this.state.view.scrollTop = snapshot.scrollTop;
      this.invalidateLayout();
      this.resetCursorBlink();
      this.markDocumentVersion();
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
    }

    measureText(text) {
      if (text.length === 0) {
        return 0;
      }
      const cachedWidth = this.textWidthCache.get(text);
      if (cachedWidth !== undefined) {
        return cachedWidth;
      }
      const width = this.ctx.measureText(text).width;
      if (this.textWidthCache.size > 10000) {
        this.textWidthCache.clear();
      }
      this.textWidthCache.set(text, width);
      return width;
    }
  }

  new CanvasEditor(
    document.getElementById("editor-canvas"),
    document.getElementById("hidden-input")
  );
});


