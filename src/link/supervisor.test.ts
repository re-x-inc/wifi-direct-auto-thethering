import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, Frame, LinkSupervisor, Transport } from './supervisor';

test('backoff: 上限を超えず、下限は半分', () => {
  const o = { baseMs: 1000, maxMs: 30000 };
  assert.equal(backoffMs(0, { ...o, random: () => 0 }), 500);
  assert.equal(backoffMs(0, { ...o, random: () => 1 }), 1000);
  assert.equal(backoffMs(20, { ...o, random: () => 1 }), 30000);
});

class FakeTransport implements Transport {
  sent: Frame[] = [];
  private fcb: (f: Frame) => void = () => {};
  private ccb: () => void = () => {};
  constructor(private failConnect = false, private autoAck = true) {}
  async connect() { if (this.failConnect) throw new Error('down'); }
  send(f: Frame) { this.sent.push(f); if (this.autoAck && f.type === 'data') queueMicrotask(() => this.fcb({ type: 'ack', seq: f.seq })); }
  onFrame(cb: (f: Frame) => void) { this.fcb = cb; }
  onClose(cb: () => void) { this.ccb = cb; }
  close() {}
  drop() { this.ccb(); }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

test('切断中に溜めた結果が、再接続後に再送される', async () => {
  const ts = [new FakeTransport(false, false), new FakeTransport(true), new FakeTransport(false, true)];
  let i = 0;
  const sup = new LinkSupervisor(() => ts[i++], () => {}, { sleep: () => tick(), pingTimeoutMs: 100000 });
  const run = sup.run();
  await tick();
  sup.send('a'); // 1本目は ack しない → 未確認のまま
  await tick();
  assert.equal(sup.pending, 1);
  ts[0].drop(); // 切断
  sup.send('b'); // 切断中に発生
  await tick(); await tick(); await tick();
  assert.equal(sup.pending, 0); // 3本目で a, b とも再送→ack
  const resent = ts[2].sent.filter((f) => f.type === 'data').map((f) => (f as any).body);
  assert.deepEqual(resent, ['a', 'b']);
  sup.stop();
  void run;
});

test('send: ttl 0 は溜めない / key は最新だけ残す / 期限切れは再送しない', async () => {
  let now = 1000;
  const ts = [new FakeTransport(false, false), new FakeTransport(false, true)];
  let i = 0;
  const sup = new LinkSupervisor(() => ts[i++], () => {}, { sleep: () => tick(), pingTimeoutMs: 100000, now: () => now });
  void sup.run();
  try {
    await tick();
    sup.send('keep'); // 無期限
    sup.send('ephemeral', { ttlMs: 0 }); // 溜めない
    sup.send('s1', { key: 'status' });
    sup.send('s2', { key: 'status' }); // s1 を置き換える
    sup.send('short', { ttlMs: 1000 });
    await tick();
    assert.equal(sup.pending, 3); // keep / s2 / short (ephemeral は溜めない、s1 は置換済み)
    now += 5000; // short は期限切れ
    ts[0].drop();
    await tick(); await tick(); await tick();
    const resent = ts[1].sent.filter((f) => f.type === 'data').map((f) => (f as any).body);
    assert.deepEqual(resent, ['keep', 's2']);
  } finally {
    sup.stop();
  }
});
