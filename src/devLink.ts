import NearbyLink from '../modules/nearby-link';
import { NearbyApi } from './link/nearbyTransport';

/** ネイティブの NearbyLink モジュールを NearbyApi に合わせる。 */
export const nearbyApi: NearbyApi = {
  advertise: (n) => NearbyLink.advertise(n),
  discover: () => NearbyLink.discover(),
  requestConnect: (id, n) => NearbyLink.requestConnect(id, n),
  accept: (id) => NearbyLink.accept(id),
  reject: (id) => NearbyLink.reject(id),
  send: (id, t) => NearbyLink.send(id, t),
  disconnect: (id) => NearbyLink.disconnect(id),
  stop: () => NearbyLink.stop(),
  hmac: (s, d) => NearbyLink.hmac(s, d),
  on: (ev, cb) => {
    const sub = (NearbyLink as any).addListener(ev, cb);
    return () => sub.remove();
  },
};

/** 実機テスト用の固定ペア。本番は初回ペアリングで交換した共有コードを使う。 */
// リポジトリは public のため、共有コードはコードに書かない。開発時はビルド時に渡す:
//   EXPO_PUBLIC_DEV_SECRET=<適当な長い文字列> npx expo start
// 両端末で同じ値を使う。未設定のときは開始を拒否する(App.tsx)。
export const DEV_SECRET: string = process.env.EXPO_PUBLIC_DEV_SECRET ?? '';
export const DEV_ID = { host: 'DH-HOST', guest: 'DH-GUEST' } as const;
