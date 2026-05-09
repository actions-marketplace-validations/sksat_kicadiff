# kicadiff

KiCad プロジェクト用の visual diff ツール。`.kicad_pcb` /
`.kicad_sch` / `.kicad_sym` / `.kicad_mod` のあるバージョン間の変更を
ブラウザで視覚的に確認したり、PR に貼れる markdown レポートとして
出力したりできる。

[English README](./README.md)

## 提供する機能

- **HTML ビューア** — Side-by-Side / Overlay / Swipe の3表示モード、
  PCB のレイヤー切替、階層回路図のページナビ、ホイールズーム + 右
  クリックドラッグでパン、視覚的に変更があったタブ・ページに琥珀色の
  マーカー。
- **Markdown レポート** (`--md`) — side-by-side の画像テーブルと、
  Reference designator 単位の構造差分 (追加 / 削除 / 変更)。PR の
  description や commit message に貼るのに適している。
- **テキスト構造差分** (`--text-only`) — 画像レンダリングなし、stdout
  に出力するので高速。

## 必要なもの

最終的には `kicad-cli` だけをランタイム依存にしたい。現状はまだ
`rsvg-convert` / ImageMagick も transient な依存として必要 (`DESIGN.md`
の「ランタイム依存の縮約」を参照)。

- [`kicad-cli`](https://www.kicad.org/) 9.x 以降 (レンダリングエンジン)
- `librsvg` パッケージの `rsvg-convert` コマンド (SVG → PNG;
  in-process な WASM ラスタライザに置換予定)
- ImageMagick の `magick` コマンド (差分ハイライト; optional, 置換予定)
- [Bun](https://bun.sh) — shebang から TypeScript の CLI を直接実行する。
  standalone binary をコンパイルするのも Bun なので、Node を別途用意
  する必要はない。

## 使い方

`git diff` と同じ位置引数の形を踏襲しつつ、ファイル型を限定したい
ときのために subcommand がある。

```sh
# プロジェクト全体の diff (cwd 内、PCB と schematic 両方、デフォルトは HEAD vs working tree)
kicadiff

# プロジェクトディレクトリ / .kicad_pro / 単一の KiCad ファイルを渡す
kicadiff path/to/project/
kicadiff project.kicad_pro
kicadiff project.kicad_pcb

# 任意の ref を比較
kicadiff main path/to/project/         # working tree vs main
kicadiff v1.0 v2.0 board.kicad_pcb     # v1.0 vs v2.0
kicadiff main..feat foo.kicad_pcb      # range syntax
kicadiff main -- foo.kicad_pcb         # 明示的な `--` separator

# Subcommand でファイル型を限定 (sibling の自動検出を無効化)
kicadiff pcb foo.kicad_pcb
kicadiff sch foo.kicad_sch       # alias: schematic
kicadiff sym lib.kicad_sym       # alias: symbol
kicadiff fp foo.kicad_mod        # alias: footprint
kicadiff fp lib.pretty           # .pretty/ ディレクトリ全体

# 出力形式
kicadiff project/                       # デフォルト: HTML ビューア + 画像
kicadiff project/ --md                  # markdown レポート + 画像、HTML なし
kicadiff project/ --md --output report.md
kicadiff project/ --md --output -       # markdown を stdout に、ログは stderr に
kicadiff project/ --text                # 構造テキスト差分も出力
kicadiff project/ --text-only           # テキストのみ、レンダリングなし (高速)
kicadiff project/ --images-only         # PNG だけ、HTML / markdown なし

# HTML を VSCode (Live Preview) やブラウザで自動オープン
kicadiff project/ --open vscode
kicadiff project/ --open firefox
kicadiff project/ --open=/usr/bin/open  # 任意のコマンド

# その他
kicadiff project/ -v                    # PNG パスまで出すサマリ
kicadiff project/ -q                    # サマリ抑止
kicadiff project/ --no-cache            # キャッシュをバイパス
```

## 出力先

デフォルトでは git ルート直下の `.claude/preview/` に出す (見つけやすい
位置)。`--output-dir <dir>` で画像ディレクトリを上書き、`--output <path>`
で HTML / markdown の出力パスを変える (中の画像パスは出力ファイルの
ディレクトリに対する相対パスに自動で書き換えられるので、ファイルを
コピーしても壊れない)。

HTML ビューアはマニフェストと画像参照を全部 inline にした 1 ファイル
なので、メールに添付したり、static asset として hosting したり、
ローカルなら VSCode の Live Preview 拡張で開いたりできる。

## レンダリングキャッシュ

各 side のレンダリング結果を content-addressed で
`$XDG_CACHE_HOME/kicadiff` (または `~/.cache/kicadiff`) に
キャッシュする。同じ内容に対する再実行はコールドの ~5 秒に対して
~1 秒で返る。`--no-cache` で無効化、`KICADIFF_CACHE_DIR` で位置を
上書きできる。

## さらに詳しく

- `DESIGN.md` — アーキテクチャ、レンダリングパイプライン、キャッシュ
  キーの構成、マニフェスト schema、ビューア表示モードのセマンティクス
- `examples/blink/` — テスト fixture 兼サンプルプロジェクト (最小構成)。
  `.kicad_pcb` / `.kicad_sch` を編集するたびに kicadiff を走らせて
  プレビューを更新する Claude Code の PostToolUse hook (`.claude/`)
  を同梱している
