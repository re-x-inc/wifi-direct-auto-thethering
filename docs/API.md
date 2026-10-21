# 公開 API(`src/api`)

他のアプリ(例: 配達ヘルパー)が、ペアリング・役割判定・自動接続・回線共有・VPN・メッセージ送受信を使うための TypeScript API。
設計の根拠(なぜ別アプリへの intent ではなくライブラリか)と使い方の全体は、
`delivery-helper/docs/TETHER_API.md` を参照。

- 入口: `src/api/index.ts`(`getTether()` で端末ごとに 1 つの `Tether` を得る)
- 実装: `src/api/tether.ts`。端末の部品(Nearby・Wi-Fi・VPN・保管領域)は `TetherPlatform` で注入し、
  実機は `src/api/native.ts`、テストは `src/api/fakePlatform.ts`(偽物)を使う。
- テスト: `npm test`(`src/api/tether.test.ts` は 親機・子機の 2 端末を偽物で動かし、接続 → 共有 → VPN → 切断復旧 → 非常口 → ペアリングまで確認)
- 利用側アプリは `expo.autolinking.searchPaths` でこのリポジトリの `modules/` を取り込む。権限(アクセシビリティは使わない)はこのリポジトリのモジュールが持つものだけ。
- この API を使うために、tether 自身の `App.tsx` も API 経由に作り替えてある(ペアがあれば起動だけで接続を始める)。

## 能力の交換と方式判断(`capability.ts` / `planner.ts`)
仕様と根拠は `docs/SPEC.md` §9、実機確認は §10。

### 能力調査
```ts
const caps = await tether.capabilities();      // Capabilities。副作用なし。取得できない項目は null
const { lohs, capabilities } = await tether.runProbe(); // LOHS を一瞬だけ起動して閉じ、結果を端末内に保存
// 共有中は TetherError('busy')、能力の部品が無ければ 'unsupported'。自動では呼ばれない
describeCapabilities(caps);                    // 人が読める文字列(実機確認用)
```
- `start()` すると診断ログ(`onLog`)に「能力 …」が出る。
- `TetherPlatform.capability`(任意): `collect()`(副作用なし)と `probeLohs()`。無ければ項目は不明になる。実機は `modules/hotspot` の `capabilities()` / `probeLohs()`、テストは `fakePlatform` の偽物。

### Link Planner(純関数)
```ts
import { planLink } from '@re-x/wifi-direct-tether';
const plan = planLink({
  host: hostCaps,
  guests: [{ peerId, paired: true, state: 'requesting', caps: guestCaps /* 未交換は null */, method: null }],
  history: { [peerId]: entries },
  policy: { existingConnection: 'keep', overLimit: 'defer', maxGuests: { WifiDirect: 1, LocalOnlyHotspot: 4 } },
});
// plan.ok / plan.order / plan.primary / plan.guests[].{admission, method, todo, reconnect}
// plan.reasons[].{code, severity, message} / plan.guestTodo / plan.failure?.{code, message, update}
```
`Tether` は接続フローの中で自動的に使う(`TetherConfig.planPolicy` で方針を渡せる)。

### 通知イベント・状態
- `tether.onHandshake(cb)`: `{ type: 'caps-received', peerId, cached, model }` / `{ type: 'plan', side: 'host' | 'guest', plan }` / `{ type: 'update-required', who: 'host' | 'guest' }`。
- `TetherState.plan`: 直近の判断(親機が決め、子機へ通知されたもの)。`plan.ok === false` のとき `plan.failure.message` が `TetherState.error` にも入る。
- `TetherConfig.capsWaitMs`: 親機が子機の能力を待つ最長時間(既定 5000)。キャッシュがあれば待たない。
- `TetherState.joinPrompt` / native `onJoinPrompt({ ssid, phase, timeoutMs? })`(子機の Wi-Fi 許可画面): `show` = 画面が出た(timeoutMs 以内に「接続」を押してもらう)。終わりは必ず次のどれか 1 つが来る: `ok`(参加できた)/ `declined`(拒否、または OS が見つからないと返した)/ `timeout`(timeoutMs 経っても見つからず・承認されず、要求を取り下げた)/ `cancelled`(leaveWifi・別 SSID への参加・stop で取り下げた)。`show` 以外では `joinPrompt` は false。待ち手が居なくても timeout/cancelled は送る。
- 端末間メッセージ(内部): `tether.hello` / `tether.caps-req` / `tether.caps` / `tether.plan`。内容は機種名・能力・判断のみ。
- ペアを解除すると、そのペアの能力キャッシュと履歴も消える。

## 診断レポート(`diagnostics.ts`)
Planner が使う能力とは別に、端末から取れるものを網羅的に採取した「診断レポート」(SPEC §9.10)。
```ts
const report = await tether.diagnosticReport();          // 作る(副作用なし)
const saved = await tether.saveDiagnosticReport();        // 作って端末内に保存。{ report, fileName, json, summary, path }
summarizeReport(report);                                  // 人が読める要約
comparisonMarkdown([reportA, reportB], /* onlyDiffs */ true); // 機種比較の Markdown 表
```
- 各項目は `{ v, minApi, source, why?, official? }`。取れない項目は `v: null` で、理由は `why`。
- 個人を特定できる値(IMEI・電話番号・SSID・MAC・アカウント等)は採取せず、それらしい文字列は `redactItem` が落とす。
- **ハンドシェイクで送るのは `capabilities()` のみ。** 診断レポート全体は相手へ送らない。外へ出るのは、利用者が診断画面で共有したときと、adb pull したときだけ。
- `CapabilityPort` の任意メソッド: `diagnostics()`(網羅採取)、`saveFile(name, text)`(アプリ専用領域へ保存し、パスを返す)。
- 診断画面: `src/DiagnosticsPanel.tsx`(tether の `App.tsx` に組み込み済み。文字つきボタンのみ)。比較: `npm run diag:compare -- <フォルダ> [--diff]`。

## Direct 稼働中の Nearby と総合状態

詳細・状態遷移図・閾値・クラス設計は [LINK_STATE.md](LINK_STATE.md)。

- Direct が張れている間は **常に** Nearby の広告・探索・接続を止め、Direct が切れたときだけ再開する(設定項目なし。keep 方式の廃止の経緯は LINK_STATE.md「廃止した keep 方式」)。`TetherConfig.nearbyWhileDirect` と `linkSnapshot().mode` は削除した。`directGuard`(echoMs / directMs / nearbyMs / hbIntervalMs / tickMs)・`directRetry`(attempts / backoffMs / joinTimeoutMs / attemptMs)で時間を変えられる。
- `TetherState.nearby`: `'up' | 'down' | 'suspended'`(`suspended` は意図した停止で異常ではない)。
- `TetherState.overall`: `'connected' | 'degraded' | 'disconnected'`。**データ経路だけ**から導く(Nearby の link には依存しない)。`Tether.onOverall(cb)` で変化を購読できる。
- `TetherConfig.hbScreenOffIntervalMs`(省略=延ばさない)/ `hbWakeLock`(既定 true): 子機のハートビートはネイティブ(Hotspot モジュールの専用スレッド)で続き、JS が止まっても送る。画面オフ中だけ間隔を延ばす値(T_echo の半分まで)と、動作中 PARTIAL_WAKE_LOCK を持つかの指定。ネイティブ側が無い部品では従来の JS ループで動く。ログのタグ: `DH-HB`(logcat)、`[DH-LINK] ネイティブのハートビート…`。
- `TetherState.data`: `{ group, echoAt, heartbeat, okAt, reach, busAt, aliveAt, bus }`(`aliveAt` = 最後に Direct の生存を確認した時刻(LinkGovernor が保持。Echo・バス・ZMTP heartbeat のどれから来ても同じ)/ `bus` = `'authenticated' | 'disconnected' | 'off'`。親機: グループの有無・子機のエコー最終受付 / 子機: Wi-Fi 参加・ハートビート・到達確認)。
- 既存の購読者への影響なし(フィールド追加のみ)。`link` は Nearby の状態のまま(suspend 中は `'waiting'`)なので、接続表示には `overall` を使う。

## Direct 稼働中のメッセージ(バス)

`tether.send()` / `onMessage()`(アプリのメッセージ: 受諾・地図を開く・待機場所・履歴など)は、**運び先が常に Direct 上のバスだけ**。Nearby には載せない(送るのも、Nearby から届いたアプリのメッセージを受けるのも)。バスが使えない間(Direct 未確立・未認証・切断中)は **バスの保留キューに溜め**、再接続後に送信順で再送する。`ttlMs` を過ぎたものは捨てる(`ttlMs` 未指定=無期限・`0`=溜めない・`key`=同じ key の未確認を置き換え。既存の既定値は変えていない)。保留はアプリのメッセージ 200 件まで(超えたら古いものから捨てる)。Nearby が運んでよいのは tether 内部の制御(`tether.wifi` / `hello` / `caps` / `timing` / `plan` / `need-wifi` など)だけ。受け手には at-least-once のうち重複を除いて 1 回だけ渡る。バス部品が無い端末ではアプリのメッセージは届かない(溜まって ttl で捨てられる)。旧 tether との互換は無い(全端末を同時に更新する前提)。

`linkSnapshot()` / `onLink()` に運び先の表示用フィールドを足した(既存フィールドは変更なし): `controlCarrier`(内部制御のいまの運び先 `'nearby' | 'bus'`)、`appCarrier`(アプリのメッセージの運び先。常に `'bus'`)、`appPending`(バスに溜まって未送達のアプリのメッセージ数)。診断ログ(`[DH-LINK]`、中身は出さず種別と運び先のみ): `送信[アプリ] 種別=<kind> → バス | 溜め(理由) | 破棄(ttl/上限)`、`受信[アプリ] 種別=<kind> ← バス`、`送信[制御] 種別=<kind> → Nearby | バス`。種別 `<kind>` はアプリの body の `kind`(無ければ `type`、どちらも無ければ型名)。詳細は [GATEWAY_BUS.md](GATEWAY_BUS.md) §11 / [LINK_STATE.md](LINK_STATE.md)。

## 生存確認(ZMTP heartbeat)と再接続 API
- `tether.linkSnapshot()`(`onLink`)に **`path.lastAliveAt`**(最後に生存を確認した時刻 epoch ms / 無ければ null)・**`path.bus`**(`authenticated` / `disconnected` / `off`)・`data`(`TetherState.data` と同じ)を追加(追加のみ。mobile は feature-detect で読む)。`TetherState.data.aliveAt` / `.bus` も同じ値。
- `TetherConfig.timing.busIvlMs`(既定 2000)/ `busTimeoutMs`(既定 6000): バスの ZMTP heartbeat(`ZMQ_HEARTBEAT_IVL` / `TIMEOUT`=`TTL`)。TIMEOUT + IVL < `echoMs`(15s)にする。詳細は GATEWAY_BUS.md §12。
- **`tether.restartLink(): Promise<{ action: 'rebuild' | 'retry' | 'share' | 'none'; reason?: string }>`**: 再接続専用。LinkGovernor の遷移表に沿って Direct の作り直しと Nearby 復帰の再試行を始める(`shareNow()` の代用をやめる用)。親機は Wi-Fi Direct 共有中なら Direct を作り直す(`rebuild`)、共有していなければ `shareNow()`(`share`)。子機は Direct 稼働中(phase=direct)なら `lost('manual')` で retrying へ(`retry`。尽きれば表どおり Nearby を再開)。すでに再接続中(retrying / rejoining)・停止中は何もしない(`none`)。
