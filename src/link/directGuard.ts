/**
 * 「Wi-Fi Direct がある間は Nearby を使わない。Direct が切れたときだけ Nearby で探しに行く」ための状態遷移(純関数)。
 *
 * 背景: Direct の固定グループが生きている最中に Nearby が(再)接続すると、GMS が帯域アップグレード先に WIFI_DIRECT を選び、
 * 'Remove current P2P group because P2P resource is unavailable' で固定グループを撤去することがある(実機 razr 09:01 / 09:07 / 09:20 / 09:26。
 * 09:26 は clients=0 でも起きた)。公開 API に止める手段が無いため、Direct が生きている間は Nearby の広告・探索・接続をすべて止める。
 *
 * 3 つの閾値(大小は T_echo < T_direct < T_nearby。基準時刻は「最後に Direct の生存を確認した時刻」。Wi-Fi 切断・グループ消滅のような確定した
 * 切断は、その検知時刻):
 *   T_echo   (echoMs)   : 生存信号(子機のエコー接続 / 子機自身のハートビート成功)が途切れた → データ経路の異常(総合状態 degraded)。
 *                          この時点から Nearby は止めたまま Direct の復帰を試す(retrying)
 *   T_direct (directMs) : ここまでに戻らなければ Direct を諦める。**親機**はここで Nearby を再開(広告・探索)。総合状態は disconnected
 *   T_nearby (nearbyMs) : **子機**はここで Nearby の探索を始める。親機の戻り(T_direct)より後なので、子機が広告のない親機を探し続けない
 *
 *   direct ──(T_echo 無通信 / 確定した切断)──▶ retrying ──alive──▶ direct
 *                                                  │ 親機: T_direct / 子機: T_nearby 経過(または親機が 3 回失敗)
 *                                                  ▼
 *                                               nearby   [動作: resume]
 *   nearby ──ready──▶ settling ──(settleMs 安定)──▶ direct   [動作: suspend]
 *   rebuild-start(接続情報を送って Nearby を閉じた)──▶ rejoining ──alive──▶ direct / rejoinMs で nearby
 */

export type GuardPhase = 'nearby' | 'settling' | 'direct' | 'retrying' | 'rejoining';

export type LostReason = 'wifi-lost' | 'group-gone' | 'no-clients' | 'silence' | 'direct-timeout' | 'retry-exhausted' | 'rejoin-timeout' | 'manual';

export interface GuardTiming {
  /** Direct が確立したと分かってから Nearby を止めるまでの安定待ち(ms)。この間に切れたら止めない */
  settleMs: number;
  /** T_echo */
  echoMs: number;
  /** T_direct */
  directMs: number;
  /** T_nearby */
  nearbyMs: number;
  /** この端末が Nearby を再開する時刻(基準からの経過 ms)。親機 = directMs、子機 = nearbyMs */
  resumeAtMs: number;
  /** 再接続を使い切ったら resumeAtMs を待たずに再開するか。親機 true(早く戻る分には子機より先で良い)、子機 false */
  resumeOnExhaust: boolean;
  /** 作り直し中(rejoining): 相手が Direct に戻るのをこれだけ待つ(ms)。来なければ Nearby を再開 */
  rejoinMs: number;
}

export const initialGuard = (now: number): GuardState => ({ phase: 'nearby', at: now, aliveAt: now, base: now, reason: null });

export interface GuardState {
  phase: GuardPhase;
  /** 今の phase に入った時刻 */
  at: number;
  /** 最後に Direct の生存を確認した時刻 */
  aliveAt: number;
  /** retrying のとき: T_direct / T_nearby を数え始める基準時刻 */
  base: number;
  reason: LostReason | null;
}

export type GuardEvent =
  /** Direct が使える状態になった(子機: 参加+到達確認+VPN 済み / 親機: 子機の到達確認を受けた) */
  | { t: 'ready' }
  /** Direct の生存を確認(ハートビート成功・エコー受付・グループにクライアントがいる) */
  | { t: 'alive' }
  /** 確定した切断(Wi-Fi 切断 / グループ消滅 / 子機が 0 台に) */
  | { t: 'lost'; reason: 'wifi-lost' | 'group-gone' | 'no-clients' | 'manual' }
  /** 再接続の試行をすべて使い切った(実行側が出す) */
  | { t: 'retry-failed' }
  /** Nearby を閉じてグループを作り直す(Nearby 経由の再接続の手順)。Nearby は止めたまま相手を待つ */
  | { t: 'rebuild-start' }
  | { t: 'tick' }
  | { t: 'reset' };

export type GuardAction =
  | { type: 'suspend' }
  | { type: 'resume'; reason: LostReason }
  /** Nearby は止めたまま、保存済みの接続情報で Direct の再接続を試す(回数・間隔は実行側の設定) */
  | { type: 'retry'; reason: LostReason }
  /** 判定の理由を DH-NEARBY に残す */
  | { type: 'note'; msg: string };

const note = (msg: string): GuardAction => ({ type: 'note', msg });

/** 次の状態と実行すべき動作。副作用なし */
export function stepGuard(s: GuardState, ev: GuardEvent, now: number, tm: GuardTiming): [GuardState, GuardAction[]] {
  if (ev.t === 'reset') return [initialGuard(now), []];
  const go = (phase: GuardPhase, patch: Partial<GuardState> = {}): GuardState => ({ ...s, phase, at: now, ...patch });
  const rebuild = (): [GuardState, GuardAction[]] => [go('rejoining', { aliveAt: now }), [note('rebuild: Nearby を止めて Direct の作り直しを待つ')]];

  switch (s.phase) {
    case 'nearby':
      if (ev.t === 'ready') return [go('settling', { aliveAt: now }), [note(`direct ready → ${tm.settleMs}ms 安定したら Nearby を止める`)]];
      if (ev.t === 'rebuild-start') return rebuild();
      return [s, []];

    case 'settling':
      if (ev.t === 'lost') return [go('nearby'), [note(`settling 中に ${ev.reason}: Nearby は止めない`)]];
      if (ev.t === 'alive') return [{ ...s, aliveAt: now }, []];
      if (ev.t === 'rebuild-start') return rebuild();
      if (ev.t === 'tick' && now - s.at >= tm.settleMs) {
        return [go('direct', { aliveAt: now }), [{ type: 'suspend' }, note(`direct 安定(${now - s.at}ms) → Nearby を止める`)]];
      }
      return [s, []];

    case 'direct':
      if (ev.t === 'alive' || ev.t === 'ready') return [{ ...s, aliveAt: now }, []];
      if (ev.t === 'lost') {
        return [go('retrying', { base: now, reason: ev.reason }), [note(`${ev.reason} を検知 → Nearby は止めたまま Direct を再接続(${tm.resumeAtMs}ms 戻らなければ Nearby を再開)`), { type: 'retry', reason: ev.reason }]];
      }
      if (ev.t === 'rebuild-start') return rebuild();
      if (ev.t === 'tick' && now - s.aliveAt >= tm.echoMs) {
        return [go('retrying', { base: s.aliveAt, reason: 'silence' }), [note(`生存信号なし ${now - s.aliveAt}ms ≥ T_echo=${tm.echoMs}ms → データ経路の異常(degraded)。Nearby は止めたまま Direct を再接続`), { type: 'retry', reason: 'silence' }]];
      }
      return [s, []];

    case 'retrying':
      // Nearby は止めたまま Direct の再接続を試している。戻れば direct、時間切れ(または親機が使い切り)なら Nearby を再開
      if (ev.t === 'alive' || ev.t === 'ready') return [go('direct', { aliveAt: now }), [note(`Direct に戻った(基準から ${now - s.base}ms)。Nearby は再開しない`)]];
      if (ev.t === 'retry-failed') {
        if (tm.resumeOnExhaust) return [go('nearby'), [note(`Direct の再接続を使い切った(${now - s.base}ms) → Nearby を再開`), { type: 'resume', reason: 'retry-exhausted' }]];
        return [s, [note(`Direct の再接続を使い切ったが、親機より先に探索へ戻らないよう ${tm.resumeAtMs}ms まで待つ(あと ${Math.max(0, tm.resumeAtMs - (now - s.base))}ms)`)]];
      }
      if (ev.t === 'rebuild-start') return rebuild();
      if (ev.t === 'tick' && now - s.base >= tm.resumeAtMs) {
        return [go('nearby'), [note(`Direct が ${now - s.base}ms 戻らない(≥ ${tm.resumeAtMs}ms) → Nearby を再開`), { type: 'resume', reason: 'direct-timeout' }]];
      }
      return [s, []];

    case 'rejoining':
      // Nearby は止まっている。相手が Direct に戻れば direct へ(安定待ちは要らない)
      if (ev.t === 'alive' || ev.t === 'ready') return [go('direct', { aliveAt: now }), [note('rebuild: Direct に戻った')]];
      if (ev.t === 'tick' && now - s.at >= tm.rejoinMs) {
        return [go('nearby'), [note(`rebuild: ${tm.rejoinMs}ms 待っても戻らない → Nearby を再開`), { type: 'resume', reason: 'rejoin-timeout' }]];
      }
      return [s, []];
  }
}

/** Nearby を止めている phase か(Nearby の要求を出してはいけない) */
export const nearbyShouldBeOff = (p: GuardPhase): boolean => p === 'direct' || p === 'retrying' || p === 'rejoining';

/**
 * 役割ごとの既定値。ハートビート間隔 hb(既定 5s)から決める:
 *   T_echo   = hb × 3                                  = 15s   (3 回分の無通信で異常)
 *   T_direct = T_echo + 再接続 attempts 回 × attemptMs   = 15 + 3×45 = 150s  (3 回の再接続は T_echo から始めて T_direct の手前で終わる)
 *   T_nearby = T_direct + T_echo                       = 165s  (Nearby を始めるのは 135s 以上経ってから)
 * 親機が Nearby を再開 = T_direct(150s)、子機が探索を始める = T_nearby(165s)。基準は同じ「最後の生存確認」なので、
 * 子機の探索開始は親機の広告再開より 15s 後(親機の戻り ≤ 子機の探索開始)。
 */
export function guardTimingFor(
  role: 'host' | 'guest',
  hbIntervalMs: number,
  over: Partial<GuardTiming> = {},
  retry: { attempts: number; attemptMs: number } = { attempts: RETRY_DEFAULTS.attempts, attemptMs: RETRY_DEFAULTS.attemptMs },
): GuardTiming {
  const echoMs = over.echoMs ?? hbIntervalMs * 3;
  const directMs = over.directMs ?? echoMs + retry.attempts * retry.attemptMs;
  const nearbyMs = over.nearbyMs ?? directMs + echoMs;
  return {
    settleMs: 3_000, echoMs, directMs, nearbyMs,
    resumeAtMs: role === 'host' ? directMs : nearbyMs,
    resumeOnExhaust: role === 'host',
    rejoinMs: role === 'host' ? 60_000 : 75_000,
    ...over,
    // 上書きされた T_direct / T_nearby に追従(resumeAtMs を直接指定した場合はそれを優先)
    ...(over.resumeAtMs === undefined ? { resumeAtMs: role === 'host' ? directMs : nearbyMs } : {}),
  };
}

/** Direct の再接続(Nearby に戻る前に保存済みの接続情報で試す)。回数・間隔・1 回の待ちは設定できる */
export interface DirectRetry {
  attempts: number;
  /** 試行の前の待ち(ms)。i 回目は backoffMs[min(i, 長さ-1)] */
  backoffMs: number[];
  /** 子機: 1 回の joinWifi の待ち(ms)。保存済みの接続情報なら承認ダイアログは出ないので短くてよい(初回の 180s とは別) */
  joinTimeoutMs: number;
  /** 1 回の再接続に見込む時間(ms)= 待ち + 参加の待ち。T_direct の既定の計算に使う(backoff の最大 + joinTimeoutMs がこれ以内) */
  attemptMs: number;
}
/**
 * 1 回 45s の見積もり = 待ち(1s / 2s / 4s)+ 参加の待ち 40s(保存済みの接続情報なら承認ダイアログは出ず、通常は数秒で終わる。初回の 180s とは別)。
 * 3 回で最悪 (1+40)+(2+40)+(4+40) = 127s ≤ 135s(= T_direct − T_echo)。
 */
export const RETRY_DEFAULTS: DirectRetry = { attempts: 3, backoffMs: [1_000, 2_000, 4_000], joinTimeoutMs: 40_000, attemptMs: 45_000 };
