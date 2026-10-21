import type { SendOptions } from './supervisor';
import type { BusControl } from './busControl';
import type { ControlTransport, NearbyControl } from './transport';

export type Carrier = 'nearby' | 'bus';

/**
 * 制御メッセージの運び先を、その時点の状態で選ぶ(Tether は ControlTransport としてこれだけを見る)。
 *  - Direct 稼働中で Nearby を止めている(suspend)間 → バス
 *  - それ以外(Nearby が使える間)→ Nearby
 *  - 例外: `tether.wifi`(Direct の接続情報。Direct が無いときに送るもの)は常に Nearby
 * バスが切れている間は、バスの保留キューに溜める(Nearby は止めてあるので、先にバスの再接続を待つ。再接続はネイティブが続ける)。
 * Nearby が再開されて運び先が Nearby に戻ったら、バスに溜まっていた未確認分を送信順のまま Nearby へ移す(reconcile)。
 */
export class RoutedControl implements ControlTransport {
  private last: Carrier;
  constructor(
    private nearby: NearbyControl,
    private bus: BusControl | null,
    /** いまの運び先(Tether が「Direct 稼働中かつ suspend かつバスが使える」で決める) */
    private pick: () => Carrier,
    private onRoute?: (to: Carrier, moved: number) => void,
  ) {
    this.last = pick();
  }

  get kind(): Carrier {
    return this.pick();
  }

  /** 運び先が変わっていれば、縮退(バス → Nearby)の移し替えをする。Tether が遷移のたびに呼ぶ。send も先に呼ぶ */
  reconcile(): void {
    const cur = this.pick();
    if (cur === this.last) return;
    const prev = this.last;
    this.last = cur;
    let moved = 0;
    if (prev === 'bus' && cur === 'nearby' && this.bus) {
      for (const m of this.bus.takePending()) { this.nearby.send(m.body, m.opts); moved++; }
    }
    this.onRoute?.(cur, moved);
  }

  /** どちらで送るか(テスト・ログ用) */
  route(body: unknown): Carrier {
    if ((body as { kind?: unknown } | null)?.kind === 'tether.wifi') return 'nearby';
    return this.pick();
  }

  send(body: unknown, opts?: SendOptions): void {
    this.reconcile();
    if (this.route(body) === 'bus' && this.bus) this.bus.send(body, opts);
    else this.nearby.send(body, opts);
  }

  subscribe(cb: (body: unknown) => void): () => void {
    const a = this.nearby.subscribe(cb);
    const b = this.bus?.subscribe(cb);
    return () => { a(); b?.(); };
  }

  get ready(): boolean {
    return this.pick() === 'bus' && this.bus ? this.bus.ready : this.nearby.ready;
  }

  get pending(): number {
    return this.nearby.pending + (this.bus?.pending ?? 0);
  }
}
