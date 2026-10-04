# Looking Glass Quilt Generator

複数の動画・静止画を奥行き（Z）付きで重ね、Looking Glass 用の quilt 動画を ffmpeg で書き出すデスクトップアプリ（Windows / macOS）。

A desktop app (Windows / macOS) that layers videos and images at different depths and exports quilt videos for Looking Glass displays using ffmpeg.

> 本ソフトウェアは Looking Glass Factory の公式製品ではありません。Looking Glass は Looking Glass Factory, Inc. の商標です。

## 必要なもの

- **ffmpeg / ffprobe**（同梱していません。各自インストールしてください）
  - Windows: `winget install Gyan.FFmpeg`
  - macOS: `brew install ffmpeg`
  - アプリが PATH と一般的なインストール先（winget / Chocolatey / Homebrew / MacPorts）から自動で探します。見つからない場合は「書き出し」タブ →「ffmpeg 設定」で指定できます。
- 実機で確認する場合: [Looking Glass Bridge](https://lookingglassfactory.com/software/looking-glass-bridge) 2.2 以降

## インストール

[Releases](../../releases) から入手してください。

| OS | ファイル |
| --- | --- |
| Windows | `...-Setup-x.y.z.exe`（インストーラー）/ `...-Portable-x.y.z.exe`（インストール不要） |
| macOS | `...-x.y.z-arm64.dmg`（Apple Silicon）/ `...-x.y.z-x64.dmg`（Intel） |

macOS 版は未署名です。初回は Finder でアプリを右クリック →「開く」で起動してください。

## 開発

```bash
npm install
npm start        # 起動
npm test         # 書き出しロジックのテスト（ffmpeg が必要）
npm run dist:win # Windows 版をビルド（dist/ に出力）
npm run dist:mac # macOS 版をビルド（macOS 上でのみ可能）
```

`v*` のタグを push すると、GitHub Actions（`.github/workflows/build.yml`）が Windows / macOS 版をビルドして Release の下書きに添付します。

## 使い方

1. 動画・静止画をウィンドウにドロップ（または「＋追加」）。音声だけのファイルは音声トラックとして設定されます。
2. 「素材」タブで各レイヤーの Z（奥行き）・位置・スケール・回転・不透明度・切り抜き・クロマキー・タイミングを調整。
3. 「全体」タブでデバイス（quilt 設定）、フォーカス Z、奥行き倍率、全体の尺、fps を設定。
4. 「音声」タブで、動画素材の音声を使うか別ファイルを使うかを選択。
5. 「書き出し」タブで「収録（書き出し）」。ファイル名に `_qs8x6a0.75` のような Looking Glass Studio 用の情報が付きます。

### 奥行き（Z）の考え方

- Z = 両端のビューでの横ずれ量（ビュー幅に対する %）。0 がスクリーン面、プラスが奥、マイナスが手前。
- 「フォーカス Z」に指定した Z の面がスクリーン面になります。
- 描画順は Z の大きい（奥の）ものから。同じ Z ならリストの上にあるものが手前。
- 背景用の静止画は「画面を覆う」＋「端の補正」をオンにすると、視差で端に隙間ができません。

### タイミング

| 項目 | 内容 |
| --- | --- |
| 開始時刻 | タイムライン上で素材が現れる時刻（タイムラインのバーをドラッグしても変更可） |
| 使用開始 / 使用終了 | 素材のどの区間を使うか |
| 終了後 | 消える / 最終フレームで静止 / 区間をループ |
| 全体の尺 | 一番長い素材 / 指定した素材 / 秒数指定 |

ループは区間ごとに入力を並べて concat するので、中間ファイルは作りません（区間が短く回数が多すぎる場合のみ素材全体のループになります）。

### 音声

- 「自動」: 元が AAC で加工（開始ずらし・トリム・音量・フェード・ループ）が無ければ無劣化コピー、それ以外は AAC 320kbps。
- ALAC（MP4）/ PCM 24bit（MOV）を選ぶと無劣化。ただし Looking Glass Studio で再生できるかは事前に確認してください。

### 映像形式

Looking Glass Bridge / Studio は NVIDIA GPU のハードウェアデコード（NVDEC）で quilt 動画を再生します。Bridge 2.6.3 で実測した結果:

| 形式 | Bridge での再生 |
| --- | --- |
| HEVC 4:2:0 8bit | 再生可（既定） |
| H.264 4:2:0 8bit | 再生可（4096px 以下のみ） |
| HEVC 10bit / ProRes | 不可（GPUs lack Hardware Acceleration） |
| HEVC / H.264 4:4:4 | Studio で緑色に崩れるため不可 |

エンコーダは GPU（Windows: NVENC / macOS: VideoToolbox・高速）と CPU（x264/x265・低速だが同容量でより高画質）を選べます。

※ macOS 版の Bridge がどの形式を再生できるかは未検証です。

**Studio 変換用（Portrait 本体へ転送する前提のマスター）**

Studio は本体へ転送するとき、レンチキュラー合成 → kvazaar（HEVC 4:2:0・約50Mbps）で再エンコードします。変換前に劣化させないよう「Studio変換用 HEVC ロスレス」（4:2:0 8bit、輝度は完全に無劣化）を用意しています（Studio 1.7.1 で読み込みを確認済み）。ProRes / HAP は Studio・Bridge が読み込めません。

実素材の quilt（3360×3360・3秒）を劣化なしの基準と比べた結果:

| 形式 | ビットレート | PSNR (Y) | SSIM |
| --- | --- | --- | --- |
| HEVC ロスレス 4:2:0（GPU / CPU） | 約 30 Mbps | 85.4 dB | 0.9969 |
| HEVC 品質4（CPU x265） | 約 30 Mbps | 66.1 dB | 0.9967 |
| HEVC 品質4（GPU 固定QP） | 約 29 Mbps | 58.2 dB | — |
| HEVC 品質12（GPU 固定QP） | 約 22 Mbps | 51.0 dB | — |
| HAP Q | 約 1360 Mbps | 38.8 dB | 0.9886 |
| HAP | 約 850 Mbps | 33.1 dB | 0.9711 |

ビットレートは素材の動きによって大きく変わります（動きの多い素材ではロスレスは数百 Mbps になることがあります）。

### Looking Glass Bridge 連携

- 右上「接続」で Bridge（localhost:33334）に接続し、実機を検出します。「実機に合わせる」で quilt 設定を実機に合わせます。
- 「実機リアルタイム表示」: 実機ディスプレイに全画面ウィンドウを開き、Bridge のキャリブレーション値を使ってアプリ自身がレンチキュラー描画します。再生・シーク・パラメータ変更がそのまま実機に反映されます（音声はメインウィンドウから再生）。表示中は Bridge のウィンドウを隠します。
- 「このフレームを実機へ」: 現在のフレームを quilt 画像にして実機に表示。
- 「ライブ反映」: 停止中にパラメータやシーク位置を変えると、自動で実機の表示を更新します。
- 書き出し後「実機で再生」: 書き出した quilt 動画を実機で再生します。

### プレビュー

- 1ビュー / ウィグル（ビューを往復）/ 左右端（両端ビューの並列）/ quilt 全体。
- ブラウザで再生できない素材（ProRes、QuickTime Animation、TIFF など）は ffmpeg でフレームを取り出して表示します。停止中の確認は問題ありませんが、再生中はコマ落ちします。書き出し結果には影響しません。

## 構成

| ファイル | 役割 |
| --- | --- |
| `src/core.js` | 配置・視差・タイミングの計算（プレビューと書き出しで共有） |
| `src/ffmpeg.js` | ffprobe、フィルタグラフ生成、書き出し・進捗 |
| `src/bridge.js` | Looking Glass Bridge HTTP API |
| `renderer/preview.js` | WebGL2 プレビュー（ffmpeg と同じ配置で各ビューを描画） |
| `renderer/lkg.js` | 実機リアルタイム表示ウィンドウ |
| `renderer/app.js` | UI |

## テスト

```bash
npm test
```

テスト素材を生成し、3 レイヤー＋音声のプロジェクトを書き出して検証します（出力は `test/tmp/`）。

## ライセンス

[MIT](LICENSE)。ffmpeg は同梱しておらず、外部コマンドとして呼び出します（ffmpeg 自体のライセンスは各ビルドに従います）。
