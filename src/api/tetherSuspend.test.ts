import test from 'node:test';
import assert from 'node:assert/strict';
import { pairedFakes } from './fakePlatform';
import { Tether } from './tether';
import type { Overall } from '../link/dataPath';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000, what = '') => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timeout ' + what);
    await wait(5);
  }
};

/** 時間を縮めた設定(hb 20ms → T_echo 60 / T_direct 200 / T_nearby 260) */
const SUSPEND = {
  link: { baseMs: 5, maxMs: 20, pingTimeoutMs: 400 }, connectTimeoutMs: 100, probeIntervalMs: 1,
  nearbyWhileDirect: 'suspend' as const,
  strictLinkGuard: true, // 不変条件に違反したら例外(= テスト失敗)
  timingUnchecked: true,
  timing: { hbIntervalMs: 20, tickMs: 10, echoMs: 60, directMs: 200, nearbyMs: 260, settleMs: 30, retryAttempts: 3, retryBackoffMs: [5], retryJoinTimeoutMs: 50, retryAttemptMs: 50, rejoinMs: 500 },
};

async function setup(cfg: object = SUSPEND) {
  const f = await pairedFakes();
  const hostT = new Tether(f.host.platform, cfg);
  const guestT = new Tether(f.guest.platform, cfg);
  // 子機のハートビート(エコー接続)が親機に届く様子を再現する
  let echo = true;
  const timer = setInterval(() => { if (echo && f.guest.ctl.probeOk) f.host.emitEcho(); }, 10);
  return { ...f, hostT, guestT, stopEcho: () => { echo = false; }, cleanup: () => { clearInterval(timer); hostT.stop(); guestT.stop(); } };
}

async function established(c: Awaited<ReturnType<typeof setup>>) {
  await c.hostT.start();
  await c.guestT.start();
  await until(() => c.guestT.getState().vpn === 'on', 3000, 'vpn');
  await until(() => c.hostT.getState().nearby === 'suspended' && c.guestT.getState().nearby === 'suspended', 3000, 'both suspended');
}

test('既定は keep: Direct が張れても Nearby を止めない', async () => {
  const c = await setup({ link: { baseMs: 5, maxMs: 20, pingTimeoutMs: 400 }, connectTimeoutMs: 100, probeIntervalMs: 1 });
  await c.hostT.start(); await c.guestT.start();
  await until(() => c.guestT.getState().vpn === 'on');
  await wait(100);
  assert.equal(c.net.host.suspendCount + c.net.guest.suspendCount, 0);
  assert.equal(c.guestT.getState().nearby, 'up');
  c.cleanup();
});

test('suspend: Direct 確立 → 両端末とも Nearby を止め、止めている間は広告・探索・接続の要求を出さない', async () => {
  const c = await setup();
  await established(c);
  await wait(150);
  assert.equal(c.net.host.suspended && c.net.guest.suspended, true);
  assert.deepEqual([...c.net.host.leaked, ...c.net.guest.leaked], []);
  assert.equal(c.guestT.getState().overall, 'connected');
  assert.equal(c.hostT.getState().overall, 'connected');
  assert.ok(c.net.guest.notes.some((n) => n.includes('Nearby 停止完了')));
  c.cleanup();
});

test('子機の Wi-Fi 切断 → Nearby は止めたまま保存済みの情報で再接続し、戻れば Nearby を使わない(overall は degraded を経由)', async () => {
  const c = await setup();
  const seen: Overall[] = [];
  c.guestT.onOverall((o) => seen.push(o));
  await established(c);
  const joins = () => c.guest.calls.filter((x) => x.startsWith('join:')).length;
  const j0 = joins();
  c.guest.loseWifi();
  await until(() => joins() > j0, 2000, 'rejoin');
  await until(() => c.guestT.getState().vpn === 'on' && c.guestT.getState().wifi === 'joined', 2000, 'back');
  await wait(300); // T_nearby(260ms) を過ぎても Nearby は再開しない
  assert.equal(c.guestT.getState().nearby, 'suspended');
  assert.equal(c.net.guest.suspended, true);
  assert.deepEqual(c.net.guest.leaked, []);
  assert.ok(seen.includes('disconnected') || seen.includes('degraded'));
  assert.equal(c.guestT.getState().overall, 'connected');
  c.cleanup();
});

test('再接続 3 回とも失敗 → 親機が先に Nearby を再開し、子機はそのあと探索へ戻る(親機の戻り ≤ 子機の探索開始)', async () => {
  const c = await setup();
  await established(c);
  const resumedAt: Record<string, number> = {};
  c.hostT.subscribe((s) => { if (s.nearby !== 'suspended' && !resumedAt.host) resumedAt.host = Date.now(); });
  c.guestT.subscribe((s) => { if (s.nearby !== 'suspended' && !resumedAt.guest) resumedAt.guest = Date.now(); });
  c.guest.ctl.joinFails = 99;
  c.guest.ctl.probeOk = false; // 子機のハートビートも止まる(親機はエコーを受けなくなる)
  c.guest.loseWifi();
  await until(() => !!resumedAt.host && !!resumedAt.guest, 4000, 'both resumed');
  assert.ok(resumedAt.host <= resumedAt.guest, `host ${resumedAt.host} guest ${resumedAt.guest}`);
  assert.ok(c.guest.calls.filter((x) => x.startsWith('join:')).length >= 1 + 3); // 初回 + 再接続 3 回
  assert.equal(c.guestT.getState().overall, 'disconnected');
  assert.ok(c.net.host.notes.some((n) => n.includes('Nearby を再開')));
  c.cleanup();
});

test('親機: エコーが止まっても T_echo の間は何もせず、T_echo で degraded、戻れば Nearby は再開しない', async () => {
  const c = await setup();
  await established(c);
  const seen: Overall[] = [];
  c.hostT.onOverall((o) => seen.push(o));
  c.stopEcho();
  await until(() => c.hostT.getState().overall === 'degraded', 1000, 'degraded');
  assert.equal(c.hostT.getState().nearby, 'suspended');
  c.host.emitEcho(); // 子機が戻った
  await wait(150);
  c.host.emitEcho();
  assert.equal(c.net.host.suspended, true);
  assert.deepEqual(c.net.host.leaked, []);
  c.cleanup();
});

test('誤検知: 一瞬の group 変化(クライアント 0 → 1)では Nearby を再開しない', async () => {
  const c = await setup();
  await established(c);
  c.host.emitGroup({ up: true, clients: 0 });
  await wait(30);
  c.host.emitGroup({ up: true, clients: 1 });
  await wait(300);
  assert.equal(c.net.host.suspended, true);
  assert.equal(c.hostT.getState().nearby, 'suspended');
  c.cleanup();
});

test('親機: グループ消滅 → Nearby は止めたまま固定グループを作り直す(最大 3 回)。作れれば Nearby は再開しない', async () => {
  const c = await setup();
  await established(c);
  const direct0 = c.host.calls.filter((x) => x === 'startDirect').length;
  c.stopEcho(); // グループが無ければ子機のエコー接続も届かない
  c.host.emitGroup({ up: false, clients: 0 });
  await until(() => c.host.calls.filter((x) => x === 'startDirect').length > direct0, 2000, 'recreate');
  await wait(100);
  assert.equal(c.net.host.suspended, true);
  assert.ok(c.net.host.notes.some((n) => n.includes('attempt=1/3')));
  c.cleanup();
});

test('stop で Nearby の suspend を解除する(ペアリングなどが Nearby を使えるように)', async () => {
  const c = await setup();
  await established(c);
  c.guestT.stop();
  assert.equal(c.net.guest.suspended, false);
  assert.equal(c.guestT.getState().nearby, 'down');
  c.cleanup();
});

test('画面用: linkSnapshot / onLink / state.linkState に状態名・ラベル・残り時間・履歴・設定が出る', async () => {
  const c = await setup();
  const snaps: string[] = [];
  c.guestT.onLink((s) => snaps.push(s.state.name));
  assert.equal(c.guestT.getState().linkState.name, 'stopped');
  await established(c);
  const sn = c.guestT.linkSnapshot();
  assert.equal(sn.state.name, 'direct-active');
  assert.equal(sn.state.label, 'Direct 接続中');
  assert.equal(sn.state.waiting?.for, 'T_echo');
  assert.ok(sn.state.waiting!.deadlineAt > Date.now() - 1000);
  assert.equal(sn.overall, 'connected');
  assert.equal(sn.path.nearby, 'suspended');
  assert.ok(sn.history.some((h) => h.to === 'settling') && sn.history.some((h) => h.to === 'direct'));
  assert.ok(JSON.stringify(sn).indexOf('shared-secret') < 0); // 秘密を含まない
  assert.equal((sn.timing as any).echoMs, 60);
  assert.equal(c.guestT.getState().linkState.name, 'direct-active');
  // 再接続中は「Direct 再接続中 n/3」
  c.guest.ctl.joinFails = 99;
  c.guest.ctl.probeOk = false;
  c.guest.loseWifi();
  await until(() => c.guestT.linkSnapshot().state.name === 'direct-retrying', 2000, 'retrying');
  await until(() => /^Direct 再接続中 [123]\/3$/.test(c.guestT.linkSnapshot().state.label), 2000, 'label');
  assert.ok(snaps.includes('direct-retrying'));
  c.cleanup();
});

test('時間設定: 保存した上書きが次の start で効く。範囲外は既定に丸める(unchecked でないとき)', async () => {
  const f = await pairedFakes();
  const t = new Tether(f.host.platform, { nearbyWhileDirect: 'suspend', connectTimeoutMs: 100, timing: { hbIntervalMs: 7_000 } });
  await t.setTimingOverride({ echoMs: 1 as number, settleMs: 9_000 });
  const logs: string[] = [];
  t.onLog((l) => logs.push(l));
  await t.start();
  const tm = t.getTiming();
  assert.equal(tm.hbIntervalMs, 7_000);
  assert.equal(tm.settleMs, 9_000);
  assert.equal(tm.echoMs, 21_000); // echoMs=1 は範囲外 → hb×3
  assert.ok(logs.some((l) => l.includes('DH-LINK') && l.includes('timing role=host')));
  t.stop();
  await t.setTimingOverride(null);
});

test('親機が正: 親機の閾値を子機が採用する(子機に別の値があっても)', async () => {
  const f = await pairedFakes();
  const base = { link: { baseMs: 5, maxMs: 20, pingTimeoutMs: 400 }, connectTimeoutMs: 100, probeIntervalMs: 1, nearbyWhileDirect: 'suspend' as const, timingUnchecked: true };
  const hostT = new Tether(f.host.platform, { ...base, timing: { hbIntervalMs: 20, echoMs: 60, directMs: 200, nearbyMs: 260, settleMs: 30, tickMs: 10 } });
  const guestT = new Tether(f.guest.platform, { ...base, timing: { hbIntervalMs: 30, echoMs: 90, directMs: 300, nearbyMs: 390, settleMs: 40, tickMs: 10 } });
  await hostT.start(); await guestT.start();
  await until(() => guestT.getTiming().echoMs === 60, 3000, 'adopt');
  assert.equal(guestT.getTiming().nearbyMs, 260);
  assert.equal(guestT.getTiming().tickMs, 10); // 端末ごとの分は自分の値
  hostT.stop(); guestT.stop();
});
