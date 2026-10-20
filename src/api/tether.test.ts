import test from 'node:test';
import assert from 'node:assert/strict';
import { fakePairNet } from '../pairing/fakePairNet';
import { fakeNearbyPair } from '../link/fakeNearby';
import { fakePlatform, pairedFakes } from './fakePlatform';
import { Tether } from './tether';
import { TetherError } from './types';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timeout');
    await wait(5);
  }
};
const CFG = { link: { baseMs: 5, maxMs: 20, pingTimeoutMs: 200 }, connectTimeoutMs: 100, probeIntervalMs: 1 };

async function setup() {
  const f = await pairedFakes();
  const host = new Tether(f.host.platform, CFG);
  const guest = new Tether(f.guest.platform, CFG);
  return { ...f, hostT: host, guestT: guest };
}

test('役割の自動判定: セルラーあり=親機、なし=子機', async () => {
  const { hostT, guestT } = await setup();
  assert.equal(hostT.detectRole(), 'host');
  assert.equal(guestT.detectRole(), 'guest');
});

test('ペアが無いと start は no-pair で失敗する', async () => {
  const t = new Tether(fakePlatform(fakeNearbyPair().host).platform, CFG);
  await assert.rejects(() => t.start(), (e: unknown) => e instanceof TetherError && e.code === 'no-pair');
});

test('start だけで 接続 → 共有 → 子機が参加して VPN まで張られる', async () => {
  const { hostT, guestT, host, guest } = await setup();
  await hostT.start();
  await guestT.start();
  assert.equal(hostT.getState().role, 'host');
  assert.equal(guestT.getState().role, 'guest');
  await until(() => guestT.getState().vpn === 'on');
  assert.equal(guestT.getState().link, 'connected');
  assert.equal(hostT.getState().share, 'on');
  assert.equal(hostT.getState().shareMethod, 'WifiDirect');
  assert.ok(guest.calls.includes('vpnStart'));
  assert.ok(host.calls.includes('startSocks') && host.calls.includes('startEcho'));
  await until(() => hostT.getState().peerReach?.ok === true);
  hostT.stop(); guestT.stop();
});

test('アプリのメッセージは相手に届き、内部メッセージは混ざらない', async () => {
  const { hostT, guestT } = await setup();
  const got: unknown[] = [];
  guestT.onMessage((b, meta) => got.push([b, meta.role]));
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  hostT.send({ kind: 'accept', id: 'o1' });
  await until(() => got.length === 1);
  assert.deepEqual(got, [[{ kind: 'accept', id: 'o1' }, 'guest']]);
  hostT.stop(); guestT.stop();
});

test('ttl: 切断中に溜める(受諾)/ 溜めない(ttl 0)/ key で置き換え', async () => {
  const { hostT, guestT, net } = await setup();
  const got: any[] = [];
  guestT.onMessage((b) => got.push(b));
  await hostT.start(); await guestT.start();
  await until(() => net.connected);
  net.drop();
  hostT.send({ n: 'status-1' }, { ttlMs: 0 });
  hostT.send({ n: 'accept' }, { ttlMs: 10 * 60 * 1000 });
  hostT.send({ n: 'pos-1' }, { key: 'pos' });
  hostT.send({ n: 'pos-2' }, { key: 'pos' });
  await until(() => got.length >= 2, 3000);
  await wait(50);
  assert.deepEqual(got.map((b) => b.n), ['accept', 'pos-2']);
  hostT.stop(); guestT.stop();
});

test('Wi-Fi が切れたら VPN を止め、親機に接続情報を再送してもらって復旧する', async () => {
  const { hostT, guestT, guest } = await setup();
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  guest.loseWifi();
  assert.equal(guestT.getState().vpn, 'off');
  assert.ok(guest.calls.includes('vpnStop'));
  await until(() => guestT.getState().vpn === 'on');
  hostT.stop(); guestT.stop();
});

test('非常口: stopVpn のあとは 接続情報が再送されても VPN を張らず、resumeVpn で戻る', async () => {
  const { hostT, guestT, guest } = await setup();
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  guestT.stopVpn();
  assert.equal(guestT.getState().vpn, 'held');
  assert.equal(guest.vpnState.running, false);
  guest.loseWifi();
  await wait(100);
  assert.equal(guest.vpnState.running, false);
  assert.equal(guestT.getState().vpn, 'held');
  await guestT.resumeVpn();
  await until(() => guestT.getState().vpn === 'on');
  hostT.stop(); guestT.stop();
});

test('Wi-Fi Direct が失敗したら LocalOnlyHotspot にフォールバックする', async () => {
  const { net } = await pairedFakes();
  const f = fakePlatform(net.host, { cellular: true, directFails: true });
  await f.platform.kv.set('identity.v1', JSON.stringify({ id: 'DH-HOST', name: 'h' }));
  await f.platform.kv.set('pairs.v1', JSON.stringify([{ peerId: 'DH-GUEST', peerName: 'g', secret: 's', createdAt: 1 }]));
  const t = new Tether(f.platform, CFG);
  await t.start();
  await until(() => t.getState().share === 'on');
  assert.equal(t.getState().shareMethod, 'LocalOnlyHotspot');
  t.stop();
});

test('stop で共有・VPN・常駐をすべて止める', async () => {
  const { hostT, guestT, host, guest } = await setup();
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  hostT.stop(); guestT.stop();
  assert.equal(hostT.getState().started, false);
  assert.equal(guestT.getState().vpn, 'off');
  assert.ok(host.calls.includes('stopSocks') && host.calls.includes('keepAliveStop'));
  assert.equal(guest.vpnState.running, false);
  assert.equal(hostT.send('x'), false);
});

test('ペアリング → そのまま start できる(動いていたリンクは止めて、終わったら再開する)', async () => {
  const net = fakePairNet('4821');
  const a = new Tether(fakePlatform(net.a).platform, CFG);
  const b = new Tether(fakePlatform(net.b).platform, CFG);
  const st = { a: { devices: [] as any[], confirm: null as any, result: null as any }, b: { devices: [] as any[], confirm: null as any, result: null as any } };
  const handlers = (x: typeof st.a) => ({
    onDevices: (l: any[]) => (x.devices = l),
    onConfirm: (c: any) => (x.confirm = c),
    onDone: (r: any) => (x.result = r),
  });
  const ca = await a.beginPairing('guest', handlers(st.a));
  await b.beginPairing('host', handlers(st.b));
  await until(() => st.a.devices.length === 1);
  ca.connectTo(st.a.devices[0].endpointId);
  await until(() => st.a.confirm && st.b.confirm);
  assert.equal(st.a.confirm.digits, st.b.confirm.digits);
  st.a.confirm.accept(); st.b.confirm.accept();
  await until(() => st.a.result && st.b.result);
  assert.equal(st.a.result.ok, true);
  assert.equal((await a.pairs()).length, 1);
  assert.equal((await a.pairs())[0].secret, (await b.pairs())[0].secret);
  assert.equal((await a.pairs())[0].role, 'guest');
  assert.equal((await b.pairs())[0].role, 'host');
});

import { pickDirectPlans } from './tether';
const summ = (sta: number) => pickDirectPlans(sta).map((p) => `${p.band}/${p.freq ?? 'auto'}`);
test('Direct の帯域・チャンネル候補(2.4GHz 固定。STA が 2.4GHz のときだけ追従)', () => {
  assert.deepEqual(summ(0), ['2.4/2412', '2.4/2437', '2.4/2462', '2.4/auto']);
  assert.deepEqual(summ(2462), ['2.4/2462', '2.4/2412', '2.4/2437', '2.4/auto']);
  assert.deepEqual(summ(2447), ['2.4/2447', '2.4/2412', '2.4/2437', '2.4/2462', '2.4/auto']);
  for (const sta of [5180, 5580, 5745, 5955]) {
    assert.deepEqual(summ(sta), ['2.4/2412', '2.4/2437', '2.4/2462', '2.4/auto']); // 5GHz・DFS には合わせない
    assert.ok(pickDirectPlans(sta).every((p) => p.band === '2.4'));
  }
});

test('子機が unpair すると親機に解除通知が届き、親機も該当ペアと direct.v1 を消す', async () => {
  const { hostT, guestT, host, guest } = await setup();
  await host.platform.kv.set('direct.v1.DH-GUEST', 'x');
  await guest.platform.kv.set('direct.v1.DH-HOST', 'x');
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().link === 'connected' && hostT.getState().link === 'connected');
  await guestT.unpair('DH-HOST');
  await until(() => hostT.getState().started === false);
  assert.deepEqual(await hostT.pairs(), []);
  assert.deepEqual(await guestT.pairs(), []);
  assert.notEqual(await host.platform.kv.get('direct.v1.DH-GUEST'), 'x');
  assert.notEqual(await guest.platform.kv.get('direct.v1.DH-HOST'), 'x');
});

test('未接続で unpair しても、子機側だけ消えてエラーにならない', async () => {
  const { guestT } = await setup();
  await guestT.unpair('DH-HOST');
  assert.deepEqual(await guestT.pairs(), []);
});

test('接続すると pairs() の lastSeenAt が更新される', async () => {
  const { hostT, guestT } = await setup();
  assert.equal((await hostT.pairs())[0].lastSeenAt, undefined);
  await hostT.start(); await guestT.start();
  await until(() => hostT.getState().link === 'connected');
  await wait(20);
  assert.equal(typeof (await hostT.pairs())[0].lastSeenAt, 'number');
  hostT.stop(); guestT.stop();
});

test('onJoinPrompt: show で案内が出て、ok/declined/timeout/cancelled のどれでも消える', async () => {
  const { hostT, guestT, guest } = await setup();
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  for (const phase of ['ok', 'declined', 'timeout', 'cancelled'] as const) {
    guest.emitJoinPrompt({ ssid: 'DIRECT-x', phase: 'show', timeoutMs: 180000 });
    assert.equal(guestT.getState().joinPrompt, true, 'show');
    guest.emitJoinPrompt({ ssid: 'DIRECT-x', phase });
    assert.equal(guestT.getState().joinPrompt, false, phase);
  }
  hostT.stop(); guestT.stop();
});

test('stop で許可画面の案内も消える', async () => {
  const { hostT, guestT, guest } = await setup();
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  guest.emitJoinPrompt({ ssid: 'DIRECT-x', phase: 'show' });
  assert.equal(guestT.getState().joinPrompt, true);
  guestT.stop();
  assert.equal(guestT.getState().joinPrompt, false);
  hostT.stop();
});
