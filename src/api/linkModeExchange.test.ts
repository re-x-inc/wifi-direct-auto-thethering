import test from 'node:test';
import assert from 'node:assert/strict';
import { pairedFakes } from './fakePlatform';
import { Tether } from './tether';
import { capsRevision } from './capability';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000, what = '') => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timeout ' + what);
    await wait(5);
  }
};

/** 時間を縮めた設定(handshake / tetherSuspend と同じ) */
const BASE = {
  link: { baseMs: 5, maxMs: 20, pingTimeoutMs: 400 }, connectTimeoutMs: 100, probeIntervalMs: 1,
  strictLinkGuard: true, timingUnchecked: true,
  timing: { hbIntervalMs: 20, tickMs: 10, echoMs: 60, directMs: 200, nearbyMs: 260, settleMs: 30, retryAttempts: 3, retryBackoffMs: [5], retryJoinTimeoutMs: 50, retryAttemptMs: 50, rejoinMs: 500 },
};
const S = { ...BASE, nearbyWhileDirect: 'suspend' as const };
const K = { ...BASE, nearbyWhileDirect: 'keep' as const };

async function run(hostCfg: object, guestCfg: object, tweak?: (g: Tether) => void) {
  const f = await pairedFakes();
  const hostT = new Tether(f.host.platform, hostCfg);
  const guestT = new Tether(f.guest.platform, guestCfg);
  tweak?.(guestT);
  const logs: string[] = [];
  hostT.onLog((l) => logs.push('H ' + l));
  guestT.onLog((l) => logs.push('G ' + l));
  // 子機のハートビート(エコー接続)が親機に届く様子を再現する
  const timer = setInterval(() => { if (f.guest.ctl.probeOk) f.host.emitEcho(); }, 10);
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on', 5000, 'vpn');
  return { ...f, hostT, guestT, logs, cleanup: () => { clearInterval(timer); hostT.stop(); guestT.stop(); } };
}
const suspended = (c: Awaited<ReturnType<typeof run>>) => c.net.host.suspendCount + c.net.guest.suspendCount;
const eff = (t: Tether) => t.linkSnapshot().mode?.effective;

test('suspend × suspend = suspend: 両端末とも実効 suspend で Nearby を止める。DH-LINK に 1 行、linkSnapshot.mode に出る', async () => {
  const c = await run(S, S);
  try {
    await until(() => c.hostT.getState().nearby === 'suspended' && c.guestT.getState().nearby === 'suspended', 5000, 'both suspended');
    assert.equal(eff(c.hostT), 'suspend');
    assert.equal(eff(c.guestT), 'suspend');
    assert.equal(c.hostT.linkSnapshot().mode?.peer, 'suspend');
    assert.ok(c.logs.some((l) => l.startsWith('H ') && l.includes('方式: 自分=suspend 相手=suspend → 実効=suspend(両方 suspend)')));
    assert.ok(c.logs.some((l) => l.startsWith('G ') && l.includes('方式: 自分=suspend 相手=suspend → 実効=suspend')));
  } finally { c.cleanup(); }
});

test('親機 suspend × 子機 keep = keep: どちらも Nearby を止めず、heartbeat 不在でも degraded にならない(2026-10-21 の事象)', async () => {
  const c = await run(S, K);
  try {
    await wait(400); // T_echo(60ms)を十分に超える
    assert.equal(eff(c.hostT), 'keep');
    assert.equal(eff(c.guestT), 'keep');
    assert.equal(suspended(c), 0);
    assert.equal(c.hostT.getState().overall, 'connected');
    assert.ok(c.logs.some((l) => l.startsWith('H ') && l.includes('方式: 自分=suspend 相手=keep → 実効=keep(相手が keep)')));
  } finally { c.cleanup(); }
});

test('親機 keep × 子機 suspend = keep: 子機の希望は親機の決定に従う', async () => {
  const c = await run(K, S);
  try {
    await wait(300);
    assert.equal(eff(c.hostT), 'keep');
    assert.equal(eff(c.guestT), 'keep');
    assert.equal(suspended(c), 0);
    assert.equal(c.guestT.getState().overall, 'connected');
    assert.ok(c.logs.some((l) => l.startsWith('G ') && l.includes('自分=suspend 相手=keep → 実効=keep')));
  } finally { c.cleanup(); }
});

test('旧版の子機(hello に名乗りなし) × 親機 suspend = keep(従来どおり)', async () => {
  const c = await run(S, S, (g) => {
    // 旧版の hello: nwd / tv を持たない
    (g as any).sendHello = async function (gen: number) {
      const caps = await this.capabilities();
      if (gen !== this.gen) return;
      this.ctl?.send({ kind: 'tether.hello', v: 1, rev: capsRevision(caps) }, { key: 'hello', ttlMs: 30_000 });
    };
  });
  try {
    await wait(300);
    assert.equal(c.hostT.linkSnapshot().mode?.peer, 'legacy');
    assert.equal(eff(c.hostT), 'keep');
    assert.equal(suspended(c), 0);
    assert.ok(c.logs.some((l) => l.startsWith('H ') && l.includes('旧版')));
  } finally { c.cleanup(); }
});

test('交換の前に Direct が張れたら keep: hello が来ないまま親機が進んでも suspend にしない(安全側)', async () => {
  const f = await pairedFakes();
  const hostT = new Tether(f.host.platform, { ...S, capsWaitMs: 30 });
  const guestT = new Tether(f.guest.platform, S);
  const logs: string[] = [];
  hostT.onLog((l) => logs.push('H ' + l));
  (guestT as any).sendHello = async () => {}; // hello が届かない/遅れる
  await hostT.start(); await guestT.start();
  try {
    await until(() => guestT.getState().vpn === 'on', 5000, 'vpn');
    // あとから(Direct 確立後に)hello が届いても、suspend へは上げない
    const caps = await guestT.capabilities();
    (guestT as any).ctl?.send({ kind: 'tether.hello', v: 1, rev: capsRevision(caps), nwd: 'suspend', tv: 1 }, { key: 'hello2', ttlMs: 30_000 });
    await wait(400);
    assert.equal(eff(hostT), 'keep');
    assert.equal(eff(guestT), 'keep');
    assert.equal(f.net.host.suspendCount + f.net.guest.suspendCount, 0);
    assert.ok(logs.some((l) => l.includes('安全側')));
  } finally { hostT.stop(); guestT.stop(); }
});

test('decideLinkMode の表と既定値の集約', async () => {
  const { decideLinkMode, DEFAULT_NEARBY_WHILE_DIRECT } = await import('../link/linkMode');
  const e = (a: any, b: any) => decideLinkMode(a, b).effective;
  assert.equal(e('suspend', 'suspend'), 'suspend');
  assert.equal(e('suspend', 'keep'), 'keep');
  assert.equal(e('keep', 'suspend'), 'keep');
  assert.equal(e('keep', 'keep'), 'keep');
  assert.equal(e('suspend', 'legacy'), 'keep');
  assert.equal(e('suspend', null), 'keep');
  assert.equal(DEFAULT_NEARBY_WHILE_DIRECT, 'keep'); // この PR では既定を変えない
});
