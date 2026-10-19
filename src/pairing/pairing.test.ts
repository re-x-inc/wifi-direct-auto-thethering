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
  const mk = (api: any, self: any, store: PairStore) => {
    const s = new PairingSession(api, { self, store, randomHex });
    const st = { devices: [] as Found[], confirm: null as Confirm | null, result: null as PairingResult | null };
    s.onDevices = (l) => (st.devices = l);
    s.onConfirm = (c) => (st.confirm = c);
    s.onDone = (r) => (st.result = r);
    return { s, st };
  };
  return { A: mk(net.a, idA, storeA), B: mk(net.b, idB, storeB), idA, idB, storeA, storeB };
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
