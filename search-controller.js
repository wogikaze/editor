export default class SearchController {
  constructor(editor) {
    this.editor = editor;
    this.state = null;
    this.pendingLayoutUpdate = null;
    this.boundHandleGlobalKeydown = this.handleGlobalKeydown.bind(this);
  }

  init() {
    const panel = document.getElementById("search-panel");
    if (!panel) {
      this.state = null;
      this.editor.search = null;
      return;
    }

    const state = {
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
      !state.queryInput ||
      !state.replaceInput ||
      !state.toggleReplaceButton ||
      !state.caseCheckbox ||
      !state.regexCheckbox ||
      !state.selectionCheckbox ||
      !state.resultLabel ||
      !state.prevButton ||
      !state.nextButton ||
      !state.closeButton ||
      !state.replaceButton ||
      !state.replaceAllButton ||
      !state.replaceRow
    ) {
      this.state = null;
      this.editor.search = null;
      return;
    }

    this.state = state;
    this.editor.search = state;
    this.bindEvents();
    this.updatePanelVisibility();
    this.updateUIState();
  }

  bindEvents() {
    const state = this.state;
    if (!state) return;

    state.panel.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    state.toggleReplaceButton.addEventListener("click", () => {
      this.toggle();
    });

    state.queryInput.addEventListener("input", () => {
      this.handleQueryInput();
    });

    state.queryInput.addEventListener("keydown", (event) => {
      this.handleQueryKeydown(event);
    });

    state.replaceInput.addEventListener("keydown", (event) => {
      this.handleReplaceInputKeydown(event);
    });

    state.caseCheckbox.addEventListener("change", () => {
      this.handleOptionChange();
    });

    state.regexCheckbox.addEventListener("change", () => {
      this.handleOptionChange();
    });

    state.selectionCheckbox.addEventListener("change", () => {
      this.handleSelectionToggle();
    });

    state.prevButton.addEventListener("click", () => {
      this.step(-1);
    });

    state.nextButton.addEventListener("click", () => {
      this.step(1);
    });

    state.closeButton.addEventListener("click", () => {
      this.close();
    });

    state.replaceButton.addEventListener("click", () => {
      this.replaceCurrent();
    });

    state.replaceAllButton.addEventListener("click", () => {
      this.replaceAll();
    });

    window.addEventListener("keydown", this.boundHandleGlobalKeydown);
  }

  updatePanelVisibility() {
    const state = this.state;
    if (!state) return;
    state.toggleReplaceButton.setAttribute(
      "aria-pressed",
      state.showReplace ? "true" : "false"
    );
    if (state.showReplace) {
      state.replaceRow.classList.remove("hidden");
    } else {
      state.replaceRow.classList.add("hidden");
    }
    this.scheduleLayoutUpdate();
  }

  updateUIState() {
    this.updateResultLabel();
    this.updateButtonsState();
  }

  updateResultLabel() {
    const state = this.state;
    if (!state) return;
    if (state.regexError) {
      state.resultLabel.textContent = "エラー";
      state.resultLabel.title = state.regexError;
      state.resultLabel.classList.add("error");
      return;
    }
    state.resultLabel.classList.remove("error");
    state.resultLabel.title = "";
    const total = state.matches.length;
    const current = total > 0 && state.activeIndex >= 0 ? state.activeIndex + 1 : 0;
    state.resultLabel.textContent = `${current} / ${total}`;
  }

  updateButtonsState() {
    const state = this.state;
    if (!state) return;
    const hasMatches = state.matches.length > 0 && !state.regexError;
    [state.prevButton, state.nextButton].forEach((button) => {
      button.disabled = !hasMatches;
      button.setAttribute("aria-disabled", hasMatches ? "false" : "true");
    });
    [state.replaceButton, state.replaceAllButton].forEach((button) => {
      button.disabled = !hasMatches;
      button.setAttribute("aria-disabled", hasMatches ? "false" : "true");
    });
  }

  handleQueryInput() {
    const state = this.state;
    if (!state || !state.isOpen) return;
    this.updateResults({ preserveActive: false });
  }

  handleQueryKeydown(event) {
    const state = this.state;
    if (!state || !state.isOpen) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        this.step(-1);
      } else {
        this.step(1);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  }

  handleReplaceInputKeydown(event) {
    const state = this.state;
    if (!state || !state.isOpen) return;
    if (event.key === "Enter") {
      event.preventDefault();
      this.replaceCurrent();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  }

  handleOptionChange() {
    const state = this.state;
    if (!state || !state.isOpen) return;
    this.updateResults({ preserveActive: false });
  }

  handleSelectionToggle() {
    const state = this.state;
    if (!state || !state.isOpen) return;
    if (state.selectionCheckbox.checked) {
      const scope = this.captureSelectionScope();
      if (scope) {
        state.selectionScope = scope;
      }
    } else {
      state.selectionScope = null;
    }
    this.updateResults({ preserveActive: false });
  }

  handleGlobalKeydown(event) {
    const state = this.state;
    if (!state || !state.isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  }

  handleWindowResize() {
    this.scheduleLayoutUpdate();
  }

  open(options = {}) {
    const state = this.state;
    if (!state) return;
    const { prefillSelection = true } = options;
    if (prefillSelection) {
      const selectionText = this.editor.getSelectedText();
      if (selectionText) {
        state.queryInput.value = selectionText;
        state.lastSelectionText = selectionText;
      }
    }

    if (state.selectionCheckbox.checked) {
      state.selectionScope = this.captureSelectionScope();
    } else {
      state.selectionScope = null;
    }

    state.panel.classList.remove("hidden");
    state.panel.setAttribute("aria-hidden", "false");
    state.isOpen = true;
    state.needsUpdate = true;
    this.updateResults({ preserveActive: false });
    this.scheduleLayoutUpdate();
    setTimeout(() => {
      state.queryInput.focus();
      state.queryInput.select();
    }, 0);
  }

  close() {
    const state = this.state;
    if (!state || !state.isOpen) return;
    state.isOpen = false;
    state.panel.classList.add("hidden");
    state.panel.setAttribute("aria-hidden", "true");
    state.selectionScope = null;
    this.clearMatches();
    this.updateLayout();
    this.editor.focus();
  }

  toggle() {
    const state = this.state;
    if (!state) return;
    state.showReplace = !state.showReplace;
    this.updatePanelVisibility();
    const target = state.showReplace ? state.replaceInput : state.queryInput;
    setTimeout(() => {
      target.focus();
      target.select();
    }, 0);
  }

  scheduleLayoutUpdate() {
    if (this.pendingLayoutUpdate !== null) {
      cancelAnimationFrame(this.pendingLayoutUpdate);
    }
    this.pendingLayoutUpdate = requestAnimationFrame(() => {
      this.pendingLayoutUpdate = null;
      this.updateLayout();
    });
  }

  updateLayout() {
    const { editor } = this;
    const state = this.state;
    if (!editor.container) return;
    if (!state || !state.isOpen || state.panel.classList.contains("hidden")) {
      editor.container.classList.remove("search-visible");
      editor.container.style.removeProperty("--search-panel-offset");
      return;
    }
    const panelHeight = state.panel.offsetHeight;
    const verticalSpacing = 24;
    const offset = Math.max(panelHeight + verticalSpacing, verticalSpacing);
    editor.container.style.setProperty("--search-panel-offset", `${offset}px`);
    editor.container.classList.add("search-visible");
  }

  captureSelectionScope() {
    const selection = this.editor.getNormalizedSelection();
    if (!selection) {
      return this.state ? this.state.selectionScope : null;
    }
    if (this.editor.comparePoints(selection.start, selection.end) === 0) {
      return this.state ? this.state.selectionScope : null;
    }
    return {
      start: { ...selection.start },
      end: { ...selection.end },
    };
  }

  clearMatches() {
    const state = this.state;
    if (!state) return;
    state.matches = [];
    state.matchesByLine.clear();
    state.activeIndex = -1;
    state.regexError = null;
    state.resultLabel.textContent = "0 / 0";
    state.resultLabel.classList.remove("error");
    state.resultLabel.title = "";
    state.needsUpdate = false;
    state.lastEvaluatedVersion = this.editor.documentVersion;
    this.updateButtonsState();
  }

  updateResults(options = {}) {
    const state = this.state;
    if (!state || !state.isOpen) return;
    const { preserveActive = false, preferredIndex = null } = options;
    const query = state.queryInput.value;

    if (state.selectionCheckbox.checked) {
      const scope = this.captureSelectionScope();
      if (scope) {
        state.selectionScope = scope;
      }
    } else {
      state.selectionScope = null;
    }

    if (!query) {
      this.clearMatches();
      state.lastEvaluatedVersion = this.editor.documentVersion;
      state.needsUpdate = false;
      return;
    }

    const previousActiveMatch =
      preserveActive && state.activeIndex >= 0
        ? state.matches[state.activeIndex]
        : null;

    const result = this.computeMatches({
      query,
      useRegex: state.regexCheckbox.checked,
      caseSensitive: state.caseCheckbox.checked,
      scope: state.selectionScope,
    });

    state.matches = result.matches;
    state.regexError = result.regexError;
    if (state.regexError) {
      state.matches = [];
      state.matchesByLine.clear();
      state.activeIndex = -1;
      this.updateUIState();
      state.lastEvaluatedVersion = this.editor.documentVersion;
      state.needsUpdate = false;
      return;
    }

    state.matchesByLine = this.groupMatchesByLine(state.matches);

    let nextActive = -1;
    if (state.matches.length > 0) {
      if (
        preferredIndex !== null &&
        preferredIndex >= 0 &&
        preferredIndex < state.matches.length
      ) {
        nextActive = preferredIndex;
      } else if (previousActiveMatch) {
        nextActive = state.matches.findIndex(
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
    state.lastEvaluatedVersion = this.editor.documentVersion;
    state.needsUpdate = false;
    this.updateUIState();
  }

  computeMatches({ query, useRegex, caseSensitive, scope }) {
    const matches = [];
    const { editor } = this;
    if (!query) {
      return { matches, regexError: null };
    }

    const lines = editor.state.lines;
    const startLine = scope ? scope.start.lineIndex : 0;
    const endLine = scope ? scope.end.lineIndex : lines.length - 1;

    const timeoutMs = editor.config.search?.regexTimeoutMs ?? 0;
    const timeoutEnabled = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const now =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? () => performance.now()
        : () => Date.now();
    const deadline = timeoutEnabled ? now() + timeoutMs : null;
    let timedOut = false;
    const checkTimeout = () => {
      if (!timeoutEnabled) return false;
      if (now() > deadline) {
        timedOut = true;
        return true;
      }
      return false;
    };

    if (useRegex) {
      let regex;
      try {
        regex = new RegExp(query, caseSensitive ? "g" : "gi");
      } catch (error) {
        return { matches: [], regexError: error.message };
      }

      lineLoop: for (
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
          if (checkTimeout()) {
            break lineLoop;
          }
        }
        if (checkTimeout()) {
          break;
        }
      }
    } else {
      const needle = caseSensitive ? query : query.toLowerCase();
      lineLoop: for (
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
          if (checkTimeout()) {
            break lineLoop;
          }
        }
        if (checkTimeout()) {
          break;
        }
      }
    }

    if (timedOut) {
      let formattedTimeout;
      if (timeoutMs >= 1000) {
        const seconds = timeoutMs / 1000;
        formattedTimeout = Number.isInteger(seconds)
          ? `${seconds}秒`
          : `${seconds.toFixed(1)}秒`;
      } else {
        formattedTimeout = `${timeoutMs}ミリ秒`;
      }
      return {
        matches: [],
        regexError: `検索がタイムアウトしました (${formattedTimeout})`,
      };
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
    const state = this.state;
    if (!state) return;
    const { scroll = true } = options;
    if (index === -1 || index === undefined || index < 0 || index >= state.matches.length) {
      state.activeIndex = -1;
      this.updateUIState();
      return;
    }
    state.activeIndex = index;
    this.updateUIState();
    const match = state.matches[index];
    if (match) {
      this.ensureMatchSelection(match, { scroll });
    }
  }

  ensureMatchSelection(match, options = {}) {
    const { scroll = true } = options;
    this.editor.setCursor(match.lineIndex, match.end, {
      resetSelection: true,
      scrollIntoView: scroll,
    });
    this.editor.state.selection = {
      start: { lineIndex: match.lineIndex, charIndex: match.start },
      end: { lineIndex: match.lineIndex, charIndex: match.end },
    };
    this.editor.selectionAnchor = { ...this.editor.state.selection.start };
  }

  step(direction) {
    const state = this.state;
    if (!state || state.matches.length === 0 || state.regexError) return;
    const length = state.matches.length;
    let nextIndex = state.activeIndex;
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

  replaceCurrent() {
    const state = this.state;
    if (!state || !state.isOpen) return;
    if (state.matches.length === 0 || state.activeIndex === -1) return;
    if (state.regexError) return;
    const match = state.matches[state.activeIndex];
    const line = this.editor.state.lines[match.lineIndex];
    if (!line) return;

    this.editor.saveHistory();
    const originalText = line.text;
    const before = originalText.slice(0, match.start);
    const after = originalText.slice(match.end);
    const replaceValue = state.replaceInput.value ?? "";
    const replacement = this.applyReplacementPattern(
      match,
      replaceValue,
      originalText,
      state.regexCheckbox.checked
    );

    line.text = before + replacement + after;
    this.editor.markDocumentVersion();
    this.editor.invalidateLayout();

    const preferredIndex = Math.min(state.activeIndex, state.matches.length - 1);
    this.updateResults({ preserveActive: false, preferredIndex });
  }

  replaceAll() {
    const state = this.state;
    if (!state || !state.isOpen) return;
    if (state.matches.length === 0 || state.regexError) return;

    this.editor.saveHistory();
    const replaceValue = state.replaceInput.value ?? "";
    const useRegex = state.regexCheckbox.checked;
    const matchesByLine = new Map();
    state.matches.forEach((match) => {
      if (!matchesByLine.has(match.lineIndex)) {
        matchesByLine.set(match.lineIndex, []);
      }
      matchesByLine.get(match.lineIndex).push(match);
    });

    matchesByLine.forEach((lineMatches, lineIndex) => {
      const line = this.editor.state.lines[lineIndex];
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

    this.editor.markDocumentVersion();
    this.editor.invalidateLayout();
    this.updateResults({ preserveActive: false });
  }
}
