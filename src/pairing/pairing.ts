import { NearbyApi } from '../link/nearbyTransport';
import { Identity, Pair, labelOf } from './types';
import { PairStore } from './store';

const PREFIX = 'P|';

/**
 * ペアリング中の広告名。通常の接続用の名前(端末IDだけ)と区別する。
 * 低電力(Bluetooth LE のみ)の広告パケットは名前に使える余地が小さいので、ASCII の短い名前にする。
 * 表示名は端末IDの末尾から作る(Identity.name と同じ規則)。
 */
export const pairingName = (id: Identity) => `${PREFIX}${id.id}`;

export function parsePairingName(name: string): { id: string; label: string } | null {
  if (!name.startsWith(PREFIX)) return null;
  const id = name.slice(PREFIX.length);
  if (!id || id.includes('|')) return null;
  return { id, label: labelOf(id) };
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
  /** この端末の役割。host=「親機になる」: 広告だけして、子機からの接続要求を待つ。guest=「子機になる」: 親機を探して接続要求を出す */
  role: 'host' | 'guest';
}

type Wire = { t: 'pair'; id: string; label: string; secret: string } | { t: 'paired' };

/**
 * 近くの端末を探し、確認コードを照合して、ペア固有の共有コードを交換する。
 * 親機(host)は広告だけ、子機(guest)は探索だけを行い、子機が見つけた親機へ connectTo() で接続を要求する。
 * 役割は利用者が選び、ペアに保存する。共有コードは子機が作り、Nearby の暗号化された接続でだけ渡す。
 */
export class PairingSession {
  onDevices: (list: Found[]) => void = () => {};
  onConfirm: (c: Confirm) => void = () => {};
  onDone: (r: PairingResult) => void = () => {};
  /** 進行状況の文言(画面に出す)。相手の承認待ちなどを伝える */
  onStatus: (s: string) => void = () => {};

  private found = new Map<string, Found>();
  private unsubs: (() => void)[] = [];
  private active: { endpointId: string; peer: { id: string; label: string }; initiator: boolean } | null = null;
  private done = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: NearbyApi, private o: PairingOptions) {}

  start(): void {
    const { api, o } = this;
    this.unsubs.push(
      api.on('onError', (e) => {
        console.log(`[DH] Nearby ${e.op} 失敗 code=${e.code}`);
        // 両端末が同時に「ペアにする」を押すと、無線エラー(8007/8012 など)で衝突する。ずらして数回やり直す。
        if (e.op === 'requestConnect' && this.target && !this.active && !this.done && this.retries < 4) {
          this.retries++;
          this.onStatus(`接続をやり直しています…(${this.retries}/4)`);
          const id = this.target;
          setTimeout(() => {
            if (!this.active && !this.done && this.target === id) api.requestConnect(id, pairingName(this.o.self));
          }, 400 + Math.random() * 1600);
        }
      }),
      api.on('onFound', (e) => {
        console.log(`[DH] ペアリング: 発見 name=${e.name}`);
        const p = parsePairingName(e.name ?? '');
        if (!p || p.id === o.self.id || o.role !== 'guest') return;
        this.found.set(e.endpointId, { endpointId: e.endpointId, ...p });
        this.emitDevices();
      }),
      api.on('onLost', (e) => {
        if (this.found.delete(e.endpointId)) this.emitDevices();
      }),
      api.on('onInitiated', (e) => {
        console.log(`[DH] ペアリング: 接続要求 name=${e.name} incoming=${e.incoming} digits=${e.digits}`);
        const p = parsePairingName(e.name ?? '');
        // ペアリング用の名前でない相手、または別の相手と進行中なら断る
        if (!p || this.active || this.done) return api.reject(e.endpointId);
        const initiator = !e.incoming;
        // 親機は受ける側、子機は要求する側。役割が噛み合わない相手(親機同士など)は断る
        if (initiator !== (o.role === 'guest')) return api.reject(e.endpointId);
        this.active = { endpointId: e.endpointId, peer: p, initiator };
        this.o.timeoutMs && this.arm();
        this.onConfirm({
          peerName: p.label,
          digits: String(e.digits ?? ''),
          accept: () => {
            this.onStatus('相手の承認を待っています…(相手の端末でも「一致する」を押してください)');
            api.accept(e.endpointId);
          },
          reject: () => {
            api.reject(e.endpointId);
            this.finish({ ok: false, error: '確認コードが一致しないため、ペアリングをやめました' });
          },
        });
      }),
      api.on('onConnected', (e) => {
        const a = this.active;
        if (!a || e.endpointId !== a.endpointId) return;
        this.onStatus('共有コードを交換しています…');
        if (!a.initiator) return;
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
    console.log(`[DH] ペアリング開始 name=${pairingName(o.self)}`);
    api.stop(); // 残骸を一掃(広告と探索は、この後に続けて始める)
    if (o.role === 'host') api.advertise(pairingName(o.self));
    else api.discover();
    if (o.timeoutMs) this.arm();
  }

  /** 見つかった端末へ接続を始める(発信側になる) */
  connectTo(endpointId: string): void {
    if (this.active || this.done || this.o.role !== 'guest') return;
    this.target = endpointId;
    this.retries = 0;
    this.onStatus('接続を要求しています…相手の端末に確認コードが出ます');
    this.api.requestConnect(endpointId, pairingName(this.o.self));
  }

  stop(): void {
    this.finish(null);
  }

  private pending: string | null = null;
  private target: string | null = null;
  private retries = 0;

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
      const pair: Pair = { peerId: w.id, peerName: w.label || a.peer.label, secret: w.secret, createdAt: now, role: this.o.role };
      await this.o.store.save(pair);
      this.write({ t: 'paired' });
      this.finish({ ok: true, pair });
    } else if (w.t === 'paired' && a.initiator && this.pending) {
      const pair: Pair = { peerId: a.peer.id, peerName: a.peer.label, secret: this.pending, createdAt: now, role: this.o.role };
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
