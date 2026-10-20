import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { directCreds, validDirectCreds } from './directCreds';

const hmac = (s: string, d: string) => createHmac('sha256', s).update(d).digest('hex');
const mem = () => {
  const m = new Map<string, string>();
  return { m, get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) };
};

test('同じペアなら毎回同じ名前・合言葉で、どちらの端末から計算しても名前は同じ', async () => {
  const kv = mem();
  const a = await directCreds({ hmac, kv, selfId: 'TA', peerId: 'TB', secret: 's1' });
  const b = await directCreds({ hmac, kv, selfId: 'TA', peerId: 'TB', secret: 's1' });
  assert.deepEqual(a, b);
  assert.ok(validDirectCreds(a));
  const other = await directCreds({ hmac, kv: mem(), selfId: 'TB', peerId: 'TA', secret: 's1' });
  assert.equal(other.ssid, a.ssid);
});

test('保存済みの値を使う / 再ペアリング(共有コード変更)では合言葉だけ変わる', async () => {
  const kv = mem();
  const a = await directCreds({ hmac, kv, selfId: 'TA', peerId: 'TB', secret: 's1' });
  kv.m.set('direct.v1.TB', JSON.stringify({ ...a, pass: 'saved-pass-1234', bind: JSON.parse(kv.m.get('direct.v1.TB')!).bind }));
  assert.equal((await directCreds({ hmac, kv, selfId: 'TA', peerId: 'TB', secret: 's1' })).pass, 'saved-pass-1234');
  const c = await directCreds({ hmac, kv, selfId: 'TA', peerId: 'TB', secret: 's2' });
  assert.equal(c.ssid, a.ssid);
  assert.notEqual(c.pass, a.pass);
});

test('壊れた保存値は作り直す', async () => {
  const kv = mem();
  kv.m.set('direct.v1.TB', '{"ssid":"x","pass":"y"}');
  assert.ok(validDirectCreds(await directCreds({ hmac, kv, selfId: 'TA', peerId: 'TB', secret: 's1' })));
});
