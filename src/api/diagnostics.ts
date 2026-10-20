import { Capabilities, ProbeStore } from './capability';

/**
 * 診断レポート: 端末から取れるものを網羅的に採取したもの(開発・機種比較用)。
 * - 方式判断(Planner)が使う能力(`Capabilities`)とは別物。Planner は必要な項目だけを参照する。
 * - ハンドシェイクで相手へ送るのは `Capabilities` のみ。診断レポート全体は端末内に置き、利用者が明示的に書き出したときだけ外へ出す。
 * - 個人を特定できる値(IMEI・電話番号・SSID・MAC・アカウント・端末名・位置・シリアル)は採取しない。
 *   万一それらしい文字列が入っていたら `redactItem` が落とす(二重の防御)。
 */

export const DIAG_SCHEMA = 1;

export type DiagSource = 'api' | 'probe' | 'observed';

export interface DiagItem {
  /** 値。取れなかった項目は null(推測しない) */
  v: unknown;
  /** その API が追加された Android API レベル(SDK の api-versions.xml による)。null = 版に依存しない */
  minApi: number | null;
  source: DiagSource;
  /** v が null の理由: `sdk<N` / `ex:クラス名` / `unavailable` / `redacted` */
  why?: string;
  /** false = 公式 SDK に載っていない取り方(非公開の設定キー・リソース名) */
  official?: false;
}

export interface DiagnosticReport {
  schema: number;
  createdAt: number;
  /** 機種比較用のキー(メーカー・機種・API レベル) */
  deviceKey: string;
  /** Planner が使う能力(ハンドシェイクで送るのはこれだけ) */
  capabilities: Capabilities;
  sections: Record<string, Record<string, DiagItem>>;
}

/** ネイティブ(modules/hotspot の diagnostics())が返す形 */
export interface NativeDiagnostics {
  schema?: number;
  sections?: Record<string, Record<string, unknown>>;
}

// ---- 個人を特定できそうな値の除去 ----
const PII_PATTERNS: RegExp[] = [
  /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i, // MAC アドレス
  /\b\d{15}\b/, // IMEI 相当
  /\+\d[\d -]{7,}\d/, // 国際形式の電話番号
  /\b0\d{1,4}-\d{1,4}-\d{3,4}\b/, // 国内の電話番号
  /[^\s@]+@[^\s@]+\.[^\s@]+/, // メールアドレス(アカウント)
];

export const looksPersonal = (s: string): boolean => PII_PATTERNS.some((re) => re.test(s));

const scrub = (x: unknown): { value: unknown; hit: boolean } => {
  if (typeof x === 'string') return looksPersonal(x) ? { value: null, hit: true } : { value: x, hit: false };
  if (Array.isArray(x)) {
    let hit = false;
    const out = x.map((e) => {
      const r = scrub(e);
      hit ||= r.hit;
      return r.value;
    });
    return { value: out, hit };
  }
  if (x && typeof x === 'object') {
    let hit = false;
    const out: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(x)) {
      const r = scrub(e);
      hit ||= r.hit;
      out[k] = r.value;
    }
    return { value: out, hit };
  }
  return { value: x ?? null, hit: false };
};

/** 1 項目を整える。個人らしい値が入っていれば、その項目ごと null にする */
export function redactItem(raw: unknown, source: DiagSource = 'api'): DiagItem {
  const o = raw as any;
  const isItem = o && typeof o === 'object' && !Array.isArray(o) && 'v' in o;
  const v = isItem ? o.v : raw;
  const r = scrub(v);
  const item: DiagItem = {
    v: r.hit ? null : r.value,
    minApi: isItem && typeof o.minApi === 'number' ? o.minApi : null,
    source,
  };
  if (r.hit) item.why = 'redacted';
  else if (isItem && typeof o.why === 'string') item.why = o.why.slice(0, 40);
  if (isItem && o.official === false) item.official = false;
  return item;
}

const slug = (s: unknown) => String(s ?? 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'unknown';

export interface BuildReportInput {
  native: NativeDiagnostics | null;
  capabilities: Capabilities;
  probe: ProbeStore | null;
  now: number;
}

export function buildDiagnosticReport(i: BuildReportInput): DiagnosticReport {
  const sections: DiagnosticReport['sections'] = {};
  for (const [sec, items] of Object.entries(i.native?.sections ?? {})) {
    if (!items || typeof items !== 'object') continue;
    sections[sec] = {};
    for (const [k, raw] of Object.entries(items)) sections[sec][k] = redactItem(raw, 'api');
  }
  // 実際に試した結果・運用で観測した結果(端末内に保存されたもの)
  const probe: Record<string, DiagItem> = {};
  if (i.probe?.lohs) {
    probe.lohsCreated = { v: i.probe.lohs.ok, minApi: 26, source: 'probe' };
    probe.lohsReason = { v: i.probe.lohs.reason ?? null, minApi: null, source: 'probe' };
    probe.lohsAt = { v: i.probe.lohs.at, minApi: null, source: 'probe' };
  } else {
    probe.lohsCreated = { v: null, minApi: 26, source: 'probe', why: 'not-probed' };
  }
  for (const k of ['staP2pConcurrent', 'p2pApCoexist'] as const) {
    const v = i.probe?.observed[k];
    probe[k] = typeof v === 'boolean' ? { v, minApi: null, source: 'observed' } : { v: null, minApi: null, source: 'observed', why: 'not-observed' };
  }
  sections.probe = probe;
  const b = sections.build ?? {};
  const deviceKey = `${slug(b.manufacturer?.v ?? i.capabilities.device.manufacturer)}-${slug(b.model?.v ?? i.capabilities.device.model)}-api${b.sdkInt?.v ?? i.capabilities.device.sdk ?? 'x'}`;
  return { schema: DIAG_SCHEMA, createdAt: i.now, deviceKey, capabilities: i.capabilities, sections };
}

export const reportFileName = (r: DiagnosticReport) => `tether-diag-${r.deviceKey}.json`;
export const reportToJson = (r: DiagnosticReport) => JSON.stringify(r, null, 2);

const show = (v: unknown): string => {
  if (v === null || v === undefined) return '不明';
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  if (Array.isArray(v)) return v.length === 0 ? '(なし)' : v.length > 12 ? `${v.length}件: ${v.slice(0, 12).map(show).join(', ')} …` : v.map(show).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** 人が読める要約(セクションごとに 1 項目 1 行。不明は理由つき) */
export function summarizeReport(r: DiagnosticReport): string {
  const lines = [`診断レポート ${r.deviceKey}(schema ${r.schema}、${new Date(r.createdAt).toISOString()})`];
  for (const [sec, items] of Object.entries(r.sections)) {
    lines.push(`[${sec}]`);
    for (const [k, it] of Object.entries(items)) {
      const val = it.v === null ? `不明${it.why ? `(${it.why})` : ''}` : show(it.v);
      lines.push(`  ${k}: ${val}${it.official === false ? ' *非公式' : ''}`);
    }
  }
  return lines.join('\n');
}

export interface ComparisonRow {
  path: string;
  /** deviceKey → 表示用の値 */
  values: Record<string, string>;
  differs: boolean;
}

/** 複数機種のレポートを項目ごとに突き合わせる(機種比較用) */
export function compareReports(reports: DiagnosticReport[]): ComparisonRow[] {
  const paths = new Set<string>();
  for (const r of reports) for (const [sec, items] of Object.entries(r.sections)) for (const k of Object.keys(items)) paths.add(`${sec}.${k}`);
  const rows: ComparisonRow[] = [];
  for (const path of [...paths].sort()) {
    const [sec, ...rest] = path.split('.');
    const key = rest.join('.');
    const values: Record<string, string> = {};
    for (const r of reports) {
      const it = r.sections[sec]?.[key];
      values[r.deviceKey] = it ? (it.v === null ? `不明${it.why ? `(${it.why})` : ''}` : show(it.v)) : '(項目なし)';
    }
    rows.push({ path, values, differs: new Set(Object.values(values)).size > 1 });
  }
  return rows;
}

/** Markdown の比較表(差のある行だけにも絞れる) */
export function comparisonMarkdown(reports: DiagnosticReport[], onlyDiffs = false): string {
  const keys = reports.map((r) => r.deviceKey);
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = `| 項目 | ${keys.join(' | ')} |\n|---|${keys.map(() => '---').join('|')}|`;
  const body = compareReports(reports)
    .filter((row) => !onlyDiffs || row.differs)
    .map((row) => `| ${row.path} | ${keys.map((k) => esc(row.values[k])).join(' | ')} |`);
  return [head, ...body].join('\n');
}
