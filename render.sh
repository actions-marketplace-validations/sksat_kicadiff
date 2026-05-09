#!/usr/bin/env bash
# kicad-diff-viewer/render.sh
#
# KiCad ファイルの Before/After ビジュアルプレビューを生成するスタンドアロンツール。
# Claude Code の PostToolUse hook から呼ばれるほか、直接実行も可能。
#
# Usage:
#   render.sh <kicad_file_path> [--output-dir <dir>] [--images-only]
#
# 依存ツール:
#   - kicad-cli (KiCad 10+): SVG エクスポート
#   - rsvg-convert (librsvg): SVG → PNG 変換
#   - magick (ImageMagick 7+): 差分ハイライト画像生成 (optional)
#   - python3: マニフェスト JSON 生成
#
# 出力:
#   - <output-dir>/after/  : 編集後の combined + per-layer PNG
#   - <output-dir>/before/ : git HEAD からの combined + per-layer PNG
#   - <output-dir>/diff/   : ImageMagick compare による差分ハイライト
#   - <output-dir>/<name>_diff.html : viewer.html にマニフェストを注入した HTML

set -euo pipefail

VIEWER_DIR="$(cd "$(dirname "$0")" && pwd)"

# =============================================================================
# 依存ツールチェック
# =============================================================================
for cmd in kicad-cli rsvg-convert python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command not found: $cmd" >&2
    exit 1
  fi
done

# =============================================================================
# 引数パース
# =============================================================================
FILE_PATH="${1:-}"
OUTPUT_DIR=""
IMAGES_ONLY=false

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      if [[ $# -lt 2 ]]; then
        echo "Error: --output-dir requires a value" >&2
        exit 1
      fi
      OUTPUT_DIR="$2"; shift 2
      ;;
    --images-only) IMAGES_ONLY=true; shift ;;
    *)
      echo "Warning: unknown option: $1" >&2
      shift
      ;;
  esac
done

if [[ -z "$FILE_PATH" ]]; then
  echo "Usage: render.sh <kicad_file_path> [--output-dir <dir>] [--images-only]" >&2
  exit 1
fi

# ファイルタイプ判定
case "$FILE_PATH" in
  *.kicad_pcb) FILE_TYPE="pcb" ;;
  *.kicad_sch) FILE_TYPE="sch" ;;
  *)
    echo "Error: not a KiCad file: $FILE_PATH" >&2
    exit 1
    ;;
esac

# 絶対パスに変換
if [[ "$FILE_PATH" != /* ]]; then
  FILE_PATH="$(pwd)/$FILE_PATH"
fi

if [[ ! -f "$FILE_PATH" ]]; then
  echo "Error: file not found: $FILE_PATH" >&2
  exit 1
fi

# リポジトリルートと相対パスを取得
REPO_ROOT=$(git -C "$(dirname "$FILE_PATH")" rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -n "$REPO_ROOT" ]]; then
  REL_PATH="${FILE_PATH#$REPO_ROOT/}"
else
  REL_PATH="$(basename "$FILE_PATH")"
fi

# 出力ディレクトリ（デフォルト: .claude/preview）
if [[ -z "$OUTPUT_DIR" ]]; then
  if [[ -n "$REPO_ROOT" ]]; then
    OUTPUT_DIR="$REPO_ROOT/.claude/preview"
  else
    OUTPUT_DIR="/tmp/kicad-diff-preview"
  fi
fi
mkdir -p "$OUTPUT_DIR/before" "$OUTPUT_DIR/after"

# ファイル名をサニタイズ（英数字・ドット・ハイフン・アンダースコア以外を _ に置換）
# glob 展開やシェル特殊文字（$, `, [, ] 等）を含むパスでも安全に扱えるようにする
SAFE_NAME=$(echo "$REL_PATH" | sed 's/[^a-zA-Z0-9._-]/_/g')

AFTER_SVG="$OUTPUT_DIR/after/${SAFE_NAME}.svg"
AFTER_PNG="$OUTPUT_DIR/after/${SAFE_NAME}.png"
BEFORE_SVG="$OUTPUT_DIR/before/${SAFE_NAME}.svg"
BEFORE_PNG="$OUTPUT_DIR/before/${SAFE_NAME}.png"

# エクスポート対象レイヤー
PCB_LAYERS="F.Cu,B.Cu,F.Silkscreen,B.Silkscreen,Edge.Cuts"

# =============================================================================
# 一時ファイルのクリーンアップ用 trap
# kicad-cli 失敗時等にゴミが残らないようにする
# =============================================================================
TEMP_BEFORE=""
cleanup() {
  if [[ -n "$TEMP_BEFORE" && -f "$TEMP_BEFORE" ]]; then
    rm -f "$TEMP_BEFORE"
  fi
}
trap cleanup EXIT

# =============================================================================
# レンダリング関数
# =============================================================================

# PCB 全レイヤー結合画像
# stdout は進捗メッセージ("Plotted to ...")なので抑制、stderr は診断用に通す
render_pcb() {
  local input="$1" output_svg="$2"
  kicad-cli pcb export svg \
    --mode-single \
    --layers "$PCB_LAYERS" \
    --page-size-mode 2 \
    --exclude-drawing-sheet \
    -o "$output_svg" \
    "$input" >/dev/null
}

# PCB レイヤー別画像（--mode-multi で一括エクスポート）
# 各レイヤーは透過 PNG として生成され、viewer.html 上でスタック表示される
render_pcb_layers() {
  local input="$1" output_dir="$2"
  mkdir -p "$output_dir"
  kicad-cli pcb export svg \
    --mode-multi \
    --layers "$PCB_LAYERS" \
    --page-size-mode 2 \
    --exclude-drawing-sheet \
    -o "$output_dir/" \
    "$input" >/dev/null
  # SVG → PNG 変換（RGBA で透過を維持）
  for svg in "$output_dir"/*.svg; do
    [[ -f "$svg" ]] || continue
    rsvg-convert -w 1600 "$svg" -o "${svg%.svg}.png"
  done
}

render_sch() {
  local input="$1" output_dir="$2" output_svg="$3"
  kicad-cli sch export svg \
    --exclude-drawing-sheet \
    --no-background-color \
    -o "$output_dir" \
    "$input" >/dev/null

  # kicad-cli sch export svg は出力ファイル名を入力ファイル名から自動決定するのでリネーム
  local base_name
  base_name=$(basename "$input" .kicad_sch)
  local generated="$output_dir/${base_name}.svg"
  if [[ -f "$generated" && "$generated" != "$output_svg" ]]; then
    mv "$generated" "$output_svg"
  fi
}

svg_to_png() {
  local svg="$1" png="$2"
  if [[ -f "$svg" ]]; then
    rsvg-convert -w 1600 "$svg" -o "$png"
  fi
}

# =============================================================================
# After 状態のレンダリング（現在のファイル）
# =============================================================================
if [[ "$FILE_TYPE" == "pcb" ]]; then
  render_pcb "$FILE_PATH" "$AFTER_SVG"
  render_pcb_layers "$FILE_PATH" "$OUTPUT_DIR/after/layers_${SAFE_NAME}"
else
  render_sch "$FILE_PATH" "$OUTPUT_DIR/after" "$AFTER_SVG"
fi

svg_to_png "$AFTER_SVG" "$AFTER_PNG"

if [[ ! -f "$AFTER_PNG" ]]; then
  echo "Error: failed to render $FILE_PATH" >&2
  exit 1
fi

# =============================================================================
# Before 状態のレンダリング（git HEAD から取得）
# 一時ファイルは元ファイルと同じディレクトリに置く。
# /tmp だと .kicad_pro や fp-lib-table の相対パス参照が解決できないため。
# mktemp を使い、予測可能なファイル名による symlink 攻撃を防ぐ。
# =============================================================================
HAS_BEFORE=false
if [[ -n "$REPO_ROOT" ]] && git -C "$REPO_ROOT" cat-file -e "HEAD:$REL_PATH" 2>/dev/null; then
  # mktemp で一時ファイルを作成（同ディレクトリ内、拡張子を維持）
  # テンプレート引数のみ使用（--suffix と併用不可）。XXXXXX は末尾に配置。
  # 拡張子は kicad-cli がファイルタイプを判定するために必要。
  TEMP_BEFORE=$(mktemp -p "$(dirname "$FILE_PATH")" "preview_XXXXXX.${FILE_PATH##*.}")
  git -C "$REPO_ROOT" show "HEAD:$REL_PATH" > "$TEMP_BEFORE"

  if [[ "$FILE_TYPE" == "pcb" ]]; then
    render_pcb "$TEMP_BEFORE" "$BEFORE_SVG"
    render_pcb_layers "$TEMP_BEFORE" "$OUTPUT_DIR/before/layers_${SAFE_NAME}"
  else
    render_sch "$TEMP_BEFORE" "$OUTPUT_DIR/before" "$BEFORE_SVG"
  fi

  rm -f "$TEMP_BEFORE"
  TEMP_BEFORE=""

  if [[ -f "$BEFORE_SVG" ]]; then
    svg_to_png "$BEFORE_SVG" "$BEFORE_PNG"
    HAS_BEFORE=true
  fi
fi

# =============================================================================
# 差分ハイライト画像（ImageMagick compare）
# Before/After の合成画像を比較し、変化したピクセルを赤く強調する。
# viewer.html 上で mix-blend-mode:multiply のオーバーレイとして表示される。
# =============================================================================
DIFF_PNG=""
if [[ "$HAS_BEFORE" == "true" ]] && command -v magick >/dev/null 2>&1; then
  mkdir -p "$OUTPUT_DIR/diff"
  DIFF_PNG="$OUTPUT_DIR/diff/${SAFE_NAME}.png"
  magick compare -fuzz 5% \
    -highlight-color "#ff000088" -lowlight-color "transparent" \
    -compose src \
    "$BEFORE_PNG" "$AFTER_PNG" "$DIFF_PNG" 2>/dev/null || true
fi

# --images-only: 画像生成のみで終了（HTML 生成・VSCode オープンをスキップ）
if [[ "$IMAGES_ONLY" == "true" ]]; then
  echo "Images updated: $OUTPUT_DIR"
  echo "  After:  $AFTER_PNG"
  [[ "$HAS_BEFORE" == "true" ]] && echo "  Before: $BEFORE_PNG"
  [[ -n "$DIFF_PNG" && -f "$DIFF_PNG" ]] && echo "  Diff:   $DIFF_PNG"
  exit 0
fi

# =============================================================================
# マニフェスト JSON 生成
# viewer.html が読み込むデータ。画像パスはすべて HTML からの相対パス。
# 変数は sys.argv 経由で渡し、シェル変数のコード注入を防ぐ。
# =============================================================================
MANIFEST=$(python3 - "$SAFE_NAME" "$FILE_TYPE" "$HAS_BEFORE" "$OUTPUT_DIR" "$DIFF_PNG" "$REL_PATH" <<'PYEOF'
import json, glob, os, sys

safe = sys.argv[1]
file_type = sys.argv[2]
has_before = sys.argv[3] == 'true'
output_dir = sys.argv[4]
diff_png = sys.argv[5]
rel_path = sys.argv[6]

def layer_map(layers_dir, side):
    result = {}
    if not os.path.isdir(layers_dir):
        return result
    for png in sorted(glob.glob(os.path.join(layers_dir, '*.png'))):
        fname = os.path.basename(png).replace('.png', '')
        # BoardName-F_Cu -> F.Cu
        layer = fname.rsplit('-', 1)[-1].replace('_', '.')
        rel = f'{side}/layers_{safe}/{os.path.basename(png)}'
        result[layer] = rel
    return result

m = {
    'file': rel_path,
    'type': file_type,
    'hasBefore': has_before,
    'after': {
        'combined': f'after/{safe}.png',
        'layers': layer_map(os.path.join(output_dir, f'after/layers_{safe}'), 'after')
    }
}

if has_before:
    m['before'] = {
        'combined': f'before/{safe}.png',
        'layers': layer_map(os.path.join(output_dir, f'before/layers_{safe}'), 'before')
    }

if diff_png and os.path.isfile(diff_png):
    m['diff'] = f'diff/{safe}.png'

print(json.dumps(m))
PYEOF
)

# =============================================================================
# HTML 生成（viewer.html テンプレートにマニフェストを注入）
# </script> が JSON 内に含まれるケースに備え、</ をエスケープする
# =============================================================================
DIFF_HTML="$OUTPUT_DIR/${SAFE_NAME}_diff.html"
ESCAPED_MANIFEST=$(printf '%s' "$MANIFEST" | sed 's|</|<\\/|g')
{
  echo "<script>window.MANIFEST = $ESCAPED_MANIFEST;</script>"
  cat "$VIEWER_DIR/viewer.html"
} > "$DIFF_HTML"

# VSCode で HTML を開く（Live Preview ボタンでプレビュー可能）
{
  if command -v code >/dev/null 2>&1; then
    code -r "$DIFF_HTML"
  fi
} 2>/dev/null &

# =============================================================================
# stdout 出力（Claude Code の PostToolUse hook からはフィードバックとして読まれる）
# =============================================================================
echo "KiCad preview rendered: $REL_PATH"
if [[ -f "$AFTER_PNG" ]]; then
  echo "  After:  $AFTER_PNG"
fi
if [[ "$HAS_BEFORE" == "true" ]]; then
  echo "  Before: $BEFORE_PNG"
  echo ""
  echo "Read both PNG files to visually compare the before/after state of your edit."
  echo "Diff HTML: $DIFF_HTML (open with Live Preview in VSCode)"
else
  echo "  (New file — no before state in git)"
  echo ""
  echo "Read the PNG file to verify the visual result of your edit."
fi
