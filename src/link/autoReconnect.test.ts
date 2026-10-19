import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeNearbyPair } from './fakeNearby';
import { createLink } from './session';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 1500) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timeout');
    await wait(5);
  }
};

const FAST = { baseMs: 5, maxMs: 20, pingTimeoutMs: 150, sleep: wait };
const pairOf = (hostSecret = 's', guestSecret = 's') => ({
  hostPair: { peerId: 'DH-GUEST', secret: hostSecret },
  guestPair: { peerId: 'DH-HOST', secret: guestSecret },
});

function setup(hostSecret = 's', guestSecret = 's') {
  const net = fakeNearbyPair();
  const { hostPair, guestPair } = pairOf(hostSecret, guestSecret);
  const atHost: unknown[] = [];
  const atGuest: unknown[] = [];
  const mkHost = () =>
    createLink(net.host, { role: 'host', selfId: 'DH-HOST', pair: hostPair, connectTimeoutMs: 80 }, (b) => atHost.push(b), FAST);
  const mkGuest = () =>
    createLink(net.guest, { role: 'guest', selfId: 'DH-GUEST', pair: guestPair, connectTimeoutMs: 80 }, (b) => atGuest.push(b), FAST);
  return { net, atHost, atGuest, mkHost, mkGuest };
}

test('起動順序: 子機が先でも親機が後から出てくれば自動で繋がる', async () => {
  const { net, atHost, mkHost, mkGuest } = setup();
  const g = mkGuest(); void g.run();
  await wait(40); // 親機は不在
  const h = mkHost(); void h.run();
  await until(() => net.connected);
  g.send('hello');
  await until(() => atHost.length === 1);
  assert.deepEqual(atHost, ['hello']);
  g.stop(); h.stop();
});

test('切断: 明示的に切れても自動で復帰し、溜めた結果が1回ずつ届く', async () => {
  const { net, atGuest, mkHost, mkGuest } = setup();
  const h = mkHost(), g = mkGuest(); void h.run(); void g.run();
  await until(() => net.connected);
  net.drop();
  h.send('r1'); h.send('r2'); // 切断中に発生
  await until(() => atGuest.length === 2);
  assert.deepEqual(atGuest, ['r1', 'r2']);
  await wait(60); // 追加の重複がないこと
  assert.equal(atGuest.length, 2);
  h.stop(); g.stop();
});

test('繰り返し切れても毎回復帰する', async () => {
  const { net, atGuest, mkHost, mkGuest } = setup();
  const h = mkHost(), g = mkGuest(); void h.run(); void g.run();
  for (let i = 0; i < 5; i++) {
    await until(() => net.connected);
    h.send(`m${i}`);
    await until(() => atGuest.length === i + 1);
    net.drop();
  }
  assert.deepEqual(atGuest, ['m0', 'm1', 'm2', 'm3', 'm4']);
  h.stop(); g.stop();
});

test('黙って届かなくなった場合も ping 途絶で検知して復帰する', async () => {
  const { net, atGuest, mkHost, mkGuest } = setup();
  const h = mkHost(), g = mkGuest(); void h.run(); void g.run();
  try {
    await until(() => net.connected);
    let selfDisconnects = 0;
    const orig = net.host.disconnect.bind(net.host);
    net.host.disconnect = (id: string) => { selfDisconnects++; orig(id); };
    net.setBlackhole(true);
    h.send('lost?'); // 届かない
    await wait(400); // pingTimeout(150ms) を超える
    assert.ok(selfDisconnects >= 1, 'ping 途絶を検知して自分から切断している');
    net.setBlackhole(false);
    await until(() => atGuest.includes('lost?'));
    assert.deepEqual(atGuest, ['lost?']);
  } finally {
    h.stop(); g.stop();
  }
});

test('親機が再起動(送信番号が1に戻る)しても、以降の結果は捨てられない', async () => {
  const { net, atGuest, mkHost, mkGuest } = setup();
  let h = mkHost(); const g = mkGuest(); void h.run(); void g.run();
  await until(() => net.connected);
  h.send('before'); // seq=1
  await until(() => atGuest.length === 1);
  h.stop(); net.drop();
  h = mkHost(); void h.run(); // 新しい epoch で seq=1 から
  await until(() => net.connected);
  h.send('after'); // seq=1 だが別 epoch
  await until(() => atGuest.length === 2);
  assert.deepEqual(atGuest, ['before', 'after']);
  h.stop(); g.stop();
});

test('共有コード不一致では繋がらず、リトライし続ける(暴走しない)', async () => {
  const { net, atGuest, mkHost, mkGuest } = setup('aaa', 'bbb');
  const h = mkHost(), g = mkGuest(); void h.run(); void g.run();
  let adverts = 0;
  const orig = net.host.advertise.bind(net.host);
  net.host.advertise = (n: string) => { adverts++; orig(n); };
  h.send('secret-data');
  await wait(400);
  assert.equal(atGuest.length, 0);
  assert.ok(adverts >= 3, `リトライしている(広告 ${adverts} 回)`);
  assert.ok(adverts < 80, `暴走していない(広告 ${adverts} 回)`);
  h.stop(); g.stop();
});

test('stop() 後は再接続しない', async () => {
  const { net, mkHost, mkGuest } = setup();
  const h = mkHost(), g = mkGuest(); void h.run(); void g.run();
  await until(() => net.connected);
  h.stop(); g.stop();
  net.drop();
  await wait(100);
  assert.equal(net.connected, false);
});

test('圏外で送ったメッセージは、範囲に入った時点で1回だけ届く', async () => {
  const { atGuest, mkHost, mkGuest } = setup();
  const h = mkHost();
  const g = mkGuest();
  void h.run(); // 子機は圏外(まだ起動していない/見つからない)
  await wait(30);
  h.send({ kind: 'wifi', ssid: 'DIRECT-dh-test' }); // 圏外で送る
  await wait(30);
  assert.equal(atGuest.length, 0);
  void g.run(); // 範囲に入った
  await until(() => atGuest.length >= 1);
  await wait(100);
  assert.equal(atGuest.filter((b: any) => b?.kind === 'wifi').length, 1);
  h.stop(); g.stop();
});
