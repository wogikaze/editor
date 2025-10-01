import CanvasEditor from "./editor/index.js";
import CollaborationClient from "./collaboration/socket-client.js";

document.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("editor-canvas");
  const textarea = document.getElementById("hidden-input");
  if (!canvas || !textarea) {
    console.error("Canvas editor elements not found.");
    return;
  }

  const editor = new CanvasEditor(canvas, textarea);

  const collabConfig = window.CollaborationConfig || {};
  const collaborationClient = new CollaborationClient(editor, {
    url: collabConfig.websocketUrl,
    port: collabConfig.websocketPort,
    debug: Boolean(collabConfig.debugCollaboration),
  });

  if (collabConfig.exposeInstances) {
    window.editorInstance = editor;
    window.collaborationClient = collaborationClient;
  }
});
