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

PCとPicoを同じLANへ接続し、ブラウザで `http://localhost:3000` を開きます。初期値の `pico-motor.local` のまま「Picoへ接続」を押してください。ブラウザはPicoへ直接接続せず、ローカルのNext.jsサーバーがmDNSでPicoを発見してAPIを中継するため、CORSやPrivate Network Accessの制限を受けません。接続時にはACK付きの安全なUDP停止命令を1回送り、PicoがUDP制御を実際に受信・適用できることを確認します。停止・回転操作はボタンを押し始めた時点でUDP 5000番へ低遅延制御プロトコルv2の同じ命令を3回送信し、OSが送信を受理した時点で画面へ応答します。v2はACKを生成せず、HTTPフォールバックもリアルタイム操作経路に含めません。状態取得は低優先度の別経路です。命令連番により、遅れて届いた古い複製が新しい状態を上書きすることはありません。接続中はTCPソケットを圧迫しないUDP経路で250ms周期の安全信号を送り続けます。

「2台同時回転」は2台分の速度を `PUT /api/motors/sync` の1命令へまとめます。Picoは
1つのUDPパケットから両方の速度を読み取り、2つのPIOステートマシンを同じクロックで
有効化するため、PCから個別命令を順番に送る待ち時間がありません。画面の初期速度は
両方とも500 steps/sです。

UDP操作にはアプリ起動ごとのセッション番号と命令連番が入ります。アプリを再起動した
場合は新しいセッションとして受け入れ、以前のセッションから遅れて届いたパケットは
拒否するため、将来時刻の命令IDやPC時計の変更で操作不能になることを防ぎます。

PCとPicoをLANケーブルで直接つなぐ場合は、起動後15〜30秒ほど待ってから接続してください。DHCPがないためPicoは`169.254.50.50`、PCはOSの自動設定による`169.254.x.x`を使用します。

VercelなどHTTPSで公開した画面からLAN内のPicoへは到達できません。この操作画面はLAN内のPCで `localhost` として起動してください。

## 安全機能

- LAN経由の運転命令には1秒のウォッチドッグがあります。画面は接続中、UDP安全信号を250ms周期で送り、信号が1秒途絶えるとPicoが両モーターを自動停止します。
- 「LANを切断」は先に全停止を要求します。停止確認に失敗してもウォッチドッグが働きます。
- API入力は最大速度範囲を検証します。
- USBシリアルの `0x100,800` 形式も保守用に残しています。USB命令にはウォッチドッグがありません。
- 初回は機構からモーターを外すか、すぐ主電源を切れる状態で低速から確認してください。
- 実機の非常停止はソフトウェアだけに依存せず、モータードライバー電源またはENABLEを遮断する物理スイッチを設けてください。
