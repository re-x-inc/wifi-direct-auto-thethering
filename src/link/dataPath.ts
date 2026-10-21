/**
 * 「つながっている」の総合状態(純関数)。Nearby のつながりと、データ経路(Direct)を分けて持ち、そこから導く。
 *
 * Nearby は制御用で、suspend 方式では Direct の間は止まる。Nearby の link だけで「接続」を出すと、
 * データ経路が壊れても「つながっている」と出る(実機 09:26: 親機は接続表示、子機は Wi-Fi 参加失敗)。
 * そのため総合状態は **データ経路だけ** で決める。Nearby は制御が届くかの参考(nearby フィールド)に留める。
 */

export type NearbyPhase = 'up' | 'down' | 'suspended';
export type Overall = 'connected' | 'degraded' | 'disconnected';

export interface DataPath {
  /** 親機: Direct グループがあるか(ネイティブの group イベント。取れない端末は null=不明)。子機: Wi-Fi に参加しているか */
  group: boolean | null;
  /** 親機: 子機のエコー接続(ハートビート)を最後に受けた時刻。無ければ null */
  echoAt: number | null;
  /** 子機: ハートビート(親機のエコーへの接続)の最後の結果。まだ無ければ null */
  heartbeat: { ok: boolean; at: number } | null;
  /** 子機: ハートビートが最後に成功した時刻 */
  okAt: number | null;
  /** 到達確認(子機: 自分の probe / 親機: 子機の報告)の最後の結果 */
  reach: { ok: boolean; at: number; rttMs?: number; error?: string } | null;
  /**
   * Direct 上のバス(src/link/busControl.ts)の生存信号。認証済みフレーム(ping/pong 含む)を最後に受けた時刻。
   * ネイティブが JS と無関係に更新し続ける値を、tick で読んで入れる。echoAt / okAt と同じ「最後に生存を確認した時刻」で、
   * どちらか新しい方を生存とする(lastAliveAt)。バスが無い・旧版の相手のときは null
   */
  busAt: number | null;
}

export const initialDataPath = (): DataPath => ({ group: null, echoAt: null, heartbeat: null, okAt: null, reach: null, busAt: null });

const maxAt = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a == null ? (b ?? null) : b == null ? a : Math.max(a, b);

/**
 * 「最後に Direct の生存を確認した時刻」。生存信号の出どころ(Echo = 親機は echoAt・子機は heartbeat の成功時刻、バス = busAt)を
 * 抽象化した 1 つの値。T_echo / T_direct の判定(deriveOverall)と、governor への alive はこの値で行う。
 * 出どころが増えても(子機のネイティブ heartbeat など)、ここに足すだけで判定側は変わらない。
 */
export function lastAliveAt(d: DataPath, role: 'host' | 'guest'): number | null {
  const echo = role === 'host' ? d.echoAt : (d.okAt ?? (d.heartbeat?.ok ? d.heartbeat.at : null));
  return maxAt(echo, d.busAt);
}

export interface OverallInput {
  role: 'host' | 'guest' | null;
  started: boolean;
  data: DataPath;
  /** 親機: share が 'on' */
  shareOn: boolean;
  /** 子機: wifi が 'joined' */
  wifiJoined: boolean;
  /** 子機: vpn が 'on' */
  vpnOn: boolean;
  /** ハートビート(エコー)が動く方式か(suspend)。keep のときは鮮度を見ない */
  heartbeatMode: boolean;
  /** Direct の再接続を試している最中(Nearby は止めたまま)。この間は degraded */
  retrying: boolean;
  now: number;
  /**
   * 無通信の閾値(ms)。親機は「子機の最後のエコー受付」からの経過、子機は「最後に成功したハートビート」からの経過で見る。
   * echoMs(T_echo)以上で degraded、directMs(T_direct)以上で disconnected
   */
  echoMs: number;
  directMs: number;
}

/**
 * connected    = データが流れる経路が揃っている
 * degraded     = 経路の一部はあるが、確認できていない(参加中・VPN 起動中・生存信号が古い・到達確認 NG)
 * disconnected = データ経路がない(停止中・グループ消滅・Wi-Fi 未参加・共有していない)
 */
export function deriveOverall(i: OverallInput): Overall {
  if (!i.started || !i.role) return 'disconnected';
  if (i.retrying) return 'degraded';
  const d = i.data;
  if (i.role === 'host') {
    if (!i.shareOn || d.group === false) return 'disconnected';
    if (!d.reach?.ok) return 'degraded';
    if (i.heartbeatMode) {
      const at = lastAliveAt(d, 'host');
      if (at === null) return 'degraded';
      const age = i.now - at;
      if (age >= i.directMs) return 'disconnected';
      if (age >= i.echoMs) return 'degraded';
    }
    return 'connected';
  }
  if (!i.wifiJoined || d.group === false) return 'disconnected';
  if (!i.vpnOn || d.reach?.ok === false) return 'degraded';
  if (i.heartbeatMode && (d.heartbeat || d.busAt !== null)) {
    const age = i.now - (maxAt(d.okAt ?? d.heartbeat?.at ?? null, d.busAt) as number);
    if (age >= i.directMs) return 'disconnected';
    // 直近の Echo 失敗でも、それより新しいバスの生存信号があれば異常とはしない
    const echoBad = !!d.heartbeat && !d.heartbeat.ok && !(d.busAt !== null && d.busAt >= d.heartbeat.at);
    if (echoBad || age >= i.echoMs) return 'degraded';
  }
  return 'connected';
}
