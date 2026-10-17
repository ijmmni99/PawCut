# PawCut — Mobile-First PWA Video Editor (Claude Code Build Prompt)

> Paste this whole file into Claude Code as the first message, or save it as `SPEC.md` in a new repo and tell Claude Code: "Read SPEC.md and start Phase 0."

---

## 0. Role & working rules for Claude Code

You are a senior web/media engineer building **PawCut**, a mobile-only PWA video editor for short-form vertical video (TikTok / Reels / Shorts). The owner runs a cat business (L&B Cattery) and will use this to make content fast.

Working rules:
- Build **phase by phase** (Section 9). Do not start a phase until the previous phase's acceptance criteria pass.
- **Performance and mobile UX beat feature count.** If a feature hurts performance, put it behind a lazy-loaded module.
- Primary target device: **iPhone, Safari, installed as PWA (Add to Home Screen)**. Secondary: Android Chrome. **No desktop layout.** Lock UI to portrait.
- Keep a `CLAUDE.md` with architecture notes, decisions, and known iOS quirks. Update it each phase.
- Small commits, one feature per commit. TypeScript strict mode. No `any`.
- Ask me before adding any dependency over ~200KB gzipped that isn't listed here.
- After each phase: give me a short test checklist I can run on my iPhone.

---

## 1. Tech stack (use these unless blocked)

| Concern | Choice |
|---|---|
| App | **Vite + React 18 + TypeScript**, **Zustand** (+ immer) for state |
| Styling | Tailwind CSS, dark theme by default |
| Demux / mux / encode | **Mediabunny** (WebCodecs-based, MP4 read/write) |
| Decode / encode | **WebCodecs** (`VideoDecoder`, `VideoEncoder`, `AudioEncoder`), hardware-accelerated |
| Fallback | **ffmpeg.wasm (single-thread core)**, lazy-loaded only when WebCodecs can't handle a format or audio encode |
| Compositor / preview | **WebGL2** on a single canvas (shaders for filters, transitions, text, overlays) |
| Transitions | Port GLSL from **gl-transitions** (MIT) |
| Audio | **Web Audio API** — `AudioContext` for preview, `OfflineAudioContext` for export mix |
| Speech-to-text | **Transformers.js** Whisper (`whisper-base` / `whisper-tiny`, word timestamps), in a Web Worker, WebGPU if available else WASM |
| Object detection (auto-cut) | **MediaPipe Tasks Vision ObjectDetector** (EfficientDet-Lite0, COCO — has `cat`, `dog`, `person`) |
| Beat detection | Onset/energy detection in a worker (or `web-audio-beat-detector`) |
| Storage | **OPFS** for media blobs/proxies, **IndexedDB via Dexie** for projects, library metadata, settings |
| PWA | `vite-plugin-pwa` (Workbox), offline-first |
| Tests | Vitest (timeline model, auto-cut scoring), Playwright with iPhone emulation for UI smoke tests |
| Hosting | **Cloudflare Pages** (need custom headers; GitHub Pages can't set them) |

Heavy work (decoding thumbnails, proxies, motion analysis, Whisper, export) must run in **Web Workers**, never on the main thread.

---

## 2. Performance requirements (non-negotiable)

- **Proxy workflow:** on import, generate a 540×960 low-bitrate proxy in a worker. Timeline preview uses proxies; export uses originals.
- Preview playback: **smooth 30fps on iPhone 12 or newer** with 3 video layers + text + 1 transition.
- Scrubbing: frame shown within **<100ms** of finger movement.
- App cold start (installed PWA): **<2s** to interactive. Initial JS bundle **<250KB gzipped**; lazy-load Whisper, MediaPipe, ffmpeg.wasm, transitions pack.
- Timeline rendered on **canvas**, not hundreds of DOM nodes.
- Strict memory discipline: always `VideoFrame.close()`, LRU frame cache with a memory budget (~300MB), release decoders when clips are off-screen.
- Export a 30s 1080×1920 30fps video in **≤ ~1.5× real time** on iPhone 13 (target, measure and report).
- Use `navigator.wakeLock` during export, and show progress + ETA. Export must survive the screen dimming.
- Feature-detect everything (WebCodecs codecs via `isConfigSupported`, WebGPU, OPFS). Degrade gracefully, never crash.

---

## 3. Core editor features (Premiere-mobile level)

**Project & media**
- Projects list (thumbnail, duration, last edited), duplicate project, rename, delete
- **Templates:** save any project as a reusable template (e.g. "L&B Weekly Kitten") with placeholders for clips
- Import from Photos/Files (video, photos, audio); photos become clips with optional Ken Burns zoom
- Aspect ratio: 9:16 default (also 1:1, 4:5). Horizontal clips: fit with **blurred background fill** or crop-to-fill with reposition

**Timeline**
- Multi-track: main video, overlay/B-roll (PiP), text/captions, stickers, music, SFX, voiceover
- Split, trim (drag handles), delete, duplicate, reorder (long-press + drag), ripple delete
- Magnetic snapping (to playhead, clip edges, beats), pinch-to-zoom timeline
- Undo/redo (unlimited within session, persisted per project)
- Multi-select clips for bulk delete/speed/filter

**Clip tools**
- Speed: constant 0.25×–4×, plus **speed ramp presets** (montage, hero, bullet, flash in/out)
- Freeze frame, reverse (export-time render, lazy)
- Transform: position, scale, rotate, crop, flip, opacity
- **Keyframes** for position/scale/rotation/opacity/volume with ease presets
- Filters (LUT-based presets) + Adjust (exposure, contrast, highlights, shadows, saturation, vibrance, temperature, tint, sharpen, vignette)
- Background blur, chroma key (green screen)

**Audio**
- Clip volume, fade in/out, mute original audio, extract audio to separate track
- Voiceover recording directly on the timeline
- **Auto-ducking:** music lowers automatically under speech/voiceover
- Basic noise reduction (lazy-loaded)

**Text & stickers**
- Text with fonts, color, outline, shadow, background box, and in/out/loop animations (pop, typewriter, bounce, slide, glow)
- Bundled OFL fonts: Montserrat ExtraBold, Poppins, Anton, Bebas Neue, Bangers, Nunito
- Emoji stickers (system emoji rendered to texture), simple shapes, arrows

**Export**
- Presets: **TikTok 1080×1920 30fps H.264 ~10 Mbps AAC 48kHz** (default), 60fps option, "small file" preset
- Export to Files / Photos via **Web Share API** (`navigator.share({ files })`) so it can go straight to TikTok
- Show final file size and duration

---

## 4. ⭐ Auto Highlight & Auto-Cut (signature feature)

Goal: I import a long, boring 3-minute cat clip and get a punchy 15–60s highlight automatically.

**Analysis pipeline (worker, on proxy):**
1. Sample frames at ~5fps, downscale to ~96×170 grayscale.
2. **Motion score:** frame differencing + optical-flow-lite (mean absolute diff in regions), smoothed.
3. **Subject score:** MediaPipe ObjectDetector every ~0.5s — boost segments where a **cat** (or person) is detected and its bounding box moves/changes size.
4. **Audio score:** RMS energy + onset peaks (meows, toy sounds, laughs).
5. **Quality penalty:** blur (Laplacian variance), very dark frames, heavy shake.
6. Combine into a per-second "interest score". Detect peaks → candidate segments (min 0.8s, max 4s each).

**User controls:**
- Target length slider: 15s / 30s / 45s / 60s / custom
- Style: **"Chill"** (longer clips, soft transitions) / **"Hype"** (short cuts, speed ramps, punch-zoom)
- **Beat sync:** if music is chosen, snap cuts to detected beats
- Toggle: "Remove dead air" (cut low-motion + silent parts only, keep order)
- Result is placed on the timeline as normal editable clips. Show a heatmap of the score over the original clip so I can drag segments in/out.

**Also:** "Auto-cut silence" for talking clips (remove pauses > X ms, with padding).

---

## 5. ⭐ Music Library

- Upload my own tracks (mp3/m4a/wav) once, stored in OPFS, reusable in every project
- Metadata: title, tags (cute, hype, chill, funny), mood, favorite ⭐, **auto-detected BPM & duration**, waveform thumbnail
- Search + filter by tag/mood/BPM, recently used
- Preview playback in the library sheet
- Add to project: auto-trim to video length, **auto fade-out at end**, start-offset picker by dragging the waveform ("pick the chorus")
- Optional "License note" field per track (e.g. "Pixabay — commercial OK")
- Export/import the whole library as a single zip backup

---

## 6. ⭐ Auto Subtitles (attention-grabbing)

- Whisper transcription with **word-level timestamps**, languages: **English, Malay, Mandarin** (auto-detect + manual override)
- Model download on first use with progress, cached offline afterwards
- Caption style presets (TikTok-native look):
  - **Word Pop** — one/two words at a time, scale-bounce in
  - **Karaoke Highlight** — active word changes color/background box
  - **Bold Outline** — heavy font, thick stroke, drop shadow
  - **Keyword Emphasis** — auto-color/enlarge important words (nouns, numbers, "FREE", "NEW")
  - **Auto Emoji** — append relevant emoji (😺 for cat, ❤️ love, 😂 funny) — toggleable
- Edit transcript as text; edits keep timings. Split/merge caption chunks. Global style change in one tap
- Max chars per line, 1–2 lines, position presets kept inside the **TikTok safe zone**
- Also works for voiceover-only videos and manual captions with no speech

---

## 7. ⭐ Sound Effects Pack

- Built-in SFX panel with categories: Whoosh, Pop, Ding, Click, Swoosh, Boing, Riser, Impact, Cash register, Camera shutter, Meow-friendly cute "bloop"
- Generate the starter pack **procedurally with Web Audio** (no licensing issues), render to audio buffers and cache
- Let me **import my own SFX** (royalty-free / CC0 from Pixabay or Freesound) into the same library with tags
- Tap to preview, tap again to drop at playhead. Favorites row at top
- "Auto-SFX" option: add whoosh on transitions and pop on caption appear

---

## 8. ⭐ Brand Kit (Copyright / Watermark)

- Brand Kit settings: logo (PNG with transparency), brand name text (e.g. "© L&B Cattery"), handle (@lb.cattery), brand colors, brand font
- Watermark: position presets (corners, inside safe zone), size, opacity, optional subtle float animation
- **Auto-apply to every export** (toggle per project)
- Branded intro/outro clip slots + end-card template ("Book now — link in bio")
- Multiple brand profiles (for future side businesses)

---

## 9. ⭐ Transitions

- 25+ transitions via WebGL shaders (port from gl-transitions + custom):
  - TikTok-style: **Zoom punch in/out, Whip pan (L/R/U/D), Spin, Glitch, RGB split, Flash white, Shake, Blur zoom, Light leak**
  - Classic: Cross dissolve, Dip to black/white, Slide, Push, Wipe, Circle reveal, Luma fade
- Tap between clips to add; duration slider (0.2–1.5s); "Apply to all"; "Random hype" option
- Live preview in the transitions sheet with a small looping thumbnail

---

## 10. Mobile UX rules

- Portrait only, full-screen, respect `safe-area-inset-*`, disable pull-to-refresh and double-tap zoom
- Layout: preview top (~45%), timeline middle, **tool bar at bottom in thumb reach**, tool panels as bottom sheets
- Gestures: pinch zoom timeline, long-press drag reorder, swipe sheets down to close, two-finger tap = undo
- **TikTok safe-zone overlay** toggle on preview (shows where TikTok UI covers the video)
- Haptic feedback where supported (Android), visual feedback on iOS
- Big touch targets (≥44px), one-hand usable
- Autosave every change to IndexedDB. Recover project after app is killed

---

## 11. PWA requirements

- Installable, custom icon/splash, `display: standalone`, theme color
- Fully offline after first load (except first model download for Whisper/MediaPipe)
- Cloudflare Pages headers: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (needed for SharedArrayBuffer/threads), long cache for hashed assets
- Request **persistent storage** (`navigator.storage.persist()`) and show storage used/free in Settings with a "clear proxies/cache" button
- App update prompt when a new version is available

---

## 12. Build phases & acceptance criteria

**Phase 0 — iOS feasibility spike (do this first, ~1 day)**
- Import a 60s iPhone video → decode with WebCodecs → re-encode 1080×1920 H.264 + AAC → save via Web Share on **real iPhone Safari PWA**
- Report: supported codecs, export speed, memory behaviour, any blockers + fallback plan
- ✅ Pass: exported MP4 plays in Photos and uploads to TikTok

**Phase 1 — Core editor MVP**
- Project list, import, proxies, single video track, split/trim/delete/reorder, speed, undo/redo, preview playback, TikTok export
- ✅ Pass: edit a 3-min clip into 30s and export on iPhone without lag

**Phase 2 — Auto Highlight / Auto-Cut**
- Full pipeline from Section 4 + heatmap + target length + Chill/Hype
- ✅ Pass: 3-min cat play clip → 30s highlight in under ~60s analysis on iPhone, cuts land on active moments

**Phase 3 — Music library + SFX + audio tools**
- Sections 5 and 7, multi-track audio, ducking, fades, beat detection + beat-snap
- ✅ Pass: add saved track in ≤3 taps; it auto-fits and fades

**Phase 4 — Auto Subtitles + Text**
- Section 6 + text tool + fonts + animations
- ✅ Pass: 30s voiceover video → styled word-pop captions in ≤3 taps

**Phase 5 — Transitions, filters, adjust, keyframes, overlays/PiP**
- ✅ Pass: 3 layers + text + transition plays at 30fps preview on iPhone 12+

**Phase 6 — Brand kit, templates, polish**
- Section 8, project templates, safe-zone overlay, storage management, offline polish, Lighthouse PWA ≥ 90
- ✅ Pass: new branded video from template in under 5 minutes

**Later / nice-to-have:** speech auto-cut, reverse, chroma key polish, AI background removal, caption translation EN↔MS, direct "Share to TikTok" shortcut.

---

## 13. Project structure (suggested)

```
src/
  app/            # routes, layout, sheets
  editor/
    timeline/     # model, canvas renderer, gestures
    preview/      # WebGL compositor, shaders, transitions
    tools/        # split, speed, text, adjust, keyframes…
  engine/
    media/        # Mediabunny import, proxies, thumbnails
    export/       # WebCodecs encode pipeline, ffmpeg fallback
    audio/        # mixer, ducking, beat detection, SFX synth
  ai/
    autocut/      # motion, detector, scoring (worker)
    subtitles/    # whisper worker, caption styles
  library/        # music, sfx, brand kit, templates (Dexie + OPFS)
  workers/
  pwa/
```

Timeline data model must be a **pure, serializable JSON** (tracks → clips → effects/keyframes) so preview and export render from the same source of truth, and it's unit-testable.

---

## 14. Start now

1. Confirm the plan in ≤10 bullet points and list any risks you see on iOS Safari.
2. Scaffold the repo (Vite + React + TS + Tailwind + PWA plugin + Cloudflare headers file).
3. Do **Phase 0** and report results before moving on.
