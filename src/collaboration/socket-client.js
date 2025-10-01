import LoroDocument from "./loro-document.js";

const DEFAULT_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

function resolveDefaultUrl(options = {}) {
  if (typeof window === "undefined") {
    return "ws://localhost:8080";
  }
  const { protocol, hostname } = window.location;
  const scheme = protocol === "https:" ? "wss" : "ws";
  const port = options.port ?? 8080;
  return `${scheme}://${hostname || "localhost"}:${port}`;
}

function safeParse(message) {
  try {
    return JSON.parse(message);
  } catch (error) {
    console.warn("Failed to parse collaboration payload", error);
    return null;
  }
}

function clonePresence(presence) {
  if (!presence) return null;
  const cursor = presence.cursor
    ? {
      lineIndex: Number(presence.cursor.lineIndex) || 0,
      charIndex: Number(presence.cursor.charIndex) || 0,
    }
    : null;
  const selection = presence.selection
    ? {
      start: {
        lineIndex: Number(presence.selection.start?.lineIndex) || 0,
        charIndex: Number(presence.selection.start?.charIndex) || 0,
      },
      end: {
        lineIndex: Number(presence.selection.end?.lineIndex) || 0,
        charIndex: Number(presence.selection.end?.charIndex) || 0,
      },
    }
    : null;
  return {
    documentVersion: Number(presence.documentVersion) || 0,
    cursor,
    selection,
  };
}

function generatePeerId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `peer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function uint8ArrayToBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) return "";
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  if (!base64) return null;
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  try {
    const binary = atob(base64);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (error) {
    console.warn("Failed to decode base64 payload", error);
    return null;
  }
}

export default class CollaborationClient {
  constructor(editor, options = {}) {
    this.editor = editor;
    this.url = options.url || resolveDefaultUrl(options);
    this.debug = Boolean(options.debug);
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 10000;
    this.reconnectTimer = null;
    this.socket = null;
    this.isDisposed = false;
    this.clientId = null;
    this.peerPresence = new Map();
    this.peerColors = new Map();
    this.colorPalette = Array.isArray(options.colors) && options.colors.length > 0
      ? options.colors
      : DEFAULT_COLORS;
    this.lastPresenceSerialized = null;
    this.presenceTimer = null;
    this.pendingUpdates = [];
    this.localUpdateUnsubscribe = null;
    this.lastAppliedSnapshot = null;

    this.loro = new LoroDocument({ peerId: generatePeerId() });
    this.localUpdateUnsubscribe = this.loro.subscribeLocalUpdates((bytes) => {
      this.handleLocalLoroUpdate(bytes);
    });

    if (this.editor && typeof this.editor.createStateSnapshot === "function") {
      try {
        const initialSnapshot = this.editor.createStateSnapshot();
        this.lastAppliedSnapshot = initialSnapshot;
      } catch (error) {
        console.warn("Failed to seed Loro document from editor", error);
      }
    }

    this.unsubscribe = this.editor.addDocumentChangeListener((documentState) => {
      this.handleLocalDocumentChange(documentState);
    });

    if (!("WebSocket" in window)) {
      console.warn("WebSocket is not supported in this environment.");
      return;
    }

    this.connect();
  }

  connect() {
    if (this.isDisposed) return;
    this.clearReconnectTimer();
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.log("Connected to collaboration server", this.url);
      this.reconnectDelay = 1000;
      if (this.clientId) {
        this.sendPresenceUpdate(true);
        this.flushPendingUpdates();
      }
    });

    socket.addEventListener("message", (event) => {
      const data = safeParse(event.data);
      if (!data || typeof data !== "object") return;
      this.handleMessage(data);
    });

    socket.addEventListener("close", () => {
      if (this.isDisposed) return;
      this.log("Collaboration socket closed. Reconnecting soon...");
      this.scheduleReconnect();
      this.clearPeerPresence();
    });

    socket.addEventListener("error", (event) => {
      this.log("Collaboration socket error", event);
      socket.close();
    });
  }

  handleMessage(message) {
    switch (message.type) {
      case "welcome":
        this.handleWelcome(message);
        break;
      case "loro-update":
        this.handleLoroNetworkUpdate(message);
        break;
      case "presence":
        this.handlePresence(message);
        break;
      case "peer-left":
        this.handlePeerLeft(message);
        break;
      case "pong":
        break;
      default:
        this.log("Unknown collaboration message", message);
    }
  }

  handleWelcome(message) {
    const { clientId, peers } = message;
    if (!clientId) return;
    this.clientId = clientId;

    if (Array.isArray(peers)) {
      peers.forEach((peer) => {
        if (!peer || peer.clientId === this.clientId) return;
        this.updatePeerPresence(peer.clientId, peer.presence);
      });
    }

    if (message.loroSnapshot) {
      const bytes = base64ToUint8Array(message.loroSnapshot);
      if (bytes) {
        this.applyRemoteBytes(bytes, {
          preserveView: false,
          preserveCursor: false,
        });
      }
    }

    this.startPresenceLoop();
    this.flushPendingUpdates();
    this.sendPresenceUpdate(true);
  }

  handleLoroNetworkUpdate(message) {
    const { clientId, update } = message;
    if (!clientId || clientId === this.clientId) return;
    if (update) {
      const bytes = base64ToUint8Array(update);
      if (bytes) {
        this.applyRemoteBytes(bytes, {
          preserveView: true,
          preserveCursor: true,
        });
      }
    }
    if (message.presence) {
      this.updatePeerPresence(clientId, message.presence);
    }
  }

  applyRemoteBytes(bytes, options = {}) {
    if (!(bytes instanceof Uint8Array)) return;
    try {
      this.loro.importUpdate(bytes);
      const snapshot = this.loro.toSnapshot();
      this.lastAppliedSnapshot = snapshot;
      const preserveView = options.preserveView ?? true;
      const preserveCursor = options.preserveCursor ?? true;
      this.editor.applyExternalDocument(
        {
          version: this.loro.getVersion(),
          snapshot,
        },
        {
          preserveView,
          preserveCursor,
        }
      );
    } catch (error) {
      console.error("Failed to apply remote update", error);
    }
  }

  handlePresence(message) {
    const { clientId, presence } = message;
    if (!clientId || clientId === this.clientId) return;
    this.updatePeerPresence(clientId, presence);
  }

  handlePeerLeft(message) {
    const { clientId } = message;
    if (!clientId || clientId === this.clientId) return;
    this.peerPresence.delete(clientId);
    this.peerColors.delete(clientId);
    if (this.editor && typeof this.editor.clearRemotePresence === "function") {
      this.editor.clearRemotePresence(clientId);
    }
  }

  handleLocalDocumentChange(documentState) {
    if (!documentState || !documentState.snapshot) return;
    this.lastAppliedSnapshot = documentState.snapshot;
    try {
      this.loro.applySnapshot(documentState.snapshot);
    } catch (error) {
      console.error("Failed to sync local snapshot into Loro", error);
    }
  }

  handleLocalLoroUpdate(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      return;
    }
    if (!this.clientId || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.pendingUpdates.push(bytes.slice());
      return;
    }
    this.sendLoroUpdate(bytes);
  }

  sendLoroUpdate(bytes) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (!this.clientId) return;
    const encoded = uint8ArrayToBase64(bytes);
    if (!encoded) return;
    const message = {
      type: "loro-update",
      clientId: this.clientId,
      update: encoded,
      version: this.loro.getVersion(),
    };
    const presence = this.collectPresenceState();
    if (presence) {
      message.presence = presence;
    }
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      console.error("Failed to send collaboration update", error);
    }
  }

  flushPendingUpdates() {
    if (!this.clientId) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    while (this.pendingUpdates.length > 0) {
      const bytes = this.pendingUpdates.shift();
      if (bytes) {
        this.sendLoroUpdate(bytes);
      }
    }
  }

  startPresenceLoop() {
    if (this.presenceTimer) return;
    this.presenceTimer = window.setInterval(() => {
      this.sendPresenceUpdate();
    }, 250);
  }

  stopPresenceLoop() {
    if (!this.presenceTimer) return;
    clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  collectPresenceState() {
    if (!this.editor || typeof this.editor.getPresenceState !== "function") {
      return null;
    }
    const state = this.editor.getPresenceState();
    if (!state) return null;
    const presence = clonePresence(state);
    if (presence && presence.selection) {
      const { start, end } = presence.selection;
      if (
        start.lineIndex === end.lineIndex &&
        start.charIndex === end.charIndex
      ) {
        presence.selection = null;
      }
    }
    return presence;
  }

  sendPresenceUpdate(force = false) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (!this.clientId) return;
    const presence = this.collectPresenceState();
    const serialized = presence ? JSON.stringify(presence) : null;
    if (!force && serialized === this.lastPresenceSerialized) {
      return;
    }
    this.lastPresenceSerialized = serialized;
    try {
      this.socket.send(
        JSON.stringify({
          type: "presence",
          clientId: this.clientId,
          presence,
        })
      );
    } catch (error) {
      console.error("Failed to send presence update", error);
    }
  }

  updatePeerPresence(clientId, presencePayload) {
    if (!presencePayload) {
      this.peerPresence.delete(clientId);
      this.peerColors.delete(clientId);
      this.editor.clearRemotePresence(clientId);
      return;
    }
    if (!this.editor || typeof this.editor.setRemotePresence !== "function") {
      return;
    }
    const presence = clonePresence(presencePayload);
    this.peerPresence.set(clientId, presence);
    const color = this.getOrAssignColor(clientId);
    this.editor.setRemotePresence(clientId, {
      ...presence,
      color,
      label: presencePayload.label || `User ${clientId}`,
    });
  }

  getOrAssignColor(clientId) {
    if (this.peerColors.has(clientId)) {
      return this.peerColors.get(clientId);
    }
    const palette = this.colorPalette;
    const index = this.peerColors.size % palette.length;
    const color = palette[index];
    this.peerColors.set(clientId, color);
    return color;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.isDisposed) return;
    const delay = Math.min(this.reconnectDelay, this.maxReconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  clearPeerPresence() {
    if (this.editor && typeof this.editor.clearRemotePresence === "function") {
      this.peerPresence.forEach((_presence, clientId) => {
        this.editor.clearRemotePresence(clientId);
      });
    }
    this.peerPresence.clear();
    this.peerColors.clear();
  }

  dispose() {
    this.isDisposed = true;
    this.stopPresenceLoop();
    this.clearReconnectTimer();
    this.clearPeerPresence();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.localUpdateUnsubscribe) {
      this.localUpdateUnsubscribe();
      this.localUpdateUnsubscribe = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  log(...args) {
    if (this.debug) {
      console.log("[Collaboration]", ...args);
    }
  }
}
