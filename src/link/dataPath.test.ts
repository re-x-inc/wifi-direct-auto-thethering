import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOverall, initialDataPath, OverallInput } from './dataPath';

const base = (o: Partial<OverallInput>): OverallInput => ({
  role: 'host', started: true, data: initialDataPath(), shareOn: true, wifiJoined: false, vpnOn: false,
  heartbeatMode: true, retrying: false, now: 100_000, echoMs: 15_000, directMs: 30_000, ...o,
});
const d = (p: Partial<ReturnType<typeof initialDataPath>>) => ({ ...initialDataPath(), ...p });

test('親機: グループあり・到達確認 OK・エコー新鮮 = connected', () => {
  assert.equal(deriveOverall(base({ data: d({ group: true, reach: { ok: true, at: 1 }, echoAt: 95_000 }) })), 'connected');
});

test('親機: エコー無通信が T_echo で degraded、T_direct で disconnected', () => {
  const data = (echoAt: number) => d({ group: true, reach: { ok: true, at: 1 }, echoAt });
  assert.equal(deriveOverall(base({ data: data(84_001) })), 'degraded');
  assert.equal(deriveOverall(base({ data: data(70_000) })), 'disconnected');
});

test('親機: Nearby が繋がっていてもグループが無ければ disconnected(接続表示にならない)', () => {
  assert.equal(deriveOverall(base({ data: d({ group: false, reach: { ok: true, at: 1 }, echoAt: 99_000 }) })), 'disconnected');
});

test('親機: 共有していない・停止中は disconnected、まだ到達確認なしは degraded', () => {
  assert.equal(deriveOverall(base({ shareOn: false })), 'disconnected');
  assert.equal(deriveOverall(base({ started: false })), 'disconnected');
  assert.equal(deriveOverall(base({ data: d({ group: true }) })), 'degraded');
});

test('子機: 参加+VPN+ハートビート成功 = connected。失敗/古いと degraded、silence で disconnected', () => {
  const g = (hb: { ok: boolean; at: number }, okAt: number) => base({ role: 'guest', wifiJoined: true, vpnOn: true, data: d({ group: true, heartbeat: hb, okAt, reach: { ok: true, at: 1 } }) });
  assert.equal(deriveOverall(g({ ok: true, at: 99_000 }, 99_000)), 'connected');
  assert.equal(deriveOverall(g({ ok: false, at: 99_000 }, 95_000)), 'degraded');
  assert.equal(deriveOverall(g({ ok: false, at: 99_000 }, 60_000)), 'disconnected');
});

test('子機: Wi-Fi 未参加は disconnected、VPN 起動中は degraded', () => {
  assert.equal(deriveOverall(base({ role: 'guest' })), 'disconnected');
  assert.equal(deriveOverall(base({ role: 'guest', wifiJoined: true, data: d({ group: true }) })), 'degraded');
});

test('Direct 再接続中は degraded(尽きれば retrying が外れて disconnected)', () => {
  assert.equal(deriveOverall(base({ role: 'guest', retrying: true })), 'degraded');
  assert.equal(deriveOverall(base({ role: 'guest', retrying: false })), 'disconnected');
});

test('suspend 未対応の旧部品(heartbeatMode=false)ではエコーの鮮度を見ない', () => {
  assert.equal(deriveOverall(base({ heartbeatMode: false, data: d({ group: true, reach: { ok: true, at: 1 } }) })), 'connected');
});
