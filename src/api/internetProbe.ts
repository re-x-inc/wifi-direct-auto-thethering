import type { InternetConfig } from '../link/internetMonitor';
import type { HotspotPort, NativeExternalProbeStatus } from './types';

/**
 * 既定の probe 供給元(ネイティブ)を、公開の口 update(success, at, reason) につなぐ薄い層。
 *
 * tether のコア(InternetMonitor)は probe の実装を知らない。ここはネイティブの結果(1 周ごと)を読んで update を呼ぶだけで、
 * enable() の opts.runner で使う/使わないを選べる('native' 既定 / 'none')。使わないときは、アプリが自前の実通信の観測から update を呼ぶ。
 * ネイティブは JS が止まっても動くので、起きたときに結果が複数周進んでいることがある。そのときは最新の 1 周だけを update に渡す
 * (成功の時刻は lastOkAt、失敗は lastFailAt。途中の周は連続失敗の数としては数えない)。
 */
export class NativeProbeRunner {
  private sig = '';
  private seen = 0;
  private running = false;
  private off: (() => void) | null = null;

  constructor(
    private h: Pick<HotspotPort, 'externalProbeStart' | 'externalProbeStop' | 'externalProbeStatus' | 'onExternalProbe'>,
    private update: (success: boolean, at: number, reason?: string) => void,
    private log: (line: string) => void,
  ) {}

  /** 使える部品か */
  get available(): boolean {
    return typeof this.h.externalProbeStart === 'function' && typeof this.h.externalProbeStatus === 'function';
  }

  get isRunning(): boolean { return this.running; }

  /**
   * あるべき状態に合わせる。target が null なら止める。接続先・設定が変わったら張り直す。
   * 始めた直後にネイティブが最初の 1 周をすぐ実行する(接続確立直後の確認と並行して結果が出る)。
   */
  sync(target: { socksHost: string; socksPort: number; user: string; pass: string; cfg: InternetConfig; wakeLock: boolean } | null): void {
    if (!target || !this.available) { this.stop(target ? '部品なし' : '不要になった'); return; }
    const c = target.cfg;
    const sig = JSON.stringify([target.socksHost, target.socksPort, target.user, target.pass, c.urls, c.intervalMs, c.screenOffIntervalMs, c.confirmIntervalMs, c.timeoutMs, c.failThreshold, target.wakeLock]);
    if (this.running && sig === this.sig) return;
    this.stop('設定が変わった');
    try {
      this.h.externalProbeStart!({
        socksHost: target.socksHost, socksPort: target.socksPort, user: target.user, pass: target.pass,
        urls: c.urls, intervalMs: c.intervalMs, screenOffIntervalMs: c.screenOffIntervalMs, confirmIntervalMs: c.confirmIntervalMs,
        timeoutMs: c.timeoutMs, failThreshold: c.failThreshold, wakeLock: target.wakeLock,
      });
    } catch (e: any) {
      this.log(`外形監視の供給元の起動に失敗: ${e?.message ?? e}`);
      return;
    }
    this.sig = sig; this.seen = 0; this.running = true;
    this.off = this.h.onExternalProbe?.(() => this.poll()) ?? null;
    this.log(`外形監視の供給元を開始(間隔 ${c.intervalMs}ms・確認 ${c.confirmIntervalMs}ms・待ち ${c.timeoutMs}ms・宛先 ${c.urls.length} 件): すぐ 1 回実行`);
  }

  stop(why: string): void {
    this.off?.(); this.off = null;
    if (!this.running) return;
    this.running = false; this.sig = ''; this.seen = 0;
    try { this.h.externalProbeStop?.(); } catch {}
    this.log(`外形監視の供給元を停止(${why})`);
  }

  /** ネイティブの最新の結果を読み、新しい周があれば update に渡す。tick と onExternalProbe から呼ぶ */
  poll(): void {
    if (!this.running || !this.available) return;
    let st: NativeExternalProbeStatus;
    try { st = this.h.externalProbeStatus!(); } catch { return; }
    if (!st.running) { this.running = false; this.sig = ''; return; }
    if (st.attempts <= this.seen) return;
    this.seen = st.attempts;
    if (st.lastOkAt > 0 && st.lastOkAt >= st.lastFailAt) this.update(true, st.lastOkAt);
    else if (st.lastFailAt > 0) this.update(false, st.lastFailAt, st.lastReason ?? undefined);
  }
}
