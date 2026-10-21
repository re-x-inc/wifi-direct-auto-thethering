import type { ControlTransport } from './transport';
import type { Frame, SendOptions } from './supervisor';

/**
 * Direct 上のバスのネイティブ部品(Kotlin の BusEngine。ZeroMQ = jeromq)の JS 側の窓口。
 * ここより下(接続の保持・認証・ping/pong・自動再接続)はネイティブが持ち、JS が止まっても生存信号 lastRxAt は進む。
 * 実装を差し替えたいとき(別のトランスポート)は、この BusPort を満たす部品を作ればよい(BusControl 以上は変わらない)。
 */
export interface BusStartOptions {
  host: boolean;
  selfId: string;
  peerId: string;
  /** 共有コードから導いた鍵(hex)。共有コード自体はネイティブへ渡さない */
  keyHex: string;
  /** 子機: 親機のアドレス。親機: null(Direct のインターフェースを探して bind する) */
  addr: string | null;
  port: number;
  pingMs: number;
  timeoutMs: number;
}

export interface BusStatus {
  running: boolean;
  up: boolean;
  /** 最後に認証済みのフレーム(ping/pong 含む)を受けた時刻(epoch ms、0 = まだ無い)。ネイティブが更新し続ける生存信号 */
  lastRxAt: number;
  connects: number;
  lastError: string | null;
}

export interface BusPort {
  /** 始める。戻り値は bind 先(ログ用) */
  start(o: BusStartOptions): string;
  stop(): void;
  /** 認証済みのときだけ送って true。false = 送っていない(呼び出し側が保留する) */
  send(payload: string): boolean;
  status(): BusStatus;
  onState(cb: (e: { up: boolean; reason: string }) => void): () => void;
  onMessage(cb: (payload: string) => void): () => void;
}

interface Pending {
  frame: Frame;
  expiresAt: number;
  key?: string;
  ttlMs?: number;
}

export interface BusControlOptions {
  now: () => number;
  /** 重複排除の記憶数 */
  seenMax?: number;
}

/**
 * Direct 上のバスを ControlTransport として見せる。到達保証はここで持つ(ネイティブは運ぶだけ):
 *  - 順序: 送信順に seq を振り、再接続後は未確認分を seq 順に再送する(TCP の順序 + 再送の順序)
 *  - 再送: 受け手が ack を返すまで保持する(at-least-once)。受け手は (epoch, seq) で重複を捨てる
 *  - ttl / key: LinkSupervisor の SendOptions と同じ意味(ttlMs 未指定=無期限、0=溜めない、key=同じ key の未確認を置き換え)
 * Frame の型は LinkSupervisor と共通(type: 'data' | 'ack')。ping/pong はネイティブが行うので使わない。
 */
export class BusControl implements ControlTransport {
  readonly kind = 'bus' as const;
  private seq = 0;
  private epoch = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private unacked = new Map<number, Pending>();
  private seen = new Set<string>();
  private subs = new Set<(body: unknown) => void>();
  private upSubs = new Set<(up: boolean, reason: string) => void>();
  private offs: (() => void)[] = [];
  private up = false;
  private opened = false;

  constructor(private port: BusPort, private o: BusControlOptions) {}

  /** ネイティブのイベントの購読を始める(start の前に呼ぶ)。detach で解く */
  attach(): void {
    if (this.opened) return;
    this.opened = true;
    this.offs.push(
      this.port.onState((e) => this.setUp(e.up, e.reason)),
      this.port.onMessage((p) => this.receive(p)),
    );
  }

  detach(): void {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.opened = false;
    this.up = false;
  }

  /** 接続の上り下がり(認証完了 / 切断)。Tether が生存信号・状態表示に使う */
  onUpDown(cb: (up: boolean, reason: string) => void): () => void {
    this.upSubs.add(cb);
    return () => this.upSubs.delete(cb);
  }

  private setUp(up: boolean, reason: string): void {
    const changed = up !== this.up;
    this.up = up;
    if (up) this.flush();
    if (changed || up) for (const cb of [...this.upSubs]) { try { cb(up, reason); } catch {} }
  }

  send(body: unknown, opts: SendOptions = {}): void {
    const frame: Frame = { type: 'data', seq: ++this.seq, epoch: this.epoch, body };
    if (opts.ttlMs !== 0) {
      if (opts.key !== undefined) for (const [s, p] of this.unacked) if (p.key === opts.key) this.unacked.delete(s);
      this.unacked.set(frame.seq, { frame, expiresAt: opts.ttlMs === undefined ? Infinity : this.o.now() + opts.ttlMs, key: opts.key, ttlMs: opts.ttlMs });
    }
    if (this.up) this.write(frame);
  }

  subscribe(cb: (body: unknown) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  get ready(): boolean {
    return this.up;
  }

  get pending(): number {
    this.purge();
    return this.unacked.size;
  }

  /**
   * 未確認の分を取り出して空にする(Nearby へ縮退するとき、Nearby の送信へ移すため)。送信順。残り ttl つき。
   * 相手が受け取っていて ack だけ失われたものは、移した先で二重に届きうる(受け手のアプリは冪等に扱う)。
   */
  takePending(): { body: unknown; opts: SendOptions }[] {
    this.purge();
    const now = this.o.now();
    const out = [...this.unacked.values()].map((p) => ({
      body: (p.frame as { body: unknown }).body,
      opts: { key: p.key, ttlMs: p.expiresAt === Infinity ? undefined : Math.max(1, p.expiresAt - now) } as SendOptions,
    }));
    this.unacked.clear();
    return out;
  }

  private purge(): void {
    const now = this.o.now();
    for (const [s, p] of this.unacked) if (p.expiresAt <= now) this.unacked.delete(s);
  }

  /** 再接続・認証完了のあと、未確認を送信順に再送する */
  private flush(): void {
    this.purge();
    for (const p of this.unacked.values()) this.write(p.frame);
  }

  private write(f: Frame): void {
    // 認証済みでなければ false が返り、送られない(保留のまま。次の up で flush される)
    try { this.port.send(JSON.stringify(f)); } catch {}
  }

  private receive(payload: string): void {
    let f: Frame;
    try { f = JSON.parse(payload) as Frame; } catch { return; }
    if (f?.type === 'ack') { this.unacked.delete(f.seq); return; }
    if (f?.type !== 'data') return;
    this.write({ type: 'ack', seq: f.seq });
    const key = `${f.epoch ?? ''}:${f.seq}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > (this.o.seenMax ?? 1000)) this.seen.delete(this.seen.values().next().value as string);
    for (const cb of [...this.subs]) { try { cb(f.body); } catch {} }
  }
}
