import { KeyValue } from './types';

/** Wi-Fi Direct グループの名前と合言葉。ペアごとに固定し、親機が作るたびに同じ値になる(子機の承認ダイアログを毎回出さないため) */
export interface DirectCreds {
  ssid: string;
  pass: string;
}

const KEY = (peerId: string) => `direct.v1.${peerId}`;
const SSID_RE = /^DIRECT-[A-Za-z0-9]{2}-[\x20-\x7e]{1,22}$/;
const SSID_SALT = 'tether-direct-ssid-v1';

export function validDirectCreds(c: Partial<DirectCreds> | null | undefined): c is DirectCreds {
  return !!c && typeof c.ssid === 'string' && typeof c.pass === 'string' && SSID_RE.test(c.ssid) && c.ssid.length <= 32 && c.pass.length >= 8 && c.pass.length <= 63;
}

/**
 * ペアの Wi-Fi Direct 名・合言葉を返す。保存済みがあればそれを使い、なければ作って保存する。
 * - 名前: 両端末の ID(並べ替えて結合)から決める。秘密ではなく、再ペアリングしても変わらない。
 * - 合言葉: ペアの共有コードから決める。再ペアリングで共有コードが変わったときだけ作り直す(名前はそのまま)。
 * 合言葉はログに出さないこと。
 */
export async function directCreds(o: {
  hmac: (secret: string, data: string) => string;
  kv: KeyValue;
  selfId: string;
  peerId: string;
  secret: string;
}): Promise<DirectCreds> {
  const bind = o.hmac(o.secret, 'direct-bind').slice(0, 8);
  const ssid = 'DIRECT-dh-' + o.hmac(SSID_SALT, [o.selfId, o.peerId].sort().join('|')).slice(0, 6);
  try {
    const raw = await o.kv.get(KEY(o.peerId));
    if (raw) {
      const v = JSON.parse(raw);
      if (v?.bind === bind && validDirectCreds(v)) return { ssid: v.ssid, pass: v.pass };
    }
  } catch {}
  const c = { ssid, pass: o.hmac(o.secret, 'direct-pass').slice(0, 16) };
  try {
    await o.kv.set(KEY(o.peerId), JSON.stringify({ ...c, bind }));
  } catch {}
  return c;
}
