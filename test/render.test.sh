#!/usr/bin/env bash
# Integration tests for render.sh
# Runs render.sh against PicoBridge PCB and verifies outputs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PROJECT_DIR/.." && pwd)"
RENDER="$PROJECT_DIR/render.sh"
KICAD_FILE="$REPO_ROOT/PicoBridge/pcb/PicoBridge.kicad_pcb"
OUTPUT_DIR=$(mktemp -d)
SAFE_NAME="PicoBridge_pcb_PicoBridge.kicad_pcb"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
assert() { if eval "$2"; then pass "$1"; else fail "$1 — $2"; fi; }

cleanup() { rm -rf "$OUTPUT_DIR"; }
trap cleanup EXIT

echo "=== render.sh integration tests ==="
echo "Output dir: $OUTPUT_DIR"
echo ""

# --- Run render.sh ---
echo "Running render.sh..."
cd "$REPO_ROOT"
bash "$RENDER" "$KICAD_FILE" --output-dir "$OUTPUT_DIR" >/dev/null 2>&1
echo ""

# --- After image ---
echo "[After images]"
assert "combined PNG exists" "[[ -f '$OUTPUT_DIR/after/${SAFE_NAME}.png' ]]"
assert "combined PNG size > 0" "[[ -s '$OUTPUT_DIR/after/${SAFE_NAME}.png' ]]"

# --- Per-layer images ---
echo "[Layer images]"
LAYERS_DIR="$OUTPUT_DIR/after/layers_${SAFE_NAME}"
for layer in F_Cu B_Cu F_Silkscreen B_Silkscreen Edge_Cuts; do
  found=$(ls "$LAYERS_DIR"/*-${layer}.png 2>/dev/null | head -1)
  assert "after layer $layer exists" "[[ -n '$found' && -f '$found' ]]"
done

# All layer PNGs have the same dimensions and RGBA mode
echo "[Layer PNG properties]"
DIMS=""
for png in "$LAYERS_DIR"/*.png; do
  info=$(python3 -c "from PIL import Image; img=Image.open('$png'); print(f'{img.size[0]}x{img.size[1]} {img.mode}')")
  if [[ -z "$DIMS" ]]; then
    DIMS="$info"
  fi
  assert "$(basename "$png") matches first layer ($DIMS)" "[[ '$info' == '$DIMS' ]]"
done
assert "layers are RGBA (transparent)" "[[ '$DIMS' == *RGBA* ]]"

# --- Before image ---
echo "[Before images]"
assert "before combined PNG exists" "[[ -f '$OUTPUT_DIR/before/${SAFE_NAME}.png' ]]"
BEFORE_LAYERS_DIR="$OUTPUT_DIR/before/layers_${SAFE_NAME}"
assert "before layers directory exists" "[[ -d '$BEFORE_LAYERS_DIR' ]]"

# --- Before/After identity (file is unchanged) ---
echo "[Before/After identity]"
for after_png in "$LAYERS_DIR"/*.png; do
  layer_suffix=$(basename "$after_png" | sed 's/.*-//')
  before_png=$(ls "$BEFORE_LAYERS_DIR"/*-"$layer_suffix" 2>/dev/null | head -1)
  if [[ -n "$before_png" && -f "$before_png" ]]; then
    after_md5=$(md5sum "$after_png" | cut -d' ' -f1)
    before_md5=$(md5sum "$before_png" | cut -d' ' -f1)
    assert "layer $layer_suffix: before == after" "[[ '$after_md5' == '$before_md5' ]]"
  fi
done

# --- Diff highlight ---
echo "[Diff highlight]"
assert "diff PNG exists" "[[ -f '$OUTPUT_DIR/diff/${SAFE_NAME}.png' ]]"

# --- HTML output ---
echo "[HTML output]"
DIFF_HTML="$OUTPUT_DIR/${SAFE_NAME}_diff.html"
assert "diff HTML exists" "[[ -f '$DIFF_HTML' ]]"
assert "HTML contains MANIFEST" "grep -q 'window.MANIFEST' '$DIFF_HTML'"
assert "HTML contains viewer content" "grep -q 'KiCad Diff' '$DIFF_HTML'"

# --- Manifest JSON validation ---
echo "[Manifest JSON]"
MANIFEST=$(sed -n 's/.*window.MANIFEST = \(.*\);.*/\1/p' "$DIFF_HTML")
assert "manifest is valid JSON" "echo '$MANIFEST' | python3 -c 'import sys,json; json.load(sys.stdin)' 2>/dev/null"

# Check manifest keys
echo "$MANIFEST" | python3 -c "
import sys, json
m = json.load(sys.stdin)
checks = [
    ('has file key', 'file' in m),
    ('has type=pcb', m.get('type') == 'pcb'),
    ('has hasBefore=true', m.get('hasBefore') == True),
    ('has after.combined', 'combined' in m.get('after', {})),
    ('has after.layers', len(m.get('after', {}).get('layers', {})) == 5),
    ('has before.combined', 'combined' in m.get('before', {})),
    ('has before.layers', len(m.get('before', {}).get('layers', {})) == 5),
    ('has diff key', 'diff' in m),
]
for name, ok in checks:
    print(f'  {\"PASS\" if ok else \"FAIL\"}: manifest {name}')
    if not ok:
        sys.exit(1)
" && PASS=$((PASS+8)) || FAIL=$((FAIL+1))

# --- Non-KiCad file rejection ---
echo "[Error handling]"
TMPFILE=$(mktemp --suffix=.txt)
if bash "$RENDER" "$TMPFILE" --output-dir "$OUTPUT_DIR" 2>/dev/null; then
  fail "should reject non-KiCad file"
else
  pass "rejects non-KiCad file"
fi
rm -f "$TMPFILE"

# --- Custom output dir ---
echo "[--output-dir]"
CUSTOM_DIR=$(mktemp -d)
bash "$RENDER" "$KICAD_FILE" --output-dir "$CUSTOM_DIR" >/dev/null 2>&1
assert "output in custom dir" "[[ -f '$CUSTOM_DIR/${SAFE_NAME}_diff.html' ]]"
rm -rf "$CUSTOM_DIR"

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
