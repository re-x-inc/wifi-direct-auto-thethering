import { NearbyApi } from '../link/nearbyTransport';
import { Identity, Pair } from './types';
import { PairStore } from './store';

const PREFIX = 'P|';

/** ペアリング中の広告名。通常の接続用の名前(端末IDだけ)と区別する。 */
export const pairingName = (id: Identity) => `${PREFIX}${id.id}|${id.name}`;

export function parsePairingName(name: string): { id: string; label: string } | null {
  if (!name.startsWith(PREFIX)) return null;
  const [, id, ...rest] = name.split('|');
  if (!id) return null;
  return { id, label: rest.join('|') || id };
}

export interface Found {
  endpointId: string;
  id: string;
  label: string;
}

export interface Confirm {
  peerName: string;
  /** 両方の画面に同じ数字が出る。一致を確かめてから accept する(中間者攻撃の対策) */
  digits: string;
  accept(): void;
  reject(): void;
}

export type PairingResult = { ok: true; pair: Pair } | { ok: false; error: string };

export interface PairingOptions {
  self: Identity;
  store: PairStore;
  /** 暗号論的乱数の16進文字列(バイト数) */
  randomHex: (bytes: number) => string;
  now?: () => number;
  timeoutMs?: number;
}

type Wire = { t: 'pair'; id: string; label: string; secret: string } | { t: 'paired' };

/**
 * 近くの端末を探し、確認コードを照合して、ペア固有の共有コードを交換する。
 * 両端末が start() して広告と探索を同時に行う。片方が connectTo() で接続を始める(発信側)。
 * 共有コードは発信側が作り、Nearby の暗号化された接続でだけ渡す。
 */
export class PairingSession {
  onDevices: (list: Found[]) => void = () => {};
  onConfirm: (c: Confirm) => void = () => {};
  onDone: (r: PairingResult) => void = () => {};

  private found = new Map<string, Found>();
  private unsubs: (() => void)[] = [];
  private active: { endpointId: string; peer: { id: string; label: string }; initiator: boolean } | null = null;
  private done = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: NearbyApi, private o: PairingOptions) {}

  start(): void {
    const { api, o } = this;
    this.unsubs.push(
      api.on('onFound', (e) => {
        const p = parsePairingName(e.name ?? '');
        if (!p || p.id === o.self.id) return;
        this.found.set(e.endpointId, { endpointId: e.endpointId, ...p });
        this.emitDevices();
      }),
      api.on('onLost', (e) => {
        if (this.found.delete(e.endpointId)) this.emitDevices();
      }),
      api.on('onInitiated', (e) => {
        const p = parsePairingName(e.name ?? '');
        // ペアリング用の名前でない相手、または別の相手と進行中なら断る
        if (!p || this.active || this.done) return api.reject(e.endpointId);
        const initiator = !e.incoming;
        this.active = { endpointId: e.endpointId, peer: p, initiator };
        this.o.timeoutMs && this.arm();
        this.onConfirm({
          peerName: p.label,
          digits: String(e.digits ?? ''),
          accept: () => api.accept(e.endpointId),
          reject: () => {
            api.reject(e.endpointId);
            this.finish({ ok: false, error: '確認コードが一致しないため、ペアリングをやめました' });
          },
        });
      }),
      api.on('onConnected', (e) => {
        const a = this.active;
        if (!a || e.endpointId !== a.endpointId || !a.initiator) return;
        const secret = o.randomHex(32);
        this.pending = secret;
        this.write({ t: 'pair', id: o.self.id, label: o.self.name, secret });
      }),
      api.on('onMessage', (e) => void this.onMessage(e)),
      api.on('onFailed', (e) => {
        if (e.endpointId === this.active?.endpointId) this.finish({ ok: false, error: '接続できませんでした(相手が承認しなかった可能性があります)' });
      }),
      api.on('onDisconnected', (e) => {
        if (e.endpointId === this.active?.endpointId) this.finish({ ok: false, error: '接続が切れました' });
      }),
    );
    api.advertise(pairingName(o.self));
    api.discover();
    if (o.timeoutMs) this.arm();
  }

  /** 見つかった端末へ接続を始める(発信側になる) */
  connectTo(endpointId: string): void {
    if (this.active || this.done) return;
    this.api.requestConnect(endpointId, pairingName(this.o.self));
  }

  stop(): void {
    this.finish(null);
  }

  private pending: string | null = null;

  private async onMessage(e: { endpointId: string; text: string }): Promise<void> {
    const a = this.active;
    if (!a || e.endpointId !== a.endpointId || this.done) return;
    let w: Wire;
    try {
      w = JSON.parse(e.text);
    } catch {
      return;
    }
    const now = (this.o.now ?? Date.now)();
    if (w.t === 'pair' && !a.initiator) {
      // 受け側: 共有コードを保存して、受け取ったことを返す
      if (typeof w.secret !== 'string' || w.secret.length < 32) return this.finish({ ok: false, error: '共有コードが不正です' });
      const pair: Pair = { peerId: w.id, peerName: w.label || a.peer.label, secret: w.secret, createdAt: now };
      await this.o.store.save(pair);
      this.write({ t: 'paired' });
      this.finish({ ok: true, pair });
    } else if (w.t === 'paired' && a.initiator && this.pending) {
      const pair: Pair = { peerId: a.peer.id, peerName: a.peer.label, secret: this.pending, createdAt: now };
      await this.o.store.save(pair);
      this.finish({ ok: true, pair });
    }
  }

  private write(w: Wire): void {
    if (this.active) this.api.send(this.active.endpointId, JSON.stringify(w));
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish({ ok: false, error: '時間切れです' }), this.o.timeoutMs);
  }

  private emitDevices(): void {
    this.onDevices([...this.found.values()]);
  }

  private finish(r: PairingResult | null): void {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.pending = null;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    if (this.active) this.api.disconnect(this.active.endpointId);
    this.api.stop();
    if (r) this.onDone(r);
  }
}
