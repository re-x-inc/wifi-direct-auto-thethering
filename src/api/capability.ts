/**
 * 能力の自己申告(Capabilities)と、その保存・照合。
 * 入れるのは機種名と能力・状態だけ。配達の内容・画面のテキスト・共有コード・資格情報は入れない。
 * 取得できない項目は null(不明)。推測して true/false にしない。
 */

/** 端末間プロトコルの版。能力の項目や planner の入出力を互換のない形に変えたら上げる */
export const PROTOCOL_VERSION = 1;
/** 受け付ける最小の版。これ未満の相手には更新を促す */
export const MIN_PROTOCOL_VERSION = 1;
/** この版が対応する機能名(相手の対応確認用) */
export const FEATURES = ['link-plan'] as const;

/** true / false / null(不明) */
export type Tri = boolean | null;

export type RadioKey =
  | 'wifiDirect' | 'lohs' | 'staP2pConcurrent' | 'staApConcurrent' | 'p2pApCoexist'
  | 'staLocalOnlyConcurrent' | 'band24' | 'band5';

export interface Capabilities {
  v: number;
  features: string[];
  device: {
    manufacturer: string | null;
    model: string | null;
    sdk: number | null;
    release: string | null;
    batteryPercent: number | null;
    batteryOptimizationExempt: Tri;
  };
  network: { cellular: Tri };
  radio: Record<RadioKey, Tri>;
  state: {
    vpnConsent: Tri;
    deviceOwner: Tri;
    /** 常時 VPN。VPN サービス稼働中でないと公式 API で判定できないため、現状は常に不明 */
    alwaysOnVpn: Tri;
    /** 足りない権限名(null = 不明) */
    missingPermissions: string[] | null;
  };
  /** radio の各項目の根拠。api = 公式 API / probe = 実際に試した / observed = 実運用の結果。無い項目は不明 */
  source: Partial<Record<RadioKey, 'api' | 'probe' | 'observed'>>;
  collectedAt: number;
}

/** ネイティブ(modules/hotspot の capabilities())が返す形。取得できない項目は null */
export interface NativeCapabilities {
  manufacturer: string | null;
  model: string | null;
  sdk: number | null;
  release: string | null;
  batteryPercent: number | null;
  batteryOptimizationExempt: boolean | null;
  wifiDirect: boolean | null;
  staApConcurrent: boolean | null;
  staLocalOnlyConcurrent: boolean | null;
  band24: boolean | null;
  band5: boolean | null;
  vpnConsent: boolean | null;
  deviceOwner: boolean | null;
  missingPermissions: string[] | null;
}

export interface CapabilityPort {
  /** 副作用なし。取得できない項目は null */
  collect(): NativeCapabilities;
  /** 診断レポート用の網羅的な採取(副作用なし。個人を特定する値は採取しない)。Planner は使わない */
  diagnostics?(): { schema?: number; sections?: Record<string, Record<string, unknown>> };
  /** 診断レポートをこのアプリ専用のファイル領域に書き、パスを返す */
  saveFile?(name: string, text: string): string;
  /** LocalOnlyHotspot を一瞬だけ起動して閉じる。Wi-Fi が一時的に切れる機種がある */
  probeLohs(): Promise<{ ok: boolean; reason?: string }>;
}

// ---- 端末内に保存する試験・観測の結果 ----

export interface ProbeStore {
  /** 機種・Android 版が変わったら無効(OS 更新で挙動が変わるため) */
  buildKey: string;
  at: number;
  lohs?: { ok: boolean; reason?: string; at: number };
  /** 実運用で観測した値 */
  observed: Partial<Record<'staP2pConcurrent' | 'p2pApCoexist', boolean>>;
}

export const PROBE_KEY = 'tether.probe.v1';
export const HISTORY_KEY = 'tether.history.v1';
export const CAPCACHE_KEY = 'tether.capcache.v1';
/** 相手の能力キャッシュの有効期間 */
export const CAPCACHE_TTL_MS = 30 * 24 * 3600 * 1000;
/** 方式の結果履歴で「最近」とみなす期間 */
export const HISTORY_TTL_MS = 14 * 24 * 3600 * 1000;
const HISTORY_MAX = 10;

export type LinkMethod = 'WifiDirect' | 'LocalOnlyHotspot';

export interface HistoryEntry {
  method: LinkMethod;
  /** create = 親機が作れたか / join = 子機が参加できたか */
  stage: 'create' | 'join';
  ok: boolean;
  at: number;
  /** 失敗の分類(固定語のみ。メッセージ本文やパスフレーズは入れない) */
  code?: string;
}

export type CapKv = { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> };

const readJson = async <T>(kv: CapKv, key: string, fallback: T): Promise<T> => {
  try {
    const s = await kv.get(key);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const buildKeyOf = (n: Pick<NativeCapabilities, 'model' | 'sdk'>) => `${n.model ?? '?'}|${n.sdk ?? '?'}`;

export async function loadProbe(kv: CapKv, buildKey: string): Promise<ProbeStore | null> {
  const p = await readJson<ProbeStore | null>(kv, PROBE_KEY, null);
  return p && p.buildKey === buildKey ? p : null;
}

export async function saveProbe(kv: CapKv, p: ProbeStore): Promise<void> {
  await kv.set(PROBE_KEY, JSON.stringify(p));
}

export async function loadHistory(kv: CapKv, peerId: string): Promise<HistoryEntry[]> {
  const all = await readJson<Record<string, HistoryEntry[]>>(kv, HISTORY_KEY, {});
  return Array.isArray(all[peerId]) ? all[peerId] : [];
}

export async function appendHistory(kv: CapKv, peerId: string, e: HistoryEntry): Promise<void> {
  const all = await readJson<Record<string, HistoryEntry[]>>(kv, HISTORY_KEY, {});
  const list = [...(all[peerId] ?? []), e].slice(-HISTORY_MAX);
  all[peerId] = list;
  await kv.set(HISTORY_KEY, JSON.stringify(all));
}

export interface CapCacheEntry {
  v: number;
  rev: string;
  at: number;
  caps: Capabilities;
}

export async function loadCapCache(kv: CapKv, peerId: string, now: number): Promise<CapCacheEntry | null> {
  const all = await readJson<Record<string, CapCacheEntry>>(kv, CAPCACHE_KEY, {});
  const e = all[peerId];
  if (!e || typeof e.rev !== 'string' || !e.caps) return null;
  // 版が変わったら無効。古すぎるものも無効
  if (e.v !== PROTOCOL_VERSION || e.caps.v !== PROTOCOL_VERSION) return null;
  if (now - e.at > CAPCACHE_TTL_MS) return null;
  return e;
}

export async function saveCapCache(kv: CapKv, peerId: string, e: CapCacheEntry): Promise<void> {
  const all = await readJson<Record<string, CapCacheEntry>>(kv, CAPCACHE_KEY, {});
  all[peerId] = e;
  await kv.set(CAPCACHE_KEY, JSON.stringify(all));
}

export async function removePeerData(kv: CapKv, peerId: string): Promise<void> {
  for (const key of [HISTORY_KEY, CAPCACHE_KEY]) {
    const all = await readJson<Record<string, unknown>>(kv, key, {});
    if (peerId in all) {
      delete all[peerId];
      await kv.set(key, JSON.stringify(all));
    }
  }
}

// ---- 組み立て ----

const UNKNOWN_NATIVE: NativeCapabilities = {
  manufacturer: null, model: null, sdk: null, release: null, batteryPercent: null,
  batteryOptimizationExempt: null, wifiDirect: null, staApConcurrent: null, staLocalOnlyConcurrent: null,
  band24: null, band5: null, vpnConsent: null, deviceOwner: null, missingPermissions: null,
};

export interface BuildInput {
  native: NativeCapabilities | null;
  cellular: Tri;
  probe: ProbeStore | null;
  now: number;
}

/** ネイティブの値 + 端末内の試験・観測結果 → Capabilities。試した結果は、公式 API の値より優先する */
export function buildCapabilities(i: BuildInput): Capabilities {
  const n = { ...UNKNOWN_NATIVE, ...(i.native ?? {}) };
  const source: Capabilities['source'] = {};
  const radio: Capabilities['radio'] = {
    wifiDirect: n.wifiDirect, lohs: null, staP2pConcurrent: null, staApConcurrent: n.staApConcurrent,
    p2pApCoexist: null, staLocalOnlyConcurrent: n.staLocalOnlyConcurrent, band24: n.band24, band5: n.band5,
  };
  for (const k of ['wifiDirect', 'staApConcurrent', 'staLocalOnlyConcurrent', 'band24', 'band5'] as const) {
    if (radio[k] !== null) source[k] = 'api';
  }
  if (i.probe?.lohs) {
    // busy / permission は「試せなかった」だけなので結論にしない
    const r = i.probe.lohs;
    if (r.ok || !['busy', 'permission', 'timeout', 'error'].includes(r.reason ?? '')) {
      radio.lohs = r.ok;
      source.lohs = 'probe';
    }
  }
  for (const k of ['staP2pConcurrent', 'p2pApCoexist'] as const) {
    const v = i.probe?.observed[k];
    if (typeof v === 'boolean') {
      radio[k] = v;
      source[k] = 'observed';
    }
  }
  return {
    v: PROTOCOL_VERSION,
    features: [...FEATURES],
    device: {
      manufacturer: n.manufacturer, model: n.model, sdk: n.sdk, release: n.release,
      batteryPercent: n.batteryPercent, batteryOptimizationExempt: n.batteryOptimizationExempt,
    },
    network: { cellular: i.cellular },
    radio,
    state: { vpnConsent: n.vpnConsent, deviceOwner: n.deviceOwner, alwaysOnVpn: null, missingPermissions: n.missingPermissions },
    source,
    collectedAt: i.now,
  };
}

/** 内容の版(変わったかの判定用)。電池残量・取得時刻のような常に変わる値は含めない。暗号用途ではない */
export function capsRevision(c: Capabilities): string {
  const stable = JSON.stringify([
    c.v, c.features, c.device.manufacturer, c.device.model, c.device.sdk, c.device.release,
    c.device.batteryOptimizationExempt, c.network, c.radio, c.state,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const tri = (x: unknown): Tri => (typeof x === 'boolean' ? x : null);
const str = (x: unknown, max = 64): string | null => (typeof x === 'string' ? x.slice(0, max) : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** 受信した能力を検証して整える。知らない項目は捨て、型が違うものは不明にする。オブジェクトでなければ null */
export function sanitizeCapabilities(x: unknown): Capabilities | null {
  const o = x as any;
  if (!o || typeof o !== 'object' || typeof o.v !== 'number') return null;
  const radioKeys: RadioKey[] = ['wifiDirect', 'lohs', 'staP2pConcurrent', 'staApConcurrent', 'p2pApCoexist', 'staLocalOnlyConcurrent', 'band24', 'band5'];
  const radio = {} as Capabilities['radio'];
  const source: Capabilities['source'] = {};
  for (const k of radioKeys) {
    radio[k] = tri(o.radio?.[k]);
    const s = o.source?.[k];
    if (s === 'api' || s === 'probe' || s === 'observed') source[k] = s;
  }
  const mp = o.state?.missingPermissions;
  return {
    v: o.v,
    features: Array.isArray(o.features) ? o.features.filter((f: unknown) => typeof f === 'string').slice(0, 16) : [],
    device: {
      manufacturer: str(o.device?.manufacturer), model: str(o.device?.model), sdk: num(o.device?.sdk),
      release: str(o.device?.release, 16), batteryPercent: num(o.device?.batteryPercent),
      batteryOptimizationExempt: tri(o.device?.batteryOptimizationExempt),
    },
    network: { cellular: tri(o.network?.cellular) },
    radio,
    state: {
      vpnConsent: tri(o.state?.vpnConsent), deviceOwner: tri(o.state?.deviceOwner), alwaysOnVpn: tri(o.state?.alwaysOnVpn),
      missingPermissions: Array.isArray(mp) ? mp.filter((p: unknown) => typeof p === 'string').slice(0, 16).map((p: string) => p.slice(0, 64)) : null,
    },
    source,
    collectedAt: num(o.collectedAt) ?? 0,
  };
}

/** 「実機確認手順」用: 人が読める 1 ブロックの文字列(機種名・能力のみ) */
export function describeCapabilities(c: Capabilities): string {
  const t = (v: Tri) => (v === null ? '不明' : v ? 'はい' : 'いいえ');
  const src = (k: RadioKey) => (c.source[k] ? `(${c.source[k]})` : '');
  const r = c.radio;
  return [
    `機種: ${c.device.manufacturer ?? '?'} ${c.device.model ?? '?'} / Android ${c.device.release ?? '?'} (API ${c.device.sdk ?? '?'})`,
    `電池: ${c.device.batteryPercent ?? '不明'}% / 省電力除外: ${t(c.device.batteryOptimizationExempt)}`,
    `セルラー: ${t(c.network.cellular)}`,
    `Wi-Fi Direct: ${t(r.wifiDirect)}${src('wifiDirect')} / LOHS: ${t(r.lohs)}${src('lohs')}`,
    `STA+P2P: ${t(r.staP2pConcurrent)}${src('staP2pConcurrent')} / STA+AP: ${t(r.staApConcurrent)}${src('staApConcurrent')} / P2P+AP: ${t(r.p2pApCoexist)}${src('p2pApCoexist')}`,
    `子機のローカル専用 STA 同時: ${t(r.staLocalOnlyConcurrent)}${src('staLocalOnlyConcurrent')}`,
    `2.4GHz: ${t(r.band24)}${src('band24')} / 5GHz: ${t(r.band5)}${src('band5')}`,
    `VPN 同意: ${t(c.state.vpnConsent)} / Device Owner: ${t(c.state.deviceOwner)} / 常時 VPN: ${t(c.state.alwaysOnVpn)}`,
    `不足権限: ${c.state.missingPermissions === null ? '不明' : c.state.missingPermissions.join(',') || 'なし'}`,
    `プロトコル v${c.v} / 機能: ${c.features.join(',') || 'なし'}`,
  ].join('\n');
}
