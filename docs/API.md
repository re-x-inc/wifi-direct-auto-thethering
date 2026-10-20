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
