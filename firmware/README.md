# W5500-EVB-Pico2 Motor API

2台のSTEP/DIRモーターを、従来のUSBシリアルに加えてW5500のHTTP APIから制御します。
W5500-EVB-Pico2の内蔵W5500（SPI0 / GPIO16〜21）を想定しています。

## ビルド

初回のCMake構成時に、WIZnet公式 `ioLibrary_Driver` をGitHubから取得します。

```sh
cmake -S . -B build
cmake --build build
```

生成された `build/pico_lan_stepper.uf2` をW5500-EVB-Pico2へ書き込みます。USBシリアルには、
DHCPで取得したIPアドレスが表示されます。

## Webブラウザから操作

LANケーブルを接続してから基板を起動し、USBシリアルへ表示された次のURLを、同じLAN上の
PCまたはスマートフォンで開きます。

```text
http://取得したIPアドレス/
```

例: `http://192.168.1.123/`

同一LANでmDNSを利用できる環境では `http://pico-motor.local/` でも開けます。表示される
操作画面はPico自身が配信するため、外部WebサイトからのHTTPアクセスで発生する
CORSやMixed Contentの影響を受けません。「送信」を押している間は安全停止期限を
更新するため、500ms周期でAPIを再送します。「停止」で再送を止めてspeed=0を送ります。

起動時にLANケーブルが未接続でも、後から接続されると自動的にDHCPを開始します。
取得したIPアドレスはUSBシリアルへ改めて表示されます。また、Pico固有IDからMACアドレスを
生成するため、複数台を同じLANへ接続してもMACアドレスが衝突しません。

## HTTP API

モーター1を800 steps/sで正転させる例:

```sh
curl -X PUT 'http://192.168.1.123/api/motors/1' \
  -H 'Content-Type: application/json' \
  --data '{"speed":800}'
```

モーター2を500 steps/sで逆転させる例:

```sh
curl -X PUT 'http://192.168.1.123/api/motors/2' \
  -H 'Content-Type: application/json' \
  --data '{"speed":-500}'
```

`speed` は正数が正転、負数が逆転、`0`が停止です。絶対値は最大20000 steps/sに
制限されます。APIから開始した回転は安全のためデフォルトで1秒後に停止します。
連続運転する場合は1秒より短い間隔（推奨500ms）で同じ速度を再送してください。
同じ速度の再送ではSTEPパルスを再設定せず、安全停止期限だけを更新します。
USBシリアルからの指令にはこのタイムアウトは適用されません。

W5500の物理LANリンクは1ms周期で監視し、ケーブル断などでリンクが切れた場合は
両モーターを即時停止します。スイッチ経由でホストだけが停止した場合は物理リンクが
維持されるため、APIウォッチドッグによって最大1秒で停止します。

疎通確認:

```sh
curl 'http://192.168.1.123/api/status'
```

最初に上記のGETでJSONが返ることを確認してから、モーター指令を送信してください。
IPアドレスは例の値ではなく、必ずUSBシリアルに表示された値を使用します。DHCPサーバーが
ない直接接続環境では `169.254.50.50` を使用します。この場合、PC側のEthernetにも
`169.254.x.x/16` のアドレスが必要です。

## インターネットからアクセスする場合

このHTTPサーバーは平文HTTPです。ルーターの80番ポートをそのまま公開せず、
VPN（Tailscale/WireGuard等）またはHTTPS対応のリバースプロキシを経由してください。
外部から直接接続するには、ルーター側のポート転送とグローバルIP/DDNSも別途必要です。
HTTPSで配信された外部WebページからPicoのHTTP APIを直接呼ぶと、ブラウザの
Mixed Content制限でブロックされます。その場合はPico内蔵の操作画面を使うか、
HTTPSリバースプロキシ経由でAPIへ接続してください。
