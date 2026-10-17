#!/usr/bin/env bash
# Generates the VP9/Opus test videos used by the Playwright e2e tests (needs ffmpeg with libvpx + libopus).
set -euo pipefail
out="$(dirname "$0")/../e2e/fixtures"
mkdir -p "$out"
ffmpeg -v error -y -f lavfi -i "testsrc2=size=720x1280:rate=30" -f lavfi -i "sine=frequency=330:sample_rate=48000" \
  -t 8 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 2M -c:a libopus "$out/portrait.mp4"
# Landscape, mono audio, stored with a 90° rotation flag like iPhone footage.
ffmpeg -v error -y -f lavfi -i "smptebars=size=1280x720:rate=30" -f lavfi -i "sine=frequency=660:sample_rate=48000" \
  -t 6 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 2M -c:a libopus -ac 1 "$out/landscape-tmp.mp4"
ffmpeg -v error -y -display_rotation 90 -i "$out/landscape-tmp.mp4" -c copy "$out/rotated.mp4"
rm "$out/landscape-tmp.mp4"
echo "fixtures written to $out"
