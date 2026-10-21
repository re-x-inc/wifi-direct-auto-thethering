import type { LinkSupervisor, SendOptions } from './supervisor';

/**
 * 端末間の「制御メッセージ」の通り道(tether.* と、アプリのメッセージ)。小さな抽象に留める。
 *
 * - いまの実装は NearbyControl(Nearby 上の LinkSupervisor)だけ。Direct が生きている間は Nearby を止めるので、その間は送れず、
 *   溜めて(supervisor の未確認キュー)Nearby 再開後にまとめて送る。heartbeat だけは Direct 上のエコー(9000)で行う。
 * - **Direct 上の軽量なメッセージバス(WebSocket / NATS)と Gateway は別 PR。バスの実装はここに差す**:
 *   `class BusControl implements ControlTransport { kind = 'bus'; … }` を作り、Direct 稼働中はそれを、Nearby 稼働中は NearbyControl を使う。
 *   Tether は ControlTransport だけを見るので、unpair / guest-apps / 設定同期をバスへ移しても Tether 側の送受信は変わらない。
 */
export interface ControlTransport {
  readonly kind: 'nearby' | 'bus';
  /** 送る。つながっていなければ溜める(opts で期限・置き換え)。ttlMs: 0 は溜めない */
  send(body: unknown, opts?: SendOptions): void;
  /** 受信。戻り値で購読解除 */
  subscribe(cb: (body: unknown) => void): () => void;
  /** いま実際に流れる状態か(false のときの send は溜まる) */
  readonly ready: boolean;
  /** 溜まっていて未送達の数 */
  readonly pending: number;
}

/** Nearby 上の LinkSupervisor を ControlTransport として見せる */
export class NearbyControl implements ControlTransport {
  readonly kind = 'nearby' as const;
  private subs = new Set<(body: unknown) => void>();
  private sup: LinkSupervisor | null = null;
  private up = false;

  attach(sup: LinkSupervisor): void {
    this.sup = sup;
  }
  /** LinkSupervisor の onReceive から呼ぶ */
  deliver(body: unknown): void {
    for (const cb of [...this.subs]) {
      try { cb(body); } catch {}
    }
  }
  /** LinkSupervisor の onState から呼ぶ */
  setConnected(up: boolean): void {
    this.up = up;
  }
  send(body: unknown, opts?: SendOptions): void {
    this.sup?.send(body, opts);
  }
  subscribe(cb: (body: unknown) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  get ready(): boolean {
    return this.up;
  }
  get pending(): number {
    return this.sup?.pending ?? 0;
  }
}
