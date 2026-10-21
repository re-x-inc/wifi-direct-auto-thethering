/**
 * 「Nearby 再開まであと何秒か」を DH-LINK ログへ定期的に出すための純関数。
 * 方針(T_direct まで Nearby を止めて Direct 再接続だけを試す)は変えない。見えるようにするだけ。
 * ログには座標・電話番号・SSID・パスワードを含めない(理由は LostReason の固定語、数は試行回数だけ)。
 */

/** ログの間隔(ms)。10〜15 秒の範囲に丸める(既定 12 秒) */
export const RESUME_ETA_LOG_MS = 12_000;
export const RESUME_ETA_MIN_MS = 10_000;
export const RESUME_ETA_MAX_MS = 15_000;

export function resumeEtaIntervalMs(v?: number): number {
  if (v === undefined || !Number.isFinite(v)) return RESUME_ETA_LOG_MS;
  return Math.max(RESUME_ETA_MIN_MS, Math.min(RESUME_ETA_MAX_MS, Math.round(v)));
}

/** 再開待ちの状態名(LinkStateName)のうち、自動再開の時刻を待っているもの */
export function isResumeWaitingName(name: string): boolean {
  return name === 'direct-retrying' || name === 'direct-rebuilding';
}

/** 残りミリ秒 → 残り秒(切り上げ。0 以下・非数は 0) */
export function remainingSec(remainingMs: number): number {
  return Number.isFinite(remainingMs) && remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

/** 次に出すべきか。lastAt が null(待ちに入った直後)は即出す */
export function shouldLogResumeEta(lastAt: number | null, now: number, intervalMs: number = RESUME_ETA_LOG_MS): boolean {
  if (lastAt === null) return true;
  if (now < lastAt) return true; // 時計が戻った
  return now - lastAt >= intervalMs;
}

export function formatResumeEta(remainingMs: number, reason: string | null, attempt: number | null): string {
  const n = attempt !== null && Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : null;
  return `再開待ち: Nearby 再開まであと ${remainingSec(remainingMs)}s(理由=${reason ?? '不明'}、試行 ${n === null ? '-' : n} 回目)`;
}
