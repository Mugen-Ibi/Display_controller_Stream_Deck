# Display Controller for Stream Deck

WindowsのDDC/CI対応外部ディスプレイの**ハードウェア輝度**を、Stream DeckのボタンやStream Deck +のダイヤルから調整するプラグインです。ダイヤルのない機種でも使えます。TypeScript / Elgato SDKとRust / Windows Monitor Configuration APIで実装しています。Monitorianの常駐は不要です。

## インストールと使い方

[**最新版のプラグインをダウンロード**](https://github.com/Mugen-Ibi/Display_controller_Stream_Deck/releases/latest/download/com.ibimu.display-controller.streamDeckPlugin) · [リリース一覧](https://github.com/Mugen-Ibi/Display_controller_Stream_Deck/releases)

1. ダウンロードした `com.ibimu.display-controller.streamDeckPlugin` をダブルクリックし、Stream Deckでインストールします（更新時も同じ手順です）。
2. **Display Controller → ディスプレイ輝度**をボタン、またはStream Deck +のダイヤルへドラッグします。
3. アクションの設定画面で、操作するディスプレイ（例：**GCQ271HA**）を選びます。
4. ボタンでは「ボタンを押したとき」を **明るくする／暗くする／プリセットに変更** から選択します。増減用に2つのボタンを並べると、ダイヤルなしで両方向に操作できます。

### ボタン操作

| 設定 | 1回押すと |
| --- | --- |
| 明るくする（初期設定） | 設定した変更幅だけ輝度を上げる（標準2ポイント） |
| 暗くする | 設定した変更幅だけ輝度を下げる（標準2ポイント） |
| プリセットに変更 | 設定した輝度へ変更する（標準50%） |

ボタンには操作内容（`+2%`・`−2%`・`→50%`等）と現在の輝度を表示します。押した瞬間に1回実行し、長押しによる自動連打は行いません。対象未選択時は「画面を選択」、通信エラー時は「接続確認」と表示します。

### ダイヤル操作（Stream Deck +）

| 操作 | 動作（初期設定） |
| --- | --- |
| 右・左へ回す | 輝度を2ポイントずつ増減 |
| 押しながら回す | 輝度を10ポイントずつ増減 |
| 回さずに押して離す | 50%のプリセットへ変更 |
| タッチストリップをタップ | 実機の現在値を再取得 |
| タッチストリップ | モニター名、輝度%、バーを表示 |

変更幅とプリセットは設定画面で変更できます。複数画面を操作する場合は、各ボタン・ダイヤルへ同じアクションを配置し、それぞれのディスプレイを選びます。同じ画面へ複数のボタン・ダイヤルを割り当てても、目標値と表示を共有します。初期状態では対象を自動選択しません。v0.1のダイヤル設定は引き続き利用できます。

MonitorianやOSDによる変更は、操作していない間に約3秒周期で読み直します。DDC通信が遅い・失敗している場合、同期に時間がかかります。連続回転中の表示に付く `…` は変更処理中を表します。

## 動作環境

- Windows x64。Windows 10以降向け、実機検証環境はWindows 11 / Stream Deck 7.6.1。
- Stream Deckアプリ6.6以降、ボタンを搭載したStream Deck。ダイヤル操作にはStream Deck +が必要です。
- DDC/CIによる輝度制御に対応し、OSDでDDC/CIが有効になっている外部ディスプレイ。
- 配布パッケージにRustヘルパーとJavaScript依存を同梱。利用時のNode.js/Rustの別途インストールは不要です。

ディスプレイの最大値が100でなくても、取得した最小・最大値を0〜100%へ換算します。GCQ271HAの検証個体は範囲0〜50で、**1段階は2%相当**でした。そのため設定上の刻みを1%にしても、実機で表現できる値へ丸められます。

## 開発

必要なもの：Node.js 20.5.1以降、npm、Rust 1.88以降（x86_64-pc-windows-msvc）、Visual Studio C++ Build Tools / Windows SDK。リポジトリルートから実行してください。

開発ビルドは[GitHub Actions](https://github.com/Mugen-Ibi/Display_controller_Stream_Deck/actions/workflows/ci.yml)の成功した実行からも取得できます。ソースリポジトリには実行ファイルや `dist` を含めていません。

```powershell
npm ci
npm run check
npm run build
npm run diagnose
npm run pack
```

- `check`：TypeScriptの型検査、制御・通信テスト、Rustテスト、Clippy。
- `build`：Rust releaseビルド、JSバンドル、アイコン生成、第三者ライセンス集約。
- `diagnose`：接続画面と輝度をJSONで表示。書き込みは行いません。
- `validate`：Elgato CLIによるmanifest・配布ファイル検証。
- `pack`：インストール用 `.streamDeckPlugin` を `dist` に作成。
- `verify:hardware -- GCQ271HA`：**実機の輝度を一時変更する**統合検証。通常・押し回し・プリセット・再取得をSDKイベントで確認し、最後に元の値へ戻します。実行中は他アプリからの輝度操作を避けてください。

開発中にStream Deckへリンクする場合：

```powershell
npx streamdeck link com.ibimu.display-controller.sdPlugin
npx streamdeck restart com.ibimu.display-controller
```

リンク中のビルドでは、使用中のヘルパーEXEの置き換えを避けるため、先に `npx streamdeck stop com.ibimu.display-controller` を実行します。リンク解除は `npx streamdeck unlink com.ibimu.display-controller` です。

## 実装の要点

- `src/plugin.ts`：Elgato SDKとRustヘルパーの起動。
- `src/brightness-action.ts`：ボタン・ダイヤルのSDKイベント、設定画面、フィードバック、定期同期。
- `src/controller.ts`：画面ごとの目標値を共有し、書き込み中に届いた中間値を最新値へ集約。
- `src/native-client.ts`：標準入出力のJSON LinesでRust子プロセスと通信。全DDCコマンドを直列化し、12秒でタイムアウト・次回再起動。
- `native/src/monitor.rs`：画面列挙、デバイス識別、EDIDの表示名、VCP `0x10` の読み書き。VCP読取りに失敗した場合は高レベル輝度APIへフォールバック。
- `com.ibimu.display-controller.sdPlugin/ui`：外部CDNに依存しない日本語の設定画面。

モニター番号ではなくWindowsのデバイスインターフェースIDを保存します。各コマンドでIDを再照合し、古い物理ハンドルを使い回しません。切断時に別の画面へ自動的に切り替えることはありません。書き込み後は実機を再読取りし、反映されない場合はエラーを表示します。失敗した操作は復帰後に再送しません。

SDKの間接依存Zodは、SDKが使用する `zod/v4-mini` と互換の修正版4.6.6以降にoverrideしています。ロックファイルを同梱し、統合検証でSDK起動・イベント・設定画面通信を確認しています。実行時に外部サービスとの通信は行いません。

## 制約とトラブルシューティング

- HDR、映像モード、ケーブル、ドック、GPUドライバーによりDDC/CIが利用できないことがあります。
- ノートPC内蔵画面のWMI輝度制御は対象外です。検出一覧には取得不可として表示します。
- 複製表示・1つの論理画面に複数の物理画面が対応する構成は対象外です。Windowsの拡張表示を使用してください。
- 接続ポートの変更等でWindowsのIDが変わった場合は、再検出して選択し直してください。
- 同じ型番の画面は表示番号で区別します。保存するIDはポートに関連するWindowsのIDであり、EDIDシリアル番号によるポート間追跡ではありません。
- DDC失敗時はOSDのDDC/CI、電源状態、HDR、接続経路を確認してください。ログはプラグインの `logs` フォルダーに出力されます。
- v0.2では輝度を対象とし、コントラスト・音量・入力切替・全画面一括操作・マルチアクションは含みません。

## 検証記録（2026-11-05）

- TypeScript側18件、Rust側6件の自動テスト。SDKテストホストでボタン3モード、連打、ダイヤルとの共有、設定変更、未接続、非表示後の停止を確認。
- GCQ271HAで輝度読取り・12%→14%→16%の変更・12%への復元。
- v0.2ではSDKのボタンイベント経由でもGCQ271HAの増減・プリセットを検証。開始時の0%から一時変更し、0%へ復元。
- ビルド済みプラグインをテスト用WebSocketホストから起動し、SDK登録、モニター一覧、回転、押し回し、押下、タップ、未接続表示を確認。
- Chromiumで設定保存、範囲外入力、DDC非対応画面、未接続表示、300px/360px幅を確認。
- ボタン用の3モード切替・保存後の再読込と、既存ダイヤル設定の表示を確認。

物理ダイヤルを手で回す操作、長時間の連続利用、実際の抜き差し・スリープ復帰、Monitorianとの同時操作は未検証です。テストホストによるSDKイベント検証と区別しています。検証範囲は `docs/QA.md` に記載しています。

## 公式資料

- [Elgato：Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/guides/dials/)
- [Elgato：Manifest](https://docs.elgato.com/streamdeck/sdk/references/manifest/)
- [Microsoft：GetVCPFeatureAndVCPFeatureReply](https://learn.microsoft.com/en-us/windows/win32/api/lowlevelmonitorconfigurationapi/nf-lowlevelmonitorconfigurationapi-getvcpfeatureandvcpfeaturereply)
- [Microsoft：SetVCPFeature](https://learn.microsoft.com/en-us/windows/win32/api/lowlevelmonitorconfigurationapi/nf-lowlevelmonitorconfigurationapi-setvcpfeature)

同梱ライブラリーのライセンスはプラグイン内の `THIRD-PARTY-NOTICES.txt` を参照してください。

## ライセンスと貢献

このプロジェクトは [MIT License](LICENSE) で公開しています。Copyright (c) 2026 Mugen Ibi。
同梱する第三者ライブラリーには、それぞれのライセンスが適用されます。

不具合報告・機能提案は [Issues](https://github.com/Mugen-Ibi/Display_controller_Stream_Deck/issues)、変更提案はPull Requestで受け付けます。画面制御の不具合には、Windows・Stream Deckのバージョン、ディスプレイ型番、接続方法を添えてください。診断ログを添付する際は、デバイスIDやローカルパス等を確認してから共有してください。
