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

export default class CollaborationClient {
  constructor(editor, options = {}) {
    this.editor = editor;
    this.url = options.url || resolveDefaultUrl(options);
    this.debug = Boolean(options.debug);
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 10000;
    this.reconnectTimer = null;
    this.socket = null;
    this.pendingDocument = null;
    this.isDisposed = false;
    this.clientId = null;
    this.peerPresence = new Map();
    this.peerColors = new Map();
    this.colorPalette = Array.isArray(options.colors) && options.colors.length > 0
      ? options.colors
      : DEFAULT_COLORS;
    this.lastPresenceSerialized = null;
    this.presenceTimer = null;

    this.unsubscribe = this.editor.addDocumentChangeListener((documentState) => {
      this.pendingDocument = documentState;
      this.flushPending();
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
        this.flushPending(true);
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
      case "update":
        this.handleDocumentUpdate(message);
        break;
      case "presence":
        this.handlePresence(message);
        break;
      case "peer-left":
        this.handlePeerLeft(message);
        break;
      case "init": // legacy support
        this.handleDocumentUpdate(message);
        break;
      case "pong":
        break;
      default:
        this.log("Unknown collaboration message", message);
    }
  }

  handleWelcome(message) {
    const { clientId, document, peers } = message;
    if (!clientId) return;
    this.clientId = clientId;
    if (document) {
      this.editor.applyExternalDocument(document, {
        preserveView: false,
        preserveCursor: false,
      });
    }
    if (Array.isArray(peers)) {
      peers.forEach((peer) => {
        if (!peer || peer.clientId === this.clientId) return;
        this.updatePeerPresence(peer.clientId, peer.presence);
      });
    }
    this.startPresenceLoop();
    this.flushPending(true);
    this.sendPresenceUpdate(true);
  }

  handleDocumentUpdate(message) {
    const { clientId, document, presence } = message;
    if (!clientId || clientId === this.clientId) return;
    if (document) {
      this.editor.applyExternalDocument(document, {
        preserveView: true,
        preserveCursor: true,
      });
    }
    if (presence) {
      this.updatePeerPresence(clientId, presence);
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

  flushPending(force = false) {
    if (!this.pendingDocument) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (force) {
        this.log("Unable to send document, socket not open yet");
      }
      return;
    }
    if (!this.clientId) {
      return;
    }
    const message = {
      type: "document",
      clientId: this.clientId,
      document: this.pendingDocument,
      presence: this.collectPresenceState(),
    };
    try {
      this.socket.send(JSON.stringify(message));
      this.pendingDocument = null;
    } catch (error) {
      console.error("Failed to send collaboration update", error);
    }
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
