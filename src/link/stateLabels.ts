import type { GuardPhase } from './directGuard';

/**
 * 画面に出す「いまの状態」。内部名(name)と日本語ラベルの対応表。i18n しやすいよう、文言はこの表だけに置く。
 * ラベルに {n}/{max} があるときは再接続の試行回数に置き換える。
 */
export type LinkStateName =
  | 'stopped' | 'keep-mode'
  | 'nearby-searching' | 'nearby-waiting' | 'nearby-connected' | 'nearby-resumed'
  | 'direct-creating' | 'direct-joining' | 'direct-settling' | 'direct-active' | 'direct-retrying' | 'direct-rebuilding';

export const LINK_LABELS: Record<LinkStateName, string> = {
  'stopped': '停止中',
  'keep-mode': 'Nearby と Direct を併用中',
  'nearby-searching': 'Nearby で探しています',
  'nearby-waiting': 'Nearby で待っています',
  'nearby-connected': 'Nearby でつながっています',
  'nearby-resumed': 'Direct が切れたため Nearby で探しています',
  'direct-creating': 'Direct を作っています',
  'direct-joining': 'Direct に参加しています',
  'direct-settling': 'Direct を確認しています',
  'direct-active': 'Direct 接続中',
  'direct-retrying': 'Direct 再接続中 {n}/{max}',
  'direct-rebuilding': 'Direct を作り直しています',
};

/** 次の遷移を待っているもの。T_echo / T_direct / T_nearby / settle(安定待ち)/ rejoin(作り直しの待ち) */
export type WaitingFor = 'T_echo' | 'T_direct' | 'T_nearby' | 'settle' | 'rejoin';

export interface LinkStateInfo {
  /** 内部名 */
  name: LinkStateName;
  /** 日本語の短いラベル(LINK_LABELS) */
  label: string;
  /** 状態機械の phase。suspend 方式でない(keep)ときは null */
  phase: GuardPhase | null;
  /** この状態に入った時刻(epoch ms)と経過秒 */
  enteredAt: number;
  elapsedSec: number;
  /** 次の遷移を待っているもの(カウントダウン用)。無ければ null */
  waiting: { for: WaitingFor; deadlineAt: number; remainingMs: number } | null;
  /** Direct 再接続の試行(n/max)。再接続中でなければ null */
  attempt: { n: number; max: number } | null;
}

export interface Transition {
  at: number;
  from: GuardPhase;
  to: GuardPhase;
  /** 契機の事象(ready / alive / lost / tick / retry-failed / rebuild-start / reset) */
  event: string;
  /** 理由(lost の種類、resume の理由など)。秘密・SSID・パスは含まない */
  reason: string | null;
}

export function labelOf(name: LinkStateName, attempt: { n: number; max: number } | null): string {
  return LINK_LABELS[name].replace('{n}', String(attempt?.n ?? 0)).replace('{max}', String(attempt?.max ?? 0));
}
