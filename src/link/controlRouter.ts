import type { SendOptions } from './supervisor';
import type { BusControl } from './busControl';
import type { ControlTransport, NearbyControl } from './transport';
import { Channel, channelOf, kindOf } from './channel';

export type Carrier = 'nearby' | 'bus';

/** 送信の報告(ログ用。中身は含めない) */
export interface SendReport {
  channel: Channel;
  kind: string;
  /** 内部制御は選んだ運び先、アプリは常に 'bus'(バス部品が無いときは null) */
  to: Carrier | null;
  outcome: 'sent' | 'queued' | 'dropped';
  reason?: 'ttl0' | 'limit' | 'no-bus';
}

/**
 * メッセージの運び先を、種類(チャネル)とその時点の状態で選ぶ(Tether は ControlTransport としてこれだけを見る)。
 *  - **アプリのメッセージ(tether.app)は常にバスだけ**。バスが使えない間はバスの保留キューに溜め(ttl で捨てる)、Nearby には載せない
 *  - 以下は内部制御(tether.app 以外の tether.*)の話:
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
    private onSend?: (r: SendReport) => void,
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
      for (const m of this.bus.takePending()) { // 内部制御だけ。アプリのメッセージはバスの保留に残す
         this.nearby.send(m.body, m.opts); moved++; }
    }
    this.onRoute?.(cur, moved);
  }

  /** どちらで送るか(テスト・ログ用)。アプリのメッセージは常にバス */
  route(body: unknown): Carrier {
    if (channelOf(body) === 'app') return 'bus';
    if ((body as { kind?: unknown } | null)?.kind === 'tether.wifi') return 'nearby';
    return this.pick();
  }

  send(body: unknown, opts?: SendOptions): void {
    this.reconcile();
    const channel = channelOf(body);
    const kind = kindOf(body);
    if (channel === 'app') {
      // アプリのメッセージはバス専用。バスが無い(部品なし)ときは捨てる(Nearby にはフォールバックしない)
      if (!this.bus) { this.onSend?.({ channel, kind, to: null, outcome: 'dropped', reason: 'no-bus' }); return; }
      const r = this.bus.send(body, opts);
      this.onSend?.({ channel, kind, to: 'bus', outcome: r.outcome, reason: r.reason });
      return;
    }
    const to = this.route(body) === 'bus' && this.bus ? 'bus' : 'nearby';
    if (to === 'bus') this.bus!.send(body, opts);
    else this.nearby.send(body, opts);
    this.onSend?.({ channel, kind, to, outcome: 'sent' });
  }

  /** アプリのメッセージの保留数(バスの保留。画面用) */
  get appPending(): number {
    return this.bus?.pendingOf('app') ?? 0;
  }

  /** from = どの運び先から届いたか */
  subscribe(cb: (body: unknown, from?: Carrier) => void): () => void {
    const a = this.nearby.subscribe((b) => cb(b, 'nearby'));
    const b = this.bus?.subscribe((x) => cb(x, 'bus'));
    return () => { a(); b?.(); };
  }

  get ready(): boolean {
    return this.pick() === 'bus' && this.bus ? this.bus.ready : this.nearby.ready;
  }

  get pending(): number {
    return this.nearby.pending + (this.bus?.pending ?? 0);
  }
}
