# kicadiff Design Doc

## ゴール

KiCad プロジェクトの「ある状態」と「別の状態」(コミット間 / コミット
vs 作業ツリーなど) の差分を、人間が視覚的に確認できる形で出力する。
`git diff` のテキスト出力では PCB / 回路図の変更がほぼ読めないので、
それを補完する。

副次的な目標として:

- PR description / commit message にそのまま貼れる markdown レポート
- 構造的な (component 単位の) 差分を機械可読な形 (テキスト) でも出す
- Claude Code の PostToolUse hook から呼べるように、CLI として安定
  したインターフェイスを提供する

## ランタイム依存の縮約

最終的にエンドユーザーが `kicad-cli` だけ持っていれば動く状態を
目指している。理由は次のとおり:

- KiCad ファイルを実際に解釈・描画するのは kicad-cli の責務であり、
  これは外部に出せない (KiCad 本体の機能に依存)。
- 一方 `rsvg-convert` / ImageMagick は SVG ラスタライズと画像比較
  という汎用処理であり、ライブラリで置換可能。
- standalone バイナリを `bun build --compile` で配布する想定なので、
  ランタイムには Bun も Node も入れなくて済む。kicad-cli さえあれば
  OK、という体験にしたい。

現状の依存と置換計画:

| 依存             | 置換                                       | 状態   |
|------------------|---------------------------------------------|--------|
| kicad-cli        | (置換しない)                               | 維持   |
| Bun              | `bun build --compile` で binary に内包      | OK     |
| `rsvg-convert`   | `@resvg/resvg-wasm` 等の in-process WASM   | TODO   |
| `magick compare` | `pixelmatch` + `pngjs` の純 JS 比較        | TODO   |

WASM ラスタライザに置換すると Bun の `--compile` でバイナリ内に
完全に取り込めるので、配布 binary 1 つだけで動く構成になる。

## アーキテクチャ概観

```
                   ┌─ kicad-cli pcb export svg ─┐
入力ファイル ───┤   ├──── rsvg-convert ──→ PNG ──┐
(.kicad_pcb 等)    │   │                            ├──→ Manifest (JSON)
   ↓               │                                │       │
git ref に対応する │           render cache         │       │
content を取り出し │ (~/.cache/kicadiff/<hash>/)    │       ↓
                                                       viewer.html
                                                       (HTML inline)
                                                            │
                                                            ↓
                                                       Markdown report
                                                       Text report
```

レンダリングは外部ツール (kicad-cli, rsvg-convert, optionally
ImageMagick) に丸投げし、kicadiff は orchestration とキャッシュと
出力フォーマットの統合を担当する。

## 出力フォーマット

| flag             | HTML | 画像 | Markdown | Text |
|------------------|------|------|----------|------|
| (なし)           | ✓    | ✓    |          |      |
| `--md`           |      | ✓    | ✓        |      |
| `--text`         | ✓    | ✓    |          | ✓    |
| `--text-only`    |      |      |          | ✓    |
| `--images-only`  |      | ✓    |          |      |

### Markdown レポート

`--md` 時は HTML を作らず markdown ファイル (`<safe>_diff.md`) を
書く。中身は file ごとに「heading + side-by-side 画像テーブル + 構造
差分」。画像パスは markdown ファイルの dir に対する相対なので、
ファイルを移動 / コピーしても link が壊れない。

`--output -` または `--output stdout` で stdout に出力。このとき
ステータスログは stderr に流す (リダイレクトでファイルが汚れない
ため)。

### 構造的なテキスト / Markdown 差分

`textdiff.ts` が S-expression を最小限パースし、`(footprint ...)` /
`(symbol ...)` ブロックを抽出して reference designator を identity
として diff する。出力例:

```
foo.kicad_pcb (pcb): +0 -0 ~3 =42
  ~ R1  value: 330 → 470
  ~ C5  value: 100nF → 220nF
  ~ U1  pos: 100.00,50.00 → 105.00,50.00
```

`+` 追加、`-` 削除、`~` 変更、`=` 変更なし。markdown 版はこれを
`### Added` / `### Removed` / `### Changed` のリストとして整形する。

## CLI 引数の解析

`git diff` 互換のために単純な flag-only パーサーは使わず、自前で
positional argument を分類する:

- 識別: subcommand (`pcb` 等) → scope を限定
- 識別: `--from` / `--to` / `--output` などの flag
- 残りの positional から `isLikelyInput()` で input を逆引き
  (拡張子 / `/` の有無で判定)
- 残りの positional は ref と見做し、`<r1>..<r2>` 記法を expand
- ref は `git rev-parse --verify` で先に validate

`--` separator で input と ref を明示分離することも可能 (git と同じ)。

## ビューア (`viewer.html`)

意図的に 1 ファイル。HTML / CSS / JS を全部内包する。
`scripts/embed-viewer.mjs` がビルド時に `src/viewer-content.ts` に
inline 文字列として注入し、Bun コンパイル後のバイナリにも入る。

### 表示モード

| Mode         | 説明                                            | before 必要? |
|--------------|------------------------------------------------|--------------|
| Overlay      | before と after を重ね、opacity slider でブレンド | ◯ (デフォルト) |
| Side by Side | 横に並べて表示。スクロール同期                  | (after 単体可) |
| Swipe        | divider の clip-path で before/after を切替    | ◯           |

before がないときは Side by Side が自動選択され、Overlay / Swipe は
controls bar / divider を出さず after 1 枚を表示する。

### Zoom と Pan

- Wheel: cursor 位置を支点に zoom (CAD ツールと同じセマンティクス)
- 右クリックドラッグ: pan (左クリックは layer row / divider などの
  UI 操作のため温存)
- スクロールバー: 通常通り pan として機能

zoom は CSS variable (`--zoom`) として root に設定し、layer-stack /
compare-wrap の width が `calc(var(--zoom,1) * 100%)` で連動する。
これにより content の layout box が拡大し、scrollbar が自然に出る。
`transform: scale()` を使わないのは、scrollWidth が transformed size
を反映しないため pan が壊れるから。

### 差分マーカー

- file タブ: `FileManifest.hasDiff === true` のとき琥珀色
- page タブ: `SchPage.hasDiff === true` のとき琥珀色
- diff overlay (赤いハイライト): pulse animation で目に留まる、デフォルト
  ON (チェックボックスでオフ可)

## マニフェスト

ビューアに渡す JSON。HTML 内に
`<script>window.MANIFEST = {...}</script>` として inline される。

```ts
ProjectManifest {
  files: FileManifest[];
}

FileManifest {
  file: string;          // repo-relative path
  type: "pcb" | "sch" | "sym" | "fp";
  hasBefore: boolean;
  hasDiff?: boolean;     // before/after combined PNG が byte 単位で違うか
  fromRef?: string;      // 比較元の ref (default: "HEAD")
  toRef?: string;        // 比較先の ref ("" = working tree)
  after: SideManifest;
  before?: SideManifest; // hasBefore のときのみ
  diff?: string;         // 差分ハイライト PNG (ImageMagick の出力)
}

SideManifest {
  combined: string;            // 主画像
  layers?: Record<string, string>;  // pcb のみ
  pages?: SchPage[];           // sch / sym / fp
}

SchPage {
  name: string;
  png: string;
  hasDiff?: boolean;     // before/after の同名 page で PNG が違うか
}
```

`hasDiff` は **テキストの差異ではなく視覚的な差異** を表す。例えば
PCB の silkscreen に出ない property の値だけ変わっても hasDiff=false
になる。これにより「diff ありますよ」マーカーがノイズで光らない。

## 4 つのファイル型

KiCad は複数の関連ファイル型を持つ。kicadiff は以下を扱う:

| 型     | 拡張子        | 中身                           | レンダリング単位       |
|--------|---------------|--------------------------------|------------------------|
| `pcb`  | `.kicad_pcb`  | 基板配置 + 埋め込みフットプリント | レイヤー (5 種類) ごと |
| `sch`  | `.kicad_sch`  | 回路図 + 埋め込みシンボル       | 階層シートごと          |
| `sym`  | `.kicad_sym`  | シンボルライブラリ              | シンボルごと            |
| `fp`   | `.kicad_mod`  | 単一フットプリント              | 1 個                    |

KiCad 6+ では `.kicad_pcb` / `.kicad_sch` には参照しているシンボル /
フットプリントの定義が embed されているので、`.kicad_sym` /
`.kicad_mod` のライブラリが手元になくてもレンダリングできる。これが
content-hash キャッシュの妥当性の根拠 (詳細は後述)。

`.pretty/` ディレクトリ入力は中の各 `.kicad_mod` を独立した file タブ
として扱う。

### 4 型を pages として統一

ビューアは以下の概念で統一されている:

- **file**: 1 ファイル = 1 file タブ。複数渡されたとき file タブが並ぶ
- **page**: file 内の選択可能な単位
  - sch: 階層シート (root + 子シート)
  - sym: ライブラリ内の各シンボル
  - fp: 通常 1 個 (内部的には pages = [{name, png}])
  - pcb: pages 概念なし (代わりに layer)
- **layer**: PCB のレイヤー (F.Cu, B.Cu, F.Silkscreen, B.Silkscreen, Edge.Cuts)

manifest 上は file が `after.pages[]` を持つかどうかで page 切替の
有無が決まる。

## レンダリングパイプライン

各 side (before / after) を独立に並列レンダリングする。各 side は:

1. ソース取得
   - 作業ツリー: ファイルをそのまま使う
   - git ref: `git show ${ref}:${path}` の出力を temp file
     (`preview_<rand>.<ext>`) として元ファイルの隣に書く
2. キャッシュ確認 (詳細は次節)
3. ヒットしなければ:
   - kicad-cli で SVG 生成
   - rsvg-convert で PNG 生成
4. キャッシュへ保存
5. (オプション) ImageMagick `magick compare` で差分ハイライト PNG

before と after が完了したら manifest に組み立て、HTML / markdown に
inline する。

### temp file の lifecycle

git ref から render するとき、kicad-cli は on-disk のファイルパスを
要求する。一方 kicad-cli は input と同じ basename の sibling
`.kicad_prl` を勝手に作る。これを残すと:

1. 作業ツリーが汚染される (preview_*.kicad_prl が増え続ける)
2. キャッシュキーが churn する (`.kicad_prl` をキー材料に含めるため)
3. `.pretty/` 入力の場合、kicad-cli がライブラリスキャン時に
   余分な `.kicad_mod` (= 我々の temp) を見つけて衝突する

そこで:

- temp file の作成は `O_EXCL` でアトミック (race 対策)
- `finally` で temp と sibling `.kicad_prl` を必ず unlink
- `resolveInputs` の `.pretty/` スキャンは `preview_*.kicad_mod` を
  防御的に除外
- フットプリントの場合は元の lib ディレクトリではなく、render
  ごとに作る隔離 lib (`<pagesDir>/lib.pretty/`) で kicad-cli を
  実行する。並列レンダリングで他の render の temp が衝突するのを
  避けるため

## キャッシュ

レンダリングは数秒〜数十秒かかるが、入力が同じなら結果も同じになる
ように設計されている。それを利用して content-addressed なキャッシュ
を持つ。

### キャッシュキーの構成

```
sha256(
  schema_version          # bump で全 invalidate
  + kicad-cli --version   # kicad-cli の挙動が変わったとき切り替わる
  + file_type             # pcb/sch/sym/fp で別 entry
  + abs_file_path         # 同 content でも path が違えば別 entry
  + sibling .kicad_pro / .kicad_prl content (pcb/sch のみ)
  + source_content
)
```

#### なぜ abs_file_path も含めるか

**原則として content が同じなら結果も同じ** だが、KiCad は project-
level の設定 (theme, variant など) を `.kicad_pro` / `.kicad_prl`
から拾う。同じ内容のファイルが別ディレクトリに置かれていて、その
ディレクトリの project 設定が違うと、レンダリング結果も変わりうる。

そこで「保守的に: path が違ったら別 entry」とした。これにより
sibling project files の差異も自動的に分岐に反映される (path の
ハッシュ値が違うので別エントリになる)。同時に sibling の content も
ハッシュキーに足しているので、project 設定だけ変わってもキャッシュは
追従する。

#### preview_*.kicad_prl の扱い

過去の crash run の残骸として `preview_*.kicad_prl` が残っていると、
これがキャッシュキーに混入してキャッシュが churn する。`cacheKeyFor`
は `preview_*.kicad_prl` を sibling fingerprint から除外することで
defensive に処理している。

### キャッシュレイアウト

```
<KICADIFF_CACHE_DIR>/
  <hash[0:2]>/          # 先頭 2 文字でディレクトリを分けて hot dir 回避
    <hash[2:]>/
      combined.png      # primary 画像 (PCB combined / sch root / sym 1st)
      extras/           # type 依存
        <layer>.png     # pcb の場合: F_Cu.png, B_Cu.png, ...
        <page>.png      # sch / sym / fp の場合
```

cache hit 時は `combined.png` を `<sideDir>/<safe>.png` に、`extras/`
の中身を type 別の dir (`layers_<safe>/` / `sch_pages_<safe>/` /
`items_<safe>/`) に展開する。

cache miss 時はレンダリング → 結果をキャッシュへ書き戻す (best-effort、
失敗しても render 自体は成功扱い)。
