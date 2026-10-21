/** 接続の失敗コード・状態を、利用者が次にやることが分かる日本語 1 文にする(純関数。生ログや秘密は含めない)。 */

/** Nearby Connections の失敗コード(ConnectionsStatusCodes)→ 次にやること */
export function nearbyErrorHint(code: number): string {
  switch (code) {
    case 8007: // STATUS_RADIO_ERROR
    case 8006: // STATUS_BLUETOOTH_ERROR
      return '無線が使えません。Wi-Fi・Bluetooth・位置情報をオンにしてください';
    case 8011: // STATUS_ENDPOINT_UNKNOWN
      return '相手が見つかりません。相手に近づき、相手のアプリの画面を開いてください';
    case 8003: // STATUS_ALREADY_CONNECTED_TO_ENDPOINT
      return 'すでに相手とつながっています。少し待っても変わらなければ、いったん停止してもう一度開始してください';
    case 8009: // STATUS_OUT_OF_ORDER_API_CALL
    case 8001: // STATUS_ALREADY_ADVERTISING
    case 8002: // STATUS_ALREADY_DISCOVERING
    case 8010: // STATUS_ALREADY_HAVE_ACTIVE_STRATEGY
      return '前の接続が残っています。いったん停止して、もう一度開始してください';
    case 8004: // STATUS_CONNECTION_REJECTED
      return '相手に断られました。相手の画面でも承認して、もう一度お試しください';
    case 8012: // STATUS_ENDPOINT_IO_ERROR
    case 8005: // STATUS_NOT_CONNECTED_TO_ENDPOINT
      return '通信が途切れました。相手に近づいて、もう一度お試しください';
    default:
      return '接続に失敗しました。相手に近づき、しばらくしてからもう一度お試しください';
  }
}

/** Wi-Fi Direct の参加失敗(例外メッセージ)→ 次にやること。メッセージ本文は画面に出さない */
export function wifiJoinHint(message: string): string {
  if (/timeout|timed out|time out|タイムアウト|時間切れ/i.test(message)) {
    return '親機の Wi-Fi が見つかりません。親機に近づき、親機で共有を始めているか確かめてください';
  }
  if (/denied|reject|拒否|cancel/i.test(message)) {
    return 'Wi-Fi への参加が許可されませんでした。表示された確認で「許可」を選んでください';
  }
  return 'Wi-Fi に参加できませんでした。親機に近づいて、もう一度お試しください';
}

export type LinkPhase = 'idle' | 'connecting' | 'waiting' | 'connected';
export type Tone = 'ok' | 'warn' | 'idle';

/** リンクの状態を見出しにする。つながるまでと、つながった後を色と文言で区別する */
export function linkSummary(phase: LinkPhase, hint?: string | null): { text: string; tone: Tone } {
  switch (phase) {
    case 'connected':
      return { text: 'つながっています', tone: 'ok' };
    case 'connecting':
      return { text: '相手とつないでいます…', tone: 'warn' };
    case 'waiting':
      return { text: hint ? hint : '相手が見つかりません。近づくと自動でつながります', tone: 'warn' };
    default:
      return { text: '停止中です', tone: 'idle' };
  }
}

/**
 * インターネットへの到達(外形監視)の見出しと補足。実装名(SOCKS・VPN・Direct・バス・probe)は出さない。
 * who: 'guest' = 子機が自分の状態を見る / 'host' = 親機が子機の報告を見る。unknown は項目を出さない(null)
 */
export function internetText(state: 'ok' | 'ng' | 'unknown', reason: string | null, who: 'guest' | 'host'): { title: string; note?: string; tone: Tone } | null {
  if (who === 'host') {
    if (state === 'ok') return { title: '子機のインターネット: 使えています', tone: 'ok' };
    if (state === 'ng') return { title: '子機がインターネットに出られていません', note: '親機のモバイル通信を確認してください。', tone: 'warn' };
    return { title: '子機のインターネット: 確認中です', tone: 'idle' };
  }
  if (state === 'ok') return { title: 'インターネットにつながっています', tone: 'ok' };
  if (state === 'ng' && reason === 'portal') return { title: '親機の回線で通信が制限されているかもしれません', note: '契約や残りの容量を確認してください。', tone: 'warn' };
  if (state === 'ng') return { title: '親機の回線につながっていません', note: '親機の電波やデータ容量を確認してください。', tone: 'warn' };
  return null;
}

/** ペアリング画面の見出し */
export function pairingHeading(p: { confirm: boolean; waiting?: boolean; connecting?: boolean; found: boolean }): string {
  if (p.confirm) return p.waiting ? '相手を待っています' : '数字を確かめます';
  if (p.connecting) return '相手とつないでいます';
  return p.found ? '相手が見つかりました' : '相手を探しています';
}

/** 自動開始のやり直し(5 秒おき・最大回数) */
export const AUTO_START_INTERVAL_MS = 5000;
export const AUTO_START_MAX = 6;
