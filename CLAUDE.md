# PawCut — engineering notes

Mobile-only PWA video editor for vertical short-form video. Full product spec: `SPEC.md`.
Primary target: iPhone Safari installed to Home Screen. No desktop layout.

## Commands
- `npm run dev` — Vite dev server (sends COOP/COEP headers)
- `npm run build` — typecheck + production build (`dist/`)
- `npm run preview` — serve `dist/` with COOP/COEP
- `npm test` — Vitest unit tests (timeline model, audio resampling)
- `./scripts/make-fixtures.sh` then `npx playwright test` — e2e on Chromium (iPhone 13 emulation). Chromium has no
  H.264/AAC, so tests open the app with `?codec=vp9` (VP9/Opus everywhere, same pipeline; also exposes
  `window.__pawcut` stores for assertions). Phase 0 spike test needs `PAWCUT_SPIKE_VIDEO=/path/to/video`.
- `node scripts/render-icons.mjs` — regenerate PNG icons from `public/icons/icon.svg`

## Workflow
- Owner's standing instruction: push finished work straight to `main` (Cloudflare Workers Builds deploys `main`).
  Keep small, validated commits; run `npm run build` and `npm test` before every push.

## Stack
Vite 8, React 18, TypeScript (strict, `noUncheckedIndexedAccess`), Tailwind 4 (via `@tailwindcss/vite`),
`vite-plugin-pwa` (generateSW, prompt-to-update), Mediabunny for demux/mux + WebCodecs orchestration.
Hosting: Cloudflare Pages; headers live in `public/_headers`.

## Architecture (current)
- **Model** `src/editor/timeline/model.ts` — pure JSON `Project { main: Clip[] }` + pure ops (split, trim, ripple delete,
  duplicate, move, speed). Main track is magnetic (no gaps). Clip = asset + in/out source seconds + constant speed.
- **State** `src/editor/store.ts` — zustand: `useEditor` (project, unlimited undo/redo, selection, gesture batching:
  `beginGesture`/`endGesture` make a whole drag one undo step), `useAssets`, `usePlayback` (playhead, playing).
- **Persistence** `src/library/` — Dexie (`projects`, `assets`, `history`, `settings`). Autosave 300ms debounce + flush on
  hide/pagehide. Last open project id is stored so a killed PWA relaunches into it. Undo history persisted (last 100).
- **Media** OPFS layout `media/<assetId>/{original.*, proxy.mp4, poster.jpg, thumbs.jpg}`, `exports/latest.mp4`.
- **Import** `src/engine/media/import.worker.ts` — copy original into OPFS → probe → ONE decode pass producing the
  540p proxy (H.264 2.5 Mbps, 0.5s GOP for fast seeks) plus poster and a thumbnail sprite (≤120 tiles). Serial queue.
  Interrupted imports resume from the OPFS original on next launch.
- **Preview** `src/editor/preview/` — `preview.worker.ts` decodes proxies with WebCodecs (Mediabunny `VideoSampleSink`)
  and streams transferable `VideoFrame`s + PCM chunks ahead of the playhead (16-frame credit window, audio ≤4s ahead).
  While a clip plays, the next clip's decoder is opened and pre-decoded, so cuts are seamless. Main thread
  (`player.ts`) schedules audio on an AudioContext and uses that clock to pick frames; WebGL2 compositor draws them.
  Paused scrubbing = single "still" requests, latest wins. `previewStats` (max frame gap, drops) is checked in e2e.
- **Timeline** `src/editor/timeline/TimelineView.tsx` — single canvas, fixed centre playhead. Pan+inertia, pinch zoom,
  tap select, trim handles (snap to playhead), long-press reorder.
- **Export** `src/engine/export/render.worker.ts` — renders the project from ORIGINALS: 30fps output frames map to
  source times via `CanvasSink.canvasesAtTimestamps`; audio decoded per 5s window and speed-resampled to 48k stereo
  (`src/engine/audio/resample.ts`), 5ms fades at cuts. Streams to OPFS.
- Phase 0 spike lives on as Diagnostics (`#/diagnostics`, gear icon on projects screen).

## Decisions
- **AAC fallback = `@mediabunny/aac-encoder`** (FFmpeg AAC in WASM, ~260 KB gz), lazy-loaded in the worker only when
  `canEncodeAudio('aac')` is false. Chosen over ffmpeg.wasm (~10 MB) for the audio-encode fallback.
- **MP4 `fastStart: false`** — moov at end, no second in-memory copy. Photos/TikTok accept it.
- **Rotation baked into pixels** (`allowTransformationMetadata: false`) so preview, export and every player agree.
- Export preset lives in `src/engine/export/protocol.ts` (`TIKTOK_1080P30`).
- **Speed shifts pitch** (export resampler + `preservesPitch=false` in preview). Pitch-preserving stretch is later work.
- Preview is a WebCodecs player, not `<video>` elements: iOS ignores preload on paused videos, so swapping elements at
  cuts stalled on `play()` (seen on iPhone in Phase 1 testing). Audio clock = AudioContext; `audioSession.type =
  'playback'` so sound plays with the silent switch on.
- Horizontal clips are letterboxed (`contain`) for now; blurred-background fill comes with the compositor work.
- Removed clips' media stays in OPFS (undo can restore them); assets are garbage-collected when a project is deleted.
- Never use `hardwareAcceleration: 'prefer-hardware'` — it's a hard requirement and fails without a HW encoder.

## Phase 0 findings — PASSED (see docs/phase0-report.md)
- Real iPhone PWA: native H.264 + AAC WebCodecs encode, OPFS sync handles, Web Share files, wake lock, WebGPU all work.
- Export plays in Photos and uploads to TikTok. 51s 1080×1920 export took 28s (0.55× RT). Safari undershoots requested H.264 bitrate (~6 of 10 Mbps).

## Known iOS quirks / risks
- AudioContext must be created/resumed inside a user gesture (the Play tap) or it stays suspended.
- Worker + WebCodecs are suspended when the PWA is backgrounded. Wake lock prevents dimming, but switching apps
  pauses export. Must warn the user to keep PawCut open.
- iPhone footage is usually HEVC, often 10-bit HDR (HLG / Dolby Vision). Re-encoding to 8-bit H.264 SDR without
  tone-mapping may look washed out. Needs a WebGL tone-map pass in Phase 1 if Phase 0 shows it.
- `navigator.share({ files })` needs a fresh user gesture — can't auto-share when export finishes; show a button.
- `performance.memory` doesn't exist in Safari; memory must be observed via Xcode/Web Inspector or by crash behaviour.
- iOS ignores manifest `orientation`; a CSS landscape guard covers portrait lock.
- Web Share into TikTok: share sheet → "Save Video" (Photos) is the reliable path; TikTok's share-extension
  acceptance of files varies by version.
