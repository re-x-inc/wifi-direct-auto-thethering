# 子機からインターネットへの外形監視と、LinkGovernor の watchdog 更新 — 設計メモ

状態: 設計メモ。2026-10-21 時点の origin/main(2190a35)を読んで書き、同日 Kaz の指示で **公開 API を 2 つの口(enable / update)に再編**した(§0・§1・§3〜§7 と新設の §11 を更新。実装は PR「外形監視のコア」)。
**実機で確かめていないことは「未検証」と明記する。推測は事実として書かない。**
前提として参照するだけの文書: `docs/LINK_STATE.md`(閾値 T_echo/T_direct/T_nearby と状態機械)、`docs/GATEWAY_BUS.md`(Direct 上のバス)、`docs/API.md`。
別作業で進んでいる「ZMTP heartbeat への移行(lastAliveAt の公開、restartLink)」と「アプリメッセージのバス専用化」は、**入る前提**で書くが、この文書はそれらを変更しない。

## 0. 要点

- **tether は probe の実装を抱え込まない。公開の口は 2 つ**(詳細は §11):
  - `tether.internet.enable(on, opts?)` — 有効/無効と設定(`intervalMs` / `failThreshold` / `recoverThreshold` ほか)
  - `tether.internet.update(success, at?, reason?)` — 実際に通信できたか。結果の出どころは問わない(既定の probe 供給元 = ネイティブ、またはアプリ/ネイティブが子機の VPN 越しの実通信で観測した成功・失敗)
  - 状態機械(§6)・`noteAliveAt` 連携・親機への報告(§7)・`state` / `linkSnapshot` への公開・設定の配布は **コア(`InternetMonitor`)** が担い、probe 本体(§2・§3 の SOCKS CONNECT + generate_204)は **差し替え可能な供給元(`ExternalProbe.kt` + `src/api/internetProbe.ts`)** として分ける。

- 外形監視は**子機(guest ロール)だけの仕組み**。probe の実行、internet 状態の保持、`noteAliveAt` への反映、watchdog の延命は、すべて子機の Tether とそのネイティブで完結する。
- **親機は何も probe しない。** 子機が probe の結果(ok / ng / unknown)をバスで報告し、親機は **ok の報告を受けた時刻で自分の watchdog を延命**して表示する。ng / unknown は延命せず表示のみ(§7)。
- probe の経路は「子機 → 参加した Wi-Fi(Direct) → 親機の中継(SOCKS) → 親機のモバイル回線 → インターネット」。**子機のネイティブが親機の中継へ直接つなぎ、そこから軽い HTTP を出す**(§2 のとおり、VPN の Network を使う案は現状の VPN 設定と相性が悪い)。
- 成功したら `noteAliveAt(gen, at)` で `lastAliveAt` を更新する。失敗しても**即 disconnected にしない**。別軸 `internet: ok | ng | unknown` に載せ、連続失敗が続いたときだけ総合状態を degraded にする。
- tether が公開するフィールド: `state.data.aliveAt`(= lastAliveAt)と `state.internet`。どちらも `linkSnapshot()` に出す(§5)。

## 1. 現状コードの読みと、差し込む場所

読んだもの: `src/link/linkGovernor.ts` / `directGuard.ts` / `dataPath.ts` / `timingConfig.ts` / `stateLabels.ts`、`src/api/tether.ts`(`noteAliveAt`・`applyNativeHb`・`syncBus`・`linkSnapshot`)、`modules/hotspot/.../Heartbeat.kt` / `BusEngine.kt` / `SocksServer.kt` / `HotspotModule.kt`、`modules/vpn-tunnel/.../TunnelService.kt`。

事実:

| 項目 | 現状(コードから) |
|---|---|
| 生存信号の入口 | `Tether.noteAliveAt(gen, at)`(tether.ts)。`data.heartbeat` と `data.okAt` を更新し、`guard(alive)`、`gov.setAliveAt(at)` を呼ぶ。phase が nearby で VPN が張れていれば `ready` も出す。`at <= data.okAt` は無視(単調) |
| 生存信号の合成 | `lastAliveAt(d, role)` = Echo(子機は `okAt` か heartbeat 成功時刻)とバス(`busAt`)の新しい方。`dataPath.ts` のコメントは「出どころが増えたらここに足す」と書いている |
| 総合状態 | `deriveOverall`。子機の枝は `lastAliveAt` を使わず、自前で `okAt`/`heartbeat.at`/`busAt` の最大を計算している(**二重実装**。出どころを足すときは両方を直す) |
| governor の `setAliveAt` | phase が `direct` のときだけ `aliveAt` を更新。時刻は `min(at, now)` |
| 状態機械 | `alive` は direct で aliveAt 更新、retrying / rejoining では direct に戻す(directGuard.ts の表)。`tick` で `now - aliveAt >= echoMs` なら retrying |
| 子機のネイティブ heartbeat | `Heartbeat.kt`。専用スレッド `dh-heartbeat`、`PARTIAL_WAKE_LOCK`(`tether:heartbeat`)、参加した Wi-Fi の `Network.socketFactory` で親機の 9000 へ TCP。画面オフ時は別間隔。結果は `heartbeatStatus()` と `onHeartbeat` |
| バス | `BusEngine.kt`(jeromq)。ネイティブのスレッドが `lastRxAt` を更新。JS は `syncBus` で読む。バス接続中は Echo を省く |
| 親機の中継 | `SocksServer.kt`。ユーザー名/パスワード認証必須の SOCKS5。出口は `cellular ?: activeNetwork`。DNS は親機側で解決(ドメイン名つき CONNECT)。失敗時の応答コードは DNS 失敗・到達不能=4(host unreachable)、接続拒否=5、タイムアウト=6(古い子機は 4 のままでも動く。ログ上は dns と区別して記録) |
| 子機の VPN | `TunnelService.kt`。全通信を親機の SOCKS へ流す。**`addDisallowedApplication(packageName)` で自アプリを VPN から外している**。5 秒ごとに親機の SOCKS へ TCP 接続して見る独自の watchdog があり、3 回連続失敗で VPN を落とす(fail-open) |
| 接続情報 | 子機は `tether.wifi` の `socks {port, user, pass}` を持つ(VPN 起動に使っている) |

### 差し込み位置(子機)

1. **ネイティブ(供給元。コアとは分離、任意)**: `modules/hotspot` に `ProbeClient.kt`(Android 非依存の 1 周分: SOCKS5 認証 → ドメイン名つき CONNECT → HTTP/1.1 generate_204 → 分類)と `ExternalProbe.kt`(周期の実行)を新設(`Heartbeat.kt` と同じ作り: 専用スレッド `dh-probe`、`PARTIAL_WAKE_LOCK`、参加した Wi-Fi の `Network.socketFactory`、結果は status と event)。`HotspotModule` に `externalProbeStart / Stop / Status` と `onExternalProbe` を足す。時刻は `System.currentTimeMillis`(heartbeat と同じ)。
2. **コア(`src/link/internetMonitor.ts`)**: `update(success, at, reason)` の 1 件ずつから `internet` 状態を導く(連続失敗/成功を内部で数える)。`now` は注入(I5)、タイマーは持たない。ネイティブの生の status を直接は読まない(読むのは 4. の接続層)。
3. **配線**: `tether.ts` の `syncInternet`(tick と参加直後)で、有効・参加済み・再接続中でない間だけ監視を活動させ、成功時刻を `noteAliveAt(…, 'net')` に渡す。Kaz の追加要件により、**開始は direct/settling を待たず、参加できた直後**(確認の待ちと並行して最初の 1 周を即時実行)。再接続中(retrying / rejoining)は止めて unknown に戻す。
4. **接続層(`src/api/internetProbe.ts` の `NativeProbeRunner`)**: 既定の供給元を始め/止め、ネイティブの新しい周を `update()` に渡すだけの薄い層。`enable(on, { runner: 'none' })` で使わず、アプリが自前で `update()` を呼ぶこともできる。
5. **総合状態**: `deriveOverall` に `internetNg` を入力として足す(§6)。`lastAliveAt` に `netAt` を足した(子機の枝はすでに `lastAliveAt` に揃っている)。
6. **governor は変えない**。`internet` は governor の phase を動かさない重ね合わせの軸。

### 不変条件 I1〜I6 との整合

| 不変条件 | 判断 |
|---|---|
| I1 Direct 稼働中は Nearby の advertise / discover / requestConnect を出さない | probe は Nearby に触れない。矛盾しない |
| I2 Nearby の再開は T_direct(親機)/ T_nearby(子機)の後だけ | probe 成功は子機の `aliveAt` を延ばすので、**子機が Nearby へ戻る時刻は遅くなりうる**。親機の時刻は、親機が ok の報告を受けたときだけ延びる(§7)。「親機の戻り ≤ 子機の探索開始」は崩れない(子機が遅れる側)。ただし §3 の非対称リスクがある |
| I3 再接続の順序 | 触れない |
| I4 遷移は表にある (状態, 事象) だけ | 新しい事象は足さない。既存の `alive` を使う。表は変えない |
| I5 時間は now 注入、タイマーは governor に持たない | `internetProbe.ts` は純関数。ネイティブのスレッドは heartbeat と同じ位置づけ |
| I6 joinWifi はどの phase でも許す | 触れない |

注意点(矛盾ではないが実装で守る):

- `retrying` / `rejoining` 中に probe が成功すると、既存の表どおり `alive` で direct に戻る。再接続を試している最中は参加した `Network` が入れ替わるので、probe は **phase が direct か settling の間だけ**動かし、retrying 以降は止めて状態を `unknown` に戻す。
- `noteAliveAt` の副作用(`data.heartbeat.ok = true` にする、phase が nearby なら `ready` を出す)は、Echo / バスの失敗表示を隠したり、早すぎる `ready` を出したりしうる。probe 経由では**副作用を分ける**(出どころの引数を足し、probe では `heartbeat` を触らず、`ready` を出さず、`data.netAt` だけを更新して `lastAliveAt` に合成する)。入口を「唯一」に保つ方針(`noteAliveAt`)は変えず、引数を足すだけにする。

## 2. probe の経路と、Direct の死活判定を誤らせないか

### 経路の選択肢

| 案 | 内容 | 判断 |
|---|---|---|
| A | VPN の `Network`(`TRANSPORT_VPN`)の `socketFactory` で出す(b6 の整理案) | **現状は第一にしない**。自アプリは VPN から外れているため、VPN の Network へ明示的に結びつけられるか(許可されるか)は**未検証**。拒否される(EPERM)場合は使えず、結びつけられなければ既定の経路に出て、親機を通らない可能性がある |
| B | 参加した Wi-Fi の `Network.socketFactory` で**親機の中継へ直接つなぎ**、SOCKS5 認証 → ドメイン名つき CONNECT → HTTP | **第一案**。heartbeat と同じ経路で、TCP の宛先は常に親機の中継。親機に届かなければ失敗するだけで、**別経路(子機自身の携帯回線など)に漏れて成功することが構造上ない** |

案 B は子機の VPN(hev-socks5-tunnel)の経路そのものは通らない。確かめられるのは「子機 → 親機の中継 → 親機の回線 → インターネット」で、親機の中継は VPN を通る通信と同じものを使う。VPN 全体が通るかどうか(案 A)は、**あとから診断用に足す別の段**として残す(未検証)。

### 「internet が通った = watchdog を延命」は Direct の死活判定を誤らせないか

- 案 B の成功が証明するのは、子機から親機の中継までの TCP(= Direct のデータ経路)が生きていること、親機の中継が動いていること、親機の回線が通っていること。Echo やバスの ping より**実際の通信に近い**証拠になる。
- **漏れて成功する偽の延命**: 案 B では起きない(宛先が親機固定)。案 A を後で足すときの懸念で、その検証は「親機のモバイルデータを切る・親機の中継を止める → probe が必ず失敗する」ことを、子機側で自前の携帯回線を有効にしたまま確かめる(b6、§8)。
- **別の誤り: 制御の死を隠す**。Echo / バスが死んでいて(親機アプリの不調、バスだけの不具合)、親機の中継だけが生きている場合、probe が子機の `connected` を保つ。メッセージが流れないのに `connected` と出る。対策:
  - バスの再接続(restartLink 相当)は watchdog と独立に続ける。probe の成功では止めない。
  - 生存確認の判定表(§5)で「バスは途絶・外形監視で延命中」を区別できるようにする(診断・ログ用)。
  - 上限を付ける案(下表)。
- **非対称リスク**: 子機だけ延命すると、親機が先に T_direct で Nearby を再開(広告・探索)し、固定グループが GMS に撤去される(docs/LINK_STATE.md「なぜ」)ことがある。そのとき probe が失敗して子機も落ちるが、**その間の混乱は残る**。親機の延命は子機の報告(バス上のメッセージ)に依るので、バスが途絶すれば親機は延命できず、従来どおり親機が先に動く(§7)。

| 延命の上限 | 内容 | 判断 |
|---|---|---|
| 無制限(b6 案) | probe が成功する限り子機は `connected` を保つ | 簡単。制御の死を隠しうる |
| 上限つき(推奨候補) | probe による延命は、バス/Echo の最後の生存から T_direct まで。超えたら延命せず、バス途絶として degraded | 親機の戻り(T_direct)と時間が揃い、非対称が時間で有限になる |

どちらにするかは**未決**(§10)。

## 3. 宛先と失敗の分類

### 宛先の選定

| 観点 | 公共の generate_204 | 自社ホスト |
|---|---|---|
| 運用 | 不要 | 稼働・監視が要る |
| 障害の影響 | 複数あれば独立 | 自社障害で全員が一斉に ng になる(**偽の degraded が最大の害**) |
| 通信事業者に止められにくいか | 広く通る(未検証) | 新しいホストは分類・遮断の対象になりうる |
| 相手に見える情報 | 親機の回線の IP と時刻 | 同じ。自社なので扱いを決められる |

第一案: **異なる運営の公共 generate_204 を 2 つ**(例: Google の `connectivitycheck.gstatic.com/generate_204`、Cloudflare の `cp.cloudflare.com/generate_204`。到達性・安定性は**未検証**)。判定は「1 周で**どれか 1 つが 204 なら成功**、**全部**失敗で失敗」。自社ホストは、公共側の変更や遮断が問題になったときの第三の宛先として後から足す(未決)。固定の少数(最大 3)で、利用者の入力は受けない。

### 送るものと送らないもの(プライバシー)

- 端末識別子・位置情報・アカウント・ペア情報は送らない。クッキーは持たない。
- 要求は最小: リクエスト行、`Host`、固定の `User-Agent`(端末・版を含めない汎用の固定文字列。値は未決)、`Connection: close`。他のヘッダーは付けない。応答本文は読まない(ステータス行とヘッダーの先頭だけ)。
- 名前解決は親機側(ドメイン名つき CONNECT)。子機は宛先の IP を知らなくてよい。
- 宛先はコード既定。親機の上書きは `http` / `https` 以外・長すぎる文字列・4 件以上を拒否する(§4)。

### 失敗の分類(reason)

| reason | 観測点 | 判定 | 現状で区別できるか |
|---|---|---|---|
| `link` | 子機: 親機の中継へ TCP 接続できない/タイムアウト | Direct 側の問題。internet の失敗には数えず `unknown` 扱いにし、Echo/バスの判定に任せる | できる |
| `auth` | 子機: SOCKS 認証の失敗 | 接続情報の食い違い。ログに残す | できる |
| `dns` | 親機の中継 | 名前が引けない | **できない**: 親機は応答コード 4 しか返さない。親機の `SocksServer` で DNS 失敗=4、接続拒否=5、タイムアウト=6 のように返し分ける変更が要る(PR 6(任意)、親機側は応答コードだけ) |
| `connect` | 同上 | 接続できない | 同上 |
| `timeout` | 子機: CONNECT 後に応答がない | 回線が詰まっている/切れている | できる |
| `portal` | 子機: 204 以外の 2xx/3xx/511 が返る(平文 HTTP のとき) | 回線の制限・案内ページの可能性 | できる(HTTP のみ) |
| `http` | 子機: 5xx など | 宛先の不調。他の宛先が 204 なら成功扱い | できる |
| `tls` | 子機: HTTPS のとき証明書/ハンドシェイクの失敗 | 中間者(portal)か宛先の不調 | できる(HTTPS のみ) |

`dns` と `connect` が区別できるまでは、まとめて `upstream`(親機から先に出られない)とする。

### captive portal 検知は副産物として使えるか

平文 HTTP の generate_204 なら、204 以外が返ったこと(`portal`)で**検知はできる**。ただし使えるのは「親機の回線が案内ページへ誘導している可能性」まで。契約や容量の制限で誘導する事業者があるかどうかは**未確認**で、実機で見たものではない。HTTPS だと portal は `tls` 失敗に見えて区別が弱くなる。そのため既定は平文 HTTP を第一(通信量も小さい、§4)にし、HTTPS は設定で選べる形にする(未決)。portal は専用の確定判定とはせず、画面の補足文言に使う(§7)。

## 4. 設定(宛先・間隔)

| 案 | 内容 | 判断 |
|---|---|---|
| A 親機が配る(b6 案) | `tether.timing` と同様に親機が全部配る | 親機一か所で調整できる。旧版の親機は配らないので、子機にコード既定が要る |
| B **子機の既定 + 親機の上書き**(推奨) | 子機のコードに既定値。親機が配る `probe` セクションがあれば上書き | 外形監視は子機の仕組みなので、既定は子機が持つ。配布は現場調整用。旧版の親機でも動く |
| C 子機のみ | 配らない | 調整が端末ごとになる |

配るのは `tether.timing`(`SharedTiming`)とは**別セクション**の `probe`(実装: `tether.timing` の封筒に任意の `probe` フィールドとして同乗。旧版の子機は無視する。`enabled` は親機が true のときだけ子機に反映し、間隔・閾値・宛先・待ち時間は親機が正)(宛先が文字列の配列で、数値だけの `SharedTiming`/`TIMING_RANGES` の型に合わない)。検証は `timingConfig.ts` と同じ流儀(範囲外・不正は既定に丸めて DH-LINK にログ)。設定の層は「既定 < `TetherConfig.internet` < `setInternetOverride`(保存) < `enable()` の opts < 親機から配られた値(子機)」。宛先は現状**平文 http のみ**(https は未実装。§10-3)。

| 設定名 | 既定 | 範囲 | 意味 |
|---|---|---|---|
| `enabled` | false(実機で確かめるまで。のち true) | — | 外形監視をするか。`enable(on)` の `on` |
| `intervalMs` | 60_000 | 15_000〜600_000 | 通常の間隔 |
| `screenOffIntervalMs` | 120_000 | intervalMs〜600_000 | 画面オフ中(heartbeat と同じ考え方で、短くはしない) |
| `confirmIntervalMs` | 10_000 | 3_000〜intervalMs | 失敗の直後に確認する間隔 |
| `timeoutMs` | 5_000 | 1_000〜15_000 | 1 宛先の合計待ち(CONNECT から応答まで) |
| `failThreshold` | 3 | 1〜10 | 連続失敗で ng とする回数 |
| `recoverThreshold` | 2 | 1〜10 | 連続成功で ok に戻す回数 |
| `urls` | 公共 2 件 | 1〜3 件、http/https のみ | 宛先 |

通信量が小さいので間隔の下限は 15 秒。既定 60 秒は §8 の見積もりと §6 の検知時間のバランスで、実機の電力測定(§8)で見直す。

## 5. tether が公開するフィールドと、「生存確認」の判定

### 公開するフィールド

`Tether.state` と `linkSnapshot()` に出す(名前は案。型は実装 PR で確定):

```ts
state.data.aliveAt: number | null          // = lastAliveAt。生存信号の最終時刻(epoch ms)。Echo・バス・外形監視のどれが出どころでも同じ値
state.internet: {
  state: 'ok' | 'ng' | 'unknown'           // overall とは別軸
  since: number                            // この状態に入った時刻
  lastOkAt: number | null                  // 最後に成功した時刻(noteAliveAt に渡したもの)
  lastAttemptAt: number | null
  consecutiveFailures: number
  reason: 'link' | 'auth' | 'dns' | 'connect' | 'upstream' | 'timeout' | 'portal' | 'http' | 'tls' | null  // 直近の失敗の分類(§3)
}
linkSnapshot(): { ..., aliveAt: number | null, internet: <上と同じ> }   // path にも aliveAt を足す
```

- `aliveAt` は**送信元に依存しない**。画面は「どの経路で確認したか」ではなく「最後に生存を確認した時刻」だけを見る。出どころ別の値(`echoAt` / `busAt` / `netAt`)は診断用に `path` に残す。
- `lastAliveAt(d, role)` に `netAt` を足し、`deriveOverall` の子機の枝の二重実装も `lastAliveAt` を使う形に揃える(§1)。
- `unknown` は「まだ判定していない/いま判定できない」(開始直後、direct でない、案 B の `link` 失敗、機能が無効)。ng ではない。

### 子機の接続の確認 ⑤「生存確認」の判定表

OK 条件は「バスの生存、または外形監視の成功(noteAliveAt)」。ここでの「生存」「成功」は、それぞれ最後の確認が **T_echo 以内**であること。

| バスの生存 | 外形監視 | ⑤ 生存確認 | 補足 |
|---|---|---|---|
| あり | 成功 | OK | |
| あり | 失敗 | OK | 生存は確認できている。インターネットは別項目(internet = ng) |
| あり | 未実施 | OK | 機能が無効/開始前 |
| なし(途絶) | 成功 | OK | 外形監視で延命。診断に「バスは途絶」を残し、バス再接続は続ける。§2 の上限つき案ならここに上限が掛かる |
| なし(途絶) | 失敗 | NG | 両方で確認できない |
| なし(途絶) | 未実施 | NG | 従来と同じ(Echo も T_echo 超過のとき)。Echo が新しければ OK |
| 一度も確認していない | 一度も実施していない | 未確認 | 開始直後 |

(「バスの生存」には、バスを使わない旧版相手のときの Echo の成功も含める。従来どおり。)

### 親機側の確認項目への反映(子機の報告を元に揃える)

親機は probe せず、子機の報告(§7)を元にする。「子機が届いている」は、従来どおり Echo/バスの受信に、**ok の報告の受信時刻**を出どころとして足した `aliveAt` で決める。

| 親機の確認項目 | 出どころ | 外形監視で変わるか |
|---|---|---|
| 共有している / グループがある | 親機自身 | 変わらない |
| 子機が届いている(生存確認) | Echo/バスの受信、または ok の報告の受信(新しい方) | **ok の報告で延命する** |
| 子機のインターネット(新規) | 子機の報告 | 新しい項目。ok / ng / 確認中 |

| 子機の報告 | 親機の生存確認 | 親機の「子機のインターネット」 | 親機の見出し |
|---|---|---|---|
| ok(受信が新しい) | 延命(OK) | OK | 「子機のインターネット: 使えています」 |
| ng | 延命しない(バスが新しければ OK のまま) | NG(理由があれば補足) | 「子機がインターネットに出られていません」 |
| unknown | 延命しない | 確認中 | 「確認中です」 |
| 報告なし / `intervalMs`×3 以上途絶 / バス断 | 延命しない | 確認中 | 「確認中です」 |

子機の ⑤ と親機の「生存確認」は、同じ報告から次のように揃う(子機は自分の probe、親機は受けた報告)。

| 状況 | 子機 ⑤ | 親機の生存確認 | 子機のインターネット(両端) |
|---|---|---|---|
| バス生存・probe 成功 | OK | OK | OK / OK |
| バス生存・probe 失敗 | OK | OK | NG / NG |
| バス途絶・probe 成功 | OK(延命) | **報告が届かないため延命しない**(非対称、§7) | OK / 確認中 |
| バス途絶・probe 失敗 | NG | NG | NG / 確認中 |

## 6. 閾値と状態遷移

`internet` の状態遷移(`internetMonitor.ts`、コア)。事象は `update(success, at, reason)` 1 件。「失敗」は 1 周(全宛先)の結果、または呼び出し元が実通信で観測した失敗。reason が `link` の周は失敗に数えない(unknown に戻す)。

| 現在 | 事象 | 次 | 動作 |
|---|---|---|---|
| unknown | 成功 | ok(`recoverThreshold`=1 の初回は即) | `noteAliveAt(at)`。連続成功を数え始める |
| unknown | 失敗 | unknown | 連続失敗を数える。`confirmIntervalMs` で再試行 |
| unknown | 連続失敗 ≥ `failThreshold` | ng | reason を記録。overall を degraded に |
| ok | 成功 | ok | `noteAliveAt(at)` |
| ok | 失敗 | ok | 連続失敗を数え、`confirmIntervalMs` に切り替える。表示は変えない |
| ok | 連続失敗 ≥ `failThreshold` | ng | reason を記録。overall を degraded に |
| ng | 失敗 | ng | 通常の間隔に戻して続ける(reason は更新) |
| ng | 連続成功 ≥ `recoverThreshold` | ok | overall の degraded を解く(ほかの理由が無ければ) |
| ng | 成功 1 回 | ng | `noteAliveAt(at)` は**成功ごとに**呼ぶ(延命は止めない)。表示だけ待つ(ヒステリシス) |
| ok / ng | phase が direct / settling でなくなった、Wi-Fi 切断、機能が無効 | unknown | probe を止め、失敗数をクリア。Direct 側の異常は Echo/バス/governor の表示に任せる |
| ok | 開始から `intervalMs`×(`failThreshold`+1) 以上応答なし(スレッドが動けていない) | unknown | ネイティブが長く試行していないとき、古い結果を新鮮とみなさない(`Heartbeat` の `ref` 判定と同じ) |

既定値(間隔 60 秒、確認 10 秒、`failThreshold`=3)での検知時間の目安: 失敗の始まりから ng まで最短で約 20 秒(60 秒の周の失敗 → 10 秒 → 10 秒)。最悪で周期ぶん(最大 60 秒)+ 20 秒 + 各周のタイムアウト(最大 5 秒×3 周)。**ng でも governor の phase は動かさない**。overall への反映:

| 条件 | overall |
|---|---|
| 生存確認 NG が T_direct 超 | disconnected(従来) |
| 生存確認 NG が T_echo 超、または再接続中 | degraded(従来) |
| 生存確認 OK かつ internet = ng | **degraded**(新規。ただし `connected` 側の他の条件が揃っているときだけ) |
| internet = ok / unknown | 従来どおり |

## 7. 子機から親機への報告と、親機の watchdog(Kaz 方針: 親機も延命する)

実装は `InternetMonitor.maybeReport()`(子機)と `receive()`(親機)。封筒は `channel.ts` の `BUS_ONLY_KINDS`(`tether.app` と `tether.internet`)に載せ、`RoutedControl` が常にバスへ(Nearby に載せない・受けない)、`ttlMs: 0`(溜めない)で送る。`seq` は起動時の時刻から増やす(子機の再起動で親機が古い seq と誤認しない)。

方針: 子機が probe の結果を**バスで親機へ報告**し、親機は **ok の報告を受けた時刻で自分の LinkGovernor の watchdog を延命**して表示する。親機は probe をしない。(前の版の「親機の watchdog には影響させない」案は、この方針で差し替えた。)

### 報告メッセージ

| 項目 | 内容 |
|---|---|
| 種別名 | `tether.internet`(`Wire` の 1 種。`tether.timing` と同じ tether 自身の制御メッセージ。名前は案) |
| 扱い | **アプリメッセージ扱い = バス専用**(Nearby では送らない・受けない)。別 PR で入るバス専用化に従う。バスが張れていない間は送らない(溜めない) |
| 内容 | `{ v: 1, state: 'ok'\|'ng'\|'unknown', okAt, at, seq, fails, reason, since }` |
| `state` | 子機の `state.internet.state`。**失敗(ng)も未実施・判定不能(unknown)も区別して送る** |
| `okAt` | 子機が最後に probe に成功した時刻。子機の壁時計(`Date.now()`) |
| `at` | この報告を作った時刻(子機の壁時計)。親機は端末間の時計のずれがあるため**表示の補助にだけ**使い、判定には受信時刻を使う |
| `seq` | 子機で増える連番。順序の入れ替わり・重複を捨てる |
| `fails` | 連続失敗数 |
| `reason` | §3 の分類(`link` / `auth` / `dns` / `connect` / `upstream` / `timeout` / `portal` / `http` / `tls` / null) |
| `since` | その状態に入った時刻 |
| 載せないもの | 宛先、URL、端末識別子、位置、ペア情報 |
| 送る契機 | **状態が変わったとき・`okAt` が進んだ成功のたびに間引いて**(下記)・定期更新。`key: 'internet'`(最新のみ残す。`tether.timing` と同じ書き方) |

送信間隔: 状態変化(ok↔ng↔unknown)は**即時**。ok が続くあいだは **probe の成功ごと**(= `intervalMs` おき、既定 60 秒)に送る。これが親機の延命の原則を担う(成功の報告が生存の証拠になる)。ng / unknown が続くあいだは `intervalMs` ごとの定期更新に留める。報告は 100 バイト前後の小さな JSON と見積もる(未測定)。

### 親機の扱い

| 受信 | 親機の動作 |
|---|---|
| `ok` | `noteAliveAt(gen, at')` で watchdog を延命する。`at' = min(受信時刻, now)`。報告の `okAt` は端末間の時計のずれで未来や大昔になりうるので**判定には使わない**(使うなら「受信時刻より古い値の ok は延命に使わない」ために `now` を上限にして丸めるだけ)。`max` で単調(`at <= okAt` は無視)。`data.netAt` を更新し、`lastAliveAt` に合成する |
| `ng` | **延命しない**。表示(子機のインターネット = NG、reason)だけ。ただし**報告自体がバス上のメッセージ**なので、バスの生存としては数えられる(下記)。ng の報告でバスの生存時刻(`busAt`)が新しくなるのは、`BusEngine` の `lastRxAt` が受信ごとに進む既存の動作によるもので、新しい処理ではない |
| `unknown` | 延命しない。表示は「確認中」 |
| 古い `seq` / 重複 | 捨てる |
| 報告が途絶(最後の受信から `intervalMs` × 3 以上) | 親機の表示を unknown に戻す。延命もしない(新しい ok が来ない限り時刻は進まない) |
| バス断 | 即 unknown(報告は届かないので、古い ok を信じない) |

### 延命の意味を分けて書く(混ぜない)

親機が `ok` の報告を受けて得る証拠は 2 つあり、**意味が違う**。

| 証拠 | 何を示すか | 示さないこと |
|---|---|---|
| (1) 報告が届いた = バス上のメッセージが来た | 子機→親機のバス(Direct 上の ZeroMQ)が生きている。これは ng / unknown の報告でも同じ。`busAt` の更新そのものでも説明がつく | 親機の回線が通っていること |
| (2) 報告の内容が `ok` = 子機の probe が成功した | **子機 → Direct → 親機の中継 → 親機のモバイル回線 → インターネット**のエンドツーエンドが、子機の観測として成立した(直近 `intervalMs` 内) | 親機が自分で観測したことではない。子機の自己申告。報告の時刻は子機の時計 |

延命に使うのは (2) の `ok` だけ(受信時刻で)。(1) は元々 `busAt` として governor に入る。両方が同時に起きる(ok の報告 = バスの受信)ので、`aliveAt` の値自体は同じ時刻になることが多い。区別が効くのは次の場面:

- 子機の probe が ng でも報告は届く: (1) だけ成立(バスは生きている、回線は通っていない)。親機の watchdog は `busAt` で延びているので **Direct としては生きている**と判定され、internet は NG と補足表示される。
- バスが途絶して報告も届かない: どちらも成立しない。**子機側**は probe の成功で延命できても、**親機側**は報告が届かないので延命しない(第一案どおり、親機の判定は親機が受けたものだけで決まる)。この場面で子機が `connected`、親機が degraded / disconnected になる**非対称**が残る。子機の延命の上限(§2)は、この非対称が有限であるための歯止め。

### 親機の LinkGovernor への影響(整理)

| 項目 | 変更 |
|---|---|
| governor の遷移表(`stepGuard`)・I1〜I6 | 変えない。`noteAliveAt` → 既存の `alive` / `setAliveAt` を使うだけ |
| 親機の `aliveAt` | `ok` の受信で延びる(新しい出どころ `netAt`)。`ng` / `unknown` では延びない |
| 親機の overall | 従来の生存判定 + 子機の internet = ng を degraded に(§6 と同じ規則。ただし親機は「報告が新しい ng」のときだけ) |
| I2(Nearby 再開の時刻) | 親機の延命で T_direct までの時間が延びうるので、親機の Nearby 再開は遅くなりうる。ただし延命は「バスで ok の報告が届く」ときだけなので、バス途絶時に親機だけ先に T_direct に達する非対称は残る(上記)。「親機の戻り ≤ 子機の探索開始」は、子機の延命が親機の延命と同じ probe 成功に基づくので概ね保たれるが、**実機で確認が要る**(未検証)。子機の延命に上限を付ける案(§2)を採るときは親機にも同じ上限を付ける |
| 悪用/誤報 | 子機は認証済みのバスの相手なので、誤報は壊れた子機(または古い版)だけを想定する。旧版の子機は報告を送らない = 親機は従来どおり(unknown) |

注意: 親機が延命するとき、**親機が受ける Echo / バスの ping が途絶えていても `ok` の報告は届かない**(報告もバス上のメッセージ)ので、親機の延命は「バスは生きていて、かつ子機の probe が成功」の場合にだけ起きる。結果として親機の延命は `busAt` が既に新しいときに重なり、**親機の判定を実質的には変えない**可能性が高い(推測。差が出るのは Echo のみで動く旧版の子機相手だが、その子機は報告を送らない)。したがって親機の延命は主に**意味の整理と表示のため**で、実害のある偽の延命を作らない。これが成り立つかは実機で確認する(§8 の検証 4)。

### 報告の経路(決めること)

| 案 | 内容 | 判断 |
|---|---|---|
| (a) バスの内部制御フレーム(`BusEngine` に `I:` のような種別を足す) | ネイティブ間で完結。JS が止まっても届く | ネイティブの両端と線の定義(GATEWAY_BUS.md)の変更が要る。親機の表示は JS が読む |
| (b) `tether.internet`(アプリメッセージ扱い、バス専用) | `tether.timing` と同じ扱い | **推奨**。バス専用化の PR に従う。バスが張れていないときは送らない |

(b) はバス専用化の最終形(別 PR)に依存する。**未決**(§10)。

## 8. 通信量・電力・実装・実機検証

### 通信量の見積もり(測定ではなく試算。実機で測る)

平文 HTTP で SOCKS 経由、応答本文なし。1 回あたり、子機〜親機(Wi-Fi)の区間でヘッダー込み約 1.5 KB、親機〜インターネット(モバイル回線)の区間で約 1.5 KB と置く。HTTPS(TLS 1.3)は約 5〜7 KB と置く。

| 間隔 | 回数/日 | 平文 HTTP(各区間) | HTTPS(各区間) |
|---|---|---|---|
| 30 秒 | 2,880 | 約 4.3 MB | 約 14〜20 MB |
| 60 秒(既定) | 1,440 | 約 2.2 MB | 約 7〜10 MB |
| 120 秒 | 720 | 約 1.1 MB | 約 3.5〜5 MB |
| 画面オフ 300 秒 | 288 | 約 0.4 MB | 約 1.4〜2 MB |

失敗直後の確認(10 秒間隔×最大数回)は上に少し足されるだけ。

### 電力

数値は持っていない(**未検証**)。分かっていること/推測:

- 子機: すでに 5 秒間隔の Echo(またはバスの ping)が Wi-Fi を起こしている。追加の影響は小さいと推測するが未測定。`Heartbeat` はバス接続中に止まる(バスが生きている間は Echo を省く)ので、そのとき `PARTIAL_WAKE_LOCK` が誰に保持されているかを確かめる必要がある。probe は自分の WakeLock を持つ(heartbeat と同じ、`setReferenceCounted(false)`、停止で必ず解放)案が既定。
- 親機: 外へ出る回線は、子機の通信が無い間は probe だけになる。間隔が短いと携帯回線の無線が休めない。これは推測で、**間隔を 60 秒以上にする理由**として置いている。
- 画面オフ・Doze: 既存 heartbeat と同じ前提(前面サービス + スレッド + WakeLock)を継承する。Doze 中のネットワーク制限が Wi-Fi Direct 内の通信に及ぶかは**未検証**。

### 実装の PR 分割(子機中心)

| PR | 内容 | 備考 |
|---|---|---|
| 1 | 子機の probe(native): `ExternalProbe.kt`(SOCKS5 CONNECT + HTTP のクライアント、分類、WakeLock、画面オフ間隔)、`HotspotModule` の関数とイベント、JVM 単体テスト(偽ソケットで 204/200/302/タイムアウト/認証失敗) | `BusEngineTest.kt` と同じ流儀 |
| 2 | 子機の状態: `src/link/internetProbe.ts`(純関数、§6 の表を一対一でテスト)、`DataPath.netAt`、`lastAliveAt` に netAt、`deriveOverall` の二重実装の解消、`state.internet` / `state.data.aliveAt` / `linkSnapshot()` | ネイティブ無し |
| 3 | 子機の配線: `tether.ts` で開始・停止(direct / settling の間だけ)、status 取り込み、`noteAliveAt` に出どころの引数を追加(§1)、`enabled` 既定 false、設定(コード既定 + 親機の上書き) | ここで子機の延命が効く |
| 4 | 報告メッセージ: 子機が `tether.internet` をバスで送る(状態変化は即時、ok は成功ごと)、`seq`、バス専用(バス専用化の PR に従う) | 親機は未対応でも害なし(旧版は無視) |
| 5 | 親機の受信・延命・表示: 受信、`noteAliveAt(受信時刻)`(ok のみ)、途絶で unknown、「子機のインターネット」項目、見出し | 親機の governor の表は変えない |
| 6(任意) | 親機の中継の応答コードの返し分け(DNS=4 / 接続拒否=5 / タイムアウト=6)。`dns` と `connect` の区別 | 親機側の変更はこの任意 PR の応答コードだけ |

テスト方針: `internetProbe.ts` は `node --test`(既存の `npm test` の対象)。ネイティブは JVM 単体テスト。governor の遷移表(`directGuard.test.ts`)は変わらないことを確認する。

### 実機検証の手順(b6 向け。この PR では実施しない)

準備: 子機は自前のモバイル回線(SIM)を**有効のまま**にする(漏れの確認のため)。Wi-Fi Direct で親機につなぎ、`enabled` を true にする。

1. 通常: 親機のモバイル回線あり。子機のログで probe が約 60 秒おきに成功し、`state.data.aliveAt` が進むこと。通信量(`dumpsys netstats` など)と電力(`dumpsys batterystats`、画面オフ 1 時間)を記録。
2. 親機の回線を断つ(モバイルデータをオフ): probe が失敗し、約 20 秒で `internet = ng`(reason が `upstream` か `timeout`)。**子機の自前の SIM があっても成功しないこと**(漏れていない確認)。overall は degraded で、disconnected にならないこと。親機に補足が出ること。
3. 回線を戻す: `recoverThreshold` 回の成功で ok に戻り、degraded が解けること。
4. バスだけ止める(親機のバスのポートをふさぐ等): 子機は外形監視の成功だけで ⑤ が OK、バスの再接続は続くこと。**親機は報告が届かず延命しない**(§7 の非対称)こと、上限つき案なら T_direct で子機も degraded になること。バスが生きているときは、親機の `aliveAt` が ok の報告で進み、ng の報告では進まないこと。
5. 親機の中継を止める(親機アプリを落とす): probe が `link` で失敗し unknown になり、従来の Echo/バス/governor の遷移に任せること。
6. 画面オフ + 長時間(Doze を含む): probe が続くか、間隔が画面オフの値になるか。
7. 平文 HTTP を横取りする環境(portal を再現できる Wi-Fi 等)がある場合のみ: `portal` の分類。

## 9. 画面の見出し案(実装名を出さない)

| 場所 | 状態 | 見出し | 補足 |
|---|---|---|---|
| 子機の接続の確認 | ⑤ 生存確認 | 「親機とつながっています」/「親機との接続を確認できません」/「確認中です」 | |
| 子機の接続の確認(新規項目) | internet = ok | 「インターネットにつながっています」 | |
| 同 | internet = ng | **「親機の回線につながっていません」** | 「親機の電波やデータ容量を確認してください。」 |
| 同 | ng かつ reason = portal | 「親機の回線で通信が制限されているかもしれません」 | 「契約や残りの容量を確認してください。」(推測の表現にとどめる) |
| 同 | unknown | 表示しない(項目は「確認中です」) | |
| 親機の確認項目 | 子機の報告 = ng | 「子機がインターネットに出られていません」 | 「親機のモバイル通信を確認してください。」 |
| 親機の確認項目 | ok / 未確認 | 「子機のインターネット: 使えています」/「確認中です」 | |

「SOCKS」「VPN」「Direct」「バス」「probe」などの語は画面に出さない。理由コードはログと診断用。

## 10. 未検証・未決事項

未検証(コードや資料から事実と言えないもの):

- 自アプリを VPN から外した状態で、VPN の `Network` へ明示的に結びつけられるか(案 A)。
- 公共 generate_204 の宛先が、親機の事業者の回線で常に通るか。
- 事業者が契約・容量の制限で平文 HTTP を案内ページへ誘導するか(portal の実在)。
- 通信量・電力の数値(試算のみ)。バス接続中に WakeLock を誰が持つか。Doze 中の Wi-Fi Direct 内の通信への影響。
- 親機の中継で、DNS 失敗/接続失敗の返し分けを入れたときの子機側 VPN(hev-socks5-tunnel)の挙動への影響(なし、と推測しているだけ)。

未決(判断が要る):

1. 延命の上限(§2): 無制限か、T_direct で打ち切るか。
2. 宛先の第一(§3): 公共 2 件でよいか。自社ホストを足す時期。固定 `User-Agent` の文字列。
3. 平文 HTTP か HTTPS か(§3): 既定を平文にする案。
4. 設定(§4): 案 B(子機の既定 + 親機の上書き)でよいか。既定の間隔 60 秒。
5. 報告の経路(§7): `tether.internet`(アプリメッセージ扱い、バス専用)か、バスの内部フレームか。バス専用化の最終形(別 PR)と揃える。
6. 親機の延命(§7): ok の報告を受信時刻で延命する方針(Kaz)。実害の無さ(バスが新しいときに重なる)の実機確認、`intervalMs`×3 の途絶判定、延命の上限を親機にも付けるか。
7. 案 A(VPN 全体が通るかの診断)を入れるか。
8. 親機の応答コードの返し分け(PR 6(任意))を入れるか。
9. 総合状態の degraded 条件(§6): internet = ng だけで degraded にしてよいか(「連続失敗のときだけ」としたが、閾値 `failThreshold` の既定は実機で見直す)。

## 11. 公開 API(2 つの口)と呼び出し元ごとの責務

### API

| 口 | 引数 | 意味 |
|---|---|---|
| `tether.internet.enable(on, opts?)` | `on`: 有効/無効。`opts`: `intervalMs` / `failThreshold` / `recoverThreshold` / `screenOffIntervalMs` / `confirmIntervalMs` / `timeoutMs` / `urls`(すべて任意、§4 の範囲)と `runner: 'native' \| 'none'`(既定 'native' = 既定の供給元を使う) | `enable(false)` の間は `state.internet` が unknown で、`update` は無視される。範囲外は既定に丸めてログ |
| `tether.internet.update(success, at?, reason?)` | `success`: 実際に通信できたか。`at`: その時刻(省略 = 現在、未来は現在に丸め、古い結果は捨てる)。`reason`: §3 の分類(任意) | 受け付けたら true。`state.internet` の遷移(§6)、成功のたびの `noteAliveAt`(ng の間も)、親機への報告に反映 |
| `tether.internet.getConfig()` | — | いま有効な設定(親機から配られた値を含む) |
| `state.internet` / `state.remoteInternet` / `linkSnapshot().internet` | — | 子機の自分の状態 / 親機が受けた子機の報告。`state.data.netAt` は延命に使った最後の成功時刻 |

### 呼び出し元ごとの責務

| 呼び出し元 | やること | tether が肩代わりすること |
|---|---|---|
| アプリ(子機) | 起動時に `enable(true, opts)`。自前の実通信(VPN 越しの HTTP など)で成功/失敗を見たら `update()`(`runner: 'none'` にすると既定の供給元と二重にならない) | 状態機械、閾値、延命、親機への報告、設定の配布の受け取り |
| 既定の供給元(`NativeProbeRunner` + `ExternalProbe.kt`) | 参加直後に即時 1 周、以後は間隔ごと、失敗直後は確認間隔。結果を `update()` へ | 始め/止め(有効・参加済み・再接続中でない間だけ) |
| アプリ(親機) | `enable(true, opts)`(子機の報告を受ける。この設定が子機へ配られる)。子機の項目は `state.remoteInternet` を見る | 受信、ok の報告で延命、途絶・バス断で確認中に戻す |
| tether コア | 上記の状態機械・延命(上限つき、§2)・報告・公開 | — |

### 判断した未決(§10 への回答)

1. 延命の上限: **上限つきを実装**。`netAt` は Echo/バスの最後の生存から T_direct を超えたら governor に渡さない(親機も同じ規則)。
2. 宛先: 公共 2 件(gstatic / cloudflare)。固定 User-Agent は `Mozilla/5.0 (Linux; Android)`(端末・版を含めない)。自社ホストは入れない。
3. 平文 HTTP を既定。https は**未実装**(設定でも受けない)。
4. 設定は案 B(子機の既定 + 親機の上書き)。`enabled` の既定は false。
5. 報告は `tether.internet`(バス専用)。
6. 親機の延命は ok の報告の受信時刻、途絶判定は `intervalMs`×3。
9. degraded は `internet = ng`(連続失敗 `failThreshold` 回)のときだけ。
7・8(案 A の診断、親機の応答コード返し分け)は入れていない。ネイティブは `rep=4 → upstream`、`5 → connect`、`6 → timeout` に対応済みで、親機が返し分ければ自動で効く。
