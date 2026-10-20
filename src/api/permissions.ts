/** 実行時権限の組(react-native に依存しない純粋な部分。テストできるよう native.ts から分けた) */

const BT_PERMS = [
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.BLUETOOTH_CONNECT',
];

/**
 * 33 以上でも要求する位置情報(おおよそ)。GMS の Nearby が Wi-Fi の状態が変わったあと(Wi-Fi Direct 参加で家の Wi-Fi から外れたあとなど)に
 * 見ることがあり、無いと discover が 8034 MISSING_PERMISSION_ACCESS_COARSE_LOCATION で失敗する(実機 Android 17)。
 * 31 以上では FINE を求める場合も COARSE を併せて要求しないと FINE の要求が無視される。
 */
export const COARSE_LOCATION = 'android.permission.ACCESS_COARSE_LOCATION';

/** Android 17(API 37)で追加された「近くのデバイス」グループの権限。ローカルネットワーク(LAN)への接続に要る */
export const ACCESS_LOCAL_NETWORK = 'android.permission.ACCESS_LOCAL_NETWORK';

/**
 * Android のバージョンごとに、要求する実行時権限を切り替える(存在しない権限を要求すると denied になり、全体が失敗扱いになる)。
 * SDK<31: 位置情報(Bluetooth/Wi-Fi の探索に必要) / 31–32: Bluetooth 三種+位置情報(COARSE+FINE) / 33–36: Bluetooth 三種+COARSE+NEARBY_WIFI_DEVICES+通知
 * / 37 以上: 33–36 の組+ACCESS_LOCAL_NETWORK(NEARBY_WIFI_DEVICES とは別の権限。持っていても免除されない)
 */
export function permsFor(sdk: number): string[] {
  const loc = 'android.permission.ACCESS_FINE_LOCATION';
  if (sdk < 31) return [loc];
  if (sdk < 33) return [...BT_PERMS, COARSE_LOCATION, loc];
  const base = [...BT_PERMS, COARSE_LOCATION, 'android.permission.NEARBY_WIFI_DEVICES', 'android.permission.POST_NOTIFICATIONS'];
  return sdk >= 37 ? [...base, ACCESS_LOCAL_NETWORK] : base;
}

/**
 * 「常に許可」の位置情報(API 29 以上)。背面でも Nearby の探索が appop(アプリ使用中のみ)で拒否されないために要る。
 * requestMultiple に混ぜると失敗する(API 30 以降は別段・設定画面で選ばせる)ので permsFor には入れない。
 * Play Console の「位置情報(バックグラウンド)」申告が必要: 用途=画面オフ・背面でも親機との接続を保つため。
 */
export const BACKGROUND_LOCATION = 'android.permission.ACCESS_BACKGROUND_LOCATION';
export const needsBackgroundLocation = (sdk: number) => sdk >= 29;
