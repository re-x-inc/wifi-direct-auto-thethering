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
  /** 到達確認(子機: 自分の probe / 親機: 子機の報告)の最後の結果 */
  reach: { ok: boolean; at: number; rttMs?: number; error?: string } | null;
  /**
   * Direct 上のバス(src/link/busControl.ts)の生存信号。認証済みフレーム(ping/pong 含む)を最後に受けた時刻。
   * ネイティブが JS と無関係に更新し続ける値を、tick で読んで入れる。「最後に生存を確認した時刻」の 1 つで、
   * 他の出どころ(netAt / aliveAt)のうち最も新しい方を生存とする(lastAliveAt)。バスが無い・旧版の相手のときは null
   */
  busAt: number | null;
  /**
   * 外形監視(インターネットへの到達)が最後に成功した時刻(子機: 自分の観測 / 親機: 子機の ok の報告を受けた時刻)。
   * 延命の出どころの 1 つ(上限つき: tether.ts の noteAliveAt)。無い・無効のとき null
   */
  netAt: number | null;
  /**
   * 「最後に Direct の生存を確認した時刻」。**LinkGovernor が保持**する(送り手 = バス・ZMTP heartbeat に依存しない。
   * noteAliveAt の入口で max を取り、古い時刻へは戻さない)。画面・判定はこの値だけを読む。まだ無ければ null
   */
  aliveAt: number | null;
  /** Direct 上のバスの状態。authenticated = 認証済みで接続中 / disconnected = 動いているが切れている / off = 使っていない */
  bus: BusLinkState;
}

export type BusLinkState = 'off' | 'disconnected' | 'authenticated';

export const initialDataPath = (): DataPath => ({ group: null, reach: null, busAt: null, netAt: null, aliveAt: null, bus: 'off' });

const maxAt = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a == null ? (b ?? null) : b == null ? a : Math.max(a, b);

/**
 * 「最後に Direct の生存を確認した時刻」。生存信号の出どころ(バス = busAt、外形監視の延命 = netAt、LinkGovernor の入口 = aliveAt)を
 * 抽象化した 1 つの値。T_echo / T_direct の判定(deriveOverall)はこの値で行う。
 * 出どころが増えても、ここに足すだけで判定側は変わらない。
 */
export function lastAliveAt(d: DataPath): number | null {
  return maxAt(maxAt(d.busAt, d.netAt), d.aliveAt);
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
  /** 生存の鮮度を見るか(Nearby 部品が suspend 対応)。旧部品の縮退動作のときは鮮度を見ない */
  heartbeatMode: boolean;
  /** Direct の再接続を試している最中(Nearby は止めたまま)。この間は degraded */
  retrying: boolean;
  now: number;
  /**
   * 無通信の閾値(ms)。生存信号(lastAliveAt)からの経過で見る。
   * echoMs(T_echo)以上で degraded、directMs(T_direct)以上で disconnected
   */
  echoMs: number;
  directMs: number;
  /** 外形監視が ng(子機: 自分の観測 / 親機: 鮮度のある子機の報告)。生存確認が OK でも degraded にする。無効・未実施は false */
  internetNg?: boolean;
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
      const at = lastAliveAt(d);
      if (at === null) return 'degraded';
      const age = i.now - at;
      if (age >= i.directMs) return 'disconnected';
      if (age >= i.echoMs) return 'degraded';
    }
    return i.internetNg ? 'degraded' : 'connected';
  }
  if (!i.wifiJoined || d.group === false) return 'disconnected';
  if (!i.vpnOn || d.reach?.ok === false) return 'degraded';
  if (i.heartbeatMode && (d.busAt !== null || d.netAt !== null || d.aliveAt !== null)) {
    const age = i.now - (lastAliveAt(d) as number);
    if (age >= i.directMs) return 'disconnected';
    if (age >= i.echoMs) return 'degraded';
  }
  return i.internetNg ? 'degraded' : 'connected';
}
