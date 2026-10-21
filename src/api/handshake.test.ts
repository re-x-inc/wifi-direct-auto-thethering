import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeNearbyPair } from '../link/fakeNearby';
import { fakePlatform } from './fakePlatform';
import { Tether } from './tether';
import { TetherError, HandshakeEvent } from './types';
import { NativeCapabilities } from './capability';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 6000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timeout');
    await wait(5);
  }
};
const CAPS_WAIT = 7777;
const CFG = { link: { baseMs: 5, maxMs: 20, pingTimeoutMs: 200 }, connectTimeoutMs: 100, probeIntervalMs: 1, capsWaitMs: CAPS_WAIT };

async function setup(o: { host?: Partial<NativeCapabilities>; guest?: Partial<NativeCapabilities>; directFails?: boolean } = {}) {
  const net = fakeNearbyPair();
  const host = fakePlatform(net.host, { cellular: true, directFails: o.directFails, caps: o.host, model: 'HostPhone' });
  const guest = fakePlatform(net.guest, { cellular: false, caps: o.guest, model: 'GuestPhone' });
  // 能力の待ち時間だけ実時間にして、交換が先に終わることを確かめられるようにする
  const fast = host.platform.sleep;
  host.platform.sleep = (ms) => (ms === CAPS_WAIT ? wait(1500) : fast(ms));
  const seed = async (p: typeof host.platform, self: string, peer: string) => {
    await p.kv.set('identity.v1', JSON.stringify({ id: self, name: self }));
    await p.kv.set('pairs.v1', JSON.stringify([{ peerId: peer, peerName: peer, secret: 'shared-secret-xyz', createdAt: 1 }]));
  };
  await seed(host.platform, 'DH-HOST', 'DH-GUEST');
  await seed(guest.platform, 'DH-GUEST', 'DH-HOST');
  const hostT = new Tether(host.platform, CFG);
  const guestT = new Tether(guest.platform, CFG);
  const hostEv: HandshakeEvent[] = [];
  const guestEv: HandshakeEvent[] = [];
  const logs: string[] = [];
  hostT.onHandshake((e) => hostEv.push(e));
  guestT.onHandshake((e) => guestEv.push(e));
  hostT.onLog((l) => logs.push(l));
  guestT.onLog((l) => logs.push(l));
  return { net, host, guest, hostT, guestT, hostEv, guestEv, logs };
}

test('接続前に子機の能力を受け取り、方式を決めて子機へ通知してから共有を始める', async () => {
  const { hostT, guestT, hostEv, guestEv, logs, host } = await setup();
  await hostT.start();
  await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  assert.deepEqual(hostT.getState().plan?.order, ['WifiDirect', 'LocalOnlyHotspot']);
  assert.deepEqual(guestT.getState().plan?.order, ['WifiDirect', 'LocalOnlyHotspot']);
  assert.ok(hostEv.some((e) => e.type === 'caps-received' && !e.cached && e.model === 'GuestPhone'));
  assert.ok(guestEv.some((e) => e.type === 'plan' && e.side === 'guest'));
  assert.equal(hostT.getState().shareMethod, 'WifiDirect');
  // 相手へ渡るのは Planner が使う能力のみ。診断レポート(sections)は含まれない
  const cacheJson = (await host.platform.kv.get('tether.capcache.v1')) ?? '';
  assert.ok(cacheJson.includes('GuestPhone'));
  assert.ok(!cacheJson.includes('sections') && !cacheJson.includes('fingerprint') && !cacheJson.includes('permissions'));
  assert.ok(!(host.calls.some((c) => c.startsWith('saveFile'))));
  // 共有コード・資格情報をログに出さない
  const all = logs.join('\n');
  assert.ok(!all.includes('shared-secret-xyz'));
  assert.ok(!/pass|user/i.test(JSON.stringify(hostT.getState().plan)));
  assert.ok(host.calls.includes('startDirect'));
  hostT.stop(); guestT.stop();
});

test('2 回目の接続: キャッシュがあれば子機の能力を待たず、交換も省略される', async () => {
  const { hostT, guestT, hostEv } = await setup();
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  hostT.stop(); guestT.stop();
  hostEv.length = 0;
  await hostT.start();
  // 子機が来る前に、キャッシュだけで計画ができて共有が始まる
  await until(() => hostT.getState().share === 'on');
  assert.equal(hostT.getState().plan?.ok, true);
  await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  await until(() => !!guestT.getState().plan);
  await wait(50);
  // 能力の本体は再送されない(受信イベントが出るとしてもキャッシュ由来のみ)
  assert.ok(hostEv.filter((e) => e.type === 'caps-received').every((e) => e.type === 'caps-received' && e.cached));
  hostT.stop(); guestT.stop();
});

test('子機の能力が変わった(版が違う)ら、キャッシュを使わず再取得する', async () => {
  const { hostT, guestT, hostEv, guest } = await setup();
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  hostT.stop(); guestT.stop();
  hostEv.length = 0;
  // VPN 同意が外れた = 能力の内容が変わる
  const cap = guest.platform.capability!;
  const orig = cap.collect;
  cap.collect = () => ({ ...orig(), vpnConsent: false });
  await hostT.start(); await guestT.start();
  await until(() => hostEv.some((e) => e.type === 'caps-received' && !e.cached));
  await until(() => !!guestT.getState().plan?.guests[0]?.todo.includes('vpn-consent'));
  hostT.stop(); guestT.stop();
});

test('Direct 不可の親機: 最初から LocalOnlyHotspot で共有し、Direct は試さない。子機は毎回承認を案内される', async () => {
  const { hostT, guestT, host } = await setup({ host: { wifiDirect: false } });
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  assert.equal(hostT.getState().shareMethod, 'LocalOnlyHotspot');
  assert.ok(!host.calls.includes('startDirect'));
  await until(() => !!guestT.getState().plan);
  assert.ok(guestT.getState().plan!.guests[0].todo.includes('approve-join-each-time'));
  hostT.stop(); guestT.stop();
});

test('使える方式がない親機: 共有に失敗し、人が読める理由が親機・子機に出る', async () => {
  const { hostT, guestT, host } = await setup({ host: { wifiDirect: false } });
  await host.platform.kv.set('tether.probe.v1', JSON.stringify({ buildKey: 'HostPhone|35', at: 1, observed: {}, lohs: { ok: false, reason: 'generic', at: 1 } }));
  const hostFailing = hostT;
  await hostFailing.start(); await guestT.start();
  await until(() => hostT.getState().share === 'failed');
  assert.match(hostT.getState().error ?? '', /使えるリンク方式/);
  await until(() => guestT.getState().plan?.ok === false);
  assert.equal(guestT.getState().plan?.failure?.code, 'no-usable-method');
  assert.ok(!host.calls.includes('startHotspot'));
  hostT.stop(); guestT.stop();
});

test('回線なし同士: 共有せず理由を返す', async () => {
  const net = fakeNearbyPair();
  const host = fakePlatform(net.host, { cellular: false });
  const guest = fakePlatform(net.guest, { cellular: false });
  for (const [p, self, peer] of [[host, 'DH-HOST', 'DH-GUEST'], [guest, 'DH-GUEST', 'DH-HOST']] as const) {
    await p.platform.kv.set('identity.v1', JSON.stringify({ id: self, name: self }));
    await p.platform.kv.set('pairs.v1', JSON.stringify([{ peerId: peer, peerName: peer, secret: 's', createdAt: 1 }]));
  }
  const hostT = new Tether(host.platform, CFG);
  const guestT = new Tether(guest.platform, CFG);
  await hostT.start({ role: 'host' }); await guestT.start({ role: 'guest' });
  await until(() => hostT.getState().plan?.failure?.code === 'no-cellular-both');
  assert.equal(hostT.getState().share, 'failed');
  hostT.stop(); guestT.stop();
});

test('プロトコル版の食い違い: 更新を促す理由コードと update-required が出る', async () => {
  const { hostT, guestT, hostEv, guestEv } = await setup();
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  // 新しい版の子機を装う(能力は読まず、版だけで判断される)
  (guestT as any).link.send({ kind: 'tether.hello', v: 99, rev: 'zz' }, { key: 'hello' });
  await until(() => hostEv.some((e) => e.type === 'update-required'));
  assert.equal(hostT.getState().plan?.failure?.code, 'protocol-host-outdated');
  assert.equal(hostT.getState().plan?.failure?.update, 'host');
  assert.match(hostT.getState().error ?? '', /更新/);
  await until(() => guestEv.some((e) => e.type === 'update-required'));
  hostT.stop(); guestT.stop();
});

test('古い親機(交換に対応していない)の相手でも、子機の hello は無視されて従来どおり動く', async () => {
  const { hostT, guestT, host } = await setup();
  // 親機の hello 処理を無効化 = 能力交換を知らない親機。待ち時間後に不明として決める
  (hostT as any).onHello = async () => {};
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on', 4000);
  assert.ok(host.calls.includes('startDirect'));
  hostT.stop(); guestT.stop();
});

test('Direct が続けて失敗した履歴があると、次回は LocalOnlyHotspot を先に試す', async () => {
  const { hostT, host } = await setup({ directFails: true });
  for (let i = 0; i < 2; i++) {
    await hostT.start();
    await until(() => hostT.getState().share === 'on', 6000);
    hostT.stop();
  }
  const before = host.calls.filter((c) => c === 'startDirect').length;
  await hostT.start();
  await until(() => hostT.getState().share === 'on', 6000);
  assert.equal(hostT.getState().plan?.order[0], 'LocalOnlyHotspot');
  assert.equal(host.calls.filter((c) => c === 'startDirect').length, before); // Direct を試さずに済んだ
  hostT.stop();
});

test('capabilities(): 不明は null のまま。試験・観測結果は端末内に保存される', async () => {
  const { hostT, host } = await setup({ host: { staApConcurrent: null } });
  const c = await hostT.capabilities();
  assert.equal(c.radio.staApConcurrent, null);
  assert.equal(c.radio.lohs, null);
  assert.equal(c.network.cellular, true);
  assert.equal(c.device.model, 'HostPhone');
  const r = await hostT.runProbe();
  assert.equal(r.lohs.ok, true);
  assert.equal(r.capabilities.radio.lohs, true);
  assert.equal(r.capabilities.source.lohs, 'probe');
  assert.ok(host.calls.includes('probeLohs'));
  // 作り直しても残る
  const again = await new Tether(host.platform, CFG).capabilities();
  assert.equal(again.radio.lohs, true);
});

test('runProbe: 共有中は busy。能力の部品がなければ unsupported', async () => {
  const { hostT, guestT } = await setup();
  await hostT.start(); await guestT.start();
  await until(() => hostT.getState().share === 'on');
  await assert.rejects(() => hostT.runProbe(), (e: unknown) => e instanceof TetherError && e.code === 'busy');
  hostT.stop(); guestT.stop();
  const bare = fakePlatform(fakeNearbyPair().host).platform;
  delete bare.capability;
  const t = new Tether(bare, CFG);
  await assert.rejects(() => t.runProbe(), (e: unknown) => e instanceof TetherError && e.code === 'unsupported');
  const c = await t.capabilities();
  assert.equal(c.radio.wifiDirect, null); // 部品が無ければ不明
});

test('Direct 成功時に STA 接続中だった場合は STA+P2P の同時動作として観測される', async () => {
  const { hostT, host, guestT } = await setup();
  (host.platform.hotspot as any).wifiFrequency = () => 2437;
  await hostT.start(); await guestT.start();
  await until(() => hostT.getState().share === 'on');
  await wait(30);
  const c = await hostT.capabilities();
  assert.equal(c.radio.staP2pConcurrent, true);
  assert.equal(c.source.staP2pConcurrent, 'observed');
  hostT.stop(); guestT.stop();
});

test('ペア解除で、その相手の能力キャッシュと履歴も消える', async () => {
  const { hostT, guestT, host } = await setup();
  await hostT.start(); await guestT.start();
  await until(() => guestT.getState().vpn === 'on');
  assert.ok((await host.platform.kv.get('tether.capcache.v1'))?.includes('DH-GUEST'));
  await hostT.removePair('DH-GUEST');
  assert.ok(!(await host.platform.kv.get('tether.capcache.v1'))?.includes('DH-GUEST'));
  assert.ok(!(await host.platform.kv.get('tether.history.v1'))?.includes('DH-GUEST'));
  guestT.stop();
});

test('ペア解除で、その相手の Wi-Fi Direct 名・合言葉(direct.v1.<peerId>)も消える', async () => {
  const { hostT, guestT, host } = await setup();
  await hostT.start(); await guestT.start();
  await until(() => hostT.getState().share === 'on');
  assert.ok(await host.platform.kv.get('direct.v1.DH-GUEST'));
  await hostT.removePair('DH-GUEST');
  assert.ok(!(await host.platform.kv.get('direct.v1.DH-GUEST')));
  guestT.stop(); hostT.stop();
});

test('ネイティブのログ(onNativeLog)が tether.onLog に流れる', async () => {
  const { hostT, host } = await setup();
  let push: (tag: string, line: string) => void = () => {};
  (host.platform as any).onNativeLog = (cb: any) => { push = cb; return () => {}; };
  const t = new (hostT.constructor as any)(host.platform, {});
  const lines: string[] = [];
  t.onLog((l: string) => lines.push(l));
  push('DH-P2P', 'i group ready freq=2412');
  assert.deepEqual(lines, ['[DH-P2P] i group ready freq=2412']);
});
