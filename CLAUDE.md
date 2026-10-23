# PawCut — engineering notes

Mobile-only PWA video editor for vertical short-form video. Full product spec: `SPEC.md`.
Primary target: iPhone Safari installed to Home Screen. No desktop layout.

## Commands
- `npm run dev` — Vite dev server (sends COOP/COEP headers)
- `npm run build` — typecheck + production build (`dist/`)
- `npm run preview` — serve `dist/` with COOP/COEP
- `npm test` — Vitest unit tests (timeline model, audio resampling, Auto-Cut scoring/selection)
- `./scripts/make-fixtures.sh` then `npx playwright test` — e2e on Chromium (iPhone 13 emulation). Chromium has no
  H.264/AAC, so tests open the app with `?codec=vp9` (VP9/Opus everywhere, same pipeline; also exposes
  `window.__pawcut` stores for assertions). Phase 0 spike test needs `PAWCUT_SPIKE_VIDEO=/path/to/video`.
  `PAWCUT_SKIP_PERF=1` skips the playback-smoothness assertions when the sandbox is CPU-starved.
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
- **Import** `src/engine/media/import.worker.ts` — two serial queues: (1) copy original into OPFS + probe for every
  file immediately (clip lands on the timeline at once), (2) build proxies one at a time: decode every frame,
  keep ≤30fps, rotate + downscale with `AdaptiveScaler` (`scaler.ts`: benchmarks WebGL / createImageBitmap / 2D on
  the first 12 frames incl. the canvas→VideoSample capture, keeps the fastest), encode 540p H.264 2.5 Mbps,
  0.5s GOP, `latencyMode: 'realtime'`, source timestamps kept. Audio goes in via a composable Conversion into the
  same Output. Poster + thumbnail sprite come from the scaled canvas. Per-stage timings (`asset.prepStats`) show in
  Diagnostics → Recent imports. Interrupted imports resume from the OPFS original on next launch.
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
- **Auto-Cut** `src/ai/autocut/` — `analyze.worker.ts` reads the proxy once: 4 samples/s at 96px short side for
  grid frame-difference motion (local vs camera/global), brightness, Laplacian sharpness; MediaPipe ObjectDetector
  (EfficientDet-Lite0 int8, CPU, every 0.5s, halved if >80ms) for cat/dog/person presence + box movement; audio RMS
  per 50ms → per-0.25s loudness + onsets. Raw features cached in Dexie `analyses` (bump `ANALYSIS_VERSION` when
  changing extraction). `score.ts` (pure, tested) combines them into a 0..1 interest score, picks peaks (prominence
  ≥0.1, score ≥0.3), grows segments (Chill 2–4s, Hype 0.8–1.8s), pads with lead-in/out before unrelated footage,
  and builds clips (Hype: top 2 segments become 1.5×→0.5×→1.5× stepped ramps). Modes: Highlights / Remove dead air
  / Cut silences. Apply replaces the main track in one undo step.
- **Audio (Phase 3)** — `Project.audio: AudioClip[]` (music / sfx / voice, freely positioned, own volume + fades),
  `Project.mix` (ducking on/off, depth). Pure ops + duck envelope + beat snapping in `src/editor/timeline/audio.ts`.
  Library = Dexie `library` + OPFS `audio/` (`src/library/audioLibrary.ts`): imported music analysed on import
  (`src/engine/audio/analysis.ts`: waveform peaks, BPM + beat grid via onset autocorrelation), built-in SFX are
  procedural (`sfx.ts`, rendered once to WAV, `SFX_VERSION`), voiceovers via MediaRecorder. Zip backup/restore
  (`backup.ts`, fflate). `scheduleOverlay` (`src/engine/audio/overlay.ts`) is the ONE mix of music/SFX/voice: preview
  runs it on the live AudioContext, export pre-renders it on an OfflineAudioContext and the render worker adds it
  to the clips' own sound. Ducking: voice clips + loud video sound (`asset.loudness`, dB per 0.1s measured from the
  proxy by the import worker, backfilled on launch; loud = > −30 dBFS and > clip median + 8 dB), 0.15s attack /
  0.5s release. Timeline draws one row per audio track under the video; trims snap to cuts/playhead/beats.
  Auto-Cut "Cut on the beat" nudges cuts to the music's beats (`snapCutsToBeats`) and refits music after Apply.
- MediaPipe runtime is copied from node_modules to `public/mediapipe/` by `scripts/copy-mediapipe.mjs` (pre-dev /
  pre-build, gitignored); model committed in `public/models/`. Both runtime-cached by the SW, not precached.
- **HDR** `src/engine/media/hdr.ts` — iPhone HLG/PQ BT.2020 → SDR BT.709 in GLSL (`TONEMAP_GLSL`, mirrored in TS for
  tests): decode transfer → linear (203 nits = 1.0) → BT.2020→709 → exposure 0.75 → soft knee at 0.6 → sRGB
  (exposure tuned against iPhone Photos: 1.0 looked overexposed). Used by the preview
  compositor (originals shown before the proxy exists), the proxy scaler (forces the WebGL scaler for HDR) and
  export (HDR clips render through a WebGL contain-scaler instead of CanvasSink). `hdrUploadIsRaw()` probes once
  per thread with a synthetic 10-bit HLG frame whether the browser already converts HDR on WebGL upload
  (Chromium does, for 10-bit only) — then the shader passes through to avoid double conversion. Safari may not
  label decoded frames, so the transfer falls back to the track's colour metadata (`trackTransfer`, colr/VUI);
  `asset.color` records it (Diagnostics). Proxies are versioned (`PROXY_VERSION` = 4); older ones are rebuilt in
  the background on launch (only if the source is HDR).
- Phase 0 spike lives on as Diagnostics (`#/diagnostics`, gear icon on projects screen): build version
  (`__APP_VERSION__` = commit · build time), Check for updates, recent imports, device report.
- **Updates** `src/pwa/updates.ts` — SW `update()` on every return to foreground + every 30 min (installed iOS apps
  stay in memory for days). A waiting SW is applied automatically (reload) within 20s of launch or while on the
  projects list; otherwise `UpdatePrompt` shows the Update bar so an edit/export is never interrupted.

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
- Detector assets are self-hosted: Google's model bucket sends no CORS headers, which COEP `require-corp` blocks.
- Punch-zoom for Hype waits for keyframes (Phase 5).
- Built-in SFX are synthesised (no samples to license). Noise reduction and "extract audio from video" are deferred.
- Music only auto-refits on Use and after Auto-Cut Apply; later main-track edits leave it where it is.
- Proxy scaling is benchmarked per device rather than hard-coded: on GPU-less Chromium WebGL readback is the slowest
  option, on iPhone the 2D canvas path (old Mediabunny resize) made "Preparing" very slow on 4K footage.
- e2e runs with `workers: 1`: media tests in parallel starve each other and skew the smoothness checks.
- Never use `hardwareAcceleration: 'prefer-hardware'` — it's a hard requirement and fails without a HW encoder.

## Phase 0 findings — PASSED (see docs/phase0-report.md)
- Real iPhone PWA: native H.264 + AAC WebCodecs encode, OPFS sync handles, Web Share files, wake lock, WebGPU all work.
- Export plays in Photos and uploads to TikTok. 51s 1080×1920 export took 28s (0.55× RT). Safari undershoots requested H.264 bitrate (~6 of 10 Mbps).

## Known iOS quirks / risks
- AudioContext must be created/resumed inside a user gesture (the Play tap) or it stays suspended.
- Worker + WebCodecs are suspended when the PWA is backgrounded. Wake lock prevents dimming, but switching apps
  pauses export. Must warn the user to keep PawCut open.
- iPhone footage is usually HEVC 10-bit HDR (HLG + Dolby Vision metadata). Safari uploads it to WebGL raw → washed
  out unless tone-mapped (see HDR above). Diagnostics shows "HDR tone-mapping by PawCut" = the probe result.
- The iOS photo picker converts HEVC to H.264 for web pages by default ("Most Compatible") — very slow for long
  clips. Picker ••• → format "Current" hands over the original instantly; PawCut handles HEVC fine.
- `navigator.share({ files })` needs a fresh user gesture — can't auto-share when export finishes; show a button.
- `performance.memory` doesn't exist in Safari; memory must be observed via Xcode/Web Inspector or by crash behaviour.
- iOS ignores manifest `orientation`; a CSS landscape guard covers portrait lock.
- iOS 26 blurs page content drawn behind the status bar of home-screen apps (headers came out blurry, intermittently).
  Fix: `apple-mobile-web-app-status-bar-style` = `black` (opaque), so the page starts below the status bar.
  Headers still use `TopBar` (fixed + spacer; safe-area padding is then 0 on iOS). Changing this meta only takes
  effect after the app is removed from the Home Screen and added again.
- Web Share into TikTok: share sheet → "Save Video" (Photos) is the reliable path; TikTok's share-extension
  acceptance of files varies by version.
