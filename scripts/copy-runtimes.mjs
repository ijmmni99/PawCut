// Copies AI runtimes into public/ so they are served same-origin (required by our COEP headers) and work offline.
// Runs before dev/build; the output is gitignored.
//  - MediaPipe Tasks Vision WASM (ES-module build, works in module workers) — Auto-Cut detector
//  - ONNX Runtime Web, plain SIMD+threads build (14 MB; the WebGPU/asyncify builds are >25 MB, over the Cloudflare
//    per-file limit) — Whisper captions
import { copyFileSync, mkdirSync } from 'node:fs';

function copy(srcDir, destDir, files) {
  const src = new URL(srcDir, import.meta.url);
  const dest = new URL(destDir, import.meta.url);
  mkdirSync(dest, { recursive: true });
  for (const file of files) copyFileSync(new URL(file, src), new URL(file, dest));
}

copy('../node_modules/@mediapipe/tasks-vision/wasm/', '../public/mediapipe/', [
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm',
]);
copy('../node_modules/onnxruntime-web/dist/', '../public/ort/', ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']);
