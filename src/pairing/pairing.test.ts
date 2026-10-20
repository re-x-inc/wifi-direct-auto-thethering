import test from 'node:test';
import assert from 'node:assert/strict';
import { fakePairNet } from './fakePairNet';
import { PairingSession, PairingResult, Confirm, Found, parsePairingName } from './pairing';
import { getIdentity, PairStore } from './store';
import { KeyValue } from './types';

const mem = (): KeyValue => {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
};
let n = 0;
const randomHex = (bytes: number) => Array.from({ length: bytes }, () => ((n++ * 37 + 11) % 256).toString(16).padStart(2, '0')).join('');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 1000) {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await wait(5);
  }
}

async function setup() {
  const net = fakePairNet();
  const kvA = mem(), kvB = mem();
  const idA = await getIdentity(kvA, randomHex), idB = await getIdentity(kvB, randomHex);
  const storeA = new PairStore(kvA), storeB = new PairStore(kvB);
  const mk = (api: any, self: any, store: PairStore, role: 'host' | 'guest') => {
    const s = new PairingSession(api, { self, store, randomHex, role });
    const st = { devices: [] as Found[], confirm: null as Confirm | null, result: null as PairingResult | null };
    s.onDevices = (l) => (st.devices = l);
    s.onConfirm = (c) => (st.confirm = c);
    s.onDone = (r) => (st.result = r);
    return { s, st };
  };
  return { A: mk(net.a, idA, storeA, 'guest'), B: mk(net.b, idB, storeB, 'host'), idA, idB, storeA, storeB };
}

test('端末IDは一度だけ作り、再起動しても同じ', async () => {
  const kv = mem();
  const a = await getIdentity(kv, randomHex);
  const b = await getIdentity(kv, randomHex);
  assert.deepEqual(a, b);
  assert.match(a.id, /^T[0-9a-f]{8}$/);
});

test('ペアリング用の名前だけを一覧に出す(通常の接続名や自分は出さない)', async () => {
  const { A, B, idB } = await setup();
  A.s.start(); B.s.start();
  await until(() => A.st.devices.length === 1);
  assert.equal(A.st.devices[0].id, idB.id);
  assert.equal(parsePairingName('T12345678'), null);
  assert.equal(parsePairingName('P|'), null);
  A.s.stop(); B.s.stop();
});

test('確認コードを両方が承認すると、同じ共有コードが両端末に保存される', async () => {
  const { A, B, idA, idB, storeA, storeB } = await setup();
  A.s.start(); B.s.start();
  await until(() => A.st.devices.length === 1);
  A.s.connectTo(A.st.devices[0].endpointId);
  await until(() => !!A.st.confirm && !!B.st.confirm);
  assert.equal(A.st.confirm!.digits, B.st.confirm!.digits); // 同じ数字が両方に出る
  A.st.confirm!.accept(); B.st.confirm!.accept();
  await until(() => !!A.st.result && !!B.st.result);
  assert.equal(A.st.result!.ok, true);
  assert.equal(B.st.result!.ok, true);
  const [pa] = await storeA.list(), [pb] = await storeB.list();
  assert.equal(pa.peerId, idB.id);
  assert.equal(pb.peerId, idA.id);
  assert.equal(pa.secret, pb.secret);
  assert.equal(pa.role, 'guest'); // 子機になる側
  assert.equal(pb.role, 'host'); // 親機になる側
  assert.match(pa.secret, /^[0-9a-f]{64}$/);
});

test('片方が「一致しない」を選ぶと、どちらにも保存されない', async () => {
  const { A, B, storeA, storeB } = await setup();
  A.s.start(); B.s.start();
  await until(() => A.st.devices.length === 1);
  A.s.connectTo(A.st.devices[0].endpointId);
  await until(() => !!A.st.confirm && !!B.st.confirm);
  A.st.confirm!.accept();
  B.st.confirm!.reject();
  await until(() => !!A.st.result && !!B.st.result);
  assert.equal(A.st.result!.ok, false);
  assert.equal(B.st.result!.ok, false);
  assert.deepEqual(await storeA.list(), []);
  assert.deepEqual(await storeB.list(), []);
});

test('同じ相手と再ペアリングすると、共有コードが入れ替わる', async () => {
  const kv = mem();
  const store = new PairStore(kv);
  await store.save({ peerId: 'Tx', peerName: 'x', secret: 'old', createdAt: 1 });
  await store.save({ peerId: 'Tx', peerName: 'x', secret: 'new', createdAt: 2 });
  const l = await store.list();
  assert.equal(l.length, 1);
  assert.equal(l[0].secret, 'new');
  await store.remove('Tx');
  assert.deepEqual(await store.list(), []);
});

test('進行状況: 要求中 → 相手の承認待ち → 共有コードの交換が通知される', async () => {
  const { A, B } = await setup();
  const a: string[] = [], b: string[] = [];
  A.s.onStatus = (m) => a.push(m);
  B.s.onStatus = (m) => b.push(m);
  A.s.start(); B.s.start();
  await until(() => A.st.devices.length === 1);
  A.s.connectTo(A.st.devices[0].endpointId);
  await until(() => !!A.st.confirm && !!B.st.confirm);
  assert.match(a[0], /要求/);
  A.st.confirm!.accept(); // 先に A だけが承認 → A は相手の承認待ち
  assert.match(a[a.length - 1], /承認を待って/);
  B.st.confirm!.accept();
  await until(() => !!A.st.result && !!B.st.result);
  assert.ok(a.some((m) => /交換/.test(m)));
  assert.ok(b.some((m) => /交換/.test(m)));
});

test('親機同士・子機同士では見つからない(親機は広告だけ、子機は探索だけ)', async () => {
  const net = fakePairNet();
  const kv1 = mem(), kv2 = mem();
  const mkS = async (api: any, kv: any, role: 'host' | 'guest') => {
    const s = new PairingSession(api, { self: await getIdentity(kv, randomHex), store: new PairStore(kv), randomHex, role });
    const st = { devices: [] as Found[] };
    s.onDevices = (l) => (st.devices = l);
    return { s, st };
  };
  const h1 = await mkS(net.a, kv1, 'host'), h2 = await mkS(net.b, kv2, 'host');
  h1.s.start(); h2.s.start();
  await wait(50);
  assert.equal(h1.st.devices.length, 0);
  assert.equal(h2.st.devices.length, 0);
  h1.s.stop(); h2.s.stop();
});

test('親機: 新ペア完了時、同じ表示名の旧ペアは置き換え、名前が違うものは残す', async () => {
  const { A, B, idA, storeB } = await setup();
  await storeB.save({ peerId: 'Told', peerName: idA.name, secret: 'old', createdAt: 1 });
  await storeB.save({ peerId: 'Tother', peerName: 'べつ', secret: 'x', createdAt: 1 });
  const replaced: string[] = [];
  (B.s as any).o.onReplaced = (old: any[]) => void replaced.push(...old.map((p) => p.peerId));
  A.s.start(); B.s.start();
  await until(() => A.st.devices.length === 1);
  A.s.connectTo(A.st.devices[0].endpointId);
  await until(() => !!A.st.confirm && !!B.st.confirm);
  A.st.confirm!.accept(); B.st.confirm!.accept();
  await until(() => !!A.st.result && !!B.st.result);
  const ids = (await storeB.list()).map((p) => p.peerId).sort();
  assert.deepEqual(ids, [idA.id, 'Tother'].sort());
  assert.deepEqual(replaced, ['Told']);
});

test('子機側(guest)は同名の旧ペアを自動では消さない', async () => {
  const { A, B, idB, storeA } = await setup();
  await storeA.save({ peerId: 'Told', peerName: idB.name, secret: 'old', createdAt: 1 });
  A.s.start(); B.s.start();
  await until(() => A.st.devices.length === 1);
  A.s.connectTo(A.st.devices[0].endpointId);
  await until(() => !!A.st.confirm && !!B.st.confirm);
  A.st.confirm!.accept(); B.st.confirm!.accept();
  await until(() => !!A.st.result && !!B.st.result);
  assert.equal((await storeA.list()).length, 2);
});

test('touch: lastSeenAt を更新する(無いペアは何もしない・旧データは未設定のまま読める)', async () => {
  const store = new PairStore(mem());
  await store.save({ peerId: 'Tx', peerName: 'x', secret: 's', createdAt: 1 });
  assert.equal((await store.list())[0].lastSeenAt, undefined);
  await store.touch('Tx', 99);
  await store.touch('none', 5);
  const l = await store.list();
  assert.equal(l.length, 1);
  assert.equal(l[0].lastSeenAt, 99);
});
