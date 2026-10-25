// Downloads the Whisper model used for captions into public/models/whisper/ so the app serves it from its own
// origin (iPhone Safari failed fetching it cross-origin from Hugging Face: "Load failed"). Files over Cloudflare's
// 25 MiB per-asset limit are split into parts; parts.json lists them. Runs before build; output is gitignored.
// A failed download doesn't fail the build — the app then falls back to Hugging Face at runtime.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const MODEL = 'onnx-community/whisper-base_timestamped';
const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];
const PART = 20 * 1024 * 1024;
const dest = new URL(`../public/models/whisper/${MODEL.split('/')[1]}/`, import.meta.url);
const manifestUrl = new URL('parts.json', dest);

async function main() {
  const manifest = existsSync(manifestUrl) ? JSON.parse(readFileSync(manifestUrl, 'utf8')) : {};
  if (FILES.every((f) => manifest[f])) {
    console.log('whisper: already downloaded');
    return;
  }
  for (const file of FILES) {
    if (manifest[file]) continue;
    const res = await fetch(`https://huggingface.co/${MODEL}/resolve/main/${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const parts = Math.max(1, Math.ceil(bytes.length / PART));
    mkdirSync(new URL(file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : './', dest), { recursive: true });
    for (let i = 0; i < parts; i++) {
      writeFileSync(new URL(parts === 1 ? file : `${file}.part${i}`, dest), bytes.subarray(i * PART, (i + 1) * PART));
    }
    manifest[file] = { size: bytes.length, parts };
    writeFileSync(manifestUrl, JSON.stringify(manifest, null, 1));
    console.log(`whisper: ${file} ${(bytes.length / 1e6).toFixed(1)} MB in ${parts} part(s)`);
  }
}

main().catch((err) => console.warn(`whisper: download skipped (${err.message}); the app will use Hugging Face`));
