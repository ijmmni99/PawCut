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
# Auto-Cut: 60s of static grey + silence with two "action" bursts:
#   10–14s moving test pattern + tone, 40–44s a cat photo moving across the frame + tone.
cat="$out/cat.jpg"
[ -s "$cat" ] || curl -sSL -A "PawCutFixtures/1.0" -o "$cat" "https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg"
ffmpeg -v error -y \
  -f lavfi -i "color=c=0x606060:size=720x1280:rate=30:duration=60" \
  -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=60" \
  -loop 1 -framerate 30 -t 60 -i "$cat" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=60" \
  -filter_complex "[2]scale=600:-1[c];[0][1]overlay=enable='between(t,10,14)'[a];[a][c]overlay=x='-600+(t-40)*300':y=300:enable='between(t,40,44)'[v];[3]volume='if(between(t,10,14)+between(t,40,44),0.5,0)':eval=frame[au]" \
  -map "[v]" -map "[au]" -t 60 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 1M -c:a libopus "$out/autocut.mp4"
# HDR: 3s of flat 75% grey as a 10-bit HLG / BT.2020 signal (HLG reference white). Tone-mapped it should export
# near white; shown raw it would stay mid-grey ("washed out").
ffmpeg -v error -y -f lavfi -i "color=c=0xBFBFBF:size=360x640:rate=30:duration=3" -f lavfi -i "sine=frequency=500:sample_rate=48000:duration=3" \
  -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc \
  -c:v libvpx-vp9 -profile:v 2 -deadline realtime -cpu-used 8 -b:v 1M -c:a libopus "$out/hlg.mp4"
echo "fixtures written to $out"
