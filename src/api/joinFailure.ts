/**
 * 子機が親機の Wi-Fi に参加できなかった理由を分ける(純関数)。
 * native(HotspotModule.joinFailure)が失敗時に出す 1 行 `join-failed reason=… direct=… total=… expected=… freq=…` を読む。
 * 理由の判定はスキャン結果と OS の通知の組み合わせ:
 * - not-found: スキャンに親機の名前が無い(近づく・親機のアプリを開いたままにする)
 * - rejected: 名前は見えているのに OS が「利用できない」を返した(親機側に断られた)
 * - awaiting-approval: 名前は見えていて、承認の操作がないまま時間切れ
 * - timeout: 時間切れで、スキャンも読めず切り分けられない
 * - unavailable: 失敗したが、スキャンが読めず断られたのか見つからないのか分からない
 * - other: 上のどれにも当てはまらない(古い版のメッセージなど)
 */
export type JoinFailureReason = 'not-found' | 'rejected' | 'awaiting-approval' | 'timeout' | 'unavailable' | 'other';

export interface JoinFailure {
  reason: JoinFailureReason;
  /** スキャンで見えた「機器どうしの接続用」の名前の数。スキャンを読めなければ null */
  direct: number | null;
  /** スキャン結果の総数 */
  total: number | null;
  /** 親機の名前がスキャンに見えたか。スキャンを読めなければ null */
  expectedSeen: boolean | null;
  /** 見えたときの周波数(MHz) */
  freq: number | null;
}

const REASONS: readonly JoinFailureReason[] = ['not-found', 'rejected', 'awaiting-approval', 'timeout', 'unavailable', 'other'];
const num = (v: string | undefined): number | null => (v && /^\d+$/.test(v) ? Number(v) : null);

/** 例外メッセージから理由を読む。native の 1 行でなければ、語句から大まかに(timeout だけ)推す */
export function parseJoinFailure(message: string): JoinFailure {
  const m = /join-failed reason=(\S+) direct=(\S+) total=(\S+) expected=([01?]) freq=(\S+)/.exec(message);
  if (m) {
    const reason = (REASONS as readonly string[]).includes(m[1]) ? (m[1] as JoinFailureReason) : 'other';
    return { reason, direct: num(m[2]), total: num(m[3]), expectedSeen: m[4] === '1' ? true : m[4] === '0' ? false : null, freq: num(m[5]) };
  }
  const reason: JoinFailureReason = /timeout|timed out|時間切れ/i.test(message) ? 'timeout' : 'other';
  return { reason, direct: null, total: null, expectedSeen: null, freq: null };
}

/** 画面に出す、理由ごとの日本語 1 文(内部の名前や生ログは含めない) */
export function joinFailureText(reason: JoinFailureReason): string {
  switch (reason) {
    case 'not-found':
      return '親機の Wi-Fi が見つかりません。親機を近づけて、親機のアプリを開いたままにしてください';
    case 'rejected':
      return '親機に接続を断られました。親機のアプリを開き直してください';
    case 'awaiting-approval':
      return '接続の確認がまだ終わっていません。表示された確認で「接続」を押してください';
    case 'timeout':
      return '時間内に接続できませんでした。親機に近づいて、もう一度お試しください';
    default:
      return '親機の Wi-Fi につなげませんでした。親機に近づいて、もう一度お試しください';
  }
}

/** 「詳細」に出す 1 行。見えた無線の数と、親機が見えたか(内部用語は使わない) */
export function joinFailureDetail(f: JoinFailure): string {
  const seen = f.expectedSeen === true ? '見えています' : f.expectedSeen === false ? '見えません' : '確認できませんでした';
  const total = f.total === null ? '不明' : `${f.total} 件`;
  const direct = f.direct === null ? '不明' : `${f.direct} 件`;
  return `周辺の無線 ${total}(機器どうしの接続用 ${direct})・親機の Wi-Fi: ${seen}`;
}
