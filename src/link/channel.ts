/**
 * 端末間メッセージの分類。
 *  - 'app': アプリのメッセージ(`tether.app` に包まれた tether.send の中身)。運び先は**バス(Direct)だけ**。Nearby には載せない
 *  - 'ctl': tether 内部の制御(tether.wifi / hello / caps / timing / plan / need-wifi / unpair など)。従来の経路選択(Nearby / バス)
 */
export type Channel = 'app' | 'ctl';

export const channelOf = (body: unknown): Channel => ((body as { kind?: unknown } | null)?.kind === 'tether.app' ? 'app' : 'ctl');

/** ログ用の種別名(中身は出さない)。制御は kind、アプリは body.kind → body.type の文字列。無ければ型名 */
export function kindOf(body: unknown): string {
  const b = body as { kind?: unknown; body?: unknown } | null;
  if (b?.kind === 'tether.app') {
    const inner = b.body as { kind?: unknown; type?: unknown } | null;
    const k = typeof inner?.kind === 'string' ? inner.kind : typeof inner?.type === 'string' ? inner.type : null;
    return clean(k) ?? (inner === null ? 'null' : typeof inner);
  }
  return clean(typeof b?.kind === 'string' ? b.kind : null) ?? '?';
}

const clean = (s: string | null): string | null => (s && /^[\w.\-:]{1,40}$/.test(s) ? s : null);
