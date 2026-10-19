import { Identity, KeyValue, Pair } from './types';

const PAIRS = 'pairs.v1';
const IDENTITY = 'identity.v1';

/** ペアの保存。同じ相手を再ペアリングしたら、共有コードを入れ替える。 */
export class PairStore {
  constructor(private kv: KeyValue) {}

  async list(): Promise<Pair[]> {
    const raw = await this.kv.get(PAIRS);
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  async save(p: Pair): Promise<void> {
    const rest = (await this.list()).filter((x) => x.peerId !== p.peerId);
    await this.kv.set(PAIRS, JSON.stringify([...rest, p]));
  }

  async remove(peerId: string): Promise<void> {
    await this.kv.set(PAIRS, JSON.stringify((await this.list()).filter((x) => x.peerId !== peerId)));
  }
}

/** 端末IDを一度だけ作って保存する。name は画面に出す名前(ID の末尾から作る)。 */
export async function getIdentity(kv: KeyValue, randomHex: (bytes: number) => string): Promise<Identity> {
  const raw = await kv.get(IDENTITY);
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (v?.id && v?.name) return v;
    } catch {}
  }
  const id = 'T' + randomHex(4);
  const identity = { id, name: `端末-${id.slice(-4).toUpperCase()}` };
  await kv.set(IDENTITY, JSON.stringify(identity));
  return identity;
}
