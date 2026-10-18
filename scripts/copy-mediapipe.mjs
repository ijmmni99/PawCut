// Copies the MediaPipe Tasks Vision WASM runtime (ES-module build, works in module workers) into public/ so it is
// served same-origin (required by our COEP headers). Runs before dev/build; the output is gitignored.
import { copyFileSync, mkdirSync } from 'node:fs';

const src = new URL('../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url);
const dest = new URL('../public/mediapipe/', import.meta.url);
mkdirSync(dest, { recursive: true });
for (const file of ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']) {
  copyFileSync(new URL(file, src), new URL(file, dest));
}
