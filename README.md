# Pico Stepper LAN Console

W5500を接続したRaspberry Pi PicoへLAN内のHTTP APIで命令を送り、2台のSTEP/DIR式ステップモーターを制御するプロジェクトです。
STEPパルスはPIOハードウェアで生成するため、LAN通信やWeb APIの再試行中も回転周期が乱れません。

- `firmware/`: Pico SDK用ファームウェア（W5500 HTTP API）
- `app/`: APIを操作するNext.jsブラウザ画面

## 配線

### モータードライバー

| 用途 | Pico GPIO |
| --- | ---: |
| Motor 1 STEP | 4 |
| Motor 1 DIR | 5 |
| Motor 2 STEP | 6 |
| Motor 2 DIR | 7 |
| Motor 1 LED | 14 |
| Motor 2 LED | 15 |

### W5500（SPI0）

| W5500 | Pico GPIO |
| --- | ---: |
| MISO | 16 |
| CS / SCS | 17 |
| SCK | 18 |
| MOSI | 19 |
| RESET / RSTn | 20 |
| 3.3V | 3V3 |
| GND | GND |

PicoとW5500は3.3Vロジックです。モーターはPicoから直接駆動せず、必ずSTEP/DIR入力対応ドライバーと別電源を使用し、GNDを共通にしてください。

## Picoファームウェア

### 1. ネットワーク設定

Picoは起動時にDHCPで、そのLANに合ったIPアドレスを自動取得します。固定IPの設定は不要です。

- 接続ホスト名: `pico-motor.local`
- HTTP port: `80`
- DHCP待機時間: 最大15秒
- DHCPサーバーがないPC直結時: `169.254.50.50/16`へ自動フォールバック

ルーター経由でもPCとのLANケーブル直結でも、通常はWeb画面へ `pico-motor.local` を入力するだけで接続できます。ホスト名は[firmware/CMakeLists.txt](firmware/CMakeLists.txt)の`MOTOR_HOSTNAME`で変更できます。

### 2. ビルド

Pico SDK、CMake、Arm GNU Toolchainを用意し、`PICO_SDK_PATH` を設定します。WIZnet公式 `ioLibrary_Driver` v3.2.0はCMake初回実行時に取得されます。

```bash
cd firmware
cmake -S . -B build
cmake --build build -j
```

生成された `firmware/build/pico_lan_stepper.uf2` を、BOOTSELモードのPicoへコピーします。

APIキーを付ける場合は `target_compile_definitions` に次を追加し、Web画面にも同じ値を入力します。

```cmake
MOTOR_API_KEY="change-this-key"
```

## HTTP API

### 状態取得

```bash
curl http://pico-motor.local/api/status
```

### Motor 1を正転800 steps/s

```bash
curl -X PUT http://pico-motor.local/api/motors/1 \
  -H 'Content-Type: application/json' \
  -d '{"speed":800}'
```

### Motor 2を逆転1200 steps/s

```bash
curl -X PUT http://pico-motor.local/api/motors/2 \
  -H 'Content-Type: application/json' \
  -d '{"speed":-1200}'
```

### 全停止

```bash
curl -X POST http://pico-motor.local/api/stop
```

APIキーを設定した場合は、すべてのリクエストへ `-H 'X-API-Key: change-this-key'` を追加します。

速度は `-20000`〜`20000` の整数です。正数は正転、負数は逆転、`0`は停止です。モーター1はID `0x100`、モーター2はID `0x101`です。

## ブラウザ画面

```bash
npm install
npm run dev
```

PCとPicoを同じLANへ接続し、ブラウザで `http://localhost:3000` を開きます。初期値の `pico-motor.local` のまま「Picoへ接続」を押してください。ブラウザはPicoへ直接接続せず、ローカルのNext.jsサーバーがmDNSでPicoを発見してAPIを中継するため、CORSやPrivate Network Accessの制限を受けません。PC直結時は既知の `169.254.50.50` を300msだけ先に試し、応答があればmDNSを待たずに接続します。接続時にはACK付きの安全なUDP停止命令を1回送り、PicoがUDP制御を実際に受信・適用できることを確認します。停止・回転操作はボタンを押し始めた時点でUDP 5000番へ低遅延制御プロトコルv2の同じ命令を3回送信し、OSが送信を受理した時点で画面へ応答します。UDP診断に失敗した場合はHTTP制御モードへ自動で切り替えます。状態取得は低優先度の別経路です。命令連番により、遅れて届いた古い複製が新しい状態を上書きすることはありません。接続中はUDP経路で250ms周期、HTTP制御モードで750ms周期の安全信号を送り続けます。

「2台同時回転」は2台分の速度を `PUT /api/motors/sync` の1命令へまとめます。Picoは
1つのUDPパケットから両方の速度を読み取り、2つのPIOステートマシンを同じクロックで
有効化するため、PCから個別命令を順番に送る待ち時間がありません。画面の初期速度は
両方とも500 steps/sです。

UDP操作にはアプリ起動ごとのセッション番号と命令連番が入ります。アプリを再起動した
場合は新しいセッションとして受け入れ、以前のセッションから遅れて届いたパケットは
拒否するため、将来時刻の命令IDやPC時計の変更で操作不能になることを防ぎます。

PCとPicoをLANケーブルで直接つなぐ場合は、起動後15〜30秒ほど待ってから接続してください。DHCPがないためPicoは`169.254.50.50`、PCはOSの自動設定による`169.254.x.x`を使用します。

VercelなどHTTPSで公開した画面からLAN内のPicoへは到達できません。この操作画面はLAN内のPCで `localhost` として起動してください。

## Web/API引き継ぎメモ

このリポジトリではPicoファームウェアと検証用Web画面を同居させていますが、今後Webアプリ側を別実装へ置き換える場合は、PicoのHTTP API仕様と安全信号の扱いを保ってください。ブラウザからPicoへ直接アクセスせず、必ずローカルまたはLAN内のサーバーAPIを経由する構造を推奨します。理由は、ブラウザのCORS、Private Network Access、Mixed Content制限に左右されやすいためです。

### 現在のWeb構造

| ファイル | 役割 |
| --- | --- |
| `app/page.tsx` | 操作UI、接続状態、楽観的UI更新、ハートビート、安全停止、UDP/HTTP制御モード切り替え |
| `app/api/pico/[...path]/route.ts` | ブラウザからのAPIをPicoへ中継するNext.js APIルート |
| `firmware/w5500_ethernet.c` | Pico側HTTP API、UDP即時制御、mDNS、DHCP、W5500ソケット管理 |
| `firmware/honda.c` | STEP/DIR出力、PIO制御、安全ウォッチドッグ、モーター状態 |

Web担当者が主に触るのは `app/page.tsx` と `app/api/pico/[...path]/route.ts` です。Pico側のAPI仕様を変える場合は、ファームウェア側と同時に調整してください。

### 通信の全体像

```text
Browser UI
  ↓ fetch /api/pico/...
Next.js API proxy
  ↓ HTTP 80 or UDP 5000
Raspberry Pi Pico + W5500
  ↓ STEP/DIR
Motor driver
```

`target` クエリにPicoの接続先を渡します。例:

```text
/api/pico/api/status?target=http%3A%2F%2Fpico-motor.local
```

Next.js APIルートは、接続先がLAN内IPv4であることを確認し、PicoのHTTP APIへ中継します。`pico-motor.local` が指定された場合、PC直結でよく使う `169.254.50.50` を300msだけ先に試し、応答があればmDNSを待たずに接続します。

### 接続時の流れ

1. UIが `/api/status` を取得します。
2. `firmwareVersion` がWeb側の要求バージョン以上か確認します。
3. `udpControlProtocol === 2` を確認します。
4. `/api/control-check` でACK付きUDP停止命令を送り、UDP即時制御が使えるか診断します。
5. UDP診断に成功したらUDP制御モード、失敗したらHTTP制御モードで接続を継続します。

直結環境ではUDP 5000が通らずHTTPだけ通ることがあります。その場合でも操作不能にしないため、HTTP制御モードを残しています。

### 制御モード

| モード | 使用条件 | 操作命令 | 安全信号 | 備考 |
| --- | --- | --- | --- | --- |
| UDP制御モード | `/api/control-check` 成功 | UDP 5000へv2パケットを3回送信 | UDP 250ms周期 | 最低遅延。ACK待ちはしない |
| HTTP制御モード | UDP診断失敗 | HTTP APIへ短タイムアウト並列送信 | HTTP 750ms周期 | UDPが使えない環境用の確実な経路 |

UIは命令送信直後に画面状態を楽観的に更新します。Picoの状態取得は低優先度のテレメトリ扱いで、操作直後は少し遅らせています。古い状態取得結果が新しいUI状態を上書きしないよう、`commandGenerationRef` で世代管理しています。

### Pico HTTP API契約

Web側が使うPico APIは次の通りです。

| Method | Path | Body | 用途 |
| --- | --- | --- | --- |
| `GET` | `/api/status` | なし | 接続確認、ファームウェア版数、モーター状態、診断カウンタ |
| `POST` | `/api/heartbeat` | なし | 安全ウォッチドッグ更新 |
| `POST` | `/api/stop` | なし | 2台同時停止 |
| `PUT` | `/api/motors/1` | `{"speed":800}` | Motor 1速度指定 |
| `PUT` | `/api/motors/2` | `{"speed":-800}` | Motor 2速度指定 |
| `PUT` | `/api/motors/sync` | `{"speed1":800,"speed2":-800}` | 2台同時速度指定 |

`speed` は `-20000`〜`20000` の整数です。正数は正転、負数は逆転、`0` は停止です。

### Web中継APIのヘッダー

| Header | 付与元 | 用途 |
| --- | --- | --- |
| `X-API-Key` | UI | Pico側で `MOTOR_API_KEY` を設定した場合の認証 |
| `X-Command-Id` | UI | 停止、開始、同期命令の順序保証。古い命令の再適用を防ぐ |
| `X-Control-Transport: http` | UI | UDP診断失敗時にHTTP制御モードを強制 |

`X-Command-Id` は単調増加する整数文字列にしてください。現在のUIは `Date.now()` とインクリメントで生成しています。

### 実装時の注意点

- ブラウザからPicoへ直接 `fetch("http://pico-motor.local/...")` する設計に戻さないでください。ローカルAPIプロキシ経由の方が安定します。
- 操作命令と状態取得を同じ優先度にしないでください。状態取得が遅くてもモーター操作を待たせない構造が重要です。
- 安全信号を止めると、Picoは3秒以内に自動停止します。接続中は必ず `/api/heartbeat` を送り続けてください。
- HTTP制御モードではハートビートを高頻度にしすぎるとW5500のHTTPソケットを圧迫します。現在は750ms周期です。
- 2台同時開始は `/api/motors/sync` を使ってください。個別に2回送ると、PC側やLAN側の待ち時間で開始タイミングがずれます。
- UI側を作り直す場合も、切断時は先に `/api/stop` を送る設計にしてください。失敗してもPico側ウォッチドッグで停止します。

## 安全機能

- LAN経由の運転命令には3秒のウォッチドッグがあります。画面は接続中、UDPでは250ms周期、HTTP制御モードでは750ms周期で安全信号を送り、信号が3秒途絶えるとPicoが両モーターを自動停止します。
- 「LANを切断」は先に全停止を要求します。停止確認に失敗してもウォッチドッグが働きます。
- API入力は最大速度範囲を検証します。
- USBシリアルの `0x100,800` 形式も保守用に残しています。USB命令にはウォッチドッグがありません。
- 初回は機構からモーターを外すか、すぐ主電源を切れる状態で低速から確認してください。
- 実機の非常停止はソフトウェアだけに依存せず、モータードライバー電源またはENABLEを遮断する物理スイッチを設けてください。
