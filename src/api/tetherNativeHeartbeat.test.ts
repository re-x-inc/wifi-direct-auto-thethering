import test from 'node:test';
import assert from 'node:assert/strict';
import { pairedFakes } from './fakePlatform';
import { Tether } from './tether';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000, what = '') => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timeout ' + what);
    await wait(5);
  }
};

/** 時間を縮めた設定(hb 20ms → T_echo 60 / T_direct 200 / T_nearby 260) */
const CFG = {
  link: { baseMs: 5, maxMs: 20, pingTimeoutMs: 400 }, connectTimeoutMs: 100, probeIntervalMs: 1,
  strictLinkGuard: true,
  timingUnchecked: true,
  timing: { hbIntervalMs: 20, tickMs: 10, echoMs: 60, directMs: 200, nearbyMs: 260, settleMs: 30, retryAttempts: 3, retryBackoffMs: [5], retryJoinTimeoutMs: 50, retryAttemptMs: 50, rejoinMs: 500 },
};

/** ネイティブのハートビートを持つ子機。native=true の間、ネイティブが 10ms ごとに成功を記録し、親機のエコーにも届ける */
async function setup(cfg: object = CFG, nativeHeartbeat = true) {
  const f = await pairedFakes({ nativeHeartbeat });
  const hostT = new Tether(f.host.platform, cfg);
  const guestT = new Tether(f.guest.platform, cfg);
  const nat = { ok: true };
  const timer = setInterval(() => {
    const hb = f.guest.ctl.hb;
    if (!hb.running || !nat.ok) return;
    const now = Date.now();
    hb.lastAttemptAt = now; hb.lastOkAt = now; hb.attempts++; hb.consecutiveFailures = 0;
    f.host.emitEcho();
  }, 10);
  return { ...f, hostT, guestT, nat, cleanup: () => { clearInterval(timer); hostT.stop(); guestT.stop(); } };
}

async function established(c: Awaited<ReturnType<typeof setup>>) {
  await c.hostT.start();
  await c.guestT.start();
  await until(() => c.guestT.getState().vpn === 'on', 3000, 'vpn');
  await until(() => c.hostT.getState().nearby === 'suspended' && c.guestT.getState().nearby === 'suspended', 3000, 'both suspended');
}

test('ネイティブ heartbeat: 親機の IP・Echo ポート・間隔・タイムアウトを渡して開始し、JS の probe では送らない', async () => {
  const c = await setup();
  await established(c);
  const starts = c.guest.calls.filter((x) => x.startsWith('hbStart:'));
  assert.equal(starts.length, 1);
  assert.equal(starts[0], 'hbStart:192.168.49.1:9000:20:20:-:true'); // timeout = min(3000, hb)
  await wait(150);
  assert.equal(c.guestT.getState().overall, 'connected');
  assert.equal(c.hostT.getState().overall, 'connected');
  c.cleanup();
  assert.ok(c.guest.calls.includes('hbStop'));
});

test('ネイティブの成功が続く限り、JS 側の判定が滞っても retrying にならない(結果はネイティブの時刻で読む)', async () => {
  const c = await setup();
  await established(c);
  // 親機側の probe(JS のハートビート)は使われない: probeOk=false でも子機は connected のまま
  c.guest.ctl.probeOk = false;
  await wait(250);
  assert.equal(c.guestT.getState().overall, 'connected');
  assert.equal(c.guestT.getState().nearby, 'suspended');
  c.cleanup();
});

test('ネイティブの失敗が T_echo を超えて続けば、生存信号なしとして degraded → Direct 再接続へ', async () => {
  const c = await setup();
  await established(c);
  c.nat.ok = false;
  const hb = c.guest.ctl.hb;
  hb.consecutiveFailures = 1; hb.lastFailAt = Date.now(); hb.lastError = 'ETIMEDOUT';
  await until(() => c.guestT.getState().overall !== 'connected', 1000, 'degraded');
  await until(() => c.net.guest.notes.some((n) => n.includes('生存信号なし')), 1000, 'silence note');
  c.cleanup();
});

test('JS が止まっていた間の時間は失敗に数えない: 判定が溜まったあと、ネイティブの最新の成功時刻で復帰する', async () => {
  const c = await setup();
  await established(c);
  // JS のタイマを塞ぐ(同期的に 300ms 占有 = T_echo=60ms を超える)。この間もネイティブは成功を記録し続ける
  const t0 = Date.now();
  let spin = 0;
  const nativeKeep = setInterval(() => {}, 1000); // 何もしない: 占有中は JS のタイマは動かない
  while (Date.now() - t0 < 300) spin++;
  clearInterval(nativeKeep);
  const hb = c.guest.ctl.hb;
  hb.lastOkAt = Date.now(); hb.lastAttemptAt = Date.now(); // ネイティブは止まらず成功していた
  await wait(80);
  assert.equal(c.guestT.getState().overall, 'connected');
  assert.equal(c.guestT.getState().nearby, 'suspended');
  assert.ok(spin > 0);
  c.cleanup();
});

test('フォールバック: ネイティブ heartbeat を持たない部品では従来の JS heartbeatLoop で動く', async () => {
  const c = await setup(CFG, false);
  await established(c);
  assert.equal(c.guest.calls.filter((x) => x.startsWith('hbStart:')).length, 0);
  await wait(150);
  assert.equal(c.guestT.getState().overall, 'connected');
  c.cleanup();
});

test('画面オフ中の間隔は T_echo の半分までに丸めて渡す', async () => {
  const c = await setup({ ...CFG, hbScreenOffIntervalMs: 10_000, hbWakeLock: false });
  await established(c);
  assert.ok(c.guest.calls.includes('hbStart:192.168.49.1:9000:20:20:30:false')); // echoMs 60 / 2
  c.cleanup();
});
