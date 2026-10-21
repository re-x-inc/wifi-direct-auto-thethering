import { DirectRetry, GuardTiming, guardTimingFor } from './directGuard';

/**
 * 時間の設定(開始待ち・タイムアウト・閾値)をまとめた型付きセクション。`TetherConfig.timing` で渡す(すべて任意)。
 * 範囲外・数値でない値は既定に丸めてログ(DH-LINK)。大小関係 T_echo < T_direct < T_nearby が破れたら補正してログ。
 */
export interface LinkTimingConfig {
  /** 子機がエコー(親機の 9000)へ接続する間隔(ms) */
  hbIntervalMs: number;
  /** T_echo: 生存信号が途切れてから「データ経路の異常」とみなすまで(ms)。既定 hb×3 */
  echoMs: number;
  /** T_direct: Direct の復帰を待つ上限(ms)。**親機**はここで Nearby を再開。既定 T_echo + 再接続回数×attemptMs */
  directMs: number;
  /** T_nearby: **子機**が Nearby の探索を始める時刻(ms)。既定 T_direct + T_echo */
  nearbyMs: number;
  /** Direct 確立を確認してから Nearby を止めるまでの安定待ち(ms)。「開始待ち」 */
  settleMs: number;
  /** 状態判定の周期(ms) */
  tickMs: number;
  /** Direct 再接続の回数(Nearby に戻る前) */
  retryAttempts: number;
  /** 再接続の i 回目の前の待ち(ms)。i が配列より大きければ最後の値 */
  retryBackoffMs: number[];
  /** 再接続 1 回の joinWifi の待ち(ms)。保存済みの接続情報なら承認ダイアログは出ない */
  retryJoinTimeoutMs: number;
  /** 再接続 1 回に見込む時間(ms)。T_direct の既定の計算に使う */
  retryAttemptMs: number;
  /** 作り直し(Nearby 経由の再接続)で、相手が Direct に戻るのを待つ上限(ms)。子機は +15s */
  rejoinMs: number;
  /** 切れが確定してから Nearby を再開するまでの追加の待ち(ms)。「Nearby 再開前の待ち」。既定 0 */
  nearbyResumeDelayMs: number;
  /** Nearby を閉じ終えてから固定グループを作り直すまでの追加の待ち(ms)。「グループ再作成前の待ち」。既定 0 */
  groupRebuildDelayMs: number;
  /** Nearby 再開後の再接続(LinkSupervisor)の間隔: 最初(ms)と上限(ms)。指数バックオフ */
  nearbyRetryBaseMs: number;
  nearbyRetryMaxMs: number;
  /** 初回の Direct 参加(承認ダイアログを含む)の待ち(ms)= JOIN_TIMEOUT_MS */
  joinTimeoutMs: number;
}

/** 親機→子機へ配る分(閾値の対応関係が崩れないよう、親機が正)。tick・join・Nearby 再試行は端末ごと */
export type SharedTiming = Pick<LinkTimingConfig,
  'hbIntervalMs' | 'echoMs' | 'directMs' | 'nearbyMs' | 'settleMs' | 'retryAttempts' | 'retryBackoffMs' | 'retryJoinTimeoutMs' | 'retryAttemptMs' | 'rejoinMs'>;

export const SHARED_KEYS: (keyof SharedTiming)[] = ['hbIntervalMs', 'echoMs', 'directMs', 'nearbyMs', 'settleMs', 'retryAttempts', 'retryBackoffMs', 'retryJoinTimeoutMs', 'retryAttemptMs', 'rejoinMs'];

type Scalar = Exclude<keyof LinkTimingConfig, 'retryBackoffMs'>;

/** [下限, 上限](ms または回数) */
export const TIMING_RANGES: Record<Scalar, [number, number]> = {
  hbIntervalMs: [1_000, 60_000],
  echoMs: [3_000, 600_000],
  directMs: [5_000, 3_600_000],
  nearbyMs: [6_000, 7_200_000],
  settleMs: [0, 60_000],
  tickMs: [100, 10_000],
  retryAttempts: [1, 10],
  retryJoinTimeoutMs: [3_000, 300_000],
  retryAttemptMs: [3_000, 300_000],
  rejoinMs: [5_000, 600_000],
  nearbyResumeDelayMs: [0, 120_000],
  groupRebuildDelayMs: [0, 120_000],
  nearbyRetryBaseMs: [200, 60_000],
  nearbyRetryMaxMs: [1_000, 300_000],
  joinTimeoutMs: [10_000, 600_000],
};
const BACKOFF_RANGE: [number, number] = [100, 120_000];

export const TIMING_DEFAULTS: LinkTimingConfig = {
  hbIntervalMs: 5_000,
  echoMs: 15_000,
  directMs: 150_000,
  nearbyMs: 165_000,
  settleMs: 3_000,
  tickMs: 1_000,
  retryAttempts: 3,
  retryBackoffMs: [1_000, 2_000, 4_000],
  retryJoinTimeoutMs: 40_000,
  retryAttemptMs: 45_000,
  rejoinMs: 60_000,
  nearbyResumeDelayMs: 0,
  groupRebuildDelayMs: 0,
  nearbyRetryBaseMs: 1_000,
  nearbyRetryMaxMs: 30_000,
  joinTimeoutMs: 180_000,
};

export interface ResolveOptions {
  /** true: 範囲チェックを省く(テスト用に短い時間を使う)。大小関係の補正は行う */
  unchecked?: boolean;
  log?: (line: string) => void;
}

/**
 * 入力(複数の層を重ねたもの)を検証して、使う値を決める。
 * 範囲外/不正 → 既定(T_echo・T_direct・T_nearby は hb と再接続設定から導いた値)。大小関係が破れたら補正。
 */
export function resolveTiming(input: Partial<LinkTimingConfig> = {}, o: ResolveOptions = {}): LinkTimingConfig {
  const log = o.log ?? (() => {});
  const out: LinkTimingConfig = { ...TIMING_DEFAULTS, retryBackoffMs: [...TIMING_DEFAULTS.retryBackoffMs] };
  const scalar = (k: Scalar, fallback: number): number => {
    const v = input[k];
    if (v === undefined) return fallback;
    const [lo, hi] = TIMING_RANGES[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || (!o.unchecked && (v < lo || v > hi))) {
      log(`timing.${k}=${String(v)} は範囲外/不正(${lo}〜${hi}) → ${fallback} にする`);
      return fallback;
    }
    return v;
  };
  for (const k of Object.keys(TIMING_RANGES) as Scalar[]) {
    if (k === 'echoMs' || k === 'directMs' || k === 'nearbyMs') continue;
    out[k] = scalar(k, TIMING_DEFAULTS[k]);
  }
  const bo = input.retryBackoffMs;
  if (bo !== undefined) {
    const ok = Array.isArray(bo) && bo.length > 0 && bo.every((x) => typeof x === 'number' && Number.isFinite(x) && (o.unchecked || (x >= BACKOFF_RANGE[0] && x <= BACKOFF_RANGE[1])));
    if (ok) out.retryBackoffMs = [...bo];
    else log(`timing.retryBackoffMs=${JSON.stringify(bo)} は不正(各 ${BACKOFF_RANGE[0]}〜${BACKOFF_RANGE[1]}ms・1個以上) → 既定にする`);
  }
  // 導出される既定: T_echo = hb×3 / T_direct = T_echo + 回数×attemptMs / T_nearby = T_direct + T_echo
  const dEcho = out.hbIntervalMs * 3;
  out.echoMs = scalar('echoMs', dEcho);
  if (input.echoMs === undefined) out.echoMs = dEcho;
  const dDirect = out.echoMs + out.retryAttempts * out.retryAttemptMs;
  out.directMs = input.directMs === undefined ? dDirect : scalar('directMs', dDirect);
  const dNearby = out.directMs + out.echoMs;
  out.nearbyMs = input.nearbyMs === undefined ? dNearby : scalar('nearbyMs', dNearby);
  // 大小関係 T_echo < T_direct < T_nearby
  if (out.directMs <= out.echoMs) {
    const fixed = out.echoMs * 2;
    log(`T_direct(${out.directMs}) ≤ T_echo(${out.echoMs}) → T_direct を ${fixed} に補正`);
    out.directMs = fixed;
  }
  if (out.nearbyMs <= out.directMs) {
    const fixed = out.directMs + out.echoMs;
    log(`T_nearby(${out.nearbyMs}) ≤ T_direct(${out.directMs}) → T_nearby を ${fixed} に補正(子機が親機より先に探索へ戻らないため)`);
    out.nearbyMs = fixed;
  }
  const need = out.retryAttempts * out.retryAttemptMs;
  if (need > out.directMs - out.echoMs) log(`注意: 再接続 ${out.retryAttempts}回×${out.retryAttemptMs}ms=${need}ms が T_direct−T_echo(${out.directMs - out.echoMs}ms)に収まらない`);
  return out;
}

/** 役割ごとの状態機械の時間 */
export function toGuardTiming(t: LinkTimingConfig, role: 'host' | 'guest'): GuardTiming {
  return guardTimingFor(role, t.hbIntervalMs, {
    settleMs: t.settleMs, echoMs: t.echoMs, directMs: t.directMs, nearbyMs: t.nearbyMs,
    rejoinMs: t.rejoinMs + (role === 'guest' ? 15_000 : 0),
  });
}

export function toRetry(t: LinkTimingConfig): DirectRetry {
  return { attempts: t.retryAttempts, backoffMs: t.retryBackoffMs, joinTimeoutMs: t.retryJoinTimeoutMs, attemptMs: t.retryAttemptMs };
}

export function pickShared(t: LinkTimingConfig): SharedTiming {
  const o: any = {};
  for (const k of SHARED_KEYS) o[k] = t[k];
  return o;
}
