# リンク層(Wi-Fi Direct / LocalOnlyHotspot)を差し替え可能にする — 設計メモ

状態: 設計メモ(コードは変えない)。2026-10-21、`origin/main` bd73628 時点のコードを読んで書いた。
関連: `docs/SPEC.md`(§2 方式、§9 能力の交換と Link Planner)、`docs/GATEWAY_BUS.md`(バス)、`docs/LINK_STATE.md`(suspend)。

書き方の約束: 「事実」にはコード・docs・テストの根拠を付ける。根拠が取れないものは **未検証** と書き、推測を事実として書かない。
実機のログはこの repo にほとんど残っていない(`docs/device-reports/` に 1 件、`LINK_STATE.md` / `directGuard.ts` に razr の時刻の記録)。実機で確かめる項目は §5 に手順としてまとめた。

## 0. 要点

- Direct 上にメッセージバス(ZeroMQ、#23)が入り、バス・Echo・SOCKS は **TCP/IP の上**で動く。したがって、IP が通る足場さえ作れれば、その下が Direct か LOHS かは差し替えられる余地がある(Kaz:「Wi-Fi Direct か LOHS かは選択肢になりうる」)。
- すでに **方式の選択(Link Planner)・LOHS の作成・LOHS への参加**はある。足りないのは「リンク層」として一つの口にまとまっていないことと、LOHS 経路でバス・グループ消滅検知・帯域アップグレード対策が **Direct 前提のまま**になっていること(§1)。
- 差し替えの本体は、①親機のリンクの作成/破棄/消滅検知、②資格情報の渡し方、③バスの bind 先、④Nearby を止める条件、の 4 点(§2)。
- Direct と LOHS の性質の違いは、実機で確かめていない点が多い(§4)。先に §5 の比較をして、既定の選び方(§3)を決めるのがよい。

## 1. 現状コードの Direct / LOHS 経路と、リンク層への依存

### 1.1 経路の読み取り(親機)

1. `Tether.shareNow()`(`src/api/tether.ts`)が `ensurePlan()` で Link Planner(`src/api/planner.ts`)の `plan.order` を得る。
2. `buildShare(gen, order)` が、前回の共有を片付け(`stopSocks` / `stopHotspot` / `stopDirect` + 1.5 秒)、**Echo(9000)と SOCKS5(1080)を先に起動**し、`order` の順に `tryDirect` / `tryLohs` を呼ぶ。LOHS を Direct の後に試すときは、Direct のグループを消して 1.5 秒待つ(P2P が残ると AP を作れない機種があるため。コメントによる)。
3. `tryDirect`: `directCreds()`(`src/pairing/directCreds.ts`)で **ペアごとに固定の SSID / パスフレーズ**を得て、`pickDirectPlans()` の帯域候補(2.4GHz の親機 STA と同じch → 1/6/11ch → 2.4GHz 自動。5GHz は使わない)を順に `startDirect` する。成功したら `nearbyDirectActive(true)`・`data.group = true`・`startBusHost()`(バス待ち受け)をして、`busPort` 付きの `tether.wifi` を返す。
4. `tryLohs`: `startHotspot()` を最大 3 回(間 2 秒)。成功したら SSID/パスフレーズ(LOHS が決めた値)を `busPort` **なし**で `tether.wifi` に載せて返す。
5. 接続情報(`tether.wifi`: method / ssid / pass / port=9000 / socks 資格情報 / busPort)は、**認証済みの Nearby 経路**で子機へ送る(`sendShare`)。

### 1.2 経路の読み取り(子機)

1. `join()` が `joinWifi(ssid, pass, timeout)`(`HotspotModule.kt` の `startJoin`)を呼ぶ。`WifiNetworkSpecifier` + `requestNetwork`。**Direct か LOHS かを区別するコードはない**(WPA2-PSK の SSID/パスフレーズだけで入る)。
2. ゲートウェイは `LinkProperties` のデフォルトルートのゲートウェイ、無ければ `dhcpServerAddress`(API 30+)から取る(`gatewayOf`)。親機の「groupOwnerAddress」は子機側では **使っていない**(`requestConnectionInfo` の結果は親機のログ出力のみ)。
3. 到達確認 `probe(gateway, 9000)` → `wifi-result` を親機へ送る → `startVpn()`: `bindToJoined()` でプロセスを参加した Network に固定 → `startBusGuest(gateway, busPort)` → VPN 開始。

### 1.3 リンク層に依存している箇所 / 依存していない箇所

| 箇所 | 依存 | 内容(根拠) |
|---|---|---|
| 方式の選択 `planLink` / `METHODS` | 方式を知っている(これが差し替え点) | `DEFAULT_ORDER = [WifiDirect, LocalOnlyHotspot]`。1 台は Direct 主。2 台以上は LOHS 優先。Direct が直近 2 回連続失敗なら LOHS 先(`failingRecently`)。`lohs=false` / `wifiDirect=false` のときだけ除外。planner.test.ts / handshake.test.ts に期待値あり |
| 親機のリンク作成 `startHotspot` / `startDirect` | **依存(別 API)** | LOHS は `startLocalOnlyHotspot(callback, handler)` で設定を渡す口がない。Direct は `WifiP2pConfig`(名前・パスフレーズ・帯域・周波数)。戻り値の形(`{ssid, passphrase}`)は同じ |
| 親機のリンク破棄 `stopHotspot` / `stopDirect` | 依存 | LOHS は `reservation.close()`、Direct は `removeGroup` + チャンネルを閉じる(閉じないと p2p0 が残り LOHS の AP を作れない、とコードのコメント) |
| 消滅検知 | **Direct のみ** | Direct は `startGroupWatch`(`WIFI_P2P_CONNECTION_CHANGED_ACTION`)→ `onDirectGroup`。LOHS は `onStopped` → `onHotspotStopped` イベントを出すが、**JS(`src/`)に購読する所がない**(`grep onHotspotStopped src` は 0 件)。LOHS が OS に止められても親機は気づかない |
| 親機の再作成 `rebuildDirect` / `onConnected` の分岐 | Direct のみ | `shareMsg.method === 'WifiDirect'` のときだけ。LOHS の自動再作成はない(再接続情報の再送のみ) |
| 資格情報の渡し方 | 依存しない | どちらも Nearby の `tether.wifi` で渡す。Direct は固定値、LOHS は毎回違う値を同じ経路で渡す(だから LOHS の参加も成立する) |
| 子機の参加 `joinWifi` / `bindToJoined` / `probe` / `heartbeat` | **依存しない** | `WifiNetworkSpecifier` と `Network.socketFactory` だけ。`joinedSsid` が同じなら張り直さない(`reused`) |
| 子機のゲートウェイ取得 `gatewayOf` | 依存しない | `LinkProperties` から。Direct/LOHS とも「子機の見る親機の IP」。`groupOwnerAddress` は不使用 |
| Echo(9000)の bind | 依存しない(ワイルドカード) | `ServerSocket().bind(InetSocketAddress(port))`。インターフェース指定なし |
| SOCKS5(1080)の bind | 依存しない(ワイルドカード) | 同上(`SocksServer.start`)。SPEC §4 は「Direct/LOHS のインターフェースのみ」と書くが、コードは全インターフェース(`GATEWAY_BUS.md` §10 にも既出の不整合) |
| バスの bind(親機) | **Direct 前提** | `BusEngine` は `p2p*` で始まる `up` のインターフェースの IPv4 を探し、**無ければ全インターフェースで待ち受け**(認証で守る)。LOHS の AP インターフェース名は `p2p*` とは限らない(機種依存・**未検証**)ので、LOHS では事実上ワイルドカードになる |
| バスの起動条件 | **Direct 前提** | `startBusHost()` は `tryDirect` からのみ呼ばれる。LOHS では `busPort` が付かず、子機の `startBusGuest` は何もしない → **LOHS では制御は Nearby のまま** |
| Nearby を止める条件(suspend) | **Direct 前提** | 親機の `nearbyDirectActive(true)` と `data.group = true` は `tryDirect` だけ。子機の `join()` は方式を見ず `nearbyDirectActive(true)` を呼ぶ。`LinkGovernor` / `directGuard` の語彙(group / direct)も Direct 前提 |
| データ経路の観測(Echo / group / バス生存) | 一部依存 | Echo と バス生存は依存しない。`group`(消滅)は Direct のみ |
| VPN(`TunnelService`) | 依存しない | `addDisallowedApplication(packageName)` で自アプリの通信(親機への SOCKS 接続)を除外。Network の指定はせず、`bindProcessToNetwork` による固定に依存 |
| 能力の調査 `capabilities` / `probeLohs` | 依存(方式ごとの項目) | `wifiDirect`・`lohs`(試験でのみ分かる)・`staApConcurrent`・`staP2pConcurrent`(観測)・`p2pApCoexist`(観測の経路は未実装、SPEC §9.1) |
| 権限 | ほぼ共通 | `NEARBY_WIFI_DEVICES`(33+)/`ACCESS_FINE_LOCATION`/`ACCESS_LOCAL_NETWORK`(37+)。方式別の権限差は §4 |

### 1.4 「LOHS を先に試す」条件(現状)

- 1 台: `order = [WifiDirect, LocalOnlyHotspot]` が既定。**Direct が同ペアで直近 2 件(14 日以内)とも失敗で、LOHS はそうでないとき**だけ `[LOHS, Direct]`(`history-direct-demoted`)。
- 2 台以上: `lohsForMulti`(LOHS が使え、かつ `staApConcurrent !== false`)なら `[LOHS]` のみ(`multi-prefers-lohs`)。
- `wifiDirect === false` なら最初から `[LOHS]` のみ(handshake.test.ts「Direct 不可の親機」)。
- 設定で方式を固定する口は **ない**。
- Direct が失敗したあとのフォールバックは `buildShare` のループ(`tether.test.ts` 「Wi-Fi Direct が失敗したら LocalOnlyHotspot にフォールバックする」)。

## 2. リンク層の共通インターフェース案

### 2.1 方針

- 差し替えるのは「**IP が通る足場を作る/入る**」部分だけにする。Echo・SOCKS・バス・VPN・heartbeat は IP の上なので、リンク層から **アドレスと Network(bind 先)** を受け取る側に回す。
- 実装は 2 つ(`DirectLink` / `LohsLink`)。ネイティブ(Kotlin)と JS の両方に同じ形を置くが、**第 1 段は JS 側の型と親機の分岐の整理だけ**にして、ネイティブの関数名は変えない(§6)。
- 判断(どちらを使うか)は Link Planner、状態の追跡と Nearby の制御は LinkGovernor が持つ現状の分担を保つ。リンク層は「作る・入る・止める・消えたと知らせる」だけを持つ。

### 2.2 型の案(TypeScript。命名は仮)

```ts
type LinkKind = 'WifiDirect' | 'LocalOnlyHotspot';

/** 親機が作ったリンクの接続情報。子機へ Nearby(認証済み)で渡す。毎回違ってよい */
interface LinkCredentials {
  kind: LinkKind;
  ssid: string;
  passphrase: string;       // ログに出さない
  /** Direct は固定(ペア由来)で子機の承認が記憶される。LOHS は作成のたびに変わる */
  stable: boolean;
}

interface HostLink {
  /** 親機: 作る。失敗理由は固定語(history に残せる) */
  start(opts: HostLinkOptions): Promise<LinkCredentials>;
  stop(): Promise<void>;
  /** 親機側から見た自分のアドレス(バスの bind 先・ログ用)。取れなければ null(= ワイルドカード+認証) */
  localAddress(): string | null;
  /** 消えた/できた/クライアント数。Direct は P2P のブロードキャスト、LOHS は onStopped */
  onState(cb: (e: { up: boolean; clients?: number; appInitiated?: boolean }) => void): () => void;
}
interface HostLinkOptions {
  name?: string; passphrase?: string;   // Direct のみ有効(固定値)。LOHS は無視される
  band?: { freq: number | null; hint: '2.4' | '5' | null };  // Direct のみ
  why?: string;
}

interface GuestLink {
  /** 子機: 入る。方式の差は無い(WifiNetworkSpecifier)。reused=同じ SSID に接続済み */
  join(c: LinkCredentials, timeoutMs?: number): Promise<{ gateway: string; reused?: boolean }>;
  leave(): void;
  /** 参加した Network にプロセスを固定(VPN・バス用) */
  bindToJoined(): boolean;
  onLost(cb: () => void): () => void;
}
```

- **start(host) / join(guest, credentials) / stop**: 上記のとおり。現状の `HotspotPort` の `startDirect` / `startHotspot` / `stopDirect` / `stopHotspot` / `joinWifi` / `leaveWifi` / `bindToJoined` に 1 対 1 で対応する(新しい OS 呼び出しは増えない)。
- **イベント**: 親機の `up/down` を **LOHS にも出す**のが新規(現状は `onHotspotStopped` を Kotlin が出すだけで JS が聞いていない)。子機の `onWifiLost` は共通。
- **address / gateway**: 子機は `gatewayOf(LinkProperties)` が既に共通で使える。親機の `localAddress()` は Direct が `p2p-*` インターフェースの IPv4 を探す実装(`BusEngine`)を持つ。LOHS は AP インターフェースの特定が **未検証**(§7)。取れないときは現状と同じワイルドカード+認証にして、取れたら絞る。
- **ネットワーク bind**: 子機は共通(`bindProcessToNetwork`)。親機の Echo/SOCKS/バスは「リンクのインターフェースのアドレスに bind」に揃える(現状の SPEC §4 との不整合の解消にもなる)。
- **資格情報の渡し方**: どちらも Nearby の `tether.wifi` で渡す(今と同じ)。Direct は固定、LOHS は毎回ランダムなので、**LOHS のときだけ「再作成のたびに新しい資格情報を再送し、子機は入り直す」**必要がある(Direct は同じ値のまま再作成できる)。Nearby を止める運用(suspend)と組み合わせると、LOHS 再作成のたびに Nearby を再開して資格情報を送る必要が出る → これが LOHS の最大の運用上の違いになりうる(§4・§7)。バスが生きていれば、再送はバス経由にできる可能性があるが、バスはリンクの上に載っているので、リンクが消えた時点では使えない。
- **Nearby との関係**: 「リンクが張れている間は Nearby を止める」の条件を `LinkKind` に依存させず「`HostLink.onState` が up の間」に変える(LOHS で止めてよいかは §5 の実測が要る。GMS が帯域アップグレードで LOHS/Hotspot を選ぶかは **未検証**)。

### 2.3 Planner との関係

`planLink` の出力 `order: LinkMethod[]` はそのまま使える。`METHODS` に `blockers` / `guestTodo` / `guestNote` がある構造は「方式を足す」前提で作られている。リンク層の導入で `METHODS` にファクトリ(`createHost()` / `createGuest()`)を足すのが自然。

## 3. 選択方式

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A 自動(第一候補→失敗で他方) | 現状。Planner の order に従い、失敗したら次を試す | 利用者の操作が要らない。履歴(直近 2 連続失敗)で順序が入れ替わる | 失敗してから切り替えるため時間がかかる(Direct の帯域候補 4 つ ×最大 15 秒+LOHS 3 回、は上限の見積もり。実測は未実施)。承認ダイアログの無駄が出うる(SPEC §9 冒頭の問題意識) |
| B 設定指定 | 設定(`linkPreference: 'auto' \| 'direct' \| 'lohs'`)で固定。固定時は他方を試さない | 検証・切り分けに使える。b6 の比較に必要。利用者が「この端末は LOHS」と決められる | 設定を持つ=UI/同期が増える。親機の設定を子機へどう伝えるか(子機は入るだけなので不要) |
| C 機種プロファイル | `manufacturer|model|sdk` 単位の既定(例: razr 型は Direct 主)。能力の自己申告(`capabilities`)や観測の履歴に近い | 初回から最適な順序にできる | 実機データがないと作れない(現状は razr 50 ultra と Pixel 7a の 2 機種のみ想定、SPEC §10.2)。OS 更新で変わるので `buildKey = model|sdk` で失効(既存の `ProbeStore` と同じ扱い) |

提案: **A を基本に、B を「診断/開発用の上書き」として足し、C は §5 のデータが 3 機種以上集まってから**。
理由: A はすでにあり、B は最小コストで §5 の比較に必要。C は根拠データがない今は作らない(推測で表を作らない)。
順序の決定は今と同じく親機で行い、`tether.plan` で子機へ知らせる。B で固定したときも `plan.reasons` に理由コード(例 `link-forced-by-setting`)を残す。

## 4. Direct と LOHS の違い

凡例: 根拠 = コード / docs / テスト、または「未検証」。docs の記述でも実機ログまで確認できないものは「docs 記載のみ」と区別した。

| 観点 | Wi-Fi Direct(P2P グループ) | LocalOnlyHotspot(LOHS) | 根拠 |
|---|---|---|---|
| SSID・パスフレーズを固定できるか | **できる**。`WifiP2pConfig.Builder().setNetworkName().setPassphrase()`(API 29+)。SSID は `DIRECT-xx-` 形式が必要(`directCreds` の `SSID_RE`)。ペアの共有コードから導出 | **コード上は設定を渡せない**(`startLocalOnlyHotspot(callback, handler)`)。SPEC・planner は「毎回変わる」と記載 | コード: `startDirect` / `startHotspot` / `directCreds.ts`。LOHS が毎回変わることを示す実機ログはこの repo に **無い**(docs 記載のみ)。API 仕様側の確認は **未実施** |
| 子機の参加手順 | `WifiNetworkSpecifier` で参加。固定 SSID なので「常に許可」で承認が記憶され、**ダイアログが消えた** | 同じ `WifiNetworkSpecifier`。SSID が毎回違うなら承認が毎回要る(planner の `approve-join-each-time`) | Direct の承認記憶: SPEC §5「✅ 実機(2 台)」。LOHS の毎回承認は docs / planner の想定で、**実機未検証** |
| 子機の「再利用」 | 同じ SSID で接続済みなら張り直さない(`joinedSsid` 比較)。親機のグループ作り直しでも同じ SSID なので、子機は同じ値で再参加できる | 作り直すと SSID/パスが変わる前提のため、再参加には新しい接続情報が要る | コード: `joinWifi` の `reused`。LOHS の再作成で値が変わるかは **未検証**(同一セッション内で同じ予約を使い続ける間は同じ) |
| GMS(Nearby)の帯域アップグレードとの競合 | **競合した記録がある**。Direct の固定グループが生きている最中に Nearby が(再)接続すると、GMS が帯域アップグレード先に WIFI_DIRECT を選び、`Remove current P2P group because P2P resource is unavailable` で固定グループを撤去(razr 09:01:49 / 09:07:46 / 09:20:48 / 09:26:41。09:26 は clients=0)。公開 API に止める手段がないため suspend 設計で Nearby を止める | **未検証**。Nearby が LOHS を使う/壊すかの記録はない。LOHS が P2P と別のリソースを使うかの確認も含め **未検証** | docs/LINK_STATE.md §なぜ、`src/link/directGuard.ts` 冒頭、`docs/GATEWAY_BUS.md` §1.1。実機ログ原本はこの repo に無い(時刻の記録のみ) |
| 親機の Wi-Fi(STA)との同時利用 | STA + P2P は **razr で作れた**(`staP2pConcurrent` を観測で保存)。5GHz は使わず 2.4GHz 固定、STA が 2.4GHz ならそのチャンネルに合わせる | **razr 50 ultra は STA 接続中に LOHS(AP)を作れない**(`staApConcurrent=false` 型)。他機種は `isStaApConcurrencySupported`(API 30+)で確認できるが、API 29 以下は不明 | SPEC §7「機種依存」、`planner.ts` の `hostLohsBlockedBySta`、`planner.test.ts` の razr 型、`tether.ts` の `observe('staP2pConcurrent')`。Pixel 7a の値は **未検証**(診断レポートは sony の API28 の 1 件のみ) |
| 同時クライアント数 | Planner 上は Direct = 1(設計上限。固定 SSID がペアごとに異なるため)。グループ自体の上限は **未検証** | Planner 上は 4(**暫定値、未検証**と明記済み) | `planner.ts` の `maxGuests` コメント、SPEC §9.5 根拠表 |
| 権限 | `NEARBY_WIFI_DEVICES`(33+)または `ACCESS_FINE_LOCATION` | LOHS 起動にも位置情報/`NEARBY_WIFI_DEVICES` が要る(`CapabilityProbe.probeLohs` が `SecurityException` を `permission` に分類)。差があるか、API 33+ で `NEARBY_WIFI_DEVICES` だけで足りるかは **未検証** | `HotspotModule.kt` の startDirect コメント(createGroup と同じ権限)、`CapabilityProbe.kt`、`permissions.ts`。アプリ全体の権限は Nearby 用に既に広く取っている |
| VPN との関係 | 子機は VPN の外(`addDisallowedApplication`)から SOCKS で親機へ。`bindProcessToNetwork` で参加した Wi-Fi に固定 | 同じ(リンク種別を区別しない) | `TunnelService.kt`、`tether.ts` の `startVpn`。LOHS での実機確認は **未検証**(SPEC §5「子機の VPN 経由でインターネット ✅ 実機(初回)」は方式の記載なし) |
| 距離による切断→復帰 | ✅ | ✅ | SPEC §5「✅ 実機(LOHS・Direct)」(詳細ログなし) |
| 消滅の検知 | `onDirectGroup`(P2P ブロードキャスト)。「アプリが消したか」も判別 | `onHotspotStopped` はあるが JS 未購読(§1.3) | コード |
| バス(ZeroMQ)・Echo・SOCKS | 動作する(第 1 段まで実装。実機確認の範囲は `GATEWAY_BUS.md` §11.5) | バスは起動しない(`startBusHost` が Direct 専用)。Echo・SOCKS は動く(`tether.test.ts` のフォールバック) | コード、テスト |
| 起動までの時間・再作成の安定 | Direct: 帯域候補ごとに最大 15 秒待つ、BUSY は段階的に片付ける | 3 回リトライ(間 2 秒) | コード。**実測値は無い(未検証)** |
| Doze / 画面オフ | 未検証(SPEC §5 に「⬜ 未検証」) | 未検証 | SPEC §5 |

## 5. 実機で比べる項目と手順(b6 向け)

前提: 親機 = razr 50 ultra、子機 = Pixel 7a(SPEC §10.2)。さらに、入れ替えた組(親機 = Pixel、子機 = razr)も 1 回ずつ。方式は **Planner の既定に任せず固定して試す**(§3 の B が入るまでは、`probeLohs` と `capabilities` の診断レポートを採り、LOHS を先に試させるには Direct を一時的に使えない状態にする必要がある。B を先に入れる PR が前提 → §6 の PR 2)。

### 5.1 共通の準備
1. 両端末で診断レポートを採取し(`docs/SPEC.md` §10.0)、`docs/device-reports/` に追加する前に目で確認する。
2. 両端末をバッテリー最適化から除外、Nearby 権限・VPN 許可は済ませる。ペア済みの状態で開始。
3. 記録欄(ログの `DH-P2P` / `DH-LINK` / `DH-NEARBY` / `DH-ECHO` / `DH-BUS`)を端末ごとに保存。1 条件ごとに時刻を控える。
4. 条件は 1 つずつ変える。親機 Wi-Fi は「接続あり(2.4GHz)」「接続あり(5GHz)」「未接続」を各 1 回。

### 5.2 比べる項目
| # | 項目 | 手順 | 記録するもの |
|---|---|---|---|
| 1 | 接続までの時間 | 共有開始〜子機の `join ok`〜到達確認 OK〜VPN `on` を 5 回ずつ。コールドスタート(両アプリ停止から)とウォーム(Nearby 接続済み)の両方 | 各区間の ms(ログの時刻から)。失敗回数、Direct の帯域候補で何番目に成功したか |
| 2 | 承認ダイアログ | 初回、2 回目、親機アプリ再起動後、親機の共有を止めて再開した後 | ダイアログが出た回数。LOHS は SSID が毎回変わるかを `ssid=` ログで確認 |
| 3 | 再接続 | 子機を離す(親機から 50m 目安、または電波遮蔽)→ 戻す。親機の共有を停止→再開。親機のグループ/ホットスポットを OS 側で落とす(Wi-Fi トグル) | 戻るまでの時間。子機が新しい資格情報を受けられたか(LOHS)。LOHS の消滅を親機が検知できたか(現状は不可のはず。結果を記録) |
| 4 | Doze | 画面オフ+充電なしで 30 分放置 → 戻る/Echo(または バス)の生存信号の途切れを確認。可能なら `adb shell dumpsys deviceidle force-idle` を b6 の判断で | 途切れた時刻、復帰の時間 |
| 5 | 画面オフ | 両端末の画面オフで 10 分、その間に子機で通信(Chrome / Maps) | 通信の成否、VPN の継続 |
| 6 | バス・Echo の安定 | Direct はバス併用(suspend)、LOHS は Echo 中心。30 分間、生存信号の欠落回数・切断回数 | `busStatus` / Echo の受付間隔・切断回数。LOHS で Nearby を止めてよいか(下の 7) |
| 7 | Nearby と各リンクの競合 | **各リンクが張れている間に Nearby を意図的に再接続させる**(Direct: 既に記録があるので再確認、LOHS: 新規の確認)。Nearby 再接続の前後で、グループ/ホットスポットが消えていないか | `Remove current P2P group…` や AP の停止ログの有無、clients 数。LOHS で消えるかどうかが §2 の「Nearby を止める条件」を決める |
| 8 | 同時利用 | 親機の Wi-Fi 接続を保ったまま共有を開始(Direct / LOHS 各)。razr で LOHS が作れないことの再現、Pixel 7a では作れるか | `startLocalOnlyHotspot` の失敗理由(`probeLohs` の固定語)、`staApConcurrent`、親機の Wi-Fi の切れ方 |
| 9 | バス bind 先 | LOHS 中の親機で、AP インターフェース名と IPv4 を控える(`ip addr` 相当の診断、または `BusEngine` のログ) | インターフェース名。`p2p*` で見つかるか、ワイルドカードに落ちるか |
| 10 | 権限 | 位置情報だけ許可 / `NEARBY_WIFI_DEVICES` だけ許可(API 33+)で各方式が動くか | 失敗の例外名 |
| 11 | 複数子機(余力があれば) | LOHS で 2 台、Direct で 2 台目が弾かれるか | 同時クライアント数の上限の実測 |

### 5.3 判定の目安(案)
- 「LOHS を第一候補にしてよい」: 1・3・6・7 で Direct と同等以上、かつ 7 で Nearby 再接続に壊されない。
- 「LOHS は予備のまま」: 3 の再接続が資格情報の再送を要して遅い、または 7 で壊れる、または 8 で razr が作れない。
- 判断は数値でなく「どの機種で・どの条件で」を表にして残す(推測で機種プロファイルを作らない)。

## 6. 段階的な移行案(PR 分割)

keep 方式の廃止(`feat/remove-keep-mode`)と Echo の廃止(`GATEWAY_BUS.md` §11.4 の ①〜④)との順序を先に置く。リンク層の PR は `tether.ts` の同じ箇所(`tryDirect` / `buildShare` / `startVpn` / `onConnected`)を触るため、keep 削除 PR が先にマージされている方が衝突が少ない。

| 順 | PR | 内容 | 前提・衝突 |
|---|---|---|---|
| 0 | keep 削除(別サブエージェント作成中) | `nearbyWhileDirect` の廃止、suspend 一本 | これが先。`docs/LINK_STATE.md`・`API.md`・`GATEWAY_BUS.md` を触る |
| 1 | 本メモ(docs のみ) | この文書 | 他 docs は SPEC にリンク 1 行のみ |
| 2 | **設定による方式の固定(§3 の B)+ LOHS の消滅通知** | `TetherConfig.linkPreference`、`plan.reasons` に理由コード、`onHotspotStopped` を JS で購読して `onState` 相当に。UI は診断画面だけ。**挙動は既定 `auto` で不変** | 0 の後。§5 の比較に必要なので実機比較の前に入れる |
| 3 | 実機比較(b6)、結果を `docs/LINK_LAYER.md` §4 に追記 | コード変更なし | 2 の後 |
| 4 | リンク層の型と親機/子機の分岐の整理(§2) | `HostLink` / `GuestLink` を導入し、`tryDirect` / `tryLohs` をその実装に。ネイティブの関数名は変えない。テストは `fakePlatform` に合わせる | 3 の結果で LOHS を第一級にするか決めてから |
| 5 | LOHS でもバスを起動 | `startBusHost` を方式に依存させない。bind は AP インターフェースが特定できればそこへ、無ければワイルドカード+認証。Nearby を止める条件を `HostLink.onState` に | 3 の項目 7・9 の結果が前提。**バス第 2 段(Echo 縮小)とは独立** |
| 6 | Echo / SOCKS の bind をリンクのアドレスに揃える | SPEC §4 との不整合の解消(GATEWAY_BUS §7.1・§10 で予定済み) | 5 と同じ頃。Direct だけでも先にできる |
| 7 | (任意)機種プロファイル(§3 の C) | データが 3 機種以上たまってから | — |

Echo 廃止との順序: Echo の縮小・廃止(GATEWAY_BUS §11.4 ③④)は「バスが Echo 同等に切断を検知できる」ことの実機確認が前提。LOHS ではバスが起動しない間は **Echo が唯一の生存信号**なので、PR 5(LOHS でバス)が入るまでは、LOHS 経路の Echo を残す。つまり **Echo の廃止は PR 5 の後**、かつ LOHS を第一級の方式として残すなら、その方式でバスの生存検知が実機で確認できてから。
keep 廃止との関係: keep 方式は「Direct 中も Nearby を保つ」ものだった。廃止後は Direct 中は Nearby を常に止めるので、リンク層側でも「リンクが up の間は Nearby を止める」が前提になる。LOHS でこの前提が妥当か(LOHS に GMS の帯域アップグレードがかかるか)は §5 の項目 7 で決まる。

## 7. 未決事項

1. **LOHS が GMS(Nearby)の帯域アップグレードで壊されるか**。壊れないなら LOHS では Nearby を止めなくてよい(制御を Nearby のまま運べる)。壊れるなら Direct と同じく止める。
2. **LOHS の SSID が毎回変わる/再作成で変わる**ことの実機確認(承認ダイアログの頻度と、再接続の設計に直結)。
3. **LOHS 再作成時の資格情報の再送**を、Nearby を止める運用とどう両立するか(バスが使えない間は Nearby を再開するしかない可能性)。
4. **LOHS の AP インターフェース名/アドレス**(バスや SOCKS の bind を絞れるか。ワイルドカード+認証のままでよいか)。
5. **LOHS の消滅を親機が検知する手段**(`onHotspotStopped` のみで足りるか、予約が OS に奪われるケース)。
6. **機種ごとの STA+AP 同時動作**(razr 型は LOHS 不可。Pixel 7a は未確認)。LOHS を第一候補にするなら、親機の Wi-Fi を一時的に切る運用が要るかどうか。
7. **同時クライアント数**(Direct の上限、LOHS の暫定値 4)。
8. **選択方式**: 設定(B)を製品に出すか、診断専用にとどめるか。機種プロファイル(C)の置き場(端末内か、配布するデータか)。
9. **権限**: LOHS と Direct で必要な権限が実際に違うか(API 33+ の `NEARBY_WIFI_DEVICES` のみで両方足りるか)。Play の申告(`docs/play-console-declarations.md`)に影響しうる。
10. **セキュリティ表現**: リンク層が Direct のとき WPA2/WPA3-PSK によるリンクの保護に頼る前提が `GATEWAY_BUS.md` §7.3 にある。LOHS でも同等か(LOHS の保護方式は端末依存の可能性があり **未検証**)。バスはリンクとは別にペアの鍵による認証を持つ(`GATEWAY_BUS.md` §7.2)。利用者向けの文面で暗号化に触れない方針は変えない。
11. 子機が別 Wi-Fi に接続中のとき(`staLocalOnlyConcurrent`)の挙動の方式差(SPEC §7 の既知の制約)。
