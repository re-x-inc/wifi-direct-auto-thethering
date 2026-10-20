import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_LOCAL_NETWORK, permsFor } from './permissions';
import { fakePairNet } from '../pairing/fakePairNet';
import { fakePlatform } from './fakePlatform';
import { Tether } from './tether';
import { TetherError } from './types';

test('ACCESS_LOCAL_NETWORK は API 37 以上だけ。API 36 以下では要求しない', () => {
  for (const sdk of [28, 30, 31, 32, 33, 34, 35, 36]) assert.ok(!permsFor(sdk).includes(ACCESS_LOCAL_NETWORK), `sdk ${sdk}`);
  for (const sdk of [37, 38]) assert.ok(permsFor(sdk).includes(ACCESS_LOCAL_NETWORK), `sdk ${sdk}`);
});

test('API 37 は 33–36 の組に ACCESS_LOCAL_NETWORK を足しただけ(NEARBY_WIFI_DEVICES も残す)', () => {
  assert.deepEqual(permsFor(37), [...permsFor(36), ACCESS_LOCAL_NETWORK]);
  assert.ok(permsFor(37).includes('android.permission.NEARBY_WIFI_DEVICES'));
});

test('既存の版ごとの組は変わらない', () => {
  assert.deepEqual(permsFor(30), ['android.permission.ACCESS_FINE_LOCATION']);
  assert.equal(permsFor(31).length, 4);
  assert.equal(permsFor(34).length, 5);
});

const handlers = { onDevices() {}, onConfirm() {}, onDone() {} };

test('beginPairing は権限が足りないと再要求せず、足りない一覧つきで即座に失敗する', async () => {
  const net = fakePairNet('4821');
  const f = fakePlatform(net.a, { missingPerms: ['android.permission.POST_NOTIFICATIONS'] });
  const t = new Tether(f.platform);
  await assert.rejects(
    () => t.beginPairing('host', handlers),
    (e: unknown) => e instanceof TetherError && e.code === 'permission-denied' && e.missing?.[0] === 'android.permission.POST_NOTIFICATIONS' && e.message.includes('POST_NOTIFICATIONS'),
  );
  assert.ok(!f.calls.includes('requestPermissions'));
  assert.ok(!f.calls.includes('keepAliveStart'));
});

test('失敗のあとも pairingBusy が残らず、権限がそろえば beginPairing できる', async () => {
  const net = fakePairNet('4821');
  const f = fakePlatform(net.a, { missingPerms: ['android.permission.POST_NOTIFICATIONS'] });
  const t = new Tether(f.platform);
  await assert.rejects(() => t.beginPairing('host', handlers));
  (f.platform as any).missingPermissions = async () => [];
  const c = await t.beginPairing('host', handlers);
  c.cancel();
  assert.ok(!f.calls.includes('requestPermissions'));
});

test('missingPermissions を持たない部品では従来どおり requestPermissions を呼ぶ(互換)', async () => {
  const net = fakePairNet('4821');
  const f = fakePlatform(net.a);
  delete (f.platform as any).missingPermissions;
  const t = new Tether(f.platform);
  const c = await t.beginPairing('guest', handlers);
  c.cancel();
  assert.ok(f.calls.includes('requestPermissions'));
});

test('ensurePermissions は要求したうえで、残りの不足を返す', async () => {
  const f = fakePlatform(fakePairNet('1').a, { missingPerms: ['android.permission.ACCESS_LOCAL_NETWORK'] });
  const r = await new Tether(f.platform).ensurePermissions();
  assert.equal(r.granted, false);
  assert.deepEqual(r.missing, ['android.permission.ACCESS_LOCAL_NETWORK']);
  assert.ok(f.calls.includes('requestPermissions'));
});
