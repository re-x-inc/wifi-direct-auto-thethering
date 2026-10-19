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
