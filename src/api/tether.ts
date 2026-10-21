import { createLink } from '../link/session';
import { directCreds, removeDirectCreds } from '../pairing/directCreds';
import type { LinkSupervisor } from '../link/supervisor';
import { BusLinkState, DataPath, deriveOverall, initialDataPath, NearbyPhase, Overall } from '../link/dataPath';
import type { DirectRetry } from '../link/directGuard';
import { GuardAction, GuardEvent, nearbyShouldBeOff } from '../link/directGuard';
import { LinkStateInfo } from '../link/stateLabels';
import { LinkTimingConfig, pickShared, resolveTiming, toGuardTiming, toRetry } from '../link/timingConfig';
import { LinkContext, LinkGovernor, LinkSnapshot } from '../link/linkGovernor';
import { NearbyControl } from '../link/transport';
import { BusControl, NO_BUS_PORT, BusEvent } from '../link/busControl';
import { kindOf } from '../link/channel';
import { InternetConfig, InternetMonitor } from '../link/internetMonitor';
import { NativeProbeRunner } from './internetProbe';
import { Carrier, RoutedControl, SendReport } from '../link/controlRouter';
import type { NearbyApi } from '../link/nearbyTransport';
import { formatResumeEta, isResumeWaitingName, shouldLogResumeEta } from '../link/resumeEta';
import { Confirm, Found, PairingResult, PairingSession } from '../pairing/pairing';
import { clearDirectCreds } from '../pairing/forget';
import { getIdentity, PairStore } from '../pairing/store';
import type { Identity, Pair } from '../pairing/types';
import {
  appendHistory, buildCapabilities, describeCapabilities, buildKeyOf, Capabilities, capsRevision, CAPCACHE_TTL_MS, loadCapCache, loadHistory,
  loadProbe, ProbeStore, removePeerData, sanitizeCapabilities, saveCapCache, saveProbe, PROTOCOL_VERSION, Tri,
} from './capability';
import { buildDiagnosticReport, DiagnosticReport, reportFileName, reportToJson, summarizeReport } from './diagnostics';
import { joinFailureDetail, joinFailureText, parseJoinFailure } from './joinFailure';
import { GuestEntry, isCompatibleVersion, LinkMethod, LinkPlan, parsePlan, planLink } from './planner';
import {
  HandshakeEvent,
  HotspotPort,
  MessageMeta,
  NativeHeartbeatStatus,
  SendOptions,
  StartOptions,
  TetherConfig,
  TetherError,
  TetherPlatform,
  TetherRole,
  TetherState,
} from './types';

/**
 * 端末間で流すメッセージの封筒。アプリのメッセージは `tether.app` に包んで送り、
 * 接続情報などの内部メッセージ(`tether.*`)と混ざらないようにする。
 */
type Wire =
  | { kind: 'tether.app'; body: unknown }
  | { kind: 'tether.wifi'; method: 'WifiDirect' | 'LocalOnlyHotspot'; ssid: string; pass: string; port: number; socks: Socks;
      /** 親機が Nearby を閉じて Direct グループを作り直す。子機も Nearby を閉じ、この情報で参加を繰り返し試す */
      rebuild?: boolean;
      /** 親機の制御バス(Direct 上の ZeroMQ)の待ち受けポート。無ければ(旧版の親機)バスは使わず Nearby のまま */
      busPort?: number }
  | { kind: 'tether.wifi-result'; ok: boolean; gateway?: string; rttMs?: number; error?: string }
  | { kind: 'tether.need-wifi' }
  // 子機が自分でペア解除するときの通知(best-effort)。親機は該当ペアを消す
  | { kind: 'tether.unpair' }
  // 能力の交換と方式判断(docs/SPEC.md §9)。機種名と能力・判断だけを流す
  // 旧版が載せる nwd / tv は無視する(方式は suspend 一本。docs/LINK_STATE.md「廃止した keep 方式」)
  | { kind: 'tether.hello'; v: number; rev: string }
  | { kind: 'tether.caps-req'; v: number }
  | { kind: 'tether.caps'; v: number; rev: string; caps: Capabilities }
  | { kind: 'tether.plan'; v: number; plan: LinkPlan }
  // 親機が正の時間設定（閾値の対応関係が崩れないよう、親機から子機へ配る）
  // probe = 外形監視の設定(間隔・閾値・宛先など。timing とは別セクション。無い/旧版の親機なら子機は自分の設定)
  | { kind: 'tether.timing'; v: 1; timing: Record<string, unknown>; probe?: Record<string, unknown> }
  // 子機→親機の外形監視の報告(アプリメッセージ扱い = バス専用。Nearby では送らない・受けない)
  | { kind: 'tether.internet'; v: 1; state: string; okAt: number | null; at: number; seq: number; fails: number; reason: string | null; since: number };

interface Socks {
  port: number;
  user: string;
  pass: string;
}

type WifiMsg = Extract<Wire, { kind: 'tether.wifi' }>;

const ECHO_PORT = 9000;
/** 制御バス(Direct 上)の待ち受けポート。Echo(9000)の隣 */
const BUS_PORT = 9001;
/** バスの鍵の導出ラベル: K_bus = HMAC(共有コード, 'dh-bus/v1')。共有コード自体はネイティブへ渡さない */
const BUS_KEY_LABEL = 'dh-bus/v1';
const SOCKS_PORT = 1080;
/** 接続情報は古くなると意味がない。切断中に溜めすぎず、1 本だけ(最新)を 60 秒保持する */
const WIFI_TTL_MS = 60_000;

const isWire = (x: unknown): x is Wire => typeof (x as any)?.kind === 'string' && (x as any).kind.startsWith('tether.');

/**
 * Wi-Fi Direct 自動テザリングの公開 API。
 *
 * - 一度ペアリングすれば、start() だけで役割を自動判定し、接続・共有・VPN・復旧まで人手なしで行う。
 * - アプリは getState()/subscribe() で状態を表示し、send()/onMessage() で自分のメッセージを流す。
 * - 端末の部品(Nearby・Wi-Fi・VPN・保管領域)は TetherPlatform として注入する(テストで差し替え可能)。
 */
export class Tether {
  private store: PairStore;
  private state: TetherState;
  private subs = new Set<(s: TetherState) => void>();
  private msgSubs = new Set<(body: unknown, meta: MessageMeta) => void>();
  private logSubs = new Set<(line: string) => void>();

  private link: LinkSupervisor | null = null;
  private pairing: PairingSession | null = null;
  /** beginPairing の準備中〜終了まで true。この間は start() がリンクを作らない(作ると Nearby の接続要求をリンクが拒否する) */
  private pairingBusy = false;
  private resumeAfterPairing: StartOptions | null = null;
  private starting = false;
  /** start() ごとに増やす世代。古い非同期処理が、止めた後の状態を書き換えないための目印 */
  private gen = 0;
  private peerId: string | null = null;
  private autoShare = true;
  private shareMsg: WifiMsg | null = null;
  private sharing = false;
  private joining = false;
  private lastJoined: WifiMsg | null = null;
  private vpnHold = false;
  private offWifiLost: (() => void) | null = null;
  private offJoinPrompt: (() => void) | null = null;
  private hsSubs = new Set<(e: HandshakeEvent) => void>();
  /** 親機: 今の子機の能力(キャッシュまたは受信)。未取得は null */
  private guestCaps: Capabilities | null = null;
  private capsWaiters: (() => void)[] = [];
  private reshares = 0;
  private todoDone = new Set<string>();
  // ---- Direct が生きている間は常に Nearby を止める(suspend 一本。keep 方式は廃止: docs/LINK_STATE.md) ----
  /** この Nearby 部品が suspend() を持つか。持たない旧部品では止められないので、従来動作(止めない)+警告ログで縮退する */
  private suspendOk = true;
  /** Nearby と Direct の使い分けの責任者。ネイティブ部品(this.nearby / this.hotspot)は必ずこれを通した薄いラッパー */
  private gov: LinkGovernor;
  private nearby: NearbyApi;
  private hotspot: HotspotPort;
  /** 制御メッセージの通り道。その時点の状態で Nearby とバス(Direct 上)を選ぶ(src/link/controlRouter.ts) */
  private ctl: RoutedControl | null = null;
  /** Direct 上の制御バス(p.bus があるとき)。null = バスなし(従来どおり Nearby だけ) */
  private bus: BusControl | null = null;
  /** この端末がバスのネイティブを動かしている(親機: 待ち受け中 / 子機: 接続を試みている) */
  private busRunning = false;
  /** 今回の起動で、バスが一度でも認証済みになった(なるまでは運び先をバスにしない = 旧版の相手との互換) */
  private busSeenUp = false;
  /** バスの状態(authenticated / disconnected / off)が最後に変わった時刻。Echo の再開のヒステリシス用 */
  private busChangedAt = 0;
  private busKey: string | null = null;
  private busSelf: string | null = null;
  private offBusUp: (() => void) | null = null;
  /** 有効な時間設定（cfg.timing < 保存した上書き < 親機から配られた分）。start のたびに決め直す */
  private timing: LinkTimingConfig = resolveTiming();
  private resumedBecause: string | null = null;
  private since = 0;
  private nearbySuspended = false;
  /** 再開待ちログを最後に出した時刻(待ちの外では null) */
  private resumeEtaLogAt: number | null = null;
  /** suspend / resume の競合を避ける番号(進行中の suspend は、番号が変わったら取り消す) */
  private suspendSeq = 0;
  private data: DataPath = initialDataPath();
  /** 子機から到達確認(wifi-result)を受けた、または Direct 作り直しで子機が Direct に居ると分かった */
  private peerReachKnown = false;
  /** 親機: 今回の接続で Echo を受けた回数と最初の時刻(wifi-result 未着時の推定用) */
  private echoCount = 0;
  private echoFirstAt: number | null = null;
  private rejoining = false;
  /** Direct の再接続中の試行(attempt / max)。null = 再接続中ではない */
  private retry: { attempt: number; max: number; reason: string } | null = null;
  private gateway: string | null = null;
  private lastPort = ECHO_PORT;
  private offGroup: (() => void) | null = null;
  private offEcho: (() => void) | null = null;
  /** 子機: ネイティブのハートビートが動いている(接続先)。null = 動いていない(JS の heartbeatLoop が代わりに動く) */
  private hbNative: { host: string; port: number } | null = null;
  private offHb: (() => void) | null = null;
  private hbFailNoted = 0;
  private overallSubs = new Set<(o: Overall, prev: Overall) => void>();
  /** インターネット外形監視のコア(状態機械・報告・親機の受信)。probe の実装は持たない */
  private monitor: InternetMonitor;
  /** 既定の probe 供給元(ネイティブ)。enable() の runner で使うかを選ぶ */
  private probeRunner: NativeProbeRunner;
  private probeRunnerMode: 'native' | 'none' = 'native';
  private netCapNoted = 0;
  /** stop 処理中は監視の変化で set しない */
  private quiet = false;

  constructor(private p: TetherPlatform, private cfg: TetherConfig = {}) {
    this.gov = new LinkGovernor({
      timing: toGuardTiming(resolveTiming(), 'guest'), now: () => p.now(), strict: cfg.strictLinkGuard,
      log: (l) => this.gnote(l), onAction: (a) => this.runAction(a),
      context: () => this.linkContext(),
    });
    this.since = p.now();
    this.nearby = this.gov.wrapNearby(p.nearby);
    this.hotspot = this.gov.wrapHotspot(p.hotspot);
    this.store = new PairStore(p.kv);
    // ネイティブのログ(SSID・合言葉は伏せ済み)も診断ログに流す。形: "[DH-P2P] i 本文"
    try { p.onNativeLog?.((tag, line) => this.log(`[${tag}] ${line}`)); } catch {}
    // 前回の JS が suspend したまま再読み込みされても、ネイティブの Nearby を塞いだままにしない
    try { this.nearby.resume?.(); } catch {}
    this.monitor = new InternetMonitor({
      now: () => p.now(), log: (l) => this.gnote(l), role: () => this.state.role,
      busUp: () => this.data.bus === 'authenticated',
      noteAlive: (at) => this.noteAliveAt(this.gen, at, 'net'),
      sendReport: (r) => this.ctl?.send(r satisfies Wire, { ttlMs: 0 }),
      changed: () => { if (this.state.started && !this.quiet) this.set({}); },
    });
    this.probeRunner = new NativeProbeRunner(this.hotspot, (ok, at, reason) => void this.monitor.update(ok, at, reason), (l) => this.gnote(l));
    this.state = {
      started: false, role: null, autoRole: this.detectRole(), peer: null,
      link: 'stopped', attempt: 0, nearby: 'down', data: initialDataPath(), overall: 'disconnected', linkState: {} as LinkStateInfo,
      internet: this.monitor.status, remoteInternet: null,
      share: 'off', shareMethod: null, peerReach: null,
      wifi: 'off', joinPrompt: false, joinFailure: null, vpn: 'off', plan: null, pending: 0, error: null,
    };
    // 子機: 前回の VPN が残っていたら、全通信を飲み込んだままにしないよう止める
    this.safeStopVpn();
    this.deriveState();
  }

  // ---------- 状態 ----------

  getState(): TetherState {
    return { ...this.state, pending: this.ctl?.pending ?? 0 };
  }

  /** 状態が変わるたびに呼ばれる。戻り値で購読解除 */
  subscribe(cb: (s: TetherState) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** 総合状態(overall)が変わるたびに呼ばれる。戻り値で購読解除。subscribe でも state.overall で同じものが見える */
  onOverall(cb: (o: Overall, prev: Overall) => void): () => void {
    this.overallSubs.add(cb);
    return () => this.overallSubs.delete(cb);
  }

  /**
   * Nearby のネイティブ層のエラー（広告・探索・接続の失敗。8007 STATUS_RADIO_ERROR など）を読む。読み取り専用で、Nearby の制御ではない。
   * 利用側アプリがネイティブモジュール（NearbyLink）を直接参照しなくて済むようにするための入口。戻り値で購読解除
   */
  onNearbyError(cb: (e: { op: string; code: number }) => void): () => void {
    return this.p.nearby.on('onError', (e: { op: string; code: number }) => cb(e));
  }

  /** 相手から届いたアプリのメッセージ(send() で送られたもの) */
  onMessage(cb: (body: unknown, meta: MessageMeta) => void): () => void {
    this.msgSubs.add(cb);
    return () => this.msgSubs.delete(cb);
  }

  /** 診断ログ(画面のログ欄用) */
  onLog(cb: (line: string) => void): () => void {
    this.logSubs.add(cb);
    return () => this.logSubs.delete(cb);
  }

  /** 能力の交換・方式判断の進行(能力受信・計画・更新要求)。戻り値で購読解除 */
  onHandshake(cb: (e: HandshakeEvent) => void): () => void {
    this.hsSubs.add(cb);
    return () => this.hsSubs.delete(cb);
  }

  /** セルラー回線があれば親機、なければ子機 */
  detectRole(): TetherRole {
    try { return this.hotspot.hasCellular() ? 'host' : 'guest'; } catch { return 'guest'; }
  }

  // ---------- この端末の役割(最初に一度だけ選ぶ) ----------

  /** 利用者が選んだ、この端末の役割。未選択は null。一度選んだら以後ずっとこの役割で動く */
  async deviceRole(): Promise<TetherRole | null> {
    const v = await this.p.kv.get(DEVICE_ROLE_KEY);
    return v === 'host' || v === 'guest' ? v : null;
  }

  /** 役割を選ぶ(変えるときも使う)。動いているときは止める */
  async setDeviceRole(role: TetherRole): Promise<void> {
    if (this.state.started) this.stop();
    await this.p.kv.set(DEVICE_ROLE_KEY, role);
  }

  // ---------- 能力調査 ----------

  /**
   * この端末の能力。副作用なし(ダイアログ・無線の切り替えを起こさない)。
   * 取得できない項目は null(不明)。実際に試した結果・運用で観測した結果は端末内に保存され、公式 API の値より優先される。
   */
  async capabilities(): Promise<Capabilities> {
    let native = null;
    try { native = this.p.capability?.collect() ?? null; } catch { native = null; }
    let cellular: Tri = null;
    try { cellular = this.hotspot.hasCellular(); } catch { cellular = null; }
    const probe = await loadProbe(this.p.kv, buildKeyOf(native ?? { model: null, sdk: null }));
    return buildCapabilities({ native, cellular, probe, now: this.p.now() });
  }

  /**
   * 実際に試して確かめる(LocalOnlyHotspot を一瞬だけ起動して閉じる)。結果は端末内に保存する。
   * 承認ダイアログは出ないが、機種によっては Wi-Fi が一時的に切れる。共有中は TetherError('busy')。
   * 自動では呼ばない。診断画面などから利用者が明示的に実行する。
   */
  async runProbe(): Promise<{ lohs: { ok: boolean; reason?: string }; capabilities: Capabilities }> {
    const port = this.p.capability;
    if (!port) throw new TetherError('unsupported', 'この環境では能力の試験ができません');
    if (this.sharing || this.state.share !== 'off') throw new TetherError('busy', '共有中は試験できません。停止してから実行してください');
    const lohs = await port.probeLohs();
    const store = await this.probeStore();
    store.lohs = { ok: lohs.ok, reason: lohs.reason, at: this.p.now() };
    store.at = this.p.now();
    await saveProbe(this.p.kv, store);
    this.log(`能力の試験: LOHS ${lohs.ok ? '作成できた' : '作成できず(' + (lohs.reason ?? '?') + ')'}`);
    return { lohs, capabilities: await this.capabilities() };
  }

  /**
   * 診断レポート: 端末から取れるものを網羅的に採取する(副作用なし)。開発・機種比較用。
   * Planner が使う能力(`capabilities`)は含むが、**相手へ送るのは `capabilities()` の内容だけ**で、このレポート全体は送らない。
   */
  async diagnosticReport(): Promise<DiagnosticReport> {
    let native = null;
    try { native = this.p.capability?.diagnostics?.() ?? null; } catch { native = null; }
    const caps = await this.capabilities();
    const probe = await loadProbe(this.p.kv, buildKeyOf({ model: caps.device.model, sdk: caps.device.sdk }));
    return buildDiagnosticReport({ native, capabilities: caps, probe, now: this.p.now() });
  }

  /**
   * 診断レポートを作り、端末内のファイル(アプリ専用領域の diagnostics/)に保存する。
   * 外へ出すのは利用者が明示的に共有したとき(画面の「共有」)か、adb pull したときだけ。
   */
  async saveDiagnosticReport(): Promise<{ report: DiagnosticReport; fileName: string; json: string; summary: string; path: string | null }> {
    const report = await this.diagnosticReport();
    const json = reportToJson(report);
    const fileName = reportFileName(report);
    let path: string | null = null;
    try { path = this.p.capability?.saveFile?.(fileName, json) ?? null; } catch (e: any) { this.log('診断レポートの保存に失敗: ' + (e?.message ?? e)); }
    this.log(`診断レポートを作成: ${fileName}${path ? ' → ' + path : '(保存先なし)'}`);
    return { report, fileName, json, summary: summarizeReport(report), path };
  }

  private async probeStore(): Promise<ProbeStore> {
    let native = null;
    try { native = this.p.capability?.collect() ?? null; } catch { native = null; }
    const key = buildKeyOf(native ?? { model: null, sdk: null });
    return (await loadProbe(this.p.kv, key)) ?? { buildKey: key, at: this.p.now(), observed: {} };
  }

  private async observe(k: 'staP2pConcurrent' | 'p2pApCoexist', v: boolean): Promise<void> {
    try {
      const st = await this.probeStore();
      if (st.observed[k] === v) return;
      st.observed[k] = v;
      st.at = this.p.now();
      await saveProbe(this.p.kv, st);
    } catch {}
  }

  private async record(method: LinkMethod, stage: 'create' | 'join', ok: boolean): Promise<void> {
    if (!this.peerId) return;
    try { await appendHistory(this.p.kv, this.peerId, { method, stage, ok, at: this.p.now(), code: ok ? undefined : stage + '-failed' }); } catch {}
  }

  // ---------- ペア ----------

  async identity(): Promise<Identity> {
    return getIdentity(this.p.kv, this.p.randomHex);
  }

  /** 保存済みのペア(新しい順) */
  async pairs(): Promise<Pair[]> {
    return (await this.store.list()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 子機が自分でペア解除する。親機と接続中なら解除通知(tether.unpair)を best-effort で送ってから、removePair する。
   * 未接続・送れない場合は通知なしで、この端末のペアだけ消す。
   */
  async unpair(peerId: string): Promise<void> {
    if (this.peerId === peerId && this.state.role === 'guest' && this.state.link === 'connected' && this.ctl) {
      try {
        this.ctl.send({ kind: 'tether.unpair' } satisfies Wire, { ttlMs: 0 });
        await this.p.sleep(300); // 送信が流れる猶予(stop で切る前に)
      } catch {}
    }
    await this.forgetPair(peerId);
  }

  /** removePair + direct.v1.<peerId> の削除(#8 の removePair が同じ削除を持つ場合も無害) */
  private async forgetPair(peerId: string): Promise<void> {
    await this.removePair(peerId);
    await clearDirectCreds(this.p.kv, peerId).catch(() => {});
  }

  async removePair(peerId: string): Promise<void> {
    await this.store.remove(peerId);
    await removePeerData(this.p.kv, peerId).catch(() => {});
    await removeDirectCreds(this.p.kv, peerId).catch(() => {});
    if (this.peerId === peerId) this.stop();
  }

  /**
   * 近くの端末を探して、確認コードを照合してペアにする。両方の端末で呼ぶ。
   * Nearby はリンクと同時には使えないので、動いているリンクは止め、終わったら元の設定で再開する。
   */
  async beginPairing(role: TetherRole, h: {
    onDevices(list: Found[]): void;
    onConfirm(c: Confirm): void;
    /** 「要求中」「相手の承認待ち」などの進行状況(任意) */
    onStatus?(message: string): void;
    onDone(r: PairingResult): void;
  }): Promise<{ connectTo(endpointId: string): void; cancel(): void }> {
    this.cancelPairing();
    this.pairingBusy = true;
    const wasStarted = this.state.started;
    const resume = wasStarted ? { role: this.state.role!, peerId: this.peerId ?? undefined, autoShare: this.autoShare } : null;
    if (wasStarted) this.stop();
    let self: Identity;
    try {
      // 権限は再要求しない: 拒否済みの権限を requestPermissions で再要求すると、画面に出ていない間は返らず広告が始まらない。
      // 足りなければ、足りない一覧つきで即座に失敗にする(呼び出し側が ensurePermissions() などで先にそろえる)
      const missing = this.p.missingPermissions ? await this.p.missingPermissions() : null;
      if (missing && missing.length > 0) {
        throw new TetherError('permission-denied', '権限が足りません: ' + missing.map((m) => m.slice(m.lastIndexOf('.') + 1)).join(', '), missing);
      }
      if (!missing && !(await this.p.requestPermissions())) this.log('権限が許可されていません');
      self = await this.identity();
    } catch (e) {
      this.pairingBusy = false;
      throw e;
    }
    this.p.keepAlive.start();
    this.resumeAfterPairing = resume;
    const s = new PairingSession(this.nearby, {
      self,
      store: this.store,
      randomHex: this.p.randomHex,
      now: this.p.now,
      onReplaced: async (old) => {
        for (const o of old) {
          await clearDirectCreds(this.p.kv, o.peerId).catch(() => {});
          await removePeerData(this.p.kv, o.peerId).catch(() => {});
          if (resume?.peerId === o.peerId) resume.peerId = undefined;
        }
        this.log(`同じ名前の旧ペアを置き換えました(${old.length}件)`);
      },
      timeoutMs: this.cfg.pairingTimeoutMs ?? 120_000,
      role,
    });
    s.onDevices = h.onDevices;
    s.onConfirm = h.onConfirm;
    if (h.onStatus) s.onStatus = h.onStatus;
    s.onDone = (r) => {
      this.endPairing(s);
      if (r.ok) this.log(`ペアリング完了: ${r.pair.peerName}`);
      else this.log('ペアリング失敗: ' + r.error);
      h.onDone(r);
    };
    this.pairing = s;
    s.start();
    return {
      connectTo: (id) => s.connectTo(id),
      cancel: () => {
        if (this.pairing === s) this.cancelPairing();
      },
    };
  }

  /**
   * 権限を求める(画面に出る)。beginPairing の前に呼ぶ。足りないものが残れば missing に入る(すべて許可なら空)。
   * missingPermissions を持たない部品では requestPermissions の結果だけで判断する。
   */
  async ensurePermissions(): Promise<{ granted: boolean; missing: string[] }> {
    const ok = await this.p.requestPermissions();
    const missing = this.p.missingPermissions ? await this.p.missingPermissions() : [];
    return { granted: ok && missing.length === 0, missing };
  }

  /**
   * 「常に許可」の位置情報の状態。背面で Nearby が 8034 にならないために要る。
   * 'granted' 許可済み(または API 28 以下で不要) / 'denied' 未許可 / 'needs-foreground' 先にアプリ使用中の位置情報の許可が要る。
   * 使い方: ensurePermissions() のあとに呼び、'denied' なら案内を出して openBackgroundLocationSettings() で設定画面へ(「常に許可」を選ばせる)。
   * 設定から戻ったら再度この関数で確かめる。
   */
  async backgroundLocation(): Promise<'granted' | 'denied' | 'needs-foreground'> {
    const missing = this.p.missingPermissions ? await this.p.missingPermissions() : [];
    if (missing.some((m) => m.endsWith('LOCATION'))) return 'needs-foreground';
    const ok = this.p.backgroundLocationGranted ? await this.p.backgroundLocationGranted() : true;
    this.log(`位置情報(常に許可)=${ok ? 'granted' : 'denied'}`);
    return ok ? 'granted' : 'denied';
  }

  /** このアプリの設定画面を開く。位置情報 →「常に許可」を選んでもらう */
  async openBackgroundLocationSettings(): Promise<void> {
    this.log('設定画面を開く(位置情報: 常に許可の案内)');
    await this.p.openAppSettings?.();
  }

  /** ペアリングをやめる(onDone は呼ばれない) */
  cancelPairing(): void {
    const s = this.pairing;
    if (!s) return;
    s.stop();
    this.endPairing(s);
  }

  private endPairing(s: PairingSession): void {
    if (this.pairing !== s) return;
    this.pairing = null;
    this.pairingBusy = false;
    this.p.keepAlive.stop();
    const resume = this.resumeAfterPairing;
    this.resumeAfterPairing = null;
    if (resume) void this.start(resume).catch((e) => this.log('再開に失敗: ' + (e?.message ?? e)));
  }

  // ---------- 起動・停止 ----------

  /**
   * 接続を始める。ペアが無ければ TetherError('no-pair')。
   * 親機: 回線の共有を先に準備して、つながり次第 接続情報を子機へ渡す。
   * 子機: 接続情報を受け取ったら Wi-Fi に参加し、VPN を張る。切れたら自動で戻す。
   */
  async start(opts: StartOptions = {}): Promise<void> {
    if (this.starting || (this.pairingBusy && !this.pairing)) return;
    this.starting = true;
    try {
      this.cancelPairing();
      this.stopInternal(false);
      const pairs = await this.pairs();
      const pair = opts.peerId ? pairs.find((x) => x.peerId === opts.peerId) : pairs[0];
      if (!pair) throw new TetherError('no-pair', '先に相手の端末とペアリングしてください');
      const self = await this.identity();
      // 役割: 指定 > この端末の役割(最初に選んだもの) > ペアに保存した役割 > 回線の有無
      const role: TetherRole = opts.role && opts.role !== 'auto' ? opts.role : (await this.deviceRole()) ?? pair.role ?? this.detectRole();
      const granted = await this.p.requestPermissions();
      if (this.pairingBusy) return; // 待っている間にペアリングが始まった
      if (!granted) this.set({ error: '権限が許可されていません(Nearby・近くのデバイス・通知)' });
      await this.resolveTiming(role);
      await this.resolveInternet();
      if (this.pairingBusy) return;
      const gen = ++this.gen;
      this.since = this.p.now();
      this.peerId = pair.peerId;
      this.autoShare = opts.autoShare ?? true;
      this.vpnHold = false;
      this.p.keepAlive.start();

      const ctl = new NearbyControl();
      const sup = createLink(
        this.nearby,
        { role, selfId: self.id, pair: { peerId: pair.peerId, secret: pair.secret }, connectTimeoutMs: this.cfg.connectTimeoutMs ?? 30_000 },
        (body) => ctl.deliver(body),
        { baseMs: this.timing.nearbyRetryBaseMs, maxMs: this.timing.nearbyRetryMaxMs, sleep: this.p.sleep, now: this.p.now, ...this.cfg.link },
      );
      sup.onState = (s, n) => {
        if (gen !== this.gen) return;
        ctl.setConnected(s === 'connected');
        this.set({ link: s === 'paused' ? 'waiting' : s, attempt: n });
        this.log('状態: ' + s);
        // Wi-Fi Direct に参加すると Nearby(WIFI_LAN など)が落ちることがある。Direct の IP 経路(VPN→親機の SOCKS)は Nearby と独立なので、
        // Direct / VPN は捨てず維持し、Nearby は裏で再探索するだけにする(onWifiLost だけが Direct の断を扱う)
        if (s === 'waiting' && role === 'guest' && this.state.wifi === 'joined') {
          this.log(`Nearby 切断(Direct 参加中: Direct・VPN は維持 vpn=${this.state.vpn}。Nearby は再探索する)`);
        }
        if (s === 'connected') this.onConnected(role, gen);
      };
      this.link = sup;
      ctl.attach(sup);
      this.busKey = null;
      this.busSelf = self.id;
      this.busRunning = false;
      this.busSeenUp = false;
      this.bus = null;
      // バスを使うかどうかは運び先の選択(pickCarrier)で決める。ここでは部品があれば作るだけ
      // バス部品が無い端末でも BusControl は作る(アプリのメッセージの保留・ttl 破棄をここで持つため。部品なしは送れないので溜まって ttl で捨てられるだけ)
      this.bus = new BusControl(this.p.bus ?? NO_BUS_PORT, { now: this.p.now, onEvent: (e) => this.onBusEvent(e) });
      if (this.p.bus) {
        this.busKey = this.nearby.hmac(pair.secret, BUS_KEY_LABEL);
        this.bus.attach();
        this.offBusUp = this.bus.onUpDown((up, reason) => this.onBusUpDown(gen, role, up, reason));
      }
      const routed = new RoutedControl(ctl, this.bus, () => this.pickCarrier(), (to, moved) => {
        this.gnote(`内部制御の運び先: ${to === 'bus' ? 'バス(Direct)' : 'Nearby'}${moved > 0 ? `(バスに溜まっていた内部制御 ${moved} 件を Nearby へ移した。アプリのメッセージは移さない)` : ''}`);
      }, (r) => this.logSend(r));
      routed.subscribe((body, from) => this.onWire(gen, role, pair.peerId, body, from));
      this.ctl = routed;
      this.set({
        started: true, role, peer: { peerId: pair.peerId, peerName: pair.peerName },
        link: 'connecting', attempt: 0, error: granted ? null : this.state.error,
      });
      // 実機確認用: この端末の能力を診断ログに出す(機種名と能力のみ。共有コード・資格情報は含まない)
      void this.capabilities().then((c) => {
        if (gen === this.gen) describeCapabilities(c).split('\n').forEach((l) => this.log('能力 ' + l));
      }).catch(() => {});
      if (role === 'guest') {
        this.offWifiLost = this.hotspot.onWifiLost(() => this.onWifiLost(gen));
        this.offJoinPrompt = this.hotspot.onJoinPrompt?.((e) => {
          if (gen !== this.gen) return;
          // 'show' だけが案内を出す。ok / declined / timeout / cancelled はどれも「終わり」なので案内を必ず消す
          this.set({ joinPrompt: e.phase === 'show' });
          this.log(`Wi-Fi 許可画面: ${e.phase}`);
        }) ?? null;
      }
      this.setupDirectGuard(gen, role);
      void sup.run();
      if (role === 'host') {
        // 前回の子機の能力が残っていれば、待たずに方式を決められる
        const cached = await loadCapCache(this.p.kv, pair.peerId, this.p.now());
        if (gen !== this.gen) return;
        if (cached) this.guestCaps = cached.caps;
      }
      if (role === 'host' && this.autoShare) void this.shareNow();
    } finally {
      this.starting = false;
    }
  }

  /** 止める。親機は共有(Direct/LOHS/SOCKS5/エコー)も止め、子機は VPN と Wi-Fi 参加を外す */
  stop(): void {
    this.stopInternal(true);
  }

  private stopInternal(emit: boolean): void {
    this.gen++;
    this.link?.stop();
    this.link = null;
    this.ctl = null;
    this.stopBus('stop');
    this.offBusUp?.(); this.offBusUp = null;
    this.bus?.detach();
    this.bus = null;
    this.busKey = null;
    this.offWifiLost?.();
    this.offWifiLost = null;
    this.offJoinPrompt?.();
    this.offJoinPrompt = null;
    if (this.state.started) this.p.keepAlive.stop();
    const h = this.hotspot;
    const wasHost = this.state.role === 'host';
    if (wasHost || this.state.share !== 'off') {
      this.log(`共有を停止(エコー・SOCKS・Direct を閉じる share=${this.state.share})`);
      try { h.stopSocks(); } catch {}
      try { h.stopEcho(); } catch {}
      try { h.stopHotspot(); } catch {}
      void h.stopDirect().catch(() => {});
    }
    this.nearbyDirectActive(false);
    this.offGroup?.(); this.offGroup = null;
    this.offEcho?.(); this.offEcho = null;
    this.stopNativeHb('stop');
    this.probeRunner.stop('stop');
    this.quiet = true;
    try { this.monitor.setActive(false); this.monitor.reset('stop'); } finally { this.quiet = false; }
    this.suspendSeq++;
    if (this.nearbySuspended) { this.nearbySuspended = false; try { this.nearby.resume?.(); } catch {} }
    this.gov.reset();
    this.data = initialDataPath();
    this.peerReachKnown = false;
    this.echoCount = 0;
    this.echoFirstAt = null;
    this.rejoining = false;
    this.retry = null;
    this.resumedBecause = null;
    this.gateway = null;
    this.safeStopVpn();
    try { h.leaveWifi(); } catch {}
    this.shareMsg = null;
    this.lastJoined = null;
    this.sharing = false;
    this.joining = false;
    this.vpnHold = false;
    this.peerId = null;
    this.guestCaps = null;
    this.capsWaiters = [];
    this.reshares = 0;
    this.todoDone.clear();
    const next: Partial<TetherState> = {
      started: false, role: null, peer: null, link: 'stopped', attempt: 0, nearby: 'down', data: initialDataPath(), overall: 'disconnected',
      internet: this.monitor.status, remoteInternet: null,
      share: 'off', shareMethod: null, peerReach: null, wifi: 'off', joinPrompt: false, joinFailure: null, vpn: 'off', plan: null,
    };
    if (emit) this.set(next);
    else this.state = { ...this.state, ...next };
  }

  // ---------- メッセージ ----------

  /**
   * 相手へアプリのメッセージを送る。**運び先は常にバス(Direct)だけ**で、Nearby には載せない。
   * バスが使えない間(Direct 未確立・未認証・切断中)はバスの保留に溜め、ttl が過ぎたら捨てる(Nearby にはフォールバックしない)。
   * - ttlMs 未指定: つながるまで溜めて、つながり次第 1 回だけ届ける(受諾など)
   * - ttlMs: 溜める最長時間。0 は「溜めない」(状態表示など、古くなれば無意味なもの)
   * - key: 同じ key の未送達は新しいものに置き換える(最新だけ届ければよいもの)
   * 停止中は何もせず false。
   */
  send(body: unknown, opts: SendOptions = {}): boolean {
    if (!this.ctl) return false;
    this.ctl.send({ kind: 'tether.app', body } satisfies Wire, opts);
    this.notify();
    return true;
  }

  // ---------- 非常口(子機) ----------

  /**
   * 通信が止まったときの非常口。VPN を止めて素の通信に戻す。
   * resumeVpn() か start() をするまで、接続情報を再受信しても VPN を自動では張らない。
   */
  stopVpn(): void {
    this.vpnHold = true;
    this.safeStopVpn();
    this.set({ vpn: 'held' });
    this.log('VPN 停止(非常口)');
  }

  /** 非常口で止めた VPN を、直近の接続情報で再び張る */
  async resumeVpn(): Promise<void> {
    this.vpnHold = false;
    if (this.state.vpn === 'held') this.set({ vpn: 'off' });
    if (this.lastJoined && this.state.role === 'guest') await this.join(this.gen, this.lastJoined, true);
    else if (this.state.role === 'guest') this.ctl?.send({ kind: 'tether.need-wifi' } satisfies Wire, { key: 'need-wifi', ttlMs: 30_000 });
  }

  // ---------- 親機: 共有 ----------

  /** 回線の共有を(再)開始する。autoShare:false のときや、やり直したいとき用 */
  async shareNow(): Promise<void> {
    if (this.sharing || this.state.role !== 'host') return;
    this.sharing = true;
    const gen = this.gen;
    this.set({ share: 'starting', error: null });
    let again = false;
    try {
      // 子機の能力と自分の能力から、方式と順序を決める(キャッシュがあれば待たない)
      const plan = await this.ensurePlan(gen);
      if (gen !== this.gen || !plan) return;
      if (!plan.ok) {
        const msg = plan.failure?.message ?? '使えるリンク方式がありません';
        this.log('方式判断: ' + msg);
        this.set({ share: 'failed', error: msg });
        return;
      }
      const msg = await this.buildShare(gen, plan.order);
      if (gen !== this.gen) return;
      if (!msg) {
        this.set({ share: 'failed' });
        return;
      }
      this.shareMsg = msg;
      this.set({ share: 'on', shareMethod: msg.method });
      this.sendShare();
      again = this.needReshare();
    } finally {
      this.sharing = false;
    }
    if (again) this.reshare();
  }

  /** 共有を作っている間に、より新しい判断(子機の能力を受信)で方式が変わったか */
  private needReshare(): boolean {
    const plan = this.state.plan;
    const m = this.state.shareMethod;
    return !!plan && plan.ok && plan.order.length > 0 && !!m && !plan.order.includes(m) && this.reshares < 2;
  }

  private reshare(): void {
    this.reshares++;
    this.log('方式判断が変わったため、共有をやり直す');
    this.shareMsg = null;
    this.set({ share: 'off', shareMethod: null });
    void this.shareNow();
  }

  // ---------- 能力の交換と方式判断 ----------

  /** 親機: 計画を得る。子機の能力が未取得なら、受信かタイムアウトまで待つ(待っても来なければ「不明」として決める) */
  private async ensurePlan(gen: number): Promise<LinkPlan | null> {
    if (!this.guestCaps && !this.state.plan) {
      await Promise.race([
        new Promise<void>((r) => this.capsWaiters.push(r)),
        this.p.sleep(this.cfg.capsWaitMs ?? 5000),
      ]);
      if (gen !== this.gen) return null;
    }
    return this.state.plan ?? (await this.makePlan(gen));
  }

  /** 親機: 今の子機の能力で方式を決め、子機へ通知する */
  private async makePlan(gen: number, guestCapsOverride?: Capabilities): Promise<LinkPlan | null> {
    const peerId = this.peerId;
    if (!peerId) return null;
    const host = await this.capabilities();
    const history = { [peerId]: await loadHistory(this.p.kv, peerId) };
    if (gen !== this.gen) return null;
    const entry: GuestEntry = {
      peerId, paired: true,
      state: this.state.peerReach?.ok ? 'connected' : 'requesting',
      caps: guestCapsOverride ?? this.guestCaps,
      method: this.state.peerReach?.ok ? this.state.shareMethod : null,
    };
    const plan = planLink({ host, guests: [entry], history, policy: this.cfg.planPolicy, now: this.p.now() });
    this.set({ plan });
    this.log(`方式判断: ${plan.ok ? plan.order.join(' → ') : '不可 ' + (plan.failure?.code ?? '')}(${[...new Set(plan.reasons.map((r) => r.code))].join(',')})`);
    this.emitHandshake({ type: 'plan', side: 'host', plan });
    this.sendPlan();
    return plan;
  }

  private sendPlan(): void {
    const plan = this.state.plan;
    if (!plan || !this.ctl || this.state.role !== 'host') return;
    this.ctl.send({ kind: 'tether.plan', v: PROTOCOL_VERSION, plan } satisfies Wire, { key: 'plan', ttlMs: WIFI_TTL_MS });
  }

  /** 親機: 子機の能力を受け取った(受信またはキャッシュ)。決め直して通知する */
  private async onGuestCaps(gen: number, caps: Capabilities, cached: boolean): Promise<void> {
    if (gen !== this.gen) return;
    this.guestCaps = caps;
    this.emitHandshake({ type: 'caps-received', peerId: this.peerId ?? '', cached, model: caps.device.model });
    const plan = await this.makePlan(gen);
    const waiters = this.capsWaiters;
    this.capsWaiters = [];
    waiters.forEach((r) => r());
    if (gen !== this.gen || !plan) return;
    if (!plan.ok) {
      const msg = plan.failure?.message ?? '使えるリンク方式がありません';
      this.set({ share: this.state.share === 'on' ? 'on' : 'failed', error: msg });
      if (plan.failure?.update) this.emitHandshake({ type: 'update-required', who: plan.failure.update });
    } else if (this.state.share === 'on' && this.needReshare()) {
      this.reshare();
    }
  }

  /** 子機: 自分の能力の版だけを送る。親機がキャッシュを持っていれば、これで交換は終わる */
  private async sendHello(gen: number): Promise<void> {
    const caps = await this.capabilities();
    if (gen !== this.gen) return;
    this.ctl?.send({ kind: 'tether.hello', v: PROTOCOL_VERSION, rev: capsRevision(caps), } satisfies Wire, { key: 'hello', ttlMs: 30_000 });
  }

  private async sendCaps(gen: number): Promise<void> {
    const caps = await this.capabilities();
    if (gen !== this.gen) return;
    this.ctl?.send({ kind: 'tether.caps', v: PROTOCOL_VERSION, rev: capsRevision(caps), caps } satisfies Wire, { key: 'caps', ttlMs: 30_000 });
  }

  private async onHello(gen: number, peerId: string, v: unknown, rev: unknown): Promise<void> {
    if (typeof v !== 'number') return;
    // 親機が正の時間設定を子機へ返す(能力のやり取りより先。旧版の hello が載せる nwd / tv は無視する)
    if (this.state.role === 'host') this.sendTiming();
    if (!isCompatibleVersion(v)) {
      // 版が合わない: 能力は読まず、版だけで「どちらを更新するか」を決めて通知する
      const stub = { ...(await this.capabilities()), v };
      await this.onGuestCaps(gen, stub, false);
      return;
    }
    const cached = await loadCapCache(this.p.kv, peerId, this.p.now());
    if (cached && typeof rev === 'string' && cached.rev === rev && this.p.now() - cached.at <= CAPCACHE_TTL_MS) {
      // 変わっていない: 交換を省略
      if (!this.guestCaps || capsRevision(this.guestCaps) !== rev) await this.onGuestCaps(gen, cached.caps, true);
      else this.sendPlan();
      return;
    }
    this.ctl?.send({ kind: 'tether.caps-req', v: PROTOCOL_VERSION } satisfies Wire, { key: 'caps-req', ttlMs: 30_000 });
  }

  private async onCaps(gen: number, peerId: string, v: unknown, rev: unknown, raw: unknown): Promise<void> {
    if (typeof v !== 'number' || !isCompatibleVersion(v)) return;
    const caps = sanitizeCapabilities(raw);
    if (!caps || !isCompatibleVersion(caps.v)) return;
    const r = capsRevision(caps);
    await saveCapCache(this.p.kv, peerId, { v: PROTOCOL_VERSION, rev: r, at: this.p.now(), caps }).catch(() => {});
    await this.onGuestCaps(gen, caps, false);
  }

  /** 子機: 親機の判断を受け取り、従う(事前にすべきことを実行し、状態に出す) */
  private async onPlan(gen: number, raw: unknown): Promise<void> {
    const plan = parsePlan(raw);
    if (!plan) return;
    if (!isCompatibleVersion(plan.v)) {
      this.emitHandshake({ type: 'update-required', who: plan.v < 1 ? 'host' : 'guest' });
      this.set({ error: plan.v < 1 ? '親機のアプリが古いため通信できません。親機のアプリを更新してください' : 'このアプリが古いため通信できません。アプリを更新してください' });
      return;
    }
    const self = await this.identity();
    if (gen !== this.gen) return;
    const me = plan.guests.find((g) => g.peerId === self.id) ?? plan.guests[0];
    this.set({ plan, error: plan.ok ? this.state.error : plan.failure?.message ?? this.state.error });
    this.log(`方式判断を受信: ${plan.ok ? plan.order.join(' → ') : '不可 ' + (plan.failure?.code ?? '')}`);
    this.emitHandshake({ type: 'plan', side: 'guest', plan });
    if (plan.failure?.update) this.emitHandshake({ type: 'update-required', who: plan.failure.update });
    if (!me || me.admission !== 'admit') return;
    for (const t of me.todo) {
      if (this.todoDone.has(t)) continue;
      // 端末のダイアログは利用者が操作する。ここでは出すだけで、押す操作はしない
      try {
        if (t === 'grant-permissions') { this.todoDone.add(t); void this.p.requestPermissions(); }
        else if (t === 'vpn-consent') { this.todoDone.add(t); this.p.vpn.prepare(); }
      } catch {}
    }
  }

  private emitHandshake(e: HandshakeEvent): void {
    for (const cb of [...this.hsSubs]) {
      try { cb(e); } catch {}
    }
  }

  private sendShare(): void {
    if (!this.shareMsg || !this.ctl) return;
    this.ctl.send(this.shareMsg satisfies Wire, { key: 'wifi', ttlMs: WIFI_TTL_MS });
    this.log('接続情報を子機へ送信');
  }

  private async buildShare(gen: number, order: LinkMethod[]): Promise<WifiMsg | null> {
    const h = this.hotspot;
    const fail = (e: string) => {
      this.log(e);
      this.set({ error: e });
      return null;
    };
    // やり直しても失敗しないよう、前回の共有を先に止める。
    // Wi-Fi Direct のグループが残っていると、機種によっては LOHS の AP を作れないため、消えるのを待つ。
    h.stopSocks();
    try { h.stopHotspot(); } catch {}
    this.nearbyDirectActive(false);
    this.gov.forgetAlive(); this.data = { ...this.data, group: null, echoAt: null, busAt: null, netAt: null, aliveAt: null, reach: null };
    await h.stopDirect().catch(() => {});
    await this.p.sleep(1500);
    if (gen !== this.gen) return null;
    // 子機は承認済みの SSID が見えた瞬間に自動参加して到達確認をする。待たせて拒否されないよう、ポートを先に開けておく
    try { h.startEcho(ECHO_PORT); this.log(`エコー起動 (port ${ECHO_PORT})`); } catch (e: any) { this.log('エコー起動失敗: ' + (e?.message ?? e)); }
    const socks: Socks = { port: SOCKS_PORT, user: 'u' + this.p.randomHex(4), pass: this.p.randomHex(12) };
    try {
      const { network } = await h.startSocks(socks.port, socks.user, socks.pass);
      this.log(`SOCKS5 起動 (出口: ${network === 'cellular' ? '携帯回線' : '既定の回線'})`);
      const t = await h.socksSelfTest(socks.port, socks.user, socks.pass);
      this.log(`SOCKS 自己診断: ${t.ok ? 'OK' : `NG ${t.error ?? t.line}`} / UDP: ${t.udp === undefined ? '—' : t.udp ? 'OK' : 'NG'}`);
    } catch (e: any) {
      return fail('SOCKS 失敗: ' + (e?.message ?? e));
    }
    const pair = (await this.pairs()).find((x) => x.peerId === this.peerId);
    if (!pair) return fail('ペアがありません');
    if (gen !== this.gen) return null;

    let directTried = false;
    for (const method of order) {
      if (gen !== this.gen) return null;
      if (method === 'WifiDirect') {
        directTried = true;
        const m = await this.tryDirect(gen, pair.peerId, pair.secret, socks);
        if (m) return m;
      } else {
        this.log('→ LocalOnlyHotspot を試す');
        if (directTried) {
          // Direct のグループが残ると AP を作れない機種があるため、完全に消してから試す
          await h.stopDirect().catch(() => {});
          await this.p.sleep(1500);
        }
        const m = await this.tryLohs(gen, socks);
        if (m) return m;
      }
    }
    return fail(`回線の共有を始められませんでした(${order.map((m) => (m === 'WifiDirect' ? 'Wi-Fi Direct' : 'LocalOnlyHotspot')).join('・')} とも失敗)`);
  }

  /**
   * グループ作成の await 中に stop() された(ホームのスイッチ OFF など)か。
   * その場合 stop() の stopDirect は「まだ無いグループ」に空振りし、後からグループだけが残る
   * (エコー・SOCKS は stop() で閉じ済み = 子機は自動参加できても 9000 が ECONNREFUSED)。
   * 新しい start() が進んでいる(started / starting)ときは、そちらの buildShare が作り直すので触らない。
   */
  private abandoned(gen: number): boolean {
    return gen !== this.gen && !this.state.started && !this.starting;
  }

  private async dropOrphan(what: string): Promise<void> {
    this.log(`${what} を作る間に停止された: 残ったグループを閉じる`);
    const h = this.hotspot;
    try { h.stopSocks(); } catch {}
    try { h.stopEcho(); } catch {}
    this.stopBus('orphan');
    try { h.stopHotspot(); } catch {}
    await h.stopDirect().catch(() => {});
  }

  /** 主: Wi-Fi Direct(SSID・パスフレーズを固定(ch は動的)。ペアの共有コードから導く → OS が承認を覚える) */
  private async tryDirect(gen: number, peerId: string, secret: string, socks: Socks): Promise<WifiMsg | null> {
    const h = this.hotspot;
    // 名前・合言葉はペアごとに固定して保存する(保存済みがあればそれを使う)。子機の承認の記憶が効く。合言葉はログに出さない
    const self = await this.identity();
    const { ssid: name, pass } = await directCreds({ hmac: (s, d) => this.nearby.hmac(s, d), kv: this.p.kv, selfId: self.id, peerId, secret });
    // チャンネルは動的に決める: まずシステム任せ(周囲と親機の Wi-Fi を見て OS が選ぶ)、だめなら親機の Wi-Fi と同じ周波数。
    const staFreq = safeFreq(h);
    const plans = pickDirectPlans(staFreq);
    this.log(`Wi-Fi Direct の帯域候補: 親機 Wi-Fi=${staFreq || '未接続'}MHz → ${plans.map((x) => describePlan(x)).join(' → ')}`);
    for (const plan of plans) {
      const freq = plan.freq;
      this.log(`Wi-Fi Direct 帯域を選択: ${describePlan(plan)}(理由: ${plan.reason})`);
      try {
        const t0 = this.p.now();
        const cred = await h.startDirect(name, pass, freq, plan.band, plan.reason);
        this.nearbyDirectActive(true);
        this.data = { ...this.data, group: true };
        this.log(`Wi-Fi Direct 成功(${this.p.now() - t0}ms, ${describePlan(plan)})`);
        if (this.abandoned(gen)) { await this.dropOrphan('Wi-Fi Direct'); return null; }
        void this.record('WifiDirect', 'create', true);
        // 親機が Wi-Fi に接続したまま Direct を作れた = STA+P2P の同時動作を観測
        if (staFreq > 0) void this.observe('staP2pConcurrent', true);
        const busPort = this.startBusHost();
        return { kind: 'tether.wifi', method: 'WifiDirect', ssid: cred.ssid, pass: cred.passphrase, port: ECHO_PORT, socks, ...(busPort ? { busPort } : {}) };
      } catch (e: any) {
        this.log(`Wi-Fi Direct 失敗(${describePlan(plan)}): ${e?.message ?? e} → 次の候補へ`);
        if (gen !== this.gen) return null;
      }
    }
    void this.record('WifiDirect', 'create', false);
    return null;
  }

  /** 予備: LocalOnlyHotspot(SSID が毎回変わり、子機に承認が毎回出る) */
  private async tryLohs(gen: number, socks: Socks): Promise<WifiMsg | null> {
    const h = this.hotspot;
    for (let i = 1; i <= 3; i++) {
      if (gen !== this.gen) return null;
      try {
        const cred = await h.startHotspot();
        this.log(`LocalOnlyHotspot 成功(${i}回目)`);
        if (this.abandoned(gen)) { await this.dropOrphan('LocalOnlyHotspot'); return null; }
        void this.record('LocalOnlyHotspot', 'create', true);
        return { kind: 'tether.wifi', method: 'LocalOnlyHotspot', ssid: cred.ssid, pass: cred.passphrase, port: ECHO_PORT, socks };
      } catch (e: any) {
        this.log(`LocalOnlyHotspot 失敗 ${i}/3: ${e?.message ?? e}`);
        if (i < 3) await this.p.sleep(2000);
      }
    }
    void this.record('LocalOnlyHotspot', 'create', false);
    return null;
  }

  // ---------- 受信・接続イベント ----------

  /** 最終接続時刻を更新する(1 分に 1 回まで書く) */
  private lastTouch = 0;
  private touchPeer(peerId: string, force = false): void {
    const t = this.p.now();
    if (!force && t - this.lastTouch < 60_000) return;
    this.lastTouch = t;
    void this.store.touch(peerId, t).catch(() => {});
  }

  /**
   * Wi-Fi Direct が張れている間は、Nearby の再接続を低電力(Wi-Fi 系へ帯域をアップグレードさせない)で始めるよう ネイティブへ知らせる。
   * Nearby の帯域アップグレードが P2P を使い、固定の Direct グループを壊す疑いがあるため(docs/SPEC.md)。古いネイティブには無いので無視する
   */
  private nearbyDirectActive(on: boolean): void {
    try { this.nearby.setDirectActive?.(on); } catch {}
  }

  private onConnected(role: TetherRole, gen: number): void {
    if (this.peerId) this.touchPeer(this.peerId, true);
    // 親機: つながり直したら、判断と共有中の接続情報を再送する(Direct は作り直さず、子機は同じ SSID を再利用する)
    if (role === 'host') {
      this.sendPlan();
      this.sendTiming();
      if (this.shareMsg) {
        // Direct のグループが消えていたら、接続情報を再送 → Nearby を閉じる → グループ再作成の順で作り直す。
        // グループが生きていれば維持して、接続情報を再送するだけ(子機は同じ SSID に入り直す)
        if (this.suspendOk && this.shareMsg.method === 'WifiDirect' && this.data.group === false) void this.rebuildDirect(gen).catch((e) => this.log('Direct 作り直しで例外: ' + (e?.message ?? e)));
        else {
          if (this.suspendOk) this.gnote(`Nearby 再接続: Direct グループは${this.data.group === null ? '不明(維持とみなす)' : '生きている(維持)'} → 接続情報の再送のみ`);
          this.sendShare();
        }
      }
    } else {
      // 子機: 接続情報より先に、能力の版を親機へ知らせる
      void this.sendHello(gen).catch(() => {});
    }
  }

  private onWire(gen: number, role: TetherRole, peerId: string, body: unknown, from?: Carrier): void {
    if (gen !== this.gen) return;
    if (!isWire(body)) return; // 知らない形式は捨てる
    this.touchPeer(peerId);
    switch (body.kind) {
      case 'tether.app':
        // アプリのメッセージはバスだけで運ぶ。Nearby から来たものは受け付けない(旧版の相手など)
        if (from === 'nearby') { this.gnote(`受信[アプリ] 種別=${kindOf(body)} ← Nearby(破棄: アプリのメッセージはバスのみ)`); break; }
        this.gnote(`受信[アプリ] 種別=${kindOf(body)} ← バス`);
        for (const cb of [...this.msgSubs]) {
          try { cb(body.body, { role, peerId }); } catch (e: any) { this.log('onMessage で例外: ' + (e?.message ?? e)); }
        }
        break;
      case 'tether.unpair':
        // 子機が解除した: 親機は該当ペアと direct.v1.<peerId> を消す
        if (role === 'host') void this.forgetPair(peerId).catch((e) => this.log('unpair 処理で例外: ' + (e?.message ?? e)));
        break;
      case 'tether.wifi':
        if (role !== 'guest') break;
        if (body.rebuild && this.suspendOk && !this.vpnHold) void this.rejoinAfterRebuild(gen, body).catch((e) => this.log('rejoin で例外: ' + (e?.message ?? e)));
        else void this.join(gen, body, false);
        break;
      case 'tether.hello':
        if (role === 'host') void this.onHello(gen, peerId, body.v, body.rev).catch((e) => this.log('hello 処理で例外: ' + (e?.message ?? e)));
        break;
      case 'tether.caps-req':
        if (role === 'guest') void this.sendCaps(gen).catch(() => {});
        break;
      case 'tether.caps':
        if (role === 'host') void this.onCaps(gen, peerId, body.v, body.rev, body.caps).catch((e) => this.log('caps 処理で例外: ' + (e?.message ?? e)));
        break;
      case 'tether.timing':
        if (role === 'guest') {
          this.adoptHostTiming(gen, body.timing);
          if (body.probe && typeof body.probe === 'object') this.monitor.adoptHost(body.probe);
        }
        break;
      case 'tether.internet':
        // 外形監視の報告はバスだけで運ぶ(アプリメッセージ扱い)。Nearby から来たものは受け付けない
        if (role !== 'host') break;
        if (from === 'nearby') { this.gnote('受信[外形監視] ← Nearby(破棄: バスのみ)'); break; }
        this.monitor.receive(body);
        break;
      case 'tether.plan':
        if (role === 'guest') void this.onPlan(gen, body.plan).catch((e) => this.log('plan 処理で例外: ' + (e?.message ?? e)));
        break;
      case 'tether.wifi-result':
        if (role === 'host') {
          if (this.state.shareMethod) void this.record(this.state.shareMethod, 'join', body.ok);
          this.peerReachKnown = true;
          this.data = { ...this.data, reach: { ok: body.ok, at: this.p.now(), rttMs: body.rttMs, error: body.error } };
          this.set({ peerReach: { ok: body.ok, rttMs: body.rttMs, error: body.error } });
          if (body.ok) this.hostPeerReady('wifi-result');
          this.log(`子機の到達確認: ${body.ok ? `OK ${body.rttMs}ms` : `NG ${body.error ?? ''}`}`);
        }
        break;
      case 'tether.need-wifi':
        if (role === 'host' && this.shareMsg) this.sendShare();
        break;
    }
  }

  // ---------- 子機: 参加と VPN ----------

  private onWifiLost(gen: number): void {
    if (gen !== this.gen) return;
    this.nearbyDirectActive(false);
    this.safeStopVpn();
    this.gov.forgetAlive(); this.data = { ...this.data, group: false, heartbeat: null, okAt: null, busAt: null, netAt: null, aliveAt: null };
    this.monitor.setActive(false);
    this.stopBus('wifi-lost');
    this.gateway = null;
    this.set({ wifi: 'off', vpn: this.vpnHold ? 'held' : 'off' });
    this.guard(gen, { t: 'lost', reason: 'wifi-lost' });
    this.log('Wi-Fi Direct 切断 → VPN を停止');
    // Nearby がつながっていれば、親機に接続情報をもう一度送ってもらう
    if (this.state.link === 'connected' && !this.vpnHold) {
      this.ctl?.send({ kind: 'tether.need-wifi' } satisfies Wire, { key: 'need-wifi', ttlMs: 30_000 });
    }
  }

  /** 受け取った接続情報で参加し、親機のポートへの到達を確かめて結果を返し、VPN を張る */
  private async join(gen: number, m: WifiMsg, force: boolean, timeoutMs?: number): Promise<void> {
    if (this.joining) return;
    // 同じ接続情報の再送で、動いている VPN を張り直さない(親機の再送・再接続のたびに通信が途切れるのを避ける)
    if (!force && this.state.vpn === 'on' && this.state.wifi === 'joined' && this.lastJoined && sameWifi(this.lastJoined, m)) {
      this.ctl?.send({ kind: 'tether.wifi-result', ok: true } satisfies Wire, { key: 'wifi-result', ttlMs: WIFI_TTL_MS });
      this.guard(gen, { t: 'ready' });
      return;
    }
    this.lastJoined = m;
    if (this.vpnHold && !force) {
      this.log('VPN は非常口で停止中のため、接続情報を保存のみ');
      return;
    }
    this.joining = true;
    const h = this.hotspot;
    this.set({ wifi: 'joining', error: null, joinFailure: null });
    this.log(`接続情報を受信 ssid=${m.ssid} → 参加(端末の承認ダイアログが出たら許可)`);
    try {
      // 固定 SSID なら、承認ダイアログで「常に許可」を選んだ後は OS が覚える
      const { gateway } = await h.joinWifi(m.ssid, m.pass, timeoutMs ?? this.timing.joinTimeoutMs);
      if (gen !== this.gen) return;
      // join ok は OS が local-only ネットワークを渡しただけ。実際に親機まで届くかは、このあとの到達確認・VPN のログで見る
      this.log(`参加 ok gw=${gateway} → 到達確認(link=${this.state.link})`);
      this.gateway = gateway;
      this.lastPort = m.port;
      this.data = { ...this.data, group: true };
      this.set({ wifi: 'joined' });
      this.nearbyDirectActive(true);
      this.syncInternet(gen); // 参加できた直後に最初の外形監視をすぐ始める(到達確認・VPN 起動と並行)
      // 親機のポートが開くのが少し遅れることがあるので、一定間隔で再試行する
      const retries = this.cfg.probeRetries ?? 10;
      let res = await h.probe(gateway, m.port);
      for (let i = 1; i < retries && !res.ok; i++) {
        this.log(`到達確認 NG(${i}/${retries}): ${res.error}`);
        await this.p.sleep(this.cfg.probeIntervalMs ?? 2000);
        if (gen !== this.gen) return;
        res = await h.probe(gateway, m.port);
      }
      this.log(`到達確認 ${res.ok ? `OK ${res.rttMs}ms` : `NG ${res.error}`}`);
      this.data = { ...this.data, reach: { ok: res.ok, at: this.p.now(), rttMs: res.rttMs, error: res.error }, ...(res.ok ? { heartbeat: { ok: true, at: this.p.now() }, okAt: this.p.now() } : {}) };
      this.ctl?.send({ kind: 'tether.wifi-result', gateway, ...res } satisfies Wire, { key: 'wifi-result', ttlMs: WIFI_TTL_MS });
      if (res.ok) await this.startVpn(gen, gateway, m.socks);
      else this.set({ error: '親機に届きません。親機が近くにあり、共有が始まっているか確認してください' });
    } catch (e: any) {
      if (gen !== this.gen) return;
      const msg = String(e?.message ?? e);
      this.log('参加失敗: ' + msg);
      const failure = parseJoinFailure(msg);
      this.log(`参加失敗の理由: ${failure.reason} / ${joinFailureDetail(failure)}`);
      this.set({ wifi: 'failed', error: joinFailureText(failure.reason), joinFailure: failure });
      this.data = { ...this.data, reach: { ok: false, at: this.p.now(), error: msg } };
      // 作り直しの待ち中は失敗を送らない(Nearby は止めてあり、繰り返し試す)
      if (!this.rejoining) this.ctl?.send({ kind: 'tether.wifi-result', ok: false, error: msg } satisfies Wire, { key: 'wifi-result', ttlMs: WIFI_TTL_MS });
    } finally {
      this.joining = false;
      // 取りこぼしの保険: 参加の処理が終わったら許可画面の案内は出さない
      if (gen === this.gen && this.state.joinPrompt) this.set({ joinPrompt: false });
    }
  }

  private async startVpn(gen: number, gateway: string, socks: Socks): Promise<void> {
    const v = this.p.vpn;
    try {
      const waitSec = this.cfg.vpnPermissionWaitSec ?? 60;
      this.set({ vpn: 'starting' });
      for (let i = 0; i < waitSec && !v.prepare(); i++) {
        if (i === 0) {
          this.set({ vpn: 'awaiting-permission' });
          this.log('VPN の許可ダイアログで「OK」を押してください');
        }
        await this.p.sleep(1000);
        if (gen !== this.gen || this.vpnHold) return;
      }
      if (gen !== this.gen || this.vpnHold) return;
      if (!v.prepare()) {
        this.set({ vpn: 'failed', error: 'VPN の許可が得られませんでした' });
        return;
      }
      this.set({ vpn: 'starting' });
      if (!this.hotspot.bindToJoined()) this.log('Wi-Fi への固定に失敗');
      // バスの接続は、プロセスを Direct の Wi-Fi に固定したあとに始める(ZeroMQ のソケットは Network を指定できず、プロセスの固定に従う)
      this.startBusGuest(gateway, this.lastJoined?.busPort);
      v.start(gateway, socks.port, socks.user, socks.pass);
      await this.p.sleep(1500);
      if (gen !== this.gen || this.vpnHold) return;
      const st = v.status();
      this.log(`VPN ${st.running ? '起動' : '失敗'}${st.error ? ' ' + st.error : ''}`);
      this.log(`参加後の状態 wifi=${this.state.wifi} vpn=${st.running ? 'on' : 'failed'} link=${this.state.link} attempt=${this.state.attempt}`);
      this.set(st.running ? { vpn: 'on', error: null } : { vpn: 'failed', error: 'VPN を起動できませんでした' + (st.error ? `: ${st.error}` : '') });
      if (st.running) this.guard(gen, { t: 'ready' });
    } catch (e: any) {
      this.log('VPN 失敗: ' + (e?.message ?? e));
      this.set({ vpn: 'failed', error: 'VPN 失敗: ' + (e?.message ?? e) });
    }
  }

  // ---------- 時間の設定・状態の公開 ----------

  /** いま有効な時間設定（既定 < cfg.timing < 保存した上書き < 親機から配られた分）。start() のたびに決まる */
  getTiming(): LinkTimingConfig {
    return { ...this.timing, retryBackoffMs: [...this.timing.retryBackoffMs] };
  }

  /**
   * 開発・検証用: 時間設定を保存して、次の start() から効かせる（再ビルド不要）。null で消す。保存先は kv（本番は SecureStore）。
   * 範囲外の値は start() で既定に丸められる。子機は親機の設定（閾値・hb・再接続）を受け取って上書きするので、通常は親機にだけ入れる。
   */
  async setTimingOverride(patch: Partial<LinkTimingConfig> | null): Promise<void> {
    if (patch === null) { if (this.p.kv.remove) await this.p.kv.remove(TIMING_KEY); else await this.p.kv.set(TIMING_KEY, ''); }
    else await this.p.kv.set(TIMING_KEY, JSON.stringify(patch));
  }

  // ---------- インターネット外形監視(公開の口は 2 つ: enable / update) ----------

  /**
   * インターネットへの到達の外形監視。tether は probe の実装を抱え込まず、結果を受ける 2 つの口だけを持つ(docs/EXTERNAL_PROBE.md)。
   *  - `internet.enable(on, opts?)`: 有効/無効と設定(intervalMs・failThreshold・recoverThreshold など。opts.runner で既定の probe 供給元を使うか選ぶ)
   *  - `internet.update(success, at?, reason?)`: 実際に通信できたか(供給元の結果でも、アプリが VPN 越しの実通信で観測した結果でもよい)
   * 結果は state.internet(ok | ng | unknown)に出て、成功のたびに生存確認を延命し、親機へ報告(tether.internet。バス専用)される。
   */
  readonly internet = {
    enable: (on: boolean, opts: Partial<Omit<InternetConfig, 'enabled'>> & { runner?: 'native' | 'none' } = {}): void => {
      const { runner, ...cfg } = opts;
      if (runner !== undefined) this.probeRunnerMode = runner === 'none' ? 'none' : 'native';
      this.monitor.enable(on, cfg);
      this.syncInternet(this.gen);
    },
    update: (success: boolean, at?: number, reason?: string): boolean => this.monitor.update(success, at, reason),
    /** いま有効な設定(親機から配られた値を含む) */
    getConfig: (): InternetConfig => this.monitor.config,
  };

  /** 開発・検証用: 外形監視の設定を保存して、次の start() から効かせる。null で消す */
  async setInternetOverride(patch: Partial<InternetConfig> | null): Promise<void> {
    if (patch === null) { if (this.p.kv.remove) await this.p.kv.remove(INTERNET_KEY); else await this.p.kv.set(INTERNET_KEY, ''); }
    else await this.p.kv.set(INTERNET_KEY, JSON.stringify(patch));
  }

  private async resolveInternet(): Promise<void> {
    let saved: Partial<InternetConfig> = {};
    try {
      const raw = await this.p.kv.get(INTERNET_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch { saved = {}; }
    this.monitor.configure({ ...(this.cfg.internet ?? {}), ...saved }, { unchecked: this.cfg.timingUnchecked });
  }

  /**
   * 子機: 外形監視を、あるべき状態(有効・Wi-Fi 参加済み・再接続中でない)に合わせる。毎 tick と参加直後に呼ぶ。
   * 既定の供給元(ネイティブ)はここで始め/止め、新しい結果を update に渡す。親機は監視しない(子機の報告を受けるだけ)。
   */
  private syncInternet(gen: number): void {
    if (gen !== this.gen) return;
    const guest = this.state.role === 'guest';
    const phaseOk = this.gov.phase !== 'retrying' && this.gov.phase !== 'rejoining';
    const want = guest && this.monitor.enabled && this.state.wifi === 'joined' && !!this.gateway && !!this.lastJoined && phaseOk && this.retry === null;
    this.monitor.setActive(want);
    this.monitor.tick();
    if (!guest) return;
    if (want && this.probeRunnerMode === 'native') {
      const j = this.lastJoined as WifiMsg;
      this.probeRunner.sync({ socksHost: this.gateway as string, socksPort: j.socks.port, user: j.socks.user, pass: j.socks.pass, cfg: this.monitor.config, wakeLock: this.cfg.hbWakeLock ?? true });
      this.probeRunner.poll();
    } else this.probeRunner.stop(want ? '供給元を使わない設定' : '不要になった(無効・未参加・再接続中)');
  }

  private async resolveTiming(role: TetherRole): Promise<void> {
    let saved: Partial<LinkTimingConfig> = {};
    try {
      const raw = await this.p.kv.get(TIMING_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch { saved = {}; }
    const t = resolveTiming({ ...(this.cfg.timing ?? {}), ...saved }, { unchecked: this.cfg.timingUnchecked, log: (l) => this.gnote('timing: ' + l) });
    this.timing = t;
    this.gnote(`timing role=${role} source=${Object.keys(saved).length ? 'config+保存した上書き' : 'config'} ${JSON.stringify(t)}`);
  }

  /**
   * 再接続専用: Direct の作り直しと Nearby 復帰の再試行を、LinkGovernor の遷移表に沿って始める(画面の「つなぎ直す」用)。
   *  - 親機: Wi-Fi Direct の共有中なら rebuildDirect(接続情報の再送 → Nearby を閉じる → グループ再作成 → 子機を待つ。子機が戻らなければ表どおり Nearby を再開)。
   *    共有していなければ shareNow()。
   *  - 子機: Direct 稼働中(phase=direct)なら lost('manual') で retrying へ(保存済みの情報で再参加。尽きれば表どおり Nearby を再開)。
   *  - すでに再接続中(retrying / rejoining)・停止中は何もしない(二重起動しない)。
   * 戻り値 action: 'rebuild' | 'retry' | 'share' | 'none'(reason に理由)。Nearby や Direct を直接は触らず、必ず governor を通る。
   */
  async restartLink(): Promise<{ action: 'rebuild' | 'retry' | 'share' | 'none'; reason?: string }> {
    const role = this.state.role;
    const gen = this.gen;
    if (!this.state.started || !role) return { action: 'none', reason: 'stopped' };
    const phase = this.gov.phase;
    if (phase === 'retrying' || phase === 'rejoining') {
      this.gnote(`つなぎ直し要求: すでに再接続中(${phase})のため何もしない`);
      return { action: 'none', reason: 'in-progress' };
    }
    if (role === 'host') {
      if (this.suspendOk && this.shareMsg && this.shareMsg.method === 'WifiDirect' && this.state.share === 'on') {
        this.gnote('つなぎ直し要求(親機): Direct を作り直す');
        void this.rebuildDirect(gen).catch((e) => this.log('Direct 作り直しで例外: ' + (e?.message ?? e)));
        return { action: 'rebuild' };
      }
      if (this.sharing) return { action: 'none', reason: 'in-progress' };
      this.gnote('つなぎ直し要求(親機): 共有をやり直す');
      await this.shareNow();
      return { action: 'share' };
    }
    if (phase === 'direct') {
      this.gnote('つなぎ直し要求(子機): Direct を再接続する');
      this.guard(gen, { t: 'lost', reason: 'manual' });
      return { action: 'retry' };
    }
    return { action: 'none', reason: `phase=${phase}` };
  }

  /** 画面用: いまの状態(内部名・日本語ラベル・経過・次の遷移までの残り・試行回数)、遷移履歴、総合状態、データ経路、有効な設定値 */
  linkSnapshot(): LinkSnapshot {
    return this.gov.snapshot();
  }

  /** 画面用: linkSnapshot が変わるたびに呼ばれる。戻り値で購読解除 */
  onLink(cb: (s: LinkSnapshot) => void): () => void {
    return this.gov.subscribe(cb);
  }

  private linkContext(): LinkContext {
    const s = this.state;
    return {
      role: s.role, started: s.started, suspend: this.suspendOk,
      carriers: { control: this.pickCarrier(), appPending: this.ctl?.appPending ?? 0 },
      creating: s.role === 'host' && s.share === 'starting', joining: s.role === 'guest' && s.wifi === 'joining',
      directUp: s.role === 'host' ? s.share === 'on' && this.data.group !== false : s.wifi === 'joined',
      nearbyUp: s.link === 'connected', resumedBecause: this.resumedBecause, attempt: this.retry ? { n: this.retry.attempt, max: this.retry.max } : null,
      overall: s.overall, nearby: s.nearby, data: this.data, since: this.since, timing: { ...this.timing, guard: this.gov.timing },
      internet: this.monitor.status, remoteInternet: this.monitor.remoteStatus,
    };
  }

  /** 親機が正の時間設定を子機へ配る(hello への返答。再接続でも送り直す) */
  private sendTiming(): void {
    this.ctl?.send({ kind: 'tether.timing', v: 1, timing: { ...pickShared(this.timing) }, probe: { ...this.monitor.config } } satisfies Wire, { key: 'timing', ttlMs: WIFI_TTL_MS });
  }

  /** 子機: 親機の共有の時間設定(閾値・hb・再接続)を採用する */
  private adoptHostTiming(gen: number, raw: Record<string, unknown>): void {
    if (gen !== this.gen || this.state.role !== 'guest') return;
    const shared = resolveTiming(raw as Partial<LinkTimingConfig>, { unchecked: this.cfg.timingUnchecked, log: (l) => this.gnote('timing(親機から): ' + l) });
    this.timing = { ...this.timing, ...pickShared(shared) };
    this.gov.setTiming(toGuardTiming(this.timing, 'guest'));
    this.gnote(`timing 親機の設定を採用 ${JSON.stringify(pickShared(this.timing))}`);
    this.set({});
  }

  // ---------- Direct が生きている間は Nearby を止める ----------
  //
  // 判断の理由と状態遷移は src/link/directGuard.ts(純関数)。ここは信号を集めて、返ってきた動作(suspend / resume)を実行する。

  private hbMs(): number {
    return this.timing.hbIntervalMs;
  }

  /** 判定の理由を診断ログ(DH-TETHER)と logcat(DH-NEARBY)の両方に残す。ssid・pass・secret は含めない */
  private gnote(msg: string): void {
    this.log('[DH-LINK] ' + msg);
    try { this.p.nearby.note?.(msg); } catch {}
  }

  private setupDirectGuard(gen: number, role: TetherRole): void {
    // 常に suspend。Nearby 部品が suspend() を持たない旧部品のときだけ、止められないので従来動作(止めない)で縮退する
    this.suspendOk = typeof this.nearby.suspend === 'function';
    if (!this.suspendOk) this.log('[警告] この Nearby 部品は suspend() 未対応のため、Direct 中も Nearby を止められません(従来動作で動きます)。部品を更新してください');
    this.gov.setTiming(toGuardTiming(this.timing, role));
    this.gov.setStrict(this.cfg.strictLinkGuard);
    this.gov.reset();
    this.data = initialDataPath();
    this.peerReachKnown = false;
    this.echoCount = 0;
    this.echoFirstAt = null;
    this.log(`Nearby と Direct: Direct 稼働中は Nearby を止める ${JSON.stringify(this.gov.timing)}`);
    // データ経路の観測は suspend できない旧部品でも行う(総合状態 overall に使う)
    if (role === 'host') {
      this.offGroup = this.hotspot.onDirectGroup?.((e) => this.onDirectGroup(gen, e)) ?? null;
      this.offEcho = this.hotspot.onEchoAccept?.(() => this.onEchoAccept(gen)) ?? null;
    }
    if (!this.suspendOk) return;
    void this.guardLoop(gen);
    if (role === 'guest') void this.heartbeatLoop(gen);
  }

  /** 事象を governor(遷移表)に入れる。動作は onAction → runAction で実行される */
  private guard(gen: number, ev: GuardEvent): void {
    if (gen !== this.gen || !this.suspendOk) return;
    const before = this.gov.phase;
    this.gov.dispatch(ev);
    if (this.retry && this.gov.phase !== 'retrying') this.retry = null;
    if (this.gov.phase === 'direct') this.resumedBecause = null;
    if (before !== this.gov.phase) { this.ctl?.reconcile(); this.set({}); }
  }

  private runAction(a: Exclude<GuardAction, { type: 'note' }>): void {
    const gen = this.gen;
    if (a.type === 'suspend') void this.suspendNearby(gen).catch((e) => this.log('Nearby 停止で例外: ' + (e?.message ?? e)));
    else if (a.type === 'resume') this.resumeNearby(gen, a.reason);
    else if (a.type === 'retry') void this.runRetry(gen, a.reason).catch((e) => this.log('Direct 再接続で例外: ' + (e?.message ?? e)));
  }

  /** Nearby 再開待ち(retrying / 作り直し中)の間、残り秒を定期的に DH-LINK へ出す。方針・遷移は変えない */
  private logResumeEta(): void {
    const ls = this.state.linkState;
    const w = ls?.waiting;
    if (!ls || !w || !isResumeWaitingName(ls.name)) { this.resumeEtaLogAt = null; return; }
    const now = this.p.now();
    if (!shouldLogResumeEta(this.resumeEtaLogAt, now)) return;
    this.resumeEtaLogAt = now;
    this.gnote(formatResumeEta(w.remainingMs, this.retry?.reason ?? null, this.retry ? this.retry.attempt : null));
  }

  private async guardLoop(gen: number): Promise<void> {
    const tickMs = this.timing.tickMs;
    let last = this.p.now();
    while (gen === this.gen) {
      await this.p.sleep(tickMs);
      if (gen !== this.gen) return;
      const t = this.p.now();
      // JS が止まっていた(画面オフ・Doze)あとの最初の tick は、無通信を数え直す(止まっていた間は相手の通信も遅れたとみなす)
      // ネイティブのハートビートが動いていれば、まずその最新の結果を読む。止まっていた時間は「失敗」ではなく、
      // ネイティブが記録した最後の成功時刻で判定する(ネイティブ自身も止まっていた場合だけ、従来どおり数え直す)
      const nativeFresh = this.syncNativeHb(gen);
      if (t - last > Math.max(tickMs * 5, 3_000)) {
        if (nativeFresh) this.gnote(`判定が ${t - last}ms 止まっていた(Doze など): ネイティブのハートビート結果で判定(数え直さない)`);
        else {
          this.gnote(`判定が ${t - last}ms 止まっていた(Doze など): 無通信の数え直し`);
          this.gov.grace();
        }
      }
      last = t;
      const aliveBefore = this.gov.lastAliveAt;
      this.syncBus(gen);
      this.syncInternet(gen);
      this.bus?.sweep(); // 溜めたままの期限切れ(アプリのメッセージ)を捨てて記録する
      this.guard(gen, { t: 'tick' });
      const before = this.state.overall;
      this.deriveState();
      this.logResumeEta();
      // 生存信号(バスの aliveAt 等)だけが進んだ tick でも購読者へ知らせる。overall が変わらないと set() が呼ばれず、
      // 画面が持つ snapshot / state.data の lastAliveAt が古いままになり「生存確認」が NG に見えるため
      if (this.state.overall !== before) this.set({});
      else if (this.gov.lastAliveAt !== aliveBefore) { this.notify(); this.gov.notify(); }
    }
  }

  /**
   * 子機: ネイティブのハートビートを、あるべき状態(Wi-Fi 参加中・親機の IP が分かっている)に合わせて開始/停止/結果の取り込みをする。
   * 戻り値 = ネイティブの結果が新鮮(ネイティブ自身が止まっていない)なら true。使えない部品・起動失敗は false(JS の heartbeatLoop が動く)。
   */
  private syncNativeHb(gen: number): boolean {
    const h = this.hotspot;
    if (typeof h.heartbeatStart !== 'function' || typeof h.heartbeatStatus !== 'function') return false;
    const want = this.state.role === 'guest' && this.suspendOk && this.state.wifi === 'joined' && !!this.gateway;
    if (!want) { this.stopNativeHb('不要になった(Wi-Fi 未参加・停止)'); return false; }
    // バスが認証済み(または起動/切断の直後で結果待ち)の間は Echo を始めない・止める。バス断が grace 続いたら再開する(ヒステリシス)
    if (this.busHoldsEcho()) {
      this.stopNativeHb('バス接続中は Echo を省く');
      return true; // 生存信号はバスの aliveAt イベント(ネイティブが更新)。JS が止まっていた間も数え直さない
    }
    const host = this.gateway as string;
    const port = this.lastPort;
    if (!this.hbNative || this.hbNative.host !== host || this.hbNative.port !== port) {
      this.stopNativeHb('接続先が変わった');
      const hb = this.hbMs();
      let off = this.cfg.hbScreenOffIntervalMs;
      if (off !== undefined) off = Math.max(hb, Math.min(off, Math.floor(this.gov.timing.echoMs / 2)));
      try {
        h.heartbeatStart({ host, port, intervalMs: hb, timeoutMs: Math.min(3_000, hb), screenOffIntervalMs: off, wakeLock: this.cfg.hbWakeLock ?? true });
      } catch (e: any) {
        this.gnote(`ネイティブのハートビート起動失敗(JS で代替): ${e?.message ?? e}`);
        return false;
      }
      this.hbNative = { host, port };
      this.hbFailNoted = 0;
      this.offHb = h.onHeartbeat?.((st) => { if (gen === this.gen) this.applyNativeHb(gen, st); }) ?? null;
      this.gnote(`ネイティブのハートビート開始 ${hb}ms${off ? ` (画面オフ中 ${off}ms)` : ''}: JS が止まっても親機のエコーへ送り続ける`);
    }
    let st: NativeHeartbeatStatus;
    try { st = h.heartbeatStatus(); } catch { return false; }
    if (!st.running) { this.stopNativeHb('ネイティブが停止していた'); return false; }
    this.applyNativeHb(gen, st);
    // ネイティブ自身が長く試行していない(CPU が眠っていた等)ときは、結果を新鮮とみなさない
    const ref = st.lastAttemptAt || 0;
    return ref > 0 && this.p.now() - ref <= this.hbMs() * 2.5 + 3_000;
  }

  private stopNativeHb(why: string): void {
    this.offHb?.(); this.offHb = null;
    if (!this.hbNative) return;
    this.hbNative = null;
    try { this.hotspot.heartbeatStop?.(); } catch {}
    this.gnote(`ネイティブのハートビート停止(${why})`);
  }

  /**
   * 生存信号の最終成功時刻(lastAliveAt)を governor に入れる唯一の入口。送信元は問わない
   * (いまはネイティブの Echo ハートビート。Direct 上のバスの ping に置き換わっても、ここへ at を渡すだけでよい)。
   * 新しい時刻なら true。
   */
  private noteAliveAt(gen: number, at: number, src: 'echo' | 'bus' | 'net' = 'echo'): boolean {
    if (gen !== this.gen) return false;
    if (src === 'echo') {
      if (at <= (this.data.okAt ?? 0)) return false;
      this.data = { ...this.data, heartbeat: { ok: true, at }, okAt: at };
    } else if (src === 'net') {
      // 外形監視による延命(子機: 自分の観測 / 親機: 子機の ok の報告)。heartbeat 表示や ready の副作用は持たない。
      // 上限: Echo・バスの最後の生存から T_direct を超えたら延命しない(制御の死を隠さない。docs/EXTERNAL_PROBE.md §2)
      if (at <= (this.data.netAt ?? 0)) return false;
      const base = Math.max(this.data.okAt ?? 0, this.data.busAt ?? 0, this.data.echoAt ?? 0);
      if (base > 0 && at - base >= this.gov.timing.directMs) {
        if (at - this.netCapNoted >= 60_000) { this.netCapNoted = at; this.gnote(`外形監視の成功では延命しない: Echo/バスの最後の生存から ${at - base}ms(上限 T_direct=${this.gov.timing.directMs}ms)`); }
        return false;
      }
      this.data = { ...this.data, netAt: at };
    } else {
      if (at <= (this.data.busAt ?? 0)) return false;
      this.data = { ...this.data, busAt: at };
    }
    // 最終時刻の保持は LinkGovernor(max。古い時刻へは戻さない)。画面・判定はそこから反映した aliveAt だけを読む
    this.gov.noteAliveAt(at);
    this.data = { ...this.data, aliveAt: this.gov.lastAliveAt };
    this.guard(gen, { t: 'alive' });
    const kept = this.gov.lastAliveAt;
    if (kept !== null) this.gov.setAliveAt(kept);
    if (src !== 'net' && this.gov.phase === 'nearby' && this.state.vpn === 'on' && !this.joining) this.guard(gen, { t: 'ready' });
    return true;
  }

  /** ネイティブの結果(最後の成功/失敗の時刻)を取り込む。時刻は結果が出た時刻そのもの=JS が止まっていた間も正しい */
  private applyNativeHb(gen: number, st: NativeHeartbeatStatus): void {
    if (gen !== this.gen || !this.hbNative) return;
    let changed = false;
    if (this.noteAliveAt(gen, st.lastOkAt)) changed = true;
    if (st.consecutiveFailures > 0 && st.lastFailAt > (this.data.heartbeat?.at ?? 0) && st.lastFailAt >= st.lastOkAt) {
      this.data = { ...this.data, heartbeat: { ok: false, at: st.lastFailAt } };
      if (st.consecutiveFailures !== this.hbFailNoted) {
        this.hbFailNoted = st.consecutiveFailures;
        this.gnote(`ハートビート失敗(ネイティブ): ${st.lastError ?? '?'} 連続 ${st.consecutiveFailures} 回(最後の成功から ${st.lastOkAt ? st.lastFailAt - st.lastOkAt : '?'}ms。T_echo=${this.gov.timing.echoMs}ms で異常とみなす)`);
      }
      changed = true;
    }
    if (st.consecutiveFailures === 0) this.hbFailNoted = 0;
    if (changed) this.set({});
  }

  /** 子機: Direct 上のエコー(親機の 9000)へ定期的に接続して生存を確かめる。親機側はこの接続の有無で子機の生存を見る */
  private async heartbeatLoop(gen: number): Promise<void> {
    const hb = this.hbMs();
    let lastAt = this.p.now();
    while (gen === this.gen) {
      await this.p.sleep(hb);
      if (gen !== this.gen) return;
      if (!this.suspendOk || this.state.wifi !== 'joined' || !this.gateway) { lastAt = this.p.now(); continue; }
      // バスが生きていれば(ネイティブの ping/pong が新しい)Echo は省く。バス接続が生存信号を兼ねる。旧版の親機・バス断のときは従来どおり Echo
      if (this.busHoldsEcho()) { lastAt = this.p.now(); continue; }
      if (this.hbNative) { lastAt = this.p.now(); continue; } // ネイティブが送っている間は JS からは送らない
      const gap = this.p.now() - lastAt > hb * 2.5;
      let res = await this.hotspot.probe(this.gateway, this.lastPort);
      // 長く眠っていた直後の 1 回目の失敗は、回線が起き切っていないだけのことが多い: 数えずに 1 回やり直す
      if (!res.ok && gap) {
        this.gnote(`ハートビート: 間隔が空いたあとの失敗(${res.error ?? '?'}) → 数えずにやり直す`);
        await this.p.sleep(1_000);
        if (gen !== this.gen) return;
        res = await this.hotspot.probe(this.gateway ?? '', this.lastPort);
      }
      lastAt = this.p.now();
      if (gen !== this.gen) return;
      if (res.ok) {
        this.data = { ...this.data, heartbeat: { ok: true, at: lastAt }, okAt: lastAt };
        this.guard(gen, { t: 'alive' });
        if (this.gov.phase === 'nearby' && this.state.vpn === 'on' && !this.joining) this.guard(gen, { t: 'ready' });
      } else {
        this.data = { ...this.data, heartbeat: { ok: false, at: lastAt } };
        this.gnote(`ハートビート失敗: ${res.error ?? '?'}(最後の成功から ${lastAt - (this.data.okAt ?? lastAt)}ms。T_echo=${this.gov.timing.echoMs}ms で異常とみなす)`);
      }
      this.set({});
    }
  }

  // ---------- 制御バス(Direct 上の ZeroMQ。modules/hotspot の BusEngine) ----------

  /** いまの運び先: バスが認証済みになったことがあり、Direct 稼働中で Nearby を止めているあいだはバス。それ以外は Nearby */
  private pickCarrier(): Carrier {
    return this.bus && this.busRunning && this.busSeenUp && this.suspendOk && !this.gov.nearbyAllowed ? 'bus' : 'nearby';
  }

  /** 送信のログ(DH-LINK。中身は出さず、種別と運び先だけ) */
  private logSend(r: SendReport): void {
    if (r.channel === 'ctl') { this.gnote(`送信[制御] 種別=${r.kind} → ${r.to === 'bus' ? 'バス' : 'Nearby'}`); return; }
    if (r.outcome === 'sent') this.gnote(`送信[アプリ] 種別=${r.kind} → バス`);
    else if (r.outcome === 'queued') this.gnote(`送信[アプリ] 種別=${r.kind} → 溜め(${this.busRunning ? 'バス切断中・再接続待ち' : 'Direct/バス未確立'})`);
    else this.gnote(`送信[アプリ] 種別=${r.kind} → 破棄(${r.reason === 'limit' ? '上限' : r.reason === 'no-bus' ? 'バス部品なし' : 'ttl=0 でバス未接続'})`);
  }

  private onBusEvent(e: BusEvent): void {
    const tag = e.channel === 'app' ? 'アプリ' : '制御';
    if (e.ev === 'flush') this.gnote(`送信[${tag}] 種別=${e.kind} → バス(溜めていた分)`);
    else this.gnote(`送信[${tag}] 種別=${e.kind} → 破棄(${e.reason === 'limit' ? '上限' : 'ttl'})`);
  }

  private busTiming(): { pingMs: number; timeoutMs: number } {
    // ZMTP heartbeat: IVL / TIMEOUT(= TTL)は timing(busIvlMs / busTimeoutMs)。T_echo より先にバス自身が切れを知る
    return { pingMs: this.timing.busIvlMs, timeoutMs: this.timing.busTimeoutMs };
  }

  /** 親機: Direct のグループができたあとにバスを待ち受けさせる。返す番号は tether.wifi の busPort に載せる(null = 使わない) */
  private startBusHost(): number | null {
    const bus = this.p.bus;
    if (!bus || !this.bus || !this.suspendOk || !this.busKey || !this.peerId || !this.busSelf) return null;
    try {
      if (this.busRunning) bus.stop();
      const t = this.busTiming();
      const bound = bus.start({ host: true, selfId: this.busSelf, peerId: this.peerId, keyHex: this.busKey, addr: null, port: BUS_PORT, ...t });
      this.busRunning = true;
      this.busSeenUp = false;
      this.setBusState('disconnected');
      this.log(`[DH-BUS] 待ち受け ${bound}:${BUS_PORT}`);
      return BUS_PORT;
    } catch (e: any) {
      this.busRunning = false;
      this.log('[DH-BUS] 待ち受け失敗(Nearby のまま): ' + (e?.message ?? e));
      return null;
    }
  }

  /** 子機: 親機が busPort を渡してきたときだけ、Direct の親機へバスをつなぎ続ける(切れても再接続はネイティブが続ける) */
  private startBusGuest(gateway: string, busPort: number | undefined): void {
    const bus = this.p.bus;
    if (!bus || !this.bus || !this.suspendOk || !busPort || !this.busKey || !this.peerId || !this.busSelf) return;
    try {
      if (this.busRunning) bus.stop();
      const bound = bus.start({ host: false, selfId: this.busSelf, peerId: this.peerId, keyHex: this.busKey, addr: gateway, port: busPort, ...this.busTiming() });
      this.busRunning = true;
      this.busSeenUp = false;
      this.setBusState('disconnected');
      this.log(`[DH-BUS] 接続開始 ${bound}`);
    } catch (e: any) {
      this.busRunning = false;
      this.log('[DH-BUS] 接続開始失敗(Nearby のまま): ' + (e?.message ?? e));
    }
  }

  private stopBus(why: string): void {
    if (!this.busRunning) return;
    this.busRunning = false;
    this.busSeenUp = false;
    this.data = { ...this.data, busAt: null, bus: 'off' };
    this.monitor.onBusDown();
    try { this.p.bus?.stop(); } catch {}
    this.log(`[DH-BUS] 停止(${why})`);
    this.ctl?.reconcile();
  }

  private onBusUpDown(gen: number, role: TetherRole, up: boolean, reason: string): void {
    if (gen !== this.gen) return;
    if (up) {
      this.busSeenUp = true;
      this.setBusState('authenticated');
      this.gnote(`バス接続(${reason})`);
      this.noteAliveAt(gen, this.p.now(), 'bus');
      this.aliveFromBus(gen, role);
      this.ctl?.reconcile();
    } else {
      this.setBusState('disconnected');
      this.monitor.onBusDown();
      this.gnote(`バス切断(${reason}): 溜まった分は再接続後に送る。Nearby は止めたまま、バスの再接続を先に待つ`);
      // 生存信号は更新しない。時間が経っても戻らなければ T_echo / T_direct の判定が進む(Nearby に戻るのは governor の判断だけ)
    }
    this.set({});
  }

  /** バスの生存信号が入った: governor に alive を渡し、親機は「子機が Direct に届いた」、子機は VPN が張れていれば ready を出す */
  private aliveFromBus(gen: number, role: TetherRole): void {
    if (role === 'host') this.hostPeerReady('bus');
    else if (this.gov.phase === 'nearby' && this.state.vpn === 'on' && !this.joining) this.guard(gen, { t: 'ready' });
  }

  /** tick で、ネイティブが(JS が止まっていても)更新し続けたバスの最終受信時刻を読み込む */
  private syncBus(gen: number): void {
    if (!this.busRunning || !this.p.bus || !this.state.role) return;
    let st;
    try { st = this.p.bus.status(); } catch { return; }
    if (!st.running) return;
    // ネイティブの up と JS の見ている状態がずれたら合わせる(イベントの取りこぼし対策)
    const nowState: BusLinkState = st.up ? 'authenticated' : 'disconnected';
    if (nowState !== this.data.bus) { this.setBusState(nowState); this.set({}); }
    if (!st.up) return;
    // 生存イベントの時刻はネイティブの値(JS が止まっていて遅れて届いても、その時刻で更新する)
    if (this.noteAliveAt(gen, st.aliveAt ?? st.lastRxAt, 'bus')) this.aliveFromBus(gen, this.state.role);
  }

  private setBusState(s: BusLinkState): void {
    if (this.data.bus === s) return;
    this.busChangedAt = this.p.now();
    this.data = { ...this.data, bus: s };
  }

  /**
   * Echo を始めない/止めてよいか。バスが認証済みの間は常に true(生存信号はバスの aliveAt)。
   * 起動直後・切断直後は grace(hb×2)のあいだ true のまま(結果待ち。tick ごとに Echo が start/stop するのを防ぐヒステリシス)。
   * 切断が grace 続いたら false(Echo を再開)。
   */
  private busHoldsEcho(): boolean {
    if (!this.busRunning) return false;
    if (this.data.bus === 'authenticated') return true;
    return this.p.now() - this.busChangedAt < this.hbMs() * 2;
  }

  private onDirectGroup(gen: number, e: { up: boolean; clients: number; appInitiated?: boolean }): void {
    if (gen !== this.gen) return;
    if (e.appInitiated) { this.data = { ...this.data, group: false }; this.set({}); return; }
    this.data = { ...this.data, group: e.up };
    this.gnote(`DH-P2P グループ変化 up=${e.up} clients=${e.clients}`);
    if (!e.up) this.guard(gen, { t: 'lost', reason: 'group-gone' });
    else if (e.clients === 0) { if (this.gov.phase !== 'nearby') this.guard(gen, { t: 'lost', reason: 'no-clients' }); }
    else this.guard(gen, { t: 'alive' });
    this.set({});
  }

  private onEchoAccept(gen: number): void {
    if (gen !== this.gen) return;
    const now = this.p.now();
    this.gov.noteAliveAt(now);
    this.data = { ...this.data, echoAt: now, aliveAt: this.gov.lastAliveAt };
    this.echoFirstAt ??= now;
    this.echoCount++;
    this.guard(gen, { t: 'alive' });
    this.hostPeerReady('echo');
    this.set({});
  }

  /** 親機: 子機が Direct に届いた(到達確認の報告 or エコー受付)。両端末が suspend のときだけ Nearby を止める準備に入る */
  private hostPeerReady(via: string): void {
    if (!this.suspendOk || this.state.role !== 'host' || this.state.share !== 'on' || this.shareMsg?.method !== 'WifiDirect') return;
    if (via === 'bus') {
      // バスが認証済み = 子機はバスを持つ新しい版で(Echo の回数による推定は不要)
      if (!this.data.reach?.ok) this.data = { ...this.data, reach: { ok: true, at: this.p.now() } };
    } else if (!this.peerReachKnown && !this.inferReachFromEcho(via)) return;
    if (this.gov.phase === 'nearby') {
      this.gnote(`子機が Direct に届いた(${via})`);
      this.guard(this.gen, { t: 'ready' });
    }
  }

  /**
   * 子機の wifi-result(方式の報告)が届かないまま、Echo だけが届いたときの推定。
   * 実機 b6 12:18: 子機が Direct に入ると Wi-Fi LAN 上の Nearby が切れ、子機の wifi-result が親機に届かなかった。
   * 到達確認の probe も Echo に 1 回つながるが、ハートビート(子機が送る)は hb 間隔の半分以上あけて繰り返し来る。
   * 報告が無いうちにそれが来たら、子機は suspend とみなす(あとで wifi-result が届けばそちらを優先)。
   */
  private inferReachFromEcho(via: string): boolean {
    if (via !== 'echo' || this.peerReachKnown || this.echoFirstAt === null || this.echoCount < 2) return false;
    if (this.p.now() - this.echoFirstAt < this.hbMs() / 2) return false;
    this.peerReachKnown = true;
    // 繰り返し届くハートビートは、子機が Direct に届いている証拠(到達確認の代わり)
    if (!this.data.reach?.ok) this.data = { ...this.data, reach: { ok: true, at: this.p.now() } };
    this.gnote(`子機の方式の報告(wifi-result)が未着のまま Echo が ${this.echoCount} 回届いた → 子機は suspend とみなす(Nearby 切断で報告が落ちた可能性)`);
    return true;
  }

  private async suspendNearby(gen: number): Promise<void> {
    const seq = ++this.suspendSeq;
    this.gnote('Nearby を止める: 未確認の送信を待ってから接続を閉じ、広告・探索・stopAllEndpoints を完了まで待つ');
    await this.link?.pause(3_000);
    if (gen !== this.gen || seq !== this.suspendSeq) return;
    await this.nearby.suspend?.();
    if (gen !== this.gen || seq !== this.suspendSeq) {
      // 待っている間に再開が決まった: 止めたままにしない
      if (gen === this.gen) { try { this.nearby.resume?.(); } catch {} }
      return;
    }
    this.nearbySuspended = true;
    this.gov.markNearbyStopped(true);
    this.set({ link: 'waiting' });
    this.gnote('Nearby 停止完了(Direct 稼働中は Nearby の要求を出さない)');
  }

  private resumeNearby(gen: number, reason: string): void {
    const seq = ++this.suspendSeq;
    this.retry = null;
    this.resumedBecause = reason;
    const was = this.nearbySuspended;
    this.nearbySuspended = false;
    this.gov.markNearbyStopped(false);
    this.nearbyDirectActive(false);
    this.gov.forgetAlive(); this.data = { ...this.data, echoAt: null, busAt: null, netAt: null, aliveAt: null };
    this.gnote(`Nearby を再開(理由=${reason}, 停止中だった=${was}, group=${this.data.group}) → 広告・探索へ`);
    const go = () => {
      if (gen !== this.gen || seq !== this.suspendSeq || this.nearbySuspended) return;
      try { this.nearby.resume?.(); } catch {}
      this.link?.resume();
    };
    const delay = this.timing.nearbyResumeDelayMs;
    if (delay > 0) {
      this.gnote(`Nearby 再開の前に ${delay}ms 待つ(timing.nearbyResumeDelayMs)`);
      void this.p.sleep(delay).then(go);
    } else go();
    if (gen === this.gen) this.set({});
  }

  /**
   * 親機: Direct のグループが消えていたときの再接続。順序は厳守する。
   *  1. 接続情報を子機へ再送(rebuild 印つき)し、ack を待つ  2. Nearby を閉じて stopAllEndpoints の完了を待つ
   *  3. 固定グループを作り直す(エコー・SOCKS は動いたまま。資格情報も前と同じ)  4. Nearby は止めたまま、子機のエコー接続を待つ
   * 子機が戻らなければ、guard の rejoinMs のあと Nearby を再開する。
   */
  private async rebuildDirect(gen: number): Promise<void> {
    const msg = this.shareMsg;
    if (!msg || this.state.role !== 'host') return;
    this.gnote('Direct 作り直し: ① 接続情報を再送');
    this.ctl?.send({ ...msg, rebuild: true } satisfies Wire, { key: 'wifi', ttlMs: WIFI_TTL_MS });
    this.guard(gen, { t: 'rebuild-start' });
    const seq = this.suspendSeq + 1;
    await this.suspendNearby(gen); // ack を待って閉じる(② stopAllEndpoints の完了待ちを含む)
    if (gen !== this.gen || this.suspendSeq !== seq) return;
    if (this.timing.groupRebuildDelayMs > 0) {
      this.gnote(`Direct 作り直し: グループ作成の前に ${this.timing.groupRebuildDelayMs}ms 待つ(timing.groupRebuildDelayMs)`);
      await this.p.sleep(this.timing.groupRebuildDelayMs);
      if (gen !== this.gen || this.suspendSeq !== seq) return;
    }
    const pair = (await this.pairs()).find((x) => x.peerId === this.peerId);
    if (!pair || gen !== this.gen) return;
    this.gnote('Direct 作り直し: ③ 固定グループを作り直す');
    const socks = msg.socks;
    const again = await this.tryDirect(gen, pair.peerId, pair.secret, socks);
    if (gen !== this.gen) return;
    if (!again) {
      this.gnote('Direct 作り直しに失敗: Nearby を再開する');
      this.gov.reset();
      this.resumeNearby(gen, 'rebuild-failed');
      this.set({ share: 'failed', error: 'Wi-Fi Direct を作り直せませんでした' });
      return;
    }
    this.shareMsg = again;
    this.peerReachKnown = true;
    this.set({ share: 'on', shareMethod: again.method, error: null });
    this.gnote('Direct 作り直し: ④ 完了。Nearby は止めたまま子機のエコー接続を待つ');
  }

  private retryCfg(): DirectRetry {
    return toRetry(this.timing);
  }

  private inRetrying(gen: number): boolean {
    return gen === this.gen && this.gov.phase === 'retrying';
  }

  /**
   * Direct が切れたと分かったときの再接続。Nearby は止めたまま(GMS の帯域アップグレードと競合させない)、保存済みの接続情報で最大 attempts 回。
   * 全部失敗したときだけ retry-failed を出し、guard が Nearby を再開する。再接続中の総合状態は degraded。
   *  子機: 検知 → backoff → joinWifi(短い待ち)→ VPN。1 回でも戻れば guard が direct に戻す。尽きても下限 floorMs までは待つ(親機の戻りを先にする)
   *  親機: グループが生きていれば維持して子機の再参加を待つ(上限は guard の retryWindowMs)。消えていれば固定グループを作り直す(最大 attempts 回)
   */
  private async runRetry(gen: number, reason: string): Promise<void> {
    const rc = this.retryCfg();
    this.retry = { attempt: 0, max: rc.attempts, reason };
    this.set({});
    const bo = (i: number) => rc.backoffMs[Math.min(i, rc.backoffMs.length - 1)] ?? 2_000;
    const done = (): boolean => { if (this.inRetrying(gen)) return false; this.retry = null; if (gen === this.gen) this.set({}); return true; };
    if (this.state.role === 'guest') {
      const m = this.lastJoined;
      if (!m || this.vpnHold) { this.gnote(`Direct 再接続: 保存済みの接続情報が無い/非常口で停止中 → Nearby へ戻る`); this.retry = null; this.guard(gen, { t: 'retry-failed' }); return; }
      this.rejoining = true; // 失敗を親機へ送らない(Nearby は止めてある)
      try {
        for (let i = 1; i <= rc.attempts; i++) {
          this.retry = { attempt: i, max: rc.attempts, reason };
          this.gnote(`Direct 再接続 attempt=${i}/${rc.attempts} reason=${reason}: ${bo(i - 1)}ms 待って保存済みの情報で参加`);
          this.set({});
          await this.p.sleep(bo(i - 1));
          if (done()) return;
          if (this.state.wifi === 'joined' && this.gateway) {
            // ハートビートが失敗しただけで Wi-Fi は残っている: まず到達を確かめ、だめなら入り直す
            const r = await this.hotspot.probe(this.gateway, this.lastPort);
            if (done()) return;
            if (r.ok) { this.gnote(`Direct 再接続 attempt=${i}/${rc.attempts}: 到達できた(Wi-Fi は維持)`); this.data = { ...this.data, heartbeat: { ok: true, at: this.p.now() }, okAt: this.p.now() }; this.retry = null; this.guard(gen, { t: 'alive' }); this.set({}); return; }
            try { this.safeStopVpn(); this.hotspot.leaveWifi(); } catch {}
            this.set({ wifi: 'off', vpn: 'off' });
          }
          await this.join(gen, m, false, rc.joinTimeoutMs);
          if (done()) return;
          if (this.state.wifi === 'joined' && this.state.vpn === 'on') return; // join 内で guard ready が出ている
          this.gnote(`Direct 再接続 attempt=${i}/${rc.attempts} 失敗: wifi=${this.state.wifi} 理由=${this.state.joinFailure?.reason ?? this.state.error ?? '?'}`);
        }
        this.gnote(`Direct 再接続 ${rc.attempts}/${rc.attempts} 失敗 → 子機は T_nearby(${this.gov.timing.nearbyMs}ms)まで待ってから探索へ戻る(親機が先に広告へ戻る)`);
      } finally {
        this.rejoining = false;
      }
      if (!done()) { this.retry = null; this.guard(gen, { t: 'retry-failed' }); this.set({}); }
      return;
    }
    // 親機
    const msg = this.shareMsg;
    if (!msg || msg.method !== 'WifiDirect') { this.retry = null; this.guard(gen, { t: 'retry-failed' }); return; }
    if (this.data.group !== false) {
      this.gnote(`Direct 再接続 reason=${reason}: 固定グループは生きている → 維持して子機の再参加を待つ(Nearby 再開は基準から ${this.gov.timing.resumeAtMs}ms)`);
      this.set({});
      return; // 子機が戻れば echo / group の alive で direct へ。来なければ guard が resumeAtMs で Nearby を再開
    }
    const pair = (await this.pairs()).find((x) => x.peerId === this.peerId);
    if (!pair) { this.retry = null; this.guard(gen, { t: 'retry-failed' }); return; }
    for (let i = 1; i <= rc.attempts; i++) {
      this.retry = { attempt: i, max: rc.attempts, reason };
      this.gnote(`Direct 再接続 attempt=${i}/${rc.attempts} reason=${reason}: ${bo(i - 1)}ms 待って固定グループを作り直す`);
      this.set({});
      await this.p.sleep(bo(i - 1));
      if (done()) return;
      const again = await this.tryDirect(gen, pair.peerId, pair.secret, msg.socks);
      if (gen !== this.gen) return;
      if (again) {
        this.shareMsg = again;
        this.gnote(`Direct 再接続 attempt=${i}/${rc.attempts}: グループ作成 OK。Nearby は止めたまま子機の再参加を待つ`);
        this.retry = null; // 以降は子機待ち(overall は group=true・echo 待ちで degraded)
        this.set({});
        return;
      }
      this.gnote(`Direct 再接続 attempt=${i}/${rc.attempts} 失敗: グループを作れなかった`);
    }
    this.retry = null;
    this.gnote(`Direct 再接続 ${rc.attempts} 回すべて失敗 → Nearby の広告・探索を再開`);
    this.guard(gen, { t: 'retry-failed' });
  }

  /** 子機: 親機が Direct を作り直す。Nearby を閉じ、接続情報で参加を繰り返し試す */
  private async rejoinAfterRebuild(gen: number, m: WifiMsg): Promise<void> {
    this.lastJoined = m;
    this.rejoining = true;
    try {
      this.gnote('Direct 作り直しを受信: Nearby を閉じて参加を繰り返し試す');
      this.guard(gen, { t: 'rebuild-start' });
      await this.suspendNearby(gen);
      for (let i = 1; i <= 12 && gen === this.gen && nearbyShouldBeOff(this.gov.phase); i++) {
        await this.p.sleep(i === 1 ? 2_500 : 4_000); // グループができてビーコンが出るまで待つ
        if (gen !== this.gen || !nearbyShouldBeOff(this.gov.phase)) return;
        await this.join(gen, m, false);
        if (this.state.wifi === 'joined') return; // 成功: VPN が on になれば guard が direct にする
        this.gnote(`作り直し後の参加 ${i}/12 失敗(${this.state.joinFailure?.reason ?? '?'})`);
      }
    } finally {
      this.rejoining = false;
    }
  }

  // ---------- 内部 ----------

  private safeStopVpn(): void {
    try { this.p.vpn.stop(); this.hotspot.unbindProcess(); } catch {}
  }

  private set(patch: Partial<TetherState>): void {
    const prev = this.state.overall;
    this.state = { ...this.state, ...patch };
    this.deriveState();
    this.notify();
    this.gov.notify();
    if (this.state.overall !== prev) {
      this.gnote(`overall ${prev} → ${this.state.overall} (nearby=${this.state.nearby})`);
      for (const cb of [...this.overallSubs]) {
        try { cb(this.state.overall, prev); } catch {}
      }
    }
  }

  /** nearby と overall(データ経路だけから)を導く */
  private deriveState(): void {
    const s = this.state;
    const nearby: NearbyPhase = this.nearbySuspended ? 'suspended' : s.link === 'connected' ? 'up' : 'down';
    const overall = deriveOverall({
      role: s.role, started: s.started, data: this.data, shareOn: s.share === 'on', wifiJoined: s.wifi === 'joined', vpnOn: s.vpn === 'on',
      heartbeatMode: this.suspendOk, retrying: this.retry !== null, now: this.p.now(), echoMs: this.gov.timing.echoMs, directMs: this.gov.timing.directMs,
      internetNg: this.monitor.isNg(s.role),
    });
    this.state = { ...s, nearby, overall, data: { ...this.data }, internet: this.monitor.status, remoteInternet: this.monitor.remoteStatus };
    this.state.linkState = this.gov.snapshot().state;
  }

  private notify(): void {
    const s = this.getState();
    for (const cb of [...this.subs]) {
      try { cb(s); } catch {}
    }
  }

  private log(line: string): void {
    for (const cb of [...this.logSubs]) {
      try { cb(line); } catch {}
    }
  }
}

const sameWifi = (a: WifiMsg, b: WifiMsg) =>
  a.ssid === b.ssid && a.pass === b.pass && a.port === b.port && a.socks.user === b.socks.user && a.socks.pass === b.socks.pass && a.socks.port === b.socks.port;

const DEVICE_ROLE_KEY = 'tether.deviceRole';
/** hello の tv: 共有 timing(tether.timing)の版 */
const TIMING_KEY = 'tether.timing.v1';
const INTERNET_KEY = 'tether.internet.v1';

const safeFreq = (h: { wifiFrequency(): number }): number => {
  try { return h.wifiFrequency(); } catch { return 0; }
};

export interface DirectPlan {
  /** 固定する周波数(MHz)。null = 帯域内の自動選択 */
  freq: number | null;
  band: '2.4' | '5';
  reason: string;
}
const describePlan = (p: DirectPlan) => (p.freq ? `${p.band}GHz/${p.freq}MHz` : `${p.band}GHz/自動`);

/** 屋外(車・バイク)で使うため GO は 2.4GHz 固定。5GHz は DFS(W53/W56)の制約があるので候補にしない */
const GO_CHANNELS_24 = [2412, 2437, 2462];

/**
 * Direct(GO)を作る周波数の候補を、優先順に返す。sta = 親機の Wi-Fi の周波数(未接続は 0)。
 * 既定は 2.4GHz の 1/6/11ch を順に。親機の STA が 2.4GHz のときだけ、そのチャンネルを先頭にして時分割(MCC)を避ける。
 * 最後に 2.4GHz 自動を置く(それでも 2.4GHz)。5GHz は使わない。
 */
export function pickDirectPlans(sta: number): DirectPlan[] {
  const plans: DirectPlan[] = [];
  const sta24 = sta >= 2412 && sta <= 2484;
  if (sta24) plans.push({ freq: sta, band: '2.4', reason: `親機の Wi-Fi(${sta}MHz)と同じ 2.4GHz チャンネルに合わせる` });
  for (const f of GO_CHANNELS_24) {
    if (f === sta) continue;
    plans.push({ freq: f, band: '2.4', reason: sta24 ? `STA と同チャンネルが不可: 2.4GHz ${f}MHz` : sta > 0 ? `親機の Wi-Fi は ${sta}MHz(2.4GHz 以外): GO は屋外向けに 2.4GHz 固定、${f}MHz を試す` : `親機が Wi-Fi 未接続: 2.4GHz ${f}MHz を試す` });
  }
  plans.push({ freq: null, band: '2.4', reason: '指定チャンネルがすべて不可: 2.4GHz 自動(従来どおり)' });
  return plans;
}
