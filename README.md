# Pico Stepper Console

Raspberry Pi PicoへブラウザのWeb Serial APIで接続し、2台のステップモーターを動作確認するVercel向けNext.jsアプリです。

## 動作条件

- PC版 Google Chrome または Microsoft Edge（Web Serial対応ブラウザ）
- Raspberry Pi Picoとデータ通信対応USBケーブル
- Pico SDK側でUSB CDC標準入出力を有効にしたファームウェア
- VercelのHTTPS環境、またはローカルの `localhost`

Safari、Firefox、iOS版ChromeではWeb Serialを利用できません。ブラウザのポート選択画面は、セキュリティ上ユーザーが「USBポートを選択」を押したときだけ表示されます。

## Picoファームウェア

質問文のCコードをPicoへ書き込みます。`CMakeLists.txt` ではUSB標準入出力を有効にしてください。

```cmake
pico_enable_stdio_usb(your_target 1)
pico_enable_stdio_uart(your_target 0)
```

Webアプリは115200 baudで接続し、次のASCIIコマンドを改行付きで送信します。

```text
0x100,800
0x101,-1200
0x100,0
```

`0x100` はモーター1、`0x101` はモーター2です。正数は正転、負数は逆転、0は停止です。

## ローカル起動

```bash
npm install
npm run dev
```

ChromeまたはEdgeで `http://localhost:3000` を開きます。

## Vercelへデプロイ

1. このフォルダーをGitHubリポジトリへpushします。
2. Vercelで「Add New Project」からリポジトリを選びます。
3. Framework Presetが `Next.js`、Build Commandが `next build` であることを確認します。
4. Deployを実行します。環境変数は不要です。

USB通信はVercelのサーバーを経由しません。ブラウザとPicoの間だけで処理されます。

## 安全上の注意

- 最初は低速で、モーターを機構から外すか、すぐ電源を切れる状態で確認してください。
- ブラウザやUSBが切断されても、Picoは最後に受信した速度で動作を続ける可能性があります。実機運用ではファームウェア側に通信タイムアウトによる自動停止を追加してください。
- `MAX_SPEED_STEPS_PER_SEC` はドライバー、モーター、電源、機構に合わせて調整してください。
