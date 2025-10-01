import { assertLoroReady, LoroDoc, LoroMap } from "./loro-runtime.js";

function ensureBoolean(value) {
  return value === true;
}

function ensureIndex(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  if (number <= 0) {
    return 0;
  }
  return Math.floor(number);
}

function ensureNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return number;
}

function ensureString(value) {
  return typeof value === "string" ? value : "";
}

function clonePoint(point) {
  if (!point || typeof point !== "object") {
    return null;
  }
  return {
    lineIndex: ensureIndex(point.lineIndex),
    charIndex: ensureIndex(point.charIndex),
  };
}

function cloneSelection(selection) {
  if (!selection || typeof selection !== "object") {
    return null;
  }
  const start = clonePoint(selection.start);
  const end = clonePoint(selection.end);
  if (!start || !end) {
    return null;
  }
  return { start, end };
}

function generateNumericPeerId() {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buffer = new Uint32Array(2);
    crypto.getRandomValues(buffer);
    const high = BigInt(buffer[0]);
    const low = BigInt(buffer[1]);
    const composite = (high << 32n) | low;
    if (composite > 0n) {
      return composite.toString();
    }
  }
  const random = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  return random > 0 ? String(random) : "1";
}

function normalizePeerId(peerId) {
  if (typeof peerId === "bigint") {
    return peerId >= 0n ? peerId.toString() : null;
  }
  if (typeof peerId === "number") {
    if (!Number.isFinite(peerId) || peerId < 0) {
      return null;
    }
    return Math.floor(peerId).toString();
  }
  if (typeof peerId === "string") {
    if (/^\d+$/.test(peerId)) {
      const trimmed = peerId.replace(/^0+(?=\d)/, "");
      return trimmed === "" ? "0" : trimmed;
    }
    return null;
  }
  return null;
}

export default class LoroDocument {
  constructor(options = {}) {
    assertLoroReady();
    this.doc = new LoroDoc();
    if (typeof this.doc.setPeerId === "function") {
      const normalized = normalizePeerId(options.peerId);
      const resolved = normalized ?? generateNumericPeerId();
      if (resolved !== null) {
        this.doc.setPeerId(resolved);
      }
    }
    this.lines = this.doc.getMovableList("lines");
    this.version = 0;
    this._viewState = {
      cursor: null,
      selection: null,
      scrollTop: 0,
      scrollLeft: 0,
    };
  }

  getVersion() {
    return this.version;
  }

  subscribeLocalUpdates(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    return this.doc.subscribeLocalUpdates(listener);
  }

  importUpdate(bytes) {
    if (!(bytes instanceof Uint8Array)) return;
    this.doc.import(bytes);
    this.version += 1;
  }

  exportSnapshotBytes() {
    return this.doc.export({ mode: "snapshot" });
  }

  applySnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.lines)) {
      return;
    }

    const targetLines = snapshot.lines;
    const seen = new Set();

    for (let i = 0; i < targetLines.length; i += 1) {
      const line = targetLines[i];
      if (!line || typeof line !== "object") continue;

      const requestedId = ensureString(line.id) || null;
      let existing = this._findLine(requestedId);

      if (!existing) {
        existing = {
          index: i,
          map: this.lines.insertContainer(i, new LoroMap()),
        };
      } else if (existing.index !== i) {
        this.lines.move(existing.index, i);
        existing = {
          index: i,
          map: this.lines.get(i),
        };
      } else {
        existing.map = this.lines.get(i);
      }

      const container = existing.map;
      if (!container || typeof container.set !== "function") {
        continue;
      }

      const id = requestedId || this._generateFallbackId();
      this._setIfChanged(container, "id", id);
      this._setIfChanged(container, "text", ensureString(line.text));
      this._setIfChanged(container, "indent", ensureIndex(line.indent));
      this._setIfChanged(container, "collapsed", ensureBoolean(line.collapsed));

      seen.add(id);
    }

    for (let index = this.lines.length - 1; index >= 0; index -= 1) {
      const entry = this.lines.get(index);
      const entryId = entry && typeof entry.get === "function" ? ensureString(entry.get("id")) : null;
      if (!entryId || !seen.has(entryId)) {
        this.lines.delete(index, 1);
      }
    }

    this.version += 1;
    this._viewState = {
      cursor: clonePoint(snapshot.cursor),
      selection: cloneSelection(snapshot.selection),
      scrollTop: ensureNumber(snapshot.scrollTop),
      scrollLeft: ensureNumber(snapshot.scrollLeft),
    };
  }

  toSnapshot() {
    const lines = [];
    const length = this.lines.length;
    for (let i = 0; i < length; i += 1) {
      const entry = this.lines.get(i);
      if (!entry || typeof entry.get !== "function") continue;
      lines.push({
        id: ensureString(entry.get("id")),
        text: ensureString(entry.get("text")),
        indent: ensureIndex(entry.get("indent")),
        collapsed: ensureBoolean(entry.get("collapsed")),
      });
    }

    const snapshot = {
      lines,
      cursor: clonePoint(this._viewState.cursor),
      selection: cloneSelection(this._viewState.selection),
      scrollTop: ensureNumber(this._viewState.scrollTop),
      scrollLeft: ensureNumber(this._viewState.scrollLeft),
    };

    return snapshot;
  }

  _findLine(lineId) {
    if (!lineId) return null;
    const length = this.lines.length;
    for (let i = 0; i < length; i += 1) {
      const entry = this.lines.get(i);
      if (!entry || typeof entry.get !== "function") continue;
      if (ensureString(entry.get("id")) === lineId) {
        return { index: i, map: entry };
      }
    }
    return null;
  }

  _setIfChanged(container, key, value) {
    if (!container || typeof container.get !== "function" || typeof container.set !== "function") {
      return;
    }
    const current = container.get(key);
    if (current !== value) {
      container.set(key, value);
    }
  }

  _generateFallbackId() {
    return `loro-line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
