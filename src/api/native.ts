import * as Crypto from 'expo-crypto';
import { PermissionsAndroid, Platform } from 'react-native';
import Hotspot from '../../modules/hotspot';
import KeepAlive from '../../modules/keep-alive';
import VpnTunnel from '../../modules/vpn-tunnel';
import { nearbyApi } from '../nearbyApi';
import { secureKv } from '../pairing/secureKv';
import { Tether } from './tether';
import { TetherConfig, TetherError, TetherPlatform } from './types';

const BT_PERMS = [
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.BLUETOOTH_CONNECT',
];

/**
 * Android のバージョンごとに、要求する実行時権限を切り替える(存在しない権限を要求すると denied になり、全体が失敗扱いになる)。
 * SDK<31: 位置情報(Bluetooth/Wi-Fi の探索に必要) / 31–32: Bluetooth 三種+位置情報 / 33 以上: Bluetooth 三種+NEARBY_WIFI_DEVICES+通知
 */
export function permsFor(sdk: number): string[] {
  const loc = 'android.permission.ACCESS_FINE_LOCATION';
  if (sdk < 31) return [loc];
  if (sdk < 33) return [...BT_PERMS, loc];
  return [...BT_PERMS, 'android.permission.NEARBY_WIFI_DEVICES', 'android.permission.POST_NOTIFICATIONS'];
}

/** 実機用の部品。ネイティブモジュールと SecureStore につなぐ。 */
export function nativePlatform(): TetherPlatform {
  return {
    nearby: nearbyApi,
    kv: secureKv,
    hotspot: {
      startHotspot: () => Hotspot.startHotspot(),
      stopHotspot: () => Hotspot.stopHotspot(),
      startDirect: (n, p, f) => Hotspot.startDirect(n, p, f),
      stopDirect: () => Hotspot.stopDirect(),
      startSocks: (port, u, p) => Hotspot.startSocks(port, u, p),
      stopSocks: () => Hotspot.stopSocks(),
      socksSelfTest: (port, u, p) => Hotspot.socksSelfTest(port, u, p),
      startEcho: (port) => Hotspot.startEcho(port),
      stopEcho: () => Hotspot.stopEcho(),
      joinWifi: (s, p) => Hotspot.joinWifi(s, p),
      leaveWifi: () => Hotspot.leaveWifi(),
      wifiFrequency: () => Hotspot.wifiFrequency(),
      hasCellular: () => Hotspot.hasCellular(),
      bindToJoined: () => Hotspot.bindToJoined(),
      unbindProcess: () => Hotspot.unbindProcess(),
      probe: (h, port) => Hotspot.probe(h, port),
      onWifiLost: (cb) => {
        const sub = Hotspot.addListener('onWifiLost', () => cb());
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
