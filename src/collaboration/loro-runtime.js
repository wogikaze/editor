import init, { LoroDoc, LoroMap } from "../../node_modules/loro-crdt/web/index.js";

let readyPromise = null;
let isReady = false;

function getWasmUrl() {
  return new URL("../../node_modules/loro-crdt/web/loro_wasm_bg.wasm", import.meta.url);
}

export function ensureLoroReady() {
  if (!readyPromise) {
    readyPromise = init({ module_or_path: getWasmUrl() }).then(() => {
      isReady = true;
    }).catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

export function assertLoroReady() {
  if (!isReady) {
    throw new Error("Loro WASM runtime is not initialized. Call ensureLoroReady() before creating collaborative clients.");
  }
}

export { LoroDoc, LoroMap };
