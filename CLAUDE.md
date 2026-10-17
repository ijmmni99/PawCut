# PawCut — engineering notes

Mobile-only PWA video editor for vertical short-form video. Full product spec: `SPEC.md`.
Primary target: iPhone Safari installed to Home Screen. No desktop layout.

## Commands
- `npm run dev` — Vite dev server (sends COOP/COEP headers)
- `npm run build` — typecheck + production build (`dist/`)
- `npm run preview` — serve `dist/` with COOP/COEP
- `npx playwright test` — UI smoke tests (iPhone 13 emulation on Chromium). Phase 0 export test needs `PAWCUT_SPIKE_VIDEO=/path/to/video`.
- `node scripts/render-icons.mjs` — regenerate PNG icons from `public/icons/icon.svg`

## Stack
Vite 8, React 18, TypeScript (strict, `noUncheckedIndexedAccess`), Tailwind 4 (via `@tailwindcss/vite`),
`vite-plugin-pwa` (generateSW, prompt-to-update), Mediabunny for demux/mux + WebCodecs orchestration.
Hosting: Cloudflare Pages; headers live in `public/_headers`.

## Architecture (current)
- `src/engine/capabilities.ts` — feature detection (WebCodecs `isConfigSupported`, OPFS, WebGPU, share, wake lock). Never throws.
- `src/engine/export/export.worker.ts` — decode → resize/rotate → H.264 + AAC encode → MP4, entirely in a worker.
  Output streams into OPFS via `createSyncAccessHandle` (falls back to in-memory `BufferTarget`).
- `src/engine/export/exportClient.ts` — main-thread wrapper; reads the finished file back from OPFS.
- `src/engine/wakeLock.ts` — screen wake lock, re-acquired on `visibilitychange`.
- `src/app/SpikeScreen.tsx` — Phase 0 spike UI (import → export → share + copyable device report).

## Decisions
- **AAC fallback = `@mediabunny/aac-encoder`** (FFmpeg AAC in WASM, ~260 KB gz), lazy-loaded in the worker only when
  `canEncodeAudio('aac')` is false. Chosen over ffmpeg.wasm (~10 MB) for the audio-encode fallback.
- **MP4 `fastStart: false`** — moov at end, no second in-memory copy. Photos/TikTok accept it.
- **Rotation baked into pixels** (`allowTransformationMetadata: false`) so preview, export and every player agree.
- Export preset lives in `src/engine/export/protocol.ts` (`TIKTOK_1080P30`).

## Phase 0 findings — PASSED (see docs/phase0-report.md)
- Real iPhone PWA: native H.264 + AAC WebCodecs encode, OPFS sync handles, Web Share files, wake lock, WebGPU all work.
- Export plays in Photos and uploads to TikTok. 51s 1080×1920 export took 28s (0.55× RT). Safari undershoots requested H.264 bitrate (~6 of 10 Mbps).

## Known iOS quirks / risks
- Worker + WebCodecs are suspended when the PWA is backgrounded. Wake lock prevents dimming, but switching apps
  pauses export. Must warn the user to keep PawCut open.
- iPhone footage is usually HEVC, often 10-bit HDR (HLG / Dolby Vision). Re-encoding to 8-bit H.264 SDR without
  tone-mapping may look washed out. Needs a WebGL tone-map pass in Phase 1 if Phase 0 shows it.
- `navigator.share({ files })` needs a fresh user gesture — can't auto-share when export finishes; show a button.
- `performance.memory` doesn't exist in Safari; memory must be observed via Xcode/Web Inspector or by crash behaviour.
- iOS ignores manifest `orientation`; a CSS landscape guard covers portrait lock.
- Web Share into TikTok: share sheet → "Save Video" (Photos) is the reliable path; TikTok's share-extension
  acceptance of files varies by version.
