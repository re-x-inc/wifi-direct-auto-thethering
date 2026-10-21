import { fakeBusPair } from '../link/fakeBus';
import type { BusPort } from '../link/busControl';
import { fakeNearbyPair } from '../link/fakeNearby';
import { NearbyApi } from '../link/nearbyTransport';
import { KeyValue } from '../pairing/types';
import type { NativeCapabilities } from './capability';
import { HotspotPort, TetherPlatform, VpnPort } from './types';

export const memKv = (): KeyValue => {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), remove: async (k) => void m.delete(k) };
};

let n = 0;
export const testRandomHex = (bytes: number) =>
  Array.from({ length: bytes }, () => ((n++ * 37 + 11) % 256).toString(16).padStart(2, '0')).join('');

/** 端末の部品の偽物。呼び出しを calls に記録する。 */
export function fakePlatform(nearby: NearbyApi, o: { cellular?: boolean; directFails?: boolean; directDelayMs?: number; joinError?: string; caps?: Partial<NativeCapabilities>; lohsProbe?: { ok: boolean; reason?: string }; model?: string; diagExtra?: Record<string, unknown>; missingPerms?: string[]; backgroundLocation?: boolean; externalProbe?: boolean; bus?: BusPort } = {}) {
  const calls: string[] = [];
  const files: Record<string, string> = {};
  const wifiLost = new Set<() => void>();
  const joinPrompt = new Set<(e: { ssid: string; phase: 'show' | 'ok' | 'declined' | 'timeout' | 'cancelled'; timeoutMs?: number }) => void>();
  const vpnState = { running: false, permitted: true };
  const groupCbs = new Set<(e: { up: boolean; clients: number; appInitiated?: boolean }) => void>();
  /** テストから切り替える: joinWifi の失敗 */
  const ctl = {
    joinFails: 0,
  };
  /** o.externalProbe のとき: 偽の probe 供給元。start されると**すぐ 1 周**実行し(xpOk の成否)、以後はテストが xpRound で進める */
  const xp = { running: false, attempts: 0, lastAttemptAt: 0, lastOkAt: 0, lastFailAt: 0, lastReason: null as string | null, lastRttMs: -1, lastHttp: 0, consecutiveFailures: 0 };
  const xpCbs = new Set<(st: typeof xp) => void>();
  const xpCtl: { ok: boolean; reason: string; round: (ok?: boolean, reason?: string) => void } = {
    ok: true, reason: 'upstream',
    /** 1 周ぶんの結果を作って onExternalProbe を流す(ok を省略すると xpCtl.ok) */
    round: (ok: boolean = xpCtl.ok, reason: string = xpCtl.reason) => {
      const now = Date.now();
      xp.attempts++; xp.lastAttemptAt = now;
      if (ok) { xp.lastOkAt = now; xp.lastReason = null; xp.lastHttp = 204; xp.lastRttMs = 5; xp.consecutiveFailures = 0; }
      else { xp.lastFailAt = now; xp.lastReason = reason; xp.lastHttp = 0; xp.consecutiveFailures++; }
      for (const cb of xpCbs) cb({ ...xp });
    },
  };
  const hotspot: HotspotPort = {
    startHotspot: async () => (calls.push('startHotspot'), { ssid: 'AndroidShare_1', passphrase: 'lohspass' }),
    stopHotspot: () => void calls.push('stopHotspot'),
    startDirect: async (name, pass) => {
      calls.push('startDirect');
      if (o.directDelayMs) await new Promise((r) => setTimeout(r, o.directDelayMs));
      calls.push('directCreated');
      if (o.directFails) throw new Error('p2p busy');
      return { ssid: name ?? 'DIRECT-x', passphrase: pass ?? 'p' };
    },
    stopDirect: async () => void calls.push('stopDirect'),
    startSocks: async () => (calls.push('startSocks'), { network: 'cellular' as const }),
    stopSocks: () => void calls.push('stopSocks'),
    socksSelfTest: async () => ({ ok: true, line: 'ok' }),
    onDirectGroup: (cb) => (groupCbs.add(cb), () => groupCbs.delete(cb)),
    joinWifi: async (ssid) => {
      calls.push('join:' + ssid);
      if (ctl.joinFails > 0) { ctl.joinFails--; throw new Error('not-found'); }
      if (o.joinError) throw new Error(o.joinError);
      return { gateway: '192.168.49.1' };
    },
    leaveWifi: () => void calls.push('leaveWifi'),
    wifiFrequency: () => 0,
    hasCellular: () => o.cellular ?? false,
    bindToJoined: () => true,
    unbindProcess: () => void calls.push('unbind'),
    ...(o.externalProbe ? {
      externalProbeStart: (a: { socksHost: string; socksPort: number; intervalMs: number; confirmIntervalMs: number; timeoutMs: number; failThreshold: number; urls: string[] }) => {
        calls.push(`xpStart:${a.socksHost}:${a.socksPort}:${a.intervalMs}:${a.confirmIntervalMs}:${a.timeoutMs}:${a.failThreshold}:${a.urls.length}`);
        xp.running = true;
        xpCtl.round(); // 始めたらすぐ 1 周
      },
      externalProbeStop: () => { calls.push('xpStop'); xp.running = false; },
      externalProbeStatus: () => ({ ...xp }),
      onExternalProbe: (cb: (st: typeof xp) => void) => (xpCbs.add(cb), () => xpCbs.delete(cb)),
    } : {}),
    onJoinPrompt: (cb) => (joinPrompt.add(cb), () => joinPrompt.delete(cb)),
    onWifiLost: (cb) => (wifiLost.add(cb), () => wifiLost.delete(cb)),
  };
  const vpn: VpnPort = {
    prepare: () => vpnState.permitted,
    start: () => {
      calls.push('vpnStart');
      vpnState.running = true;
    },
    stop: () => {
      if (vpnState.running) calls.push('vpnStop');
      vpnState.running = false;
    },
    status: () => ({ running: vpnState.running, error: null }),
  };
  const nativeCaps: NativeCapabilities = {
    manufacturer: 'Fake', model: o.model ?? 'FakePhone', sdk: 35, release: '15', batteryPercent: 80,
    batteryOptimizationExempt: true, wifiDirect: true, staApConcurrent: true, staLocalOnlyConcurrent: true,
    band24: true, band5: true, vpnConsent: true, deviceOwner: false, missingPermissions: [], ...o.caps,
  };
  const platform: TetherPlatform = {
    nearby,
    capability: {
      collect: () => ({ ...nativeCaps }),
      probeLohs: async () => (calls.push('probeLohs'), o.lohsProbe ?? { ok: true }),
      diagnostics: () => ({
        schema: 1,
        sections: {
          build: {
            manufacturer: { v: nativeCaps.manufacturer, minApi: null },
            model: { v: nativeCaps.model, minApi: null },
            sdkInt: { v: nativeCaps.sdk, minApi: null },
            ...(o.diagExtra ?? {}),
          },
          wifi: { band6: { v: null, minApi: 30, why: 'sdk<30' }, standardsSupported: { v: ['11n', '11ac'], minApi: 30 } },
        },
      }),
      saveFile: (name, text) => (calls.push('saveFile:' + name), (files[name] = text), '/fake/diagnostics/' + name),
    },
    kv: memKv(),
    hotspot,
    vpn,
    ...(o.bus ? { bus: o.bus } : {}),
    keepAlive: { start: () => void calls.push('keepAliveStart'), stop: () => void calls.push('keepAliveStop') },
    missingPermissions: async () => [...(o.missingPerms ?? [])],
    backgroundLocationGranted: async () => o.backgroundLocation ?? true,
    openAppSettings: async () => void calls.push('openAppSettings'),
    requestPermissions: async () => (calls.push('requestPermissions'), true),
    randomHex: testRandomHex,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    now: () => Date.now(),
  };
  return { platform, calls, files, vpnState, ctl, xp, xpCtl,
    emitGroup: (e: { up: boolean; clients: number; appInitiated?: boolean }) => groupCbs.forEach((cb) => cb(e)),
    emitJoinPrompt: (e: Parameters<typeof joinPrompt.add>[0] extends (x: infer E) => void ? E : never) => joinPrompt.forEach((cb) => cb(e)), loseWifi: () => wifiLost.forEach((cb) => cb()) };
}

/** 両端末に同じ共有コードのペアを入れた、親機・子機の偽プラットフォーム(fakeNearbyPair の端末名に合わせる) */
export async function pairedFakes(guestOpts: { joinError?: string; externalProbe?: boolean } = {}, o: { bus?: boolean } = {}) {
  const net = fakeNearbyPair();
  /** o.bus: 両端末に Direct 上のバスの偽物を付ける(既定は付けない = 従来どおり Nearby だけ) */
  const bus = o.bus ? fakeBusPair() : null;
  const host = fakePlatform(net.host, { cellular: true, bus: bus?.host });
  const guest = fakePlatform(net.guest, { cellular: false, bus: bus?.guest, ...guestOpts });
  const seed = async (p: TetherPlatform, self: string, peer: string) => {
    await p.kv.set('identity.v1', JSON.stringify({ id: self, name: self }));
    await p.kv.set('pairs.v1', JSON.stringify([{ peerId: peer, peerName: peer, secret: 'shared-secret', createdAt: 1 }]));
  };
  await seed(host.platform, 'DH-HOST', 'DH-GUEST');
  await seed(guest.platform, 'DH-GUEST', 'DH-HOST');
  return { net, host, guest, bus };
}
