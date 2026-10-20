import { KeyValue } from './types';

/** ペア相手の Wi-Fi Direct 名・合言葉(direct.v1.<peerId>)を消す。remove が無い KeyValue は空文字で無効にする(directCreds は空を「保存なし」と扱う) */
export async function clearDirectCreds(kv: KeyValue, peerId: string): Promise<void> {
  const key = `direct.v1.${peerId}`;
  const r = (kv as { remove?: (k: string) => Promise<void> }).remove;
  if (r) await r.call(kv, key);
  else await kv.set(key, '');
}
