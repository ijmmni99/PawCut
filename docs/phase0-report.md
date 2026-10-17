# Phase 0 — iOS feasibility spike results

## Device run #1 (2026-10-17)
- iPhone, iOS 18.7 UA / Safari 27, installed PWA, 4 cores
- Cross-origin isolated, OPFS, Web Share (files), Wake Lock, WebGL2, WebGPU, `storage.persist()` all available
- WebCodecs: video + audio encoders and decoders all present
- Encode 1080×1920: H.264 Baseline/Main/High up to L4.2, HEVC, VP9, AV1 (all reported HW)
- Decode: H.264 4K, HEVC 4K, HEVC Main10 (HDR), VP9, AV1
- Audio: native AAC-LC + Opus encode → WASM AAC fallback not needed on this device

| Input | Output | Time | Speed |
|---|---|---|---|
| IMG_1883.mov, H.264 SDR 1920×1080 rot 270, AAC 48k, 51.1s, 59.8 MB | 1080×1920 H.264 + AAC, 38.4 MB | 28.2s | **0.55× real time** (target ≤ 1.5×) |

Notes
- Rotation baked correctly (portrait in → portrait out).
- Output averaged ~6 Mbps against the 10 Mbps target: Safari's H.264 encoder runs under the requested bitrate on
  simple content. Acceptable; revisit with `bitrateMode: 'constant'` if TikTok re-compression looks soft.
- Output was streamed to OPFS, no memory problems on a 60 MB source.

## Still open
- [ ] Exported MP4 plays in Photos (via Share → Save Video)
- [ ] Uploads to TikTok
- [ ] HEVC 10-bit HDR source (default iPhone camera) — check speed and whether colours look washed out
- [ ] 4K60 source
