import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { LoroDoc } from "loro-crdt";

const DEFAULT_PORT = Number.parseInt(
  process.env.COLLAB_PORT ?? process.env.PORT ?? "8080",
  10
);

const server = createServer();
const wss = new WebSocketServer({ server });

let nextClientId = 1;
const presenceByClient = new Map();
const socketToClientId = new Map();
const loroDoc = new LoroDoc();

function encodeBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(encoded) {
  try {
    return Buffer.from(encoded, "base64");
  } catch (error) {
    console.warn("Failed to decode base64", error);
    return null;
  }
}

function sendJson(target, message) {
  if (!target || target.readyState !== WebSocket.OPEN) return;
  try {
    target.send(JSON.stringify(message));
  } catch (error) {
    console.error("Failed to send message", error);
  }
}

function broadcast(message, originSocket) {
  wss.clients.forEach((client) => {
    if (client === originSocket || client.readyState !== WebSocket.OPEN) return;
    sendJson(client, message);
  });
}

function buildPeersSnapshot(excludeId) {
  const peers = [];
  presenceByClient.forEach((presence, clientId) => {
    if (clientId === excludeId) return;
    peers.push({ clientId, presence });
  });
  return peers;
}

wss.on("connection", (socket) => {
  const clientId = String(nextClientId++);
  socketToClientId.set(socket, clientId);
  console.log(`Client connected: ${clientId}`);

  const snapshotBytes = loroDoc.export({ mode: "snapshot" });
  sendJson(socket, {
    type: "welcome",
    clientId,
    loroSnapshot: encodeBase64(snapshotBytes),
    peers: buildPeersSnapshot(clientId),
  });

  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      console.warn("Received invalid JSON payload", error);
      return;
    }
    if (!message || typeof message !== "object") return;

    const declaredClientId = String(message.clientId ?? "");
    if (!declaredClientId || declaredClientId !== clientId) {
      return;
    }

    switch (message.type) {
      case "loro-update": {
        if (typeof message.update !== "string" || message.update.length === 0) {
          break;
        }
        const decoded = decodeBase64(message.update);
        if (!decoded) {
          break;
        }
        try {
          loroDoc.import(decoded);
        } catch (error) {
          console.error("Failed to import Loro update", error);
          break;
        }
        if (message.presence) {
          presenceByClient.set(clientId, message.presence);
        }
        broadcast({
          type: "loro-update",
          clientId,
          update: message.update,
          presence: message.presence ?? null,
          version: message.version ?? null,
        }, socket);
        break;
      }
      case "presence": {
        if (message.presence) {
          presenceByClient.set(clientId, message.presence);
        } else {
          presenceByClient.delete(clientId);
        }
        broadcast({
          type: "presence",
          clientId,
          presence: message.presence ?? null,
        }, socket);
        break;
      }
      default:
        console.warn("Unknown message type", message.type);
    }
  });

  socket.on("close", () => {
    socketToClientId.delete(socket);
    presenceByClient.delete(clientId);
    console.log(`Client disconnected: ${clientId}`);
    broadcast({ type: "peer-left", clientId }, socket);
  });

  socket.on("error", (error) => {
    console.error("WebSocket error", error);
  });
});

server.listen(DEFAULT_PORT, () => {
  console.log(`Collaboration server listening on ws://localhost:${DEFAULT_PORT}`);
});
