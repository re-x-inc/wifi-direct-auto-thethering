/**
 * インターネット到達の外形監視 — 状態機械と公開の口(docs/EXTERNAL_PROBE.md)。
 *
 * tether は probe の実装を抱え込まない。外から「実際に通信できたか」を受け取る **2 つの口**だけを持つ:
 *   - enable(on, opts)               監視の有効/無効と設定(間隔・閾値など)
 *   - update(success, at?, reason?)  1 回の結果(probe でも、VPN 越しの実通信の観測でもよい)
 * このクラスは、結果から state.internet(ok | ng | unknown)を導き、成功のたびに生存信号(noteAlive)を出し、
 * 子機は親機へ報告(tether.internet。バス専用)を作り、親機は受けた報告で延命・表示する。
 * 時間は now を注入する(I5)。タイマーは持たない(tick は呼び出し側から)。
 */

export type InternetStateName = 'ok' | 'ng' | 'unknown';

export const INTERNET_REASONS = ['link', 'auth', 'dns', 'connect', 'upstream', 'timeout', 'portal', 'http', 'tls'] as const;
export type InternetReason = (typeof INTERNET_REASONS)[number];

/** 公開する状態(画面・linkSnapshot 用)。overall とは別の軸 */
export interface InternetStatus {
  state: InternetStateName;
  /** この状態に入った時刻 */
  since: number;
  /** 最後に成功した時刻(生存信号に渡したもの)。無ければ null */
  lastOkAt: number | null;
  lastAttemptAt: number | null;
  consecutiveFailures: number;
  /** 直近の失敗の分類。ok のときは null */
  reason: InternetReason | null;
}

export interface InternetConfig {
  /** 監視をするか。既定 false(実機で確かめてから既定を変える) */
  enabled: boolean;
  /** 通常の間隔(ms)。probe 供給元の実行間隔、報告の定期更新、結果が途絶えた判定に使う */
  intervalMs: number;
  /** 画面オフ中の間隔(ms)。intervalMs 以上 */
  screenOffIntervalMs: number;
  /** 失敗の直後に確かめ直す間隔(ms)。intervalMs 以下 */
  confirmIntervalMs: number;
  /** 1 宛先の合計待ち(ms) */
  timeoutMs: number;
  /** 連続失敗がこの回数で ng */
  failThreshold: number;
  /** ng から ok に戻すのに必要な連続成功の回数 */
  recoverThreshold: number;
  /** 宛先(平文 HTTP の generate_204)。運営の異なる 1〜3 件。どれか 1 つが 204 なら成功 */
  urls: string[];
}

export const INTERNET_URLS_DEFAULT = ['http://connectivitycheck.gstatic.com/generate_204', 'http://cp.cloudflare.com/generate_204'];

export const INTERNET_DEFAULTS: InternetConfig = {
  enabled: false,
  intervalMs: 60_000,
  screenOffIntervalMs: 120_000,
  confirmIntervalMs: 10_000,
  timeoutMs: 5_000,
  failThreshold: 3,
  recoverThreshold: 2,
  urls: [...INTERNET_URLS_DEFAULT],
};

type NumKey = Exclude<keyof InternetConfig, 'enabled' | 'urls'>;
export const INTERNET_RANGES: Record<NumKey, [number, number]> = {
  intervalMs: [15_000, 600_000],
  screenOffIntervalMs: [15_000, 600_000],
  confirmIntervalMs: [3_000, 600_000],
  timeoutMs: [1_000, 15_000],
  failThreshold: [1, 10],
  recoverThreshold: [1, 10],
};

const URL_RE = /^http:\/\/[A-Za-z0-9]([A-Za-z0-9.-]{0,120}[A-Za-z0-9])?(:\d{1,5})?(\/[\x21-\x7e]{0,150})?$/;
/** 宛先として使える URL か(平文 HTTP のみ。長さ・文字を制限し、ヘッダー注入を防ぐ) */
export const isProbeUrl = (u: unknown): u is string => typeof u === 'string' && u.length <= 200 && URL_RE.test(u);

export interface ResolveInternetOptions {
  /** true: 範囲チェックを省く(テスト用に短い時間を使う) */
  unchecked?: boolean;
  log?: (line: string) => void;
}

/** 設定を検証して使う値を決める。範囲外・不正は既定に丸めてログ(timingConfig と同じ流儀) */
export function resolveInternetConfig(input: Partial<InternetConfig> = {}, o: ResolveInternetOptions = {}): InternetConfig {
  const log = o.log ?? (() => {});
  const out: InternetConfig = { ...INTERNET_DEFAULTS, urls: [...INTERNET_DEFAULTS.urls] };
  if (input.enabled !== undefined) out.enabled = input.enabled === true;
  const num = (k: NumKey, fallback: number, lo?: number, hi?: number): number => {
    const v = input[k];
    if (v === undefined) return fallback;
    const [rl, rh] = INTERNET_RANGES[k];
    const min = lo ?? (o.unchecked ? 0 : rl), max = hi ?? (o.unchecked ? Infinity : rh);
    if (typeof v !== 'number' || !Number.isFinite(v) || (!o.unchecked && (v < rl || v > rh))) {
      log(`internet.${k}=${String(v)} は範囲外/不正(${rl}〜${rh}) → ${fallback} にする`);
      return fallback;
    }
    if (v < min || v > max) { log(`internet.${k}=${v} は ${min}〜${max} に収める`); return Math.min(max, Math.max(min, v)); }
    return v;
  };
  out.intervalMs = num('intervalMs', INTERNET_DEFAULTS.intervalMs);
  out.screenOffIntervalMs = num('screenOffIntervalMs', Math.max(out.intervalMs, INTERNET_DEFAULTS.screenOffIntervalMs), out.intervalMs, INTERNET_RANGES.screenOffIntervalMs[1]);
  out.confirmIntervalMs = num('confirmIntervalMs', Math.min(out.intervalMs, INTERNET_DEFAULTS.confirmIntervalMs), o.unchecked ? 0 : INTERNET_RANGES.confirmIntervalMs[0], out.intervalMs);
  out.timeoutMs = num('timeoutMs', INTERNET_DEFAULTS.timeoutMs);
  out.failThreshold = Math.round(num('failThreshold', INTERNET_DEFAULTS.failThreshold));
  out.recoverThreshold = Math.round(num('recoverThreshold', INTERNET_DEFAULTS.recoverThreshold));
  const u = input.urls;
  if (u !== undefined) {
    const ok = Array.isArray(u) && u.length >= 1 && u.length <= 3 && u.every(isProbeUrl);
    if (ok) out.urls = [...u];
    else log(`internet.urls=${JSON.stringify(u)} は不正(平文 http の 1〜3 件) → 既定にする`);
  }
  return out;
}

// ---------- 状態遷移(純関数。docs/EXTERNAL_PROBE.md §6 の表) ----------

export interface InternetCore {
  status: InternetStatus;
  /** 連続成功の回数(ng からの復帰判定) */
  successes: number;
}

export const initialInternet = (now: number): InternetCore => ({
  status: { state: 'unknown', since: now, lastOkAt: null, lastAttemptAt: null, consecutiveFailures: 0, reason: null },
  successes: 0,
});

export interface InternetResult {
  success: boolean;
  at: number;
  reason: InternetReason | null;
}

const enter = (c: InternetCore, state: InternetStateName, now: number): InternetStatus => (c.status.state === state ? c.status : { ...c.status, state, since: now });

/**
 * 1 回の結果を状態に反映する。
 *  - unknown + 成功 → ok(初回は即)。失敗は数えるだけで、failThreshold で ng
 *  - ok + 失敗 → 数える(表示は変えない)。failThreshold で ng
 *  - ng + 成功 → recoverThreshold 回の連続成功で ok(成功ごとの延命は呼び出し側が行う)
 *  - 失敗の reason が link(親機の中継に届かない = Direct 側の問題)は失敗に数えず unknown に戻す
 */
export function reduceInternet(c: InternetCore, r: InternetResult, cfg: Pick<InternetConfig, 'failThreshold' | 'recoverThreshold'>, now: number): InternetCore {
  const base = { ...c.status, lastAttemptAt: Math.max(c.status.lastAttemptAt ?? 0, r.at) };
  if (r.success) {
    const successes = c.successes + 1;
    const lastOkAt = Math.max(c.status.lastOkAt ?? 0, r.at);
    const toOk = c.status.state !== 'ng' || successes >= cfg.recoverThreshold;
    const st = toOk ? enter({ ...c, status: base }, 'ok', now) : base;
    return { status: { ...st, lastOkAt, consecutiveFailures: 0, reason: toOk ? null : st.reason }, successes };
  }
  if (r.reason === 'link') {
    return { status: { ...enter({ ...c, status: base }, 'unknown', now), consecutiveFailures: 0, reason: 'link' }, successes: 0 };
  }
  const fails = c.status.consecutiveFailures + 1;
  const toNg = fails >= cfg.failThreshold;
  return { status: { ...(toNg ? enter({ ...c, status: base }, 'ng', now) : base), consecutiveFailures: fails, reason: r.reason }, successes: 0 };
}

// ---------- 親機への報告(tether.internet。バス専用) ----------

export interface InternetReport {
  kind: 'tether.internet';
  v: 1;
  state: InternetStateName;
  okAt: number | null;
  at: number;
  seq: number;
  fails: number;
  reason: InternetReason | null;
  since: number;
}

/** 親機が持つ「子機の報告」。時刻のうち receivedAt だけが親機の時計(判定に使う)。ほかは子機の時計で、表示の補助 */
export interface RemoteInternet {
  state: InternetStateName;
  since: number;
  okAt: number | null;
  fails: number;
  reason: InternetReason | null;
  seq: number;
  receivedAt: number;
}

const isState = (x: unknown): x is InternetStateName => x === 'ok' || x === 'ng' || x === 'unknown';
export const parseReason = (x: unknown): InternetReason | null => ((INTERNET_REASONS as readonly unknown[]).includes(x) ? (x as InternetReason) : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** 受信した報告の形を検証する。不正は null(捨てる) */
export function parseReport(x: unknown): InternetReport | null {
  const r = x as Record<string, unknown> | null;
  if (!r || r.kind !== 'tether.internet' || r.v !== 1 || !isState(r.state)) return null;
  const seq = num(r.seq), at = num(r.at), since = num(r.since), fails = num(r.fails);
  if (seq === null || at === null || since === null || fails === null || fails < 0) return null;
  const okAt = r.okAt === null || r.okAt === undefined ? null : num(r.okAt);
  if (r.okAt !== null && r.okAt !== undefined && okAt === null) return null;
  return { kind: 'tether.internet', v: 1, state: r.state, okAt, at, seq, fails: Math.floor(fails), reason: parseReason(r.reason), since };
}

// ---------- 監視本体 ----------

export interface MonitorPorts {
  now(): number;
  log(line: string): void;
  role(): 'host' | 'guest' | null;
  /** バス(Direct 上)が認証済みか。報告はバスが張れている間だけ送る(溜めない) */
  busUp(): boolean;
  /** 生存信号を渡す(成功のたび)。上限などで拒否されたら false */
  noteAlive(at: number): boolean;
  /** 報告をバスで送る(アプリメッセージ扱い。Nearby には載せない) */
  sendReport(r: InternetReport): void;
  /** 公開する状態が変わった */
  changed(): void;
}

export class InternetMonitor {
  private cfg: InternetConfig = resolveInternetConfig();
  /** 設定の層: 起動時(cfg + 保存) < enable() で渡された値 < 親機から配られた値(子機) */
  private baseIn: Partial<InternetConfig> = {};
  private runtimeIn: Partial<InternetConfig> = {};
  private hostIn: Partial<InternetConfig> | null = null;
  private resolveOpts: ResolveInternetOptions = {};
  private enabledFlag = false;
  private active = false;
  private core: InternetCore;
  private remote: RemoteInternet | null = null;
  // 報告(子機)
  private seq: number;
  private rep: { state: InternetStateName | null; okAt: number | null; at: number } = { state: null, okAt: null, at: 0 };

  constructor(private p: MonitorPorts) {
    this.core = initialInternet(p.now());
    this.seq = p.now(); // 再起動しても親機の重複判定(seq が増えること)を満たすため、時刻から始める
  }

  get config(): InternetConfig { return { ...this.cfg, urls: [...this.cfg.urls] }; }
  get enabled(): boolean { return this.enabledFlag; }
  get status(): InternetStatus { return { ...this.core.status }; }
  get remoteStatus(): RemoteInternet | null { return this.remote ? { ...this.remote } : null; }

  /** 起動のたび: 設定の層を決め直し、状態を初期化する(enable() で渡した値は残す) */
  configure(base: Partial<InternetConfig>, o: ResolveInternetOptions = {}): void {
    this.baseIn = { ...base };
    this.resolveOpts = o;
    this.hostIn = null;
    this.recompute();
    this.reset('start');
    this.remote = null;
  }

  /** 公開の口 1: 有効/無効と設定。opts は部分指定でよい(範囲外は既定に丸めてログ)。enable(false) の間は unknown */
  enable(on: boolean, opts: Partial<Omit<InternetConfig, 'enabled'>> = {}): void {
    this.runtimeIn = { ...this.runtimeIn, ...opts, enabled: on };
    this.recompute();
    this.p.log(`internet.enable(${on}) ${JSON.stringify(this.cfg)}`);
    if (!this.enabledFlag) this.reset('disabled');
    else this.p.changed();
  }

  /**
   * 子機: 親機から配られた設定(tether.timing の probe セクション)を採用する。
   * 間隔・閾値・宛先・待ち時間は親機が正。enabled は親機が true のときだけ子機に反映する(親機が false でも子機の enable(true) は残る)
   */
  adoptHost(raw: Record<string, unknown>): void {
    this.hostIn = { ...(raw as Partial<InternetConfig>) };
    this.recompute();
    this.p.log(`internet 親機の設定を採用 ${JSON.stringify(this.cfg)}`);
    if (!this.enabledFlag) this.reset('disabled');
    else this.p.changed();
  }

  private recompute(): void {
    const layered: Partial<InternetConfig> = { ...this.baseIn, ...this.runtimeIn };
    let enabled = layered.enabled === true;
    if (this.hostIn) {
      const { enabled: he, ...rest } = this.hostIn;
      Object.assign(layered, rest);
      if (he === true) enabled = true;
    }
    layered.enabled = enabled;
    this.cfg = resolveInternetConfig(layered, { ...this.resolveOpts, log: (l) => this.p.log(l) });
    this.enabledFlag = this.cfg.enabled;
  }

  /** 監視してよい状況か(子機: 参加済みで再接続中でない)。false になると unknown に戻す */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (!on) this.reset('inactive');
  }

  get isActive(): boolean { return this.enabledFlag && this.active; }

  /** 状態を unknown に戻して失敗数をクリア。報告の履歴も消す */
  reset(why: string): void {
    const now = this.p.now();
    const was = this.core.status;
    this.core = initialInternet(now);
    this.rep = { state: null, okAt: null, at: 0 };
    if (was.state !== 'unknown' || was.consecutiveFailures > 0 || was.lastOkAt !== null) {
      this.p.log(`internet ${was.state} → unknown (${why})`);
      this.p.changed();
    }
  }

  /**
   * 公開の口 2: 1 回の結果。success = 実際に通信できたか。at = その時刻(省略は現在、未来は現在に丸める)。reason = 失敗の分類(任意)。
   * 受け付けたら true。無効・非活動・古い結果は無視(false)。成功のたびに生存信号を渡す。
   */
  update(success: boolean, at?: number, reason?: string): boolean {
    const now = this.p.now();
    if (!this.enabledFlag || !this.active) { this.p.log(`internet.update(${success}) を無視(${!this.enabledFlag ? '無効' : '接続していない'})`); return false; }
    const t = typeof at === 'number' && Number.isFinite(at) ? Math.min(at, now) : now;
    if (t < (this.core.status.lastAttemptAt ?? 0)) return false;
    const r = parseReason(reason);
    const prev = this.core.status;
    this.core = reduceInternet(this.core, { success, at: t, reason: success ? null : r }, this.cfg, now);
    const st = this.core.status;
    if (success) this.p.noteAlive(t);
    if (st.state !== prev.state) this.p.log(`internet ${prev.state} → ${st.state}${st.reason ? ` reason=${st.reason}` : ''} (連続失敗 ${st.consecutiveFailures})`);
    else if (!success && st.consecutiveFailures !== prev.consecutiveFailures) this.p.log(`internet 失敗 ${st.consecutiveFailures}/${this.cfg.failThreshold}${st.reason ? ` reason=${st.reason}` : ''}`);
    this.maybeReport();
    this.p.changed();
    return true;
  }

  /** 周期の処理(Tether の tick から)。結果の途絶、報告の定期更新、親機の受信の鮮度 */
  tick(): void {
    const now = this.p.now();
    if (this.p.role() === 'host') {
      if (this.remote && this.remote.state !== 'unknown' && now - this.remote.receivedAt >= this.cfg.intervalMs * 3) {
        this.p.log(`internet 子機の報告が ${this.cfg.intervalMs * 3}ms 途絶 → 確認中に戻す`);
        this.remote = { ...this.remote, state: 'unknown' };
        this.p.changed();
      }
      return;
    }
    if (!this.isActive) return;
    const s = this.core.status;
    const stale = Math.max(this.cfg.intervalMs, this.cfg.screenOffIntervalMs) * (this.cfg.failThreshold + 1);
    if (s.state !== 'unknown' && s.lastAttemptAt !== null && now - s.lastAttemptAt > stale) {
      this.reset('結果が途絶(供給元が動けていない)');
      return;
    }
    this.maybeReport();
  }

  /** 運び先(バス)が切れた: 親機は古い ok を信じない */
  onBusDown(): void {
    this.rep = { state: null, okAt: null, at: 0 };
    if (this.remote && this.remote.state !== 'unknown') {
      this.remote = { ...this.remote, state: 'unknown' };
      this.p.changed();
    }
  }

  // ---- 子機: 報告 ----
  /** 状態が変わった / ok の成功が進んだ / 前回の報告から intervalMs 経った、のとき送る(バスが張れている間だけ。溜めない) */
  private maybeReport(): void {
    if (this.p.role() !== 'guest' || !this.isActive || !this.p.busUp()) return;
    const now = this.p.now();
    const s = this.core.status;
    const due =
      this.rep.state !== s.state ||
      (s.state === 'ok' && (s.lastOkAt ?? 0) > (this.rep.okAt ?? 0)) ||
      now - this.rep.at >= this.cfg.intervalMs;
    if (!due) return;
    this.rep = { state: s.state, okAt: s.lastOkAt, at: now };
    this.p.sendReport({ kind: 'tether.internet', v: 1, state: s.state, okAt: s.lastOkAt, at: now, seq: ++this.seq, fails: s.consecutiveFailures, reason: s.reason, since: s.since });
  }

  // ---- 親機: 受信 ----
  /**
   * 子機の報告を受ける(バスから届いたものだけ)。無効・古い seq・不正は捨てる(false)。
   * ok なら受信時刻で生存信号を渡す(報告の okAt は子機の時計なので判定に使わない)。ng / unknown は延命しない
   */
  receive(raw: unknown): boolean {
    if (this.p.role() !== 'host' || !this.enabledFlag) return false;
    const r = parseReport(raw);
    if (!r) { this.p.log('internet 報告の形が不正 → 捨てる'); return false; }
    if (this.remote && r.seq <= this.remote.seq) return false;
    const now = this.p.now();
    this.remote = { state: r.state, since: r.since, okAt: r.okAt, fails: r.fails, reason: r.reason, seq: r.seq, receivedAt: now };
    if (r.state === 'ok') this.p.noteAlive(now);
    this.p.log(`internet 子機の報告 ${r.state}${r.reason ? ` reason=${r.reason}` : ''} fails=${r.fails}`);
    this.p.changed();
    return true;
  }

  /** deriveOverall に渡す: 確かな ng か(子機は自分の状態、親機は鮮度のある子機の報告) */
  isNg(role: 'host' | 'guest' | null): boolean {
    if (!this.enabledFlag) return false;
    if (role === 'guest') return this.isActive && this.core.status.state === 'ng';
    if (role === 'host') return this.remote?.state === 'ng';
    return false;
  }
}
