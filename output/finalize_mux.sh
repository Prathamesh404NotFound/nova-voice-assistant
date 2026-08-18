#!/usr/bin/env bash
# Render all scenes at 1080p60, then mux each scene's narration WAV onto
# its own clip and concatenate into a final video with audio.
set -euo pipefail
CODE="$1"; MEDIA="$2"; FINAL="$3"; shift 3
# remaining args: path-to-scene1.wav path-to-scene2.wav ... (same order as scene classes)

HQ="${MEDIA}/videos/video/1080p60"
manim -qh --write_all --media_dir "$MEDIA" "$CODE"

WAVS=("$@")
i=0
MUTED=()
AUDIO_MUXED=()
for f in "$HQ"/*.mp4; do
  [ -f "$f" ] || continue
  name="$(basename "$f" .mp4)"
  wav="${WAVS[$i]:-}"
  i=$((i + 1))
  out="${MEDIA}/${name}_withaudio.mp4"
  if [ -n "$wav" ] && [ -f "$wav" ]; then
    ffmpeg -y -hide_banner -loglevel error -i "$f" -i "$wav" \
      -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k \
      -af "apad" -shortest "$out"
  else
    cp "$f" "$out"
  fi
  AUDIO_MUXED+=("$out")
done

LIST="${MEDIA}/concat_mux.txt"
: > "$LIST"
for f in "${AUDIO_MUXED[@]}"; do
  echo "file '$(realpath "$f")'" >> "$LIST"
done
ffmpeg -y -hide_banner -loglevel error -f concat -safe 0 -i "$LIST" \
  -c copy "$FINAL"
rm -f "$LIST"
echo "FINAL: $(realpath "$FINAL")"
