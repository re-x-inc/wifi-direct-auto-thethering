/**
 * requestConnection の排他と、失敗コードごとの扱い。
 * NearbyLinkModule.kt(inFlight / settleUntil / requestWithRetry)と同じ規則を JS 側でも持つ:
 * JS の onFound が重複しても、同じ endpoint に requestConnection を重ねない(重なると 8009 OUT_OF_ORDER_API_CALL)。
 * 規則を変えるときは Kotlin 側と揃えること。
 */
export const RETRY_MAX = 2;
/** 8012・8009 のあと、失敗した接続の後始末(disconnectFromEndpoint)が済むまで待つ時間(ms) */
export const SETTLE_MS = 1500;

export type FailureAction =
  | { kind: 'retry'; delayMs: number; disconnectFirst: boolean }
  | { kind: 'rediscover'; settleMs: number; disconnectFirst: boolean }
  | { kind: 'giveup' };

/** requestConnection が code で失敗したとき(attempt は 0 始まり)に何をするか */
export function failureAction(code: number, attempt: number): FailureAction {
  if (code === 8012 || code === 8009) return { kind: 'rediscover', settleMs: SETTLE_MS, disconnectFirst: true };
  if ((code === 8003 || code === 8007) && attempt < RETRY_MAX) {
    return { kind: 'retry', delayMs: code === 8003 ? 700 : 1500, disconnectFirst: code === 8003 };
  }
  if (code === 8011 || code === 8007) return { kind: 'rediscover', settleMs: 0, disconnectFirst: false };
  return { kind: 'giveup' };
}

export class ConnectGate {
  private inFlight = new Set<string>();
  private settleUntil = 0;
  constructor(private now: () => number = () => Date.now()) {}

  /** endpoint ごとに 1 つだけ。進行中なら false(新しく出さない) */
  tryAcquire(endpointId: string): boolean {
    if (this.inFlight.has(endpointId)) return false;
    this.inFlight.add(endpointId);
    return true;
  }
  /** onConnectionResult / onDisconnected / 失敗確定で枠を返す */
  release(endpointId: string): void {
    this.inFlight.delete(endpointId);
  }
  clear(): void {
    this.inFlight.clear();
    this.settleUntil = 0;
  }
  /** 失敗した接続の後始末を始めた。これから ms の間は次の requestConnection を出さない */
  settle(ms: number): void {
    this.settleUntil = this.now() + ms;
  }
  /** 次の requestConnection を出してよいまでの待ち(ms)。0 なら今すぐ */
  waitMs(): number {
    return Math.max(0, this.settleUntil - this.now());
  }
  get size(): number {
    return this.inFlight.size;
  }
}
