/** 実行時権限の組(react-native に依存しない純粋な部分。テストできるよう native.ts から分けた) */

const BT_PERMS = [
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.BLUETOOTH_CONNECT',
];

/** Android 17(API 37)で追加された「近くのデバイス」グループの権限。ローカルネットワーク(LAN)への接続に要る */
export const ACCESS_LOCAL_NETWORK = 'android.permission.ACCESS_LOCAL_NETWORK';

/**
 * Android のバージョンごとに、要求する実行時権限を切り替える(存在しない権限を要求すると denied になり、全体が失敗扱いになる)。
 * SDK<31: 位置情報(Bluetooth/Wi-Fi の探索に必要) / 31–32: Bluetooth 三種+位置情報 / 33–36: Bluetooth 三種+NEARBY_WIFI_DEVICES+通知
 * / 37 以上: 33–36 の組+ACCESS_LOCAL_NETWORK(NEARBY_WIFI_DEVICES とは別の権限。持っていても免除されない)
 */
export function permsFor(sdk: number): string[] {
  const loc = 'android.permission.ACCESS_FINE_LOCATION';
  if (sdk < 31) return [loc];
  if (sdk < 33) return [...BT_PERMS, loc];
  const base = [...BT_PERMS, 'android.permission.NEARBY_WIFI_DEVICES', 'android.permission.POST_NOTIFICATIONS'];
  return sdk >= 37 ? [...base, ACCESS_LOCAL_NETWORK] : base;
}
