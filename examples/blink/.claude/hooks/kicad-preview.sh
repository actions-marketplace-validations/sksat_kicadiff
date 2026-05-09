#!/usr/bin/env bash
# Claude Code の PostToolUse hook 例。
# .kicad_pcb / .kicad_sch ファイルを Edit / Write するたびに kicadiff を
# 走らせて、HTML プレビュー (および画像) を再生成する。stdout は
# Claude へのフィードバックとして読まれるので、Claude が直後に Read で
# 生成された PNG / HTML を確認できる。
set -euo pipefail

# stdin から PostToolUse JSON を読み取り、編集されたファイルパスを抽出。
INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('tool_input', {}).get('file_path', ''))
" 2>/dev/null) || {
  echo "Error: failed to parse hook input JSON" >&2
  exit 1
}

# KiCad ファイル以外は即終了 (他のファイル編集には触らない)。
case "$FILE_PATH" in
  *.kicad_pcb|*.kicad_sch) ;;
  *) exit 0 ;;
esac

# 絶対パスに変換。
if [[ "$FILE_PATH" != /* ]]; then
  FILE_PATH="$(pwd)/$FILE_PATH"
fi

[[ -f "$FILE_PATH" ]] || exit 0

# kicadiff CLI に委譲。examples/blink/ は kicadiff repo の中にあるので、
# git toplevel を辿るとリポジトリルートにある `kicadiff` 実行ファイルが
# 見つかる。--open vscode で VSCode の Live Preview にタブが自動で開く。
# kicadiff の中身は TypeScript で shebang (`#!/usr/bin/env bun`) で Bun が
# 実行する。bash で包むと TS をシェルとして parse して即座に失敗するので、
# 実行可能ファイルとして直接 exec する。
REPO_ROOT=$(git -C "$(dirname "$FILE_PATH")" rev-parse --show-toplevel)
exec "$REPO_ROOT/kicadiff" "$FILE_PATH" --open vscode
