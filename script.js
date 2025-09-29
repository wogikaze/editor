import CanvasEditor from "./editor-core.js";

document.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("editor-canvas");
  const textarea = document.getElementById("hidden-input");
  if (!canvas || !textarea) {
    console.error("Canvas editor elements not found.");
    return;
  }

  new CanvasEditor(canvas, textarea);
});
