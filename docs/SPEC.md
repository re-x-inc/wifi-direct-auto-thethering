# Wi-Fi Direct Tethering Auto Connect(仮称)— 製品仕様

配達ヘルパーとは**別アプリ**として、一般向けに公開する(Google Play)。
目的は、「回線を持つ端末(親機)」と「回線を持たない端末(子機)」を、一度ペアにしたら**人手なしで自動接続・自動復旧**させること。

## 1. 社会から見た位置づけ
- **困りごと:** テザリングは勝手に切られる。毎回手動で入れる。接続のたびに承認ダイアログが出る。
- **使う場面:** 配達員、現場作業、車載、キャンプなど、親機と子機が常に近くにいる場面。
- **約束すること:** 近づけば繋がる。離れて戻れば自動で戻る。子機は親機の回線でインターネットに出られる。

## 1.5 役割の決め方
- **親機 = セルラー回線がある端末。** 回線を子機へ中継する。**子機にもなれる**(回線があっても、手動で子機として使える。別の親機から回線を借りたいとき)。
- **子機 = セルラー回線がない端末。** 親機の回線で通信する。
- **自動判定:** 起動時に、セルラーの `INTERNET` 能力を持つネットワークがあれば親機、なければ子機にする。回線の有無が変わったら、役割も見直す(確認ダイアログまたは通知で)。
- **手動切り替え:** 回線のある端末でも、「子機として使う」を選べる。
- **衝突の扱い:** 両方の端末に回線がある場合は、**自動では決めない**(両方が親機になって、誰も子機にならないため)。ユーザーが片方を子機にする。ペアに子機が見つからない親機は、待機して表示する。

## 2. 方式(実機で確認済み、2026-10-20)
```
子機アプリ ─ VPN(hev-socks5-tunnel) ─ Wi-Fi Direct ─ 親機 SOCKS5 ─ 携帯回線
        └──── Nearby Connections(制御: 認証・接続情報・状態) ────┘
```
| 層 | 採用 | 理由 |
|---|---|---|
| 制御 | Nearby Connections(低電力・Bluetooth のみ) | 自動検出・自動再接続が確認済み。Wi-Fi 共有と無線を取り合わない |
| データリンク | **Wi-Fi Direct(固定 SSID・固定パスフレーズ・ch は動的)** | 固定にすると OS が承認(「常に許可」)を覚え、ダイアログが出なくなった |
| 予備 | LocalOnlyHotspot | 承認が毎回必要(SSID が毎回変わる)。機種によっては Direct と同時に使えない |
| 中継 | 親機の SOCKS5(CONNECT、ユーザー/パスワード認証) | 子機の VPN から全通信を受ける |
| 子機の取り込み | VpnService + hev-socks5-tunnel(mapdns で DNS をドメイン名つき CONNECT に変換) | UDP 中継なしで名前解決できる |

## 3. 機能要件
1. **初回ペアリング(1回だけ):** 親機側で「親機にする」(広告して待つ)、子機側で「子機にする」(親機を探して接続要求)を押す。役割はペアに保存し、以後の自動接続に使う → 両画面に出る数字が一致することを確認して承認 → ペア固有の共有コードを交換し、SecureStore に保存。
2. **自動接続:** Nearby が相手を見つけて、共有コードで相互認証(HMAC)する。
3. **自動共有:** 親機は共有を開始し、固定の Direct グループ、SOCKS5、エコーを**先に**起動する。接続情報(SOCKS 資格情報)は、認証済みの Nearby 経路でだけ子機へ渡す。
4. **自動復旧:** 距離で切れても、Nearby が戻れば接続情報を再送し、子機は同じ SSID を再利用する。切れている間、子機の VPN は自動で落ちる(fail-open)。
5. **状態表示と非常口:** 子機に「VPN 停止」ボタン。通信できないときに、手動で素の通信へ戻せる。

## 4. セキュリティ設計(リリース必須)
| 項目 | 現状 | 本番 |
|---|---|---|
| 共有コード | 固定の開発用文字列(**配布不可**) | ペアごとのランダム 32 バイト。SecureStore 保存。ペアリング時に数字照合 |
| Direct の SSID / パスフレーズ | 開発用の共有コードから導出 | ペアの共有コードから HMAC で導出(端末ごとに異なる)。保存はしない(毎回導出) |
| SOCKS5 資格情報 | 共有のたびにランダム | 現状維持(Nearby の認証済み経路でのみ送る) |
| SOCKS5 の公開範囲 | Direct/LOHS のインターフェースのみ | 子機以外から届かないことを検証する(他の端末が Direct に参加した場合の扱い) |
| ペアの解除 | なし | 親機・子機の双方で削除でき、削除すると共有コードを破棄する |
| ログ | `console.log` に nonce の先頭を出す | 本番ビルドでは出さない |

## 5. 検証計画
| 項目 | 状態 |
|---|---|
| Nearby 自動接続、停止→再開始での復帰 | ✅ 実機(2 台) |
| 固定 SSID の Direct で承認ダイアログが消える | ✅ 実機(2 台) |
| 距離による切断→復帰 | ✅ 実機(LOHS・Direct) |
| 子機の VPN 経由でインターネット | ✅ 実機(初回) |
| バックグラウンド・画面オフ・Doze での維持 | ⬜ 未検証 |
| 親機アプリの再起動後の復旧 | ⬜ 未検証 |
| Chrome / Google Maps の実使用 | ⬜ 未検証 |
| 機種違い(最低 3 機種。STA/P2P/AP の同時動作の違い) | ⬜ 未検証 |
| 長時間(1 時間以上)の安定性、電池消費 | ⬜ 未検証 |
| 子機が Wi-Fi に未接続の条件での Suggestion | ⬜ 未検証 |

## 6. Google Play 申告(想定)
- `VpnService`: VPN 用途の申告と、プライバシーポリシー(通信は親機を経由すること、内容を保存しないこと)。
- フォアグラウンドサービス(`connectedDevice`): 親機・子機の接続維持。
- 権限: 位置情報(Wi-Fi/Nearby の要件)、Nearby Wi-Fi デバイス、Bluetooth、通知。
- アクセシビリティ: **使わない**。配達ヘルパー(Uber の画面読み取り)とは別アプリにして、権限を混ぜない。

## 7. 既知の制約と対応
- **UDP:** SOCKS5 の UDP ASSOCIATE に対応(DNS は mapdns、それ以外の UDP は中継)。QUIC・通話は通る想定だが、実機で検証する。
- **機種依存:** 検証した機種(Razr 50 ultra)は STA+P2P の状態で AP(LOHS)を作れない。Direct を主、LOHS を予備にする。
- **キャリア規約:** 回線の共有が規約に触れる場合がある。ストアの説明とアプリ内に注意書きを置く。
- **子機が別 Wi-Fi に接続中:** Suggestion は効かない。Direct + 承認の記憶を主にする。

## 8. マイルストーン
1. **コアの切り出し:** `modules/hotspot`、`nearby-link`、`vpn-tunnel`、`src/link/*` を、独立アプリ(別ディレクトリ)に移す。配達ヘルパー側は、コアを参照する形にするか、複製を止める。
2. **本番の認証:** ペアリング画面、共有コードの生成・保存・解除、Direct の導出。
3. **UI:** 親機/子機の役割選択、ペア一覧、状態(接続・共有・VPN)、非常口。開発用の画面は削除。
4. **耐久テスト:** バックグラウンド、画面オフ、離れて戻る、機種違い。
5. **クローズドテスト:** 内輪に配布 → Play の内部テスト → 製品ページ・プライバシーポリシー。

## 9. 能力の交換と方式判断
目的: 「Direct を試す → だめなら LOHS」と**失敗してから**切り替えると、承認ダイアログの無駄や次の接続の妨害が起きる。接続の**前**に、認証済みの Nearby 経路の上で端末の能力を交換し、親機が方式を決めてから起動する。
実装: `src/api/capability.ts`(能力の型・保存・照合)、`src/api/planner.ts`(Link Planner。純関数)、`src/api/tether.ts`(交換と起動の流れ)。ネイティブは `modules/hotspot` の `capabilities()` / `probeLohs()`。

### 9.1 能力の項目(自己申告。実際に困るものだけ)
値は `true` / `false` / `null`(不明)。**取得できない項目は null を返し、推測しない。** 「根拠」は `source`(api = 公式 API / probe = 実際に試した / observed = 運用で観測)に入る。

| 区分 | 項目 | 取得元 | 備考 |
|---|---|---|---|
| 端末 | manufacturer / model / sdk / release | `Build.*` | 機種名として共有してよい情報 |
| 端末 | batteryPercent | `ACTION_BATTERY_CHANGED` | 版(rev)の計算には含めない |
| 端末 | batteryOptimizationExempt | `PowerManager.isIgnoringBatteryOptimizations` | 省電力除外の可否 |
| 回線 | cellular | 既存の `hasCellular()` | INTERNET 能力つきのセルラー |
| 無線 | wifiDirect | `WifiManager.isP2pSupported()`(API 21〜)。取れなければ `FEATURE_WIFI_DIRECT` | |
| 無線 | lohs | **公式 API なし** → 試験(`probeLohs`)の結果のみ | 試すまで null |
| 無線 | staApConcurrent | API 30+ `WifiManager.isStaApConcurrencySupported()` | 未満は null |
| 無線 | staP2pConcurrent | **公式 API なし** → 運用の観測(Wi-Fi 接続中に Direct を作れた) | 観測するまで null。「作れなかった」は理由が多様なので false にしない |
| 無線 | p2pApCoexist | **公式 API なし** → 観測のみ | Direct グループと AP の同居。現状は観測する経路が未実装(§9.9) |
| 無線 | staLocalOnlyConcurrent | API 31+ `isStaConcurrencyForLocalOnlyConnectionsSupported()` | 子機が別 Wi-Fi につないだまま参加できるか |
| 無線 | band24 / band5 | band24: API 31+ `is24GHzBandSupported()` / band5: `is5GHzBandSupported()` | band24 は API 31 未満で null |
| 状態 | vpnConsent | `VpnService.prepare() == null`(ダイアログは出さない) | |
| 状態 | deviceOwner | `DevicePolicyManager.isDeviceOwnerApp` | |
| 状態 | alwaysOnVpn | 常に null | `VpnService.isAlwaysOn()` は VPN サービス稼働中しか判定できず、外部から問い合わせる公式 API がない |
| 状態 | missingPermissions | `checkSelfPermission`(その Android 版に存在する権限のみ) | |
| アプリ | v / features | `PROTOCOL_VERSION`(=1) / `['link-plan']` | |

意図的に使わないもの: `isStaConcurrencyForMultiInternetSupported`(STA 2 本で同時にインターネットへ出る機能の可否。テザリングの方式判断には関係しない)。
共有しないもの: 配達の内容、画面の生テキスト、共有コード、SOCKS5 資格情報、Wi-Fi のパスフレーズ。

### 9.2 実際に試して端末内に保存するもの
- `probeLohs`(**自動では実行しない。** `Tether.runProbe()` を診断画面などから利用者が明示的に呼ぶ): LocalOnlyHotspot を一瞬だけ起動して閉じ、作れたかを保存する。承認ダイアログは出ないが、**機種によっては Wi-Fi(STA)が一時的に切れる**。共有中は `busy` で実行しない。失敗理由は固定語(`no-channel` / `generic` / `incompatible-mode` / `tethering-disallowed` / `permission` / `busy` / `timeout`)。`permission`・`busy`・`timeout`・`error` は「試せなかった」だけなので lohs=false とは判断しない。
- 運用の観測: Wi-Fi 接続中に Direct を作れたら `staP2pConcurrent=true` を保存する。
- 保存先は端末の KeyValue(`tether.probe.v1`)。機種・Android 版(`model|sdk`)が変わったら無効。
- 方式ごとの結果履歴(`tether.history.v1`、ペアごと・直近 10 件): 親機が作れたか(create)/ 子機が参加できたか(join)を、固定語の分類だけで残す(メッセージ本文は残さない)。

### 9.3 ハンドシェイクの順序
前提: Nearby の共有コード認証(HMAC)が済んだ経路でだけ流す。いずれも `tether.*` の内部メッセージで、アプリのメッセージとは混ざらない。

```
子機                                         親機
 │  (Nearby 接続 + 認証)                      │
 ├─ tether.hello {v, rev} ──────────────────▶│  rev = 能力の内容の版
 │                                           │  キャッシュの rev と同じ → 交換を省略
 │◀──────────────── tether.caps-req {v} ─────┤  違う/無い → 要求
 ├─ tether.caps {v, rev, caps} ─────────────▶│  検証(sanitize)→ キャッシュ保存
 │                                           │  Link Planner で方式を決める
 │◀──────────────── tether.plan {v, plan} ───┤  決定を通知
 │  事前にすべきこと(権限・VPN 同意)を実行    │  plan.order の順で Direct / LOHS を起動
 │◀──────────────── tether.wifi {接続情報} ──┤  既存の接続情報(認証済み経路のみ)
```
- 親機は、起動(`start`)時に**キャッシュした子機の能力**があればそれで計画を作り、子機を待たずに共有を準備する(従来の「先に起動」を保つ)。無ければ、子機の能力を最長 `capsWaitMs`(既定 5 秒)待つ。来なければ「子機の能力は不明」として既定の順序で決める。
- 後から子機の能力が届き、作った方式が新しい判断の `order` に含まれなければ、共有を作り直す(最大 2 回)。
- **互換:** 交換に対応していない相手とは、従来どおり(Direct → LOHS)で動く。対応していない親機は `tether.hello` を無視し、対応していない子機は計画を無視する。
- 子機は計画に従う: `grant-permissions`(権限要求)と `vpn-consent`(VPN 許可)は、端末のダイアログを出すところまで行う(**承認の操作は自動化しない**)。それ以外は状態(`TetherState.plan`)に出す。

### 9.4 キャッシュと無効化
- 親機が子機ごとに保存: `{ v, rev, at, caps }`(`tether.capcache.v1`)。
- 交換の省略: hello の `rev` と一致し、有効期間(30 日)内で、プロトコル版が同じとき。
- 無効化: プロトコル版が変わる / 30 日経過 / `rev` が変わる(能力・状態の内容が変わった。電池残量は除く)/ ペアを解除する(キャッシュと履歴を削除)。
- 履歴の使い方: 同じ方式の直近 2 件(14 日以内)がどちらも失敗なら、その方式を後ろへ回す(除外はしない)。成功が挟まればリセット。

### 9.5 Link Planner(純関数)
`planLink({ host, guests, history?, policy?, now? }) → LinkPlan`

- 入力: 親機の能力、**接続中・接続要求中の子機の一覧**(各子機: `peerId` / `paired` / `state`(requesting・connected)/ `caps`(未交換は null)/ `method`(接続中の方式))、ペアごとの履歴、方針(§9.7)。
- 出力: `ok` / `order`(試す方式と順序)/ `primary` / `guests[]`(子機ごとの `admission`(admit・defer・reject)・`method`・`todo`・`reconnect`)/ `reasons[]`(コード・重大度・日本語の説明)/ `guestTodo`(事前にすべきことの和集合)/ `ignored`(未ペアの端末 ID)/ `band` / `failure`(使えないときの理由コードと更新が必要な側)/ `summary`(1 行)。
- 方式は `METHODS`(Direct / LocalOnlyHotspot)の定義に足せば増やせる。不明(null)は「使える」側に倒して実際に試し、`capability-unknown` を理由に残す。

#### 判断の規則(1 台)
1. 版の照合 → 親機の条件(回線・権限・周波数帯)→ 方式の候補 → 順序。
2. 既定は Direct → LOHS。履歴で Direct が続けて失敗していれば LOHS → Direct。
3. 明示的に `false` の項目だけで除外する(wifiDirect=false → Direct 除外、lohs=false → LOHS 除外)。両方除外なら `no-usable-method`。

#### 判断の規則(複数台)
- **1 台 = 従来どおり(固定 SSID の Direct を主)。2 台以上 = LOHS を優先**(AP 型で複数クライアントに向く)。
- 台数に数えるのは**ペア済みの端末だけ**。未ペアは `ignored` に ID だけ入れ、理由コード・ログは出さない。
- 方式ごとの上限(既定 Direct = 1 / LOHS = 4)。超えた子機は方針に従い `defer`(待たせる)または `reject`(断る)で、理由コード `guest-limit-reached` を返す。
- **LOHS に切り替えられない機種(razr 型: Wi-Fi 接続のまま AP を作れない = `staApConcurrent=false`)**: Direct を維持する。超えた分は `defer`/`reject` + `guest-limit-reached`(`multi-direct-kept-no-lohs`)。
- **既に Direct で接続中の子機がいて 2 台目が来たとき**: 既定は**既存を切らない**(`existingConnection: 'keep'`)。2 台目は `wait-existing-direct` で待機。方針を `'switch'` にすると、LOHS へ切り替え、既存の子機の `todo` に `reconnect` を入れて**再接続を指示**する(`switch-to-lohs-for-multi`)。`p2pApCoexist=true`(Direct と AP の同居を確認済み)なら、既存はそのまま新規だけ LOHS にする(`lohs-added-beside-direct`)。
- **SOCKS5 資格情報は子機ごとに別**(`perGuestCredentials: true`、発行は `issueGuestCredentials`)。LOHS の SSID/パスフレーズは AP 共通なので、各子機の認証済み Nearby 経路で個別に渡す。
- LOHS を選ぶと、子機の `todo` に `approve-join-each-time`(SSID が毎回変わるため承認が毎回要る)、Direct なら `approve-join-once`(初回だけ)が入る。

#### 根拠(公式ドキュメントでの確認状況)
| 点 | 状況 |
|---|---|
| Wi-Fi Direct の 1 グループ内の最大クライアント数 | **未検証**。公式ガイド(developer.android.com/develop/connectivity/wifi/wifi-direct)に上限の記載なし。「3 台以上が 1 台につながる場合は group owner を決める」とあるのみ |
| Wi-Fi Direct の接続時の承認ダイアログの扱い | **未検証**(ガイドに記載なし)。「固定 SSID・パスフレーズで承認が記憶される」は 2 台の実機記録(docs/USER_JOURNEY.md)のみ |
| 固定 SSID の Direct が複数ペアに向かない理由 | 設計上の事実: SSID・パスフレーズはペアの共有コードから導出する(§4)ため、1 つの group には 1 ペア分の資格情報しか載らない。よって Direct の上限は設計上 1 とした |
| LOHS の最大クライアント数、Direct との同居、エラー定数の意味 | **未検証**(`WifiManager` のリファレンスは取得できず、この調査では読めていない)。LOHS の上限 4 は暫定値。端末依存の可能性が高い |
| API レベル(`isP2pSupported` = 21、`isStaApConcurrencySupported` = 30、`is24GHzBandSupported` / `isStaConcurrencyForLocalOnlyConnectionsSupported` = 31 ほか) | **確認済み**: SDK 付属の `platforms/android-36/data/api-versions.xml`(各 API の since)で照合した。診断レポートの `minApi` もこの値。なお初版で `isP2pSupported` を 33 としていたのは誤りで、21 に訂正済み |

### 9.6 理由コード
| コード | 重大度 | 意味 |
|---|---|---|
| `protocol-guest-outdated` / `protocol-host-outdated` | block | 版の不一致。子機/親機のアプリ更新を促す(`failure.update` = guest/host、イベント `update-required`) |
| `host-no-cellular` / `host-no-cellular-guest-has` / `no-cellular-both` | block | 親機に回線がない / 子機にはある(役割を入れ替え)/ 双方ない |
| `host-permission-missing` | block | 親機の権限不足 |
| `no-common-band` | block | 共通の周波数帯がない |
| `host-no-wifi-direct` / `host-no-lohs` | warn | 該当方式が使えない |
| `no-usable-method` / `no-guest` | block | 使える方式がない / 相手がいない |
| `guest-limit-reached` / `wait-existing-direct` / `multi-direct-kept-no-lohs` / `lohs-needs-sta-off` | warn・info | 台数上限・待機・Direct 維持(複数台) |
| `switch-to-lohs-for-multi` / `lohs-added-beside-direct` / `multi-prefers-lohs` | warn・info | 方式の切り替え・追加・複数台の既定 |
| `history-direct-demoted` / `history-lohs-demoted` | info | 履歴による順序の入れ替え |
| `direct-approval-remembered` / `lohs-approval-each-time` / `lohs-after-direct-teardown` / `sta-ap-not-concurrent` / `both-have-cellular` / `capability-unknown` / `guest-caps-unknown` | info | 注意・補足 |
| `guest-vpn-consent-needed` / `guest-permission-missing` / `battery-optimization-on` | warn・info | 子機が事前にすべきこと |

### 9.7 方針(`TetherConfig.planPolicy`)
`maxGuests`(既定 `{ WifiDirect: 1, LocalOnlyHotspot: 4 }`)/ `existingConnection`(`'keep'` 既定 | `'switch'`)/ `overLimit`(`'defer'` 既定 | `'reject'`)。

### 9.8 ログ・プライバシー
診断ログに出すのは機種名・能力・理由コードだけ。共有コード・SOCKS5 資格情報・パスフレーズは出さない。未ペア端末の要求は理由もログに出さない。

### 9.9 現状の範囲と未実装
- **実行時は 1 組(親機 1 台 + 子機 1 台)**。`Tether` は今のところ 1 つのペアとだけ Nearby リンクを張る。複数子機の**判断**(Planner)は実装・テスト済みだが、親機が複数の Nearby リンクを同時に持ち、子機ごとに SOCKS5 資格情報を分けて SOCKS サーバーに登録する**実行時の対応は未実装**(`issueGuestCredentials` は用意済み。`SocksServer` は単一の資格情報)。
- `p2pApCoexist` を観測する経路(Direct 稼働中に LOHS を試す試験)は未実装。実機で手動確認する(§10)。
- 常時 VPN(`alwaysOnVpn`)は取得できない(§9.1)。

### 9.10 診断レポート(網羅採取。Planner とは分ける)
方針: 「実際に困るものだけ」に絞らず、端末から取れるものを網羅的に採取して**診断レポート**に保存する。方式判断(Planner)は引き続き §9.1 の必要な項目だけを参照する。

- **範囲の分離:** ハンドシェイクで相手へ送るのは `Capabilities`(§9.1)だけ。診断レポート全体は送らない。端末内のファイルに保存し、外へ出るのは利用者が画面の「レポートを共有(JSON)」を押したときと、`adb pull` で取り出したときだけ。
- **採取しないもの(個人を特定できる値):** IMEI・電話番号・SSID・BSSID/MAC・アカウント・端末名・位置・シリアル・IP/DNS・SIM の識別子。ネイティブ側で採取せず、TS 側でも MAC / IMEI 相当 / 電話番号 / メールに見える文字列を含む項目は丸ごと `null`(`why: "redacted"`)にする(二重の防御)。
- **各項目の形:** `{ v, minApi, source, why?, official? }`
  - `v`: 値。取れなければ `null`(推測しない)
  - `minApi`: その API の追加された Android API レベル(`api-versions.xml` で照合)。版に依存しなければ `null`
  - `source`: `api` / `probe`(実際に試した)/ `observed`(運用で観測)
  - `why`: `v` が `null` の理由(`sdk<N` = Android 版不足 / `ex:クラス名` = 例外 / `unavailable` / `redacted` / `not-probed` / `not-observed`)
  - `official: false`: 公式 SDK に載っていない取り方(`Settings.Secure` の `always_on_vpn_app`、システムリソース `config_tether_*_regexs` の要素数)。
- **セクション(`sections`):**

| セクション | 内容 |
|---|---|
| `build` | メーカー・ブランド・機種・device・product・hardware・board・SDK_INT・release・codename・セキュリティパッチ・build ID・fingerprint・type・tags・ABI(全/64bit)・radio version |
| `app` | パッケージ名・versionName・versionCode・targetSdk(プロトコル版は `capabilities.v`) |
| `wifi` | WifiManager: 有効状態、2.4/5/6/60GHz、規格(11n/ac/ax/ad/be)、P2P、STA+AP / STA+STA(ローカル専用・Multi-Internet)/ ブリッジ AP / デュアルバンド同時 / make-before-break、TDLS、オフロード、RTT、Easy Connect、Enhanced Open、WPA3(SAE/Suite-B/H2E)、WAPI、WEP、Decorated Identity、TOFU、スキャン制限、提案上限、信号レベル上限 |
| `wifiP2p` | WifiP2pManager: サービス有無、Channel Constrained Discovery、Vendor Elements、Group Client Removal、GO の IPv6、Wi-Fi Direct R2、PCC |
| `wifiAwareRtt` | Wi-Fi Aware の可否・特性(サービス名/情報長)・Instant 通信、Wi-Fi RTT の可否 |
| `bluetooth` | アダプタ有無・状態、LE 2M/Coded PHY、拡張/周期広告、最大広告データ長、複数広告、オフロード |
| `nfcUwb` | NFC アダプタ有無・有効・Secure NFC、UWB フィーチャ |
| `cellular` | 電話機能(音声/SMS/データ)、フォン種別、SIM 状態(識別子は取らない)、データ有効・回線種別(権限が無ければ null)、マルチ SIM、モデム数、RTT、テザリング設定リソースの有無(非公式) |
| `power` | 電池(残量・状態・給電・温度)、省電力モード、Doze(通常/軽量)、Low Power Standby、対話状態、バッテリー最適化の除外、熱状態、App Standby バケット、バックグラウンド制限、データセーバー |
| `permissions` | 宣言済み・付与済み・未付与の全一覧 |
| `vpn` | 同意済みか、自アプリの常時 VPN(稼働中でないと判定不可 = null)、常時 VPN のパッケージ名(非公式)、他の VPN の有無 |
| `dpc` | Device Owner / Profile Owner(自アプリ)、有効な管理者の数(名前は取らない)、組織所有+仕事用プロファイル、ユーザー種別 |
| `features` | `hasSystemFeature` の関連フィーチャの全列挙(wifi / bluetooth / nfc / uwb / telephony / ethernet / usb / location / thread / device_admin / managed_users 等)と、主要フィーチャの有無 |
| `network` | 各ネットワークの transport と NetworkCapabilities の全能力、帯域目安、メータード、既定ネットワークの稼働 |
| `probe` | 試験・観測の結果: LOHS を作れたか・理由・時刻、STA+P2P / P2P+AP の観測(未実施は `not-probed` / `not-observed`) |

- **取り出し:** `tether.diagnosticReport()`(作る)/ `tether.saveDiagnosticReport()`(作って保存し、`{ report, fileName, json, summary, path }` を返す)。ファイルは `tether-diag-<メーカー>-<機種>-api<SDK>.json`(機種ごとに 1 つ)で、保存先は `Android/data/<パッケージ>/files/diagnostics/`。要約は `summarizeReport()`(人が読める文字列)。
- **機種比較:** 置き場 `docs/device-reports/`。`npm run diag:compare -- docs/device-reports --diff` で、機種間で値が違う項目だけの Markdown 表を出す。
- **診断画面(開発用):** アプリ下部の「診断(開発用)」。ボタンはすべて文字つき(アイコンだけは使わない)。「LocalOnlyHotspot を試す」は実行前に「Wi-Fi が一時的に切れる場合があります」の確認を出す。

## 10. 実機確認手順(未実施。実機で確認すること)
共通: アプリ(開発ビルド)を起動し、下部の「診断(開発用)」を開く。アプリを開始(`start`)したときの診断ログにも「能力 …」の 10 行が出る(Planner が使う項目のみ)。

### 10.0 診断レポートの採取(全機種で実施。Xperia を含む複数機種を比較する)
1. 「診断レポートを作って保存」を押す。画面に要約が出て、`tether-diag-<メーカー>-<機種>-api<SDK>.json` が端末内に保存される(保存先は画面に表示)。
2. 取り出す: (a) 「レポートを共有(JSON)」→ 自分宛て(Drive / メール)に送る、または (b) PC で `adb pull /sdcard/Android/data/<パッケージ名>/files/diagnostics/ ./` (読み取りのみ。端末は変更しない)。
3. 親機候補では、共有を止めた状態で「LocalOnlyHotspot を試す」を押す(確認で「試す」)。Wi-Fi が一時的に切れてもよいときだけ。押したあと、レポートが自動で作り直され、`probe.lohsCreated` が埋まる。**Wi-Fi が切れたかどうか、何秒で戻ったかを控える。**
4. 各機種の JSON を `docs/device-reports/` に置き、`npm run diag:compare -- docs/device-reports --diff` で比較する。個人を特定する値が入っていないか、置く前に目で確認する(`redacted` の項目があればその理由も控える)。
5. 見るところ: `wifi.*`(同時動作の判定、規格、帯域)、`wifiP2p.*`、`features.present`、`power.*`(Doze、バケット、最適化除外)、`vpn.*`、`dpc.*`、`permissions.denied`、`network.networks`(セルラーの有無と能力)、`why` が `sdk<N` / `ex:…` の項目(その機種では取れない)。
6. 項目ごとの結果を表(§10.4)へ書き戻す。**取れない項目が「不明」のままなのは異常ではない。** 取れた値が実機の振る舞い(例: razr の STA+P2P で AP 不可)と食い違う場合は、API の値より実機を信用し、その食い違いを記録する。

### 10.1 Xperia(子機)の能力値の採取
1. 機種名・Android 版を控える(設定 > デバイス情報)。Device Owner 設定の**前**と**後**の 2 回、§10.0 を実施する(`dpc.*`、`vpn.*`、`permissions.*` が変わる)。レポートは `-before` / `-after` を付けて保存し分ける。
2. 子機として開始し、診断ログの「能力」行も保存する。期待: `LOHS` は **不明**(子機では試さない)、`STA+AP` は API 30+ なら値あり、`子機のローカル専用 STA 同時` は API 31+ なら値あり。
3. 不明のまま残る項目と、`source`(api)の有無を表に書き戻す。
4. 親機と接続し、親機のログに「方式判断: …」、子機のログに「方式判断を受信: …」が出ること、子機の `todo`(権限・VPN 同意・省電力)が実態と合っていることを確認する。

### 10.2 親機(Pixel 7a / razr 50 ultra)の確認
0. §10.0 の診断レポートを採取する(Pixel 7a と razr 50 ultra の両方)。
1. 開始して「能力」行を保存。razr 型の期待: `STA+AP` = いいえ(API 30+ で false が返れば)。**返らない/true の場合は、razr の実記録(STA+P2P の状態で AP を作れない)と一致しない**ので、`STA+AP` の値は信用せず、手順 3 の試験で確かめる。
2. 初回接続: 親機のログ「方式判断」の `order`、実際に起動した方式(「Wi-Fi Direct 成功」または「LocalOnlyHotspot 成功」)が一致すること。承認ダイアログが想定どおり(Direct は初回のみ、LOHS は毎回)であること。
3. LOHS の試験(`runProbe()`。共有を止めた状態で、Wi-Fi が一時的に切れてもよいときだけ): 結果が保存され、再起動後の「能力」行の `LOHS` に `(probe)` が付くこと。失敗理由を控える。
4. 2 回目の接続: 子機の能力が変わっていなければ、親機が待たずに共有を始めること(ログに caps-received が出ない/cached になる)。
5. 履歴: Direct が 2 回続けて失敗する条件(同じ機種で再現できる場合)で、3 回目に LOHS が先になること。
6. 版の食い違い: 片方だけ古いビルドを入れた場合、新しい側に「更新してください」が出て、古い側は従来どおり動くこと。

### 10.3 複数台(実行時は未実装のため、判断のみ)
- 2 台目の端末が手元にない/実行時が未実装のため、実機では確認できない。判断は単体テスト(`src/api/planner.test.ts`)で確認済み。上限(LOHS 4 台、Direct 同居)は実機で測るまで暫定値。

### 10.4 記録する表(採取した値の書き戻し先)
| 項目 | Xperia(子機) | Pixel 7a(親機) | razr 50 ultra(親機) |
|---|---|---|---|
| 機種・Android 版(API) | | | |
| Wi-Fi Direct | | | |
| LOHS(probe) | | | |
| STA+P2P(observed) | | | |
| STA+AP(api) | | | |
| P2P+AP | | | |
| 2.4 / 5GHz | | | |
| 子機のローカル専用 STA 同時 | | | |
| 省電力除外 / Device Owner / VPN 同意 | | | |
| 初回接続で使われた方式・承認ダイアログ | | | |
