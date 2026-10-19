import { Frame, Transport } from './supervisor';

type Handler = (e: any) => void;

/** modules/nearby-link の必要最小限。テストでは偽物に差し替える。 */
export interface NearbyApi {
  advertise(name: string): void;
  discover(): void;
  requestConnect(endpointId: string, name: string): void;
  accept(endpointId: string): void;
  reject(endpointId: string): void;
  send(endpointId: string, text: string): void;
  disconnect(endpointId: string): void;
  stop(): void;
  hmac(secret: string, data: string): string;
  on(event: string, cb: Handler): () => void;
}

export interface PairInfo {
  /** 相手の端末ID(広告・探索時の名前と一致を見る) */
  peerId: string;
  /** 初回ペアリングで交換した共有コード */
  secret: string;
}

export interface NearbyOptions {
  role: 'host' | 'guest';
  selfId: string;
  pair: PairInfo;
  connectTimeoutMs?: number;
  nonce?: () => string;
}

type Wire =
  | { t: 'hello'; nonce: string }
  | { t: 'auth'; mac: string }
  | { t: 'frame'; f: Frame };

/**
 * 保存済みの相手とだけ接続し、共有コードの HMAC で相互認証する。
 * 認証が済むまでは Frame を流さない。
 */
export class NearbyTransport implements Transport {
  private endpoint: string | null = null;
  private frameCb: (f: Frame) => void = () => {};
  private closeCb: () => void = () => {};
  private unsubs: (() => void)[] = [];
  private authed = false;
  private closed = false;

  constructor(private api: NearbyApi, private o: NearbyOptions) {}

  connect(): Promise<void> {
    const { api, o } = this;
    const myNonce = (o.nonce ?? (() => api.hmac(o.pair.secret, `${Date.now()}:${Math.random()}`)))();

    return new Promise<void>((resolve, reject) => {
      const fail = (msg: string) => {
        console.log(`[DH] 接続失敗: ${msg}`);
        this.close();
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail('timeout'), o.connectTimeoutMs ?? 30000);
      const ok = () => {
        clearTimeout(timer);
        resolve();
      };

      this.unsubs.push(
        api.on('onFound', (e) => {
          if (o.role === 'guest' && e.name === o.pair.peerId && !this.endpoint) {
            api.requestConnect(e.endpointId, o.selfId);
          }
        }),
        api.on('onInitiated', (e) => {
          if (this.endpoint || e.name !== o.pair.peerId) {
            console.log(`[DH] 拒否 role=${o.role} ep=${e.endpointId} name=${e.name} want=${o.pair.peerId} 既存=${this.endpoint ?? '-'}`);
            return api.reject(e.endpointId);
          }
          this.endpoint = e.endpointId;
          api.accept(e.endpointId);
        }),
        api.on('onConnected', (e) => {
          if (e.endpointId !== this.endpoint) return;
          this.write({ t: 'hello', nonce: myNonce });
        }),
        api.on('onError', (e) => console.log(`[DH] Nearby ${e.op} 失敗 code=${e.code}`)),
        api.on('onFailed', (e) => {
          if (e.endpointId === this.endpoint) fail('connection failed');
        }),
        api.on('onDisconnected', (e) => {
          if (e.endpointId !== this.endpoint) return;
          if (!this.authed) fail('disconnected before auth');
          else this.close();
        }),
        api.on('onMessage', (e) => {
          if (e.endpointId !== this.endpoint) return;
          let w: Wire;
          try {
            w = JSON.parse(e.text);
          } catch {
            return;
          }
          if (w.t === 'hello') {
            console.log(`[DH] hello受信 role=${o.role} ep=${e.endpointId} peerNonce=${String(w.nonce).slice(0, 8)}`);
            this.write({ t: 'auth', mac: api.hmac(o.pair.secret, w.nonce) });
          } else if (w.t === 'auth') {
            if (w.mac !== api.hmac(o.pair.secret, myNonce)) {
              console.log(`[DH] auth不一致 role=${o.role} ep=${e.endpointId} myNonce=${myNonce.slice(0, 8)} got=${String(w.mac).slice(0, 8)} want=${api.hmac(o.pair.secret, myNonce).slice(0, 8)}`);
              return fail('auth mismatch');
            }
            this.authed = true;
            ok();
          } else if (w.t === 'frame' && this.authed) {
            this.frameCb(w.f);
          }
        }),
      );

      if (o.role === 'host') api.advertise(o.selfId);
      else api.discover();
    });
  }

  send(frame: Frame): void {
    if (this.authed) this.write({ t: 'frame', f: frame });
  }
  onFrame(cb: (f: Frame) => void): void {
    this.frameCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.endpoint) this.api.disconnect(this.endpoint);
    this.api.stop();
    this.closeCb();
  }

  private write(w: Wire): void {
    if (this.endpoint) this.api.send(this.endpoint, JSON.stringify(w));
  }
}
