import * as Crypto from 'expo-crypto';
import { Linking, PermissionsAndroid, Platform } from 'react-native';
import Hotspot from '../../modules/hotspot';
import KeepAlive from '../../modules/keep-alive';
import NearbyLink from '../../modules/nearby-link';
import VpnTunnel from '../../modules/vpn-tunnel';
import { nearbyApi } from '../nearbyApi';
import { secureKv } from '../pairing/secureKv';
import { BACKGROUND_LOCATION, needsBackgroundLocation, permsFor } from './permissions';
import { Tether } from './tether';
import { TetherConfig, TetherError, TetherPlatform } from './types';

export { permsFor } from './permissions';

/** 実機用の部品。ネイティブモジュールと SecureStore につなぐ。 */
export function nativePlatform(): TetherPlatform {
  return {
    nearby: nearbyApi,
    onNativeLog: (cb) => {
      const subs = [Hotspot, NearbyLink].map((m: any) => m.addListener('log', (e: { tag: string; line: string }) => cb(e.tag, e.line)));
      return () => subs.forEach((s) => s.remove());
    },
    kv: secureKv,
    hotspot: {
      startHotspot: () => Hotspot.startHotspot(),
      stopHotspot: () => Hotspot.stopHotspot(),
      startDirect: (n, p, f, b, w) => Hotspot.startDirect(n, p, f, b ?? null, w ?? null),
      stopDirect: () => Hotspot.stopDirect(),
      startSocks: (port, u, p) => Hotspot.startSocks(port, u, p),
      stopSocks: () => Hotspot.stopSocks(),
      socksSelfTest: (port, u, p) => Hotspot.socksSelfTest(port, u, p),
      startEcho: (port) => Hotspot.startEcho(port),
      stopEcho: () => Hotspot.stopEcho(),
      joinWifi: (s, p, t) => Hotspot.joinWifi(s, p, t ?? null),
      leaveWifi: () => Hotspot.leaveWifi(),
      wifiFrequency: () => Hotspot.wifiFrequency(),
      hasCellular: () => Hotspot.hasCellular(),
      bindToJoined: () => Hotspot.bindToJoined(),
      unbindProcess: () => Hotspot.unbindProcess(),
      probe: (h, port) => Hotspot.probe(h, port),
      heartbeatStart: (o) => Hotspot.heartbeatStart(o.host, o.port, o.intervalMs, o.timeoutMs, o.screenOffIntervalMs ?? 0, o.wakeLock ?? true),
      heartbeatStop: () => Hotspot.heartbeatStop(),
      heartbeatStatus: () => Hotspot.heartbeatStatus(),
      onHeartbeat: (cb) => {
        const sub = Hotspot.addListener('onHeartbeat', (e) => cb(e));
        return () => sub.remove();
      },
      onWifiLost: (cb) => {
        const sub = Hotspot.addListener('onWifiLost', () => cb());
        return () => sub.remove();
      },
      onDirectGroup: (cb) => {
        const sub = Hotspot.addListener('onDirectGroup', (e) => cb(e));
        return () => sub.remove();
      },
      onEchoAccept: (cb) => {
        const sub = Hotspot.addListener('onEchoAccept', () => cb());
        return () => sub.remove();
      },
      onJoinPrompt: (cb) => {
        const sub = Hotspot.addListener('onJoinPrompt', (e) => cb(e));
        return () => sub.remove();
      },
    },
    capability: {
      collect: () => Hotspot.capabilities(),
      probeLohs: () => Hotspot.probeLohs(),
      diagnostics: () => Hotspot.diagnostics(),
      saveFile: (name, text) => Hotspot.saveDiagnosticFile(name, text),
    },
    vpn: {
      prepare: () => VpnTunnel.prepare(),
      start: (h, port, u, p) => VpnTunnel.start(h, port, u, p),
      stop: () => VpnTunnel.stop(),
      status: () => VpnTunnel.status(),
    },
    keepAlive: { start: () => KeepAlive.start(), stop: () => KeepAlive.stop() },
    missingPermissions: async () => {
      const miss: string[] = [];
      for (const p of permsFor(Number(Platform.Version))) if (!(await PermissionsAndroid.check(p as any))) miss.push(p);
      return miss;
    },
    backgroundLocationGranted: async () =>
      !needsBackgroundLocation(Number(Platform.Version)) || (await PermissionsAndroid.check(BACKGROUND_LOCATION as any)),
    openAppSettings: () => Linking.openSettings(),
    requestPermissions: async () => {
      const res = await PermissionsAndroid.requestMultiple(permsFor(Number(Platform.Version)) as any[]);
      return Object.values(res).every((v) => v === 'granted');
    },
    randomHex: (bytes) => Array.from(Crypto.getRandomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join(''),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}


/**
 * この端末の Tether(1 プロセスに 1 つ)。Fast Refresh で作り直されても二重にリンクが走らないよう、同じものを返す。
 * Android 以外では TetherError('unsupported')。
 */
export function getTether(cfg?: TetherConfig): Tether {
  if (Platform.OS !== 'android') throw new TetherError('unsupported', 'Android のみ対応しています');
  // モジュールが再評価されても(Fast Refresh)同じ Tether を使うよう、globalThis に持つ
  const g = globalThis as { __tetherShared?: Tether };
  if (!g.__tetherShared) g.__tetherShared = new Tether(nativePlatform(), cfg);
  return g.__tetherShared;
}
