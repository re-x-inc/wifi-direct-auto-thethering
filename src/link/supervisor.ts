/** 通信路(Wi-Fi Direct / ホットスポット / Nearby など)を差し替えるための最小インターフェース。 */
export interface Transport {
  /** 保存済みの相手へ接続し、認証まで済ませる。失敗なら reject。 */
  connect(): Promise<void>;
  send(frame: Frame): void;
  onFrame(cb: (f: Frame) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export type Frame = { type: 'data'; seq: number; epoch?: string; body: unknown } | { type: 'ack'; seq: number } | { type: 'ping' } | { type: 'pong' };

export interface Options {
  baseMs: number;
  maxMs: number;
  /** この時間 pong が来なければ切断とみなす */
  pingTimeoutMs: number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /**
   * つながっていた時間がこれ以上なら、切れたあと待たずにすぐ探索をやり直す(ms)。
   * 待ちは setTimeout なので、アプリが背面にいる間(Wi-Fi 承認ダイアログが前面など)は React Native が止めてしまい、
   * 再接続が始まらない。native のイベントで進む探索に、すぐ戻すため。短すぎる接続(つながってすぐ切れる)だけ待つ。
   */
  flapMs: number;
}

export interface SendOptions {
  /**
   * 切断中に溜めておく最長時間(ms)。未指定は無期限。
   * 0 は「溜めない」: 接続中なら送り、切断中なら捨てる(状態表示など、古くなれば無意味なもの用)。
   */
  ttlMs?: number;
  /** 同じ key の未確認メッセージは、新しいものに置き換える(最新だけ届ければよいもの用) */
  key?: string;
}

interface Pending {
  frame: Frame;
  expiresAt: number;
  key?: string;
}

export const DEFAULTS: Options = {
  baseMs: 1000,
  maxMs: 30000,
  pingTimeoutMs: 10000,
  random: Math.random,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  flapMs: 3000,
};

/** 指数バックオフ + ジッター。attempt は 0 始まり。 */
export function backoffMs(attempt: number, o: Pick<Options, 'baseMs' | 'maxMs' | 'random'>): number {
  const cap = Math.min(o.maxMs, o.baseMs * 2 ** attempt);
  return Math.round(cap / 2 + (o.random() * cap) / 2);
}

/**
 * 切れても自動で再接続し、未確認のデータを再送する。
 * 受信側は seq で重複を除く前提(再送で同じ seq が複数回届きうる)。
 */
export class LinkSupervisor {
  private seq = 0;
  /** 送信側の起動ごとの識別子。再起動で seq が1に戻っても重複と区別するため */
  private epoch = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private seen = new Set<string>();
  private unacked = new Map<number, Pending>();
  private transport: Transport | null = null;
  private running = false;
  private endSession: (() => void) | null = null;
  /** 画面表示用。connecting=接続試行中 / connected=認証済み / waiting=再試行待ち / stopped */
  onState: (state: 'connecting' | 'connected' | 'waiting' | 'paused' | 'stopped', attempt: number) => void = () => {};
  /** pause() 中。true の間は Nearby に何も要求しない(接続も探索もしない) */
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private abortConnect: (() => void) | null = null;
  private connecting: Transport | null = null;
  private o: Options;

  constructor(
    private makeTransport: () => Transport,
    private onReceive: (body: unknown, seq: number) => void,
    opts: Partial<Options> = {},
  ) {
    this.o = { ...DEFAULTS, ...opts };
  }

  get pending(): number {
    this.purge();
    return this.unacked.size;
  }

  /** 期限切れの未確認メッセージを捨てる */
  private purge(): void {
    const now = this.o.now();
    for (const [seq, p] of this.unacked) if (p.expiresAt <= now) this.unacked.delete(seq);
  }

  /** 結果を送る。切断中は溜めて、つながり次第送る(opts で期限・置き換えを指定できる)。 */
  send(body: unknown, opts: SendOptions = {}): void {
    const f: Frame = { type: 'data', seq: ++this.seq, epoch: this.epoch, body };
    if (opts.ttlMs !== 0) {
      if (opts.key !== undefined) {
        for (const [seq, p] of this.unacked) if (p.key === opts.key) this.unacked.delete(seq);
      }
      const expiresAt = opts.ttlMs === undefined ? Infinity : this.o.now() + opts.ttlMs;
      this.unacked.set(f.seq, { frame: f, expiresAt, key: opts.key });
    }
    this.transport?.send(f);
  }

  async run(): Promise<void> {
    this.running = true;
    let attempt = 0;
    while (this.running) {
      if (this.paused) {
        this.onState('paused', 0);
        await new Promise<void>((r) => this.resumeWaiters.push(r));
        attempt = 0;
        continue;
      }
      const t = this.makeTransport();
      this.onState('connecting', attempt);
      this.connecting = t;
      try {
        await Promise.race([t.connect(), new Promise<never>((_, rej) => { this.abortConnect = () => rej(new Error('paused')); })]);
      } catch {
        this.abortConnect = null;
        this.connecting = null;
        if (this.paused || !this.running) { t.close(); continue; }
        this.onState('waiting', attempt);
        await this.o.sleep(backoffMs(attempt++, this.o));
        continue;
      }
      this.abortConnect = null;
      this.connecting = null;
      attempt = 0;
      this.onState('connected', 0);
      const upAt = this.o.now();
      await this.session(t);
      this.transport = null;
      if (this.running && !this.paused) {
        this.onState('waiting', 0);
        // しばらくつながっていた後の切断は、待たずにすぐ探索をやり直す。つながってすぐ切れる場合だけ間をおく
        if (this.o.now() - upAt < this.o.flapMs) await this.o.sleep(backoffMs(0, this.o));
      }
    }
    this.onState('stopped', 0);
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    this.endSession?.();
    this.transport?.close();
    this.abortConnect?.();
    this.wake();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private wake(): void {
    const w = this.resumeWaiters;
    this.resumeWaiters = [];
    w.forEach((r) => r());
  }

  /**
   * Nearby を閉じて、resume() まで再接続しない(Direct が生きている間、Nearby の接続・探索・広告を出さないため)。
   * 接続中なら、未確認の送信が ack されるまで最大 drainMs 待ってから閉じる(接続情報・到達確認を取りこぼさない)。
   * 溜めたメッセージは捨てず、resume 後の接続で再送する。
   */
  async pause(drainMs = 0): Promise<void> {
    if (this.paused) return;
    const t0 = this.o.now();
    while (this.transport && drainMs > 0 && this.unacked.size > 0 && this.o.now() - t0 < drainMs) await this.o.sleep(50);
    this.paused = true;
    this.abortConnect?.();
    this.connecting?.close();
    this.endSession?.();
    this.transport?.close();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.wake();
  }

  private session(t: Transport): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      let lastSeen = Date.now();
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        this.endSession = null;
        t.close();
        resolve();
      };
      this.endSession = finish;
      t.onClose(finish);
      t.onFrame((f) => {
        lastSeen = Date.now();
        if (f.type === 'ack') this.unacked.delete(f.seq);
        else if (f.type === 'ping') t.send({ type: 'pong' });
        else if (f.type === 'data') {
          t.send({ type: 'ack', seq: f.seq });
          // ack が失われて再送された分は、一度だけ処理する
          const key = `${f.epoch ?? ''}:${f.seq}`;
          if (this.seen.has(key)) return;
          this.seen.add(key);
          if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value as string);
          this.onReceive(f.body, f.seq);
        }
      });
      const timer = setInterval(() => {
        if (Date.now() - lastSeen > this.o.pingTimeoutMs) finish();
        else t.send({ type: 'ping' });
      }, Math.max(100, this.o.pingTimeoutMs / 3));
      this.transport = t;
      this.purge();
      for (const p of this.unacked.values()) t.send(p.frame); // 再送
    });
  }
}
