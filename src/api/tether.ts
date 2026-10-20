import { createLink } from '../link/session';
import { directCreds, removeDirectCreds } from '../pairing/directCreds';
import type { LinkSupervisor } from '../link/supervisor';
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
  MessageMeta,
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
  | { kind: 'tether.wifi'; method: 'WifiDirect' | 'LocalOnlyHotspot'; ssid: string; pass: string; port: number; socks: Socks }
  | { kind: 'tether.wifi-result'; ok: boolean; gateway?: string; rttMs?: number; error?: string }
  | { kind: 'tether.need-wifi' }
  // 子機が自分でペア解除するときの通知(best-effort)。親機は該当ペアを消す
  | { kind: 'tether.unpair' }
  // 能力の交換と方式判断(docs/SPEC.md §9)。機種名と能力・判断だけを流す
  | { kind: 'tether.hello'; v: number; rev: string }
  | { kind: 'tether.caps-req'; v: number }
  | { kind: 'tether.caps'; v: number; rev: string; caps: Capabilities }
  | { kind: 'tether.plan'; v: number; plan: LinkPlan };

interface Socks {
  port: number;
  user: string;
  pass: string;
}

type WifiMsg = Extract<Wire, { kind: 'tether.wifi' }>;

const ECHO_PORT = 9000;
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

  constructor(private p: TetherPlatform, private cfg: TetherConfig = {}) {
    this.store = new PairStore(p.kv);
    // ネイティブのログ(SSID・合言葉は伏せ済み)も診断ログに流す。形: "[DH-P2P] i 本文"
    try { p.onNativeLog?.((tag, line) => this.log(`[${tag}] ${line}`)); } catch {}
    this.state = {
      started: false, role: null, autoRole: this.detectRole(), peer: null,
      link: 'stopped', attempt: 0,
      share: 'off', shareMethod: null, peerReach: null,
      wifi: 'off', joinPrompt: false, joinFailure: null, vpn: 'off', plan: null, pending: 0, error: null,
    };
    // 子機: 前回の VPN が残っていたら、全通信を飲み込んだままにしないよう止める
    this.safeStopVpn();
  }

  // ---------- 状態 ----------

  getState(): TetherState {
    return { ...this.state, pending: this.link?.pending ?? 0 };
  }

  /** 状態が変わるたびに呼ばれる。戻り値で購読解除 */
  subscribe(cb: (s: TetherState) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
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
    try { return this.p.hotspot.hasCellular() ? 'host' : 'guest'; } catch { return 'guest'; }
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
    try { cellular = this.p.hotspot.hasCellular(); } catch { cellular = null; }
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
    if (this.peerId === peerId && this.state.role === 'guest' && this.state.link === 'connected' && this.link) {
      try {
        this.link.send({ kind: 'tether.unpair' } satisfies Wire, { ttlMs: 0 });
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
    const s = new PairingSession(this.p.nearby, {
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
      const gen = ++this.gen;
      this.peerId = pair.peerId;
      this.autoShare = opts.autoShare ?? true;
      this.vpnHold = false;
      this.p.keepAlive.start();

      const sup = createLink(
        this.p.nearby,
        { role, selfId: self.id, pair: { peerId: pair.peerId, secret: pair.secret }, connectTimeoutMs: this.cfg.connectTimeoutMs ?? 30_000 },
        (body) => this.onWire(gen, role, pair.peerId, body),
        { sleep: this.p.sleep, now: this.p.now, ...this.cfg.link },
      );
      sup.onState = (s, n) => {
        if (gen !== this.gen) return;
        this.set({ link: s, attempt: n });
        this.log('状態: ' + s);
        // Wi-Fi Direct に参加すると Nearby(WIFI_LAN など)が落ちることがある。Direct の IP 経路(VPN→親機の SOCKS)は Nearby と独立なので、
        // Direct / VPN は捨てず維持し、Nearby は裏で再探索するだけにする(onWifiLost だけが Direct の断を扱う)
        if (s === 'waiting' && role === 'guest' && this.state.wifi === 'joined') {
          this.log(`Nearby 切断(Direct 参加中: Direct・VPN は維持 vpn=${this.state.vpn}。Nearby は再探索する)`);
        }
        if (s === 'connected') this.onConnected(role, gen);
      };
      this.link = sup;
      this.set({
        started: true, role, peer: { peerId: pair.peerId, peerName: pair.peerName },
        link: 'connecting', attempt: 0, error: granted ? null : this.state.error,
      });
      // 実機確認用: この端末の能力を診断ログに出す(機種名と能力のみ。共有コード・資格情報は含まない)
      void this.capabilities().then((c) => {
        if (gen === this.gen) describeCapabilities(c).split('\n').forEach((l) => this.log('能力 ' + l));
      }).catch(() => {});
      if (role === 'guest') {
        this.offWifiLost = this.p.hotspot.onWifiLost(() => this.onWifiLost(gen));
        this.offJoinPrompt = this.p.hotspot.onJoinPrompt?.((e) => {
          if (gen !== this.gen) return;
          // 'show' だけが案内を出す。ok / declined / timeout / cancelled はどれも「終わり」なので案内を必ず消す
          this.set({ joinPrompt: e.phase === 'show' });
          this.log(`Wi-Fi 許可画面: ${e.phase}`);
        }) ?? null;
      }
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
    this.offWifiLost?.();
    this.offWifiLost = null;
    this.offJoinPrompt?.();
    this.offJoinPrompt = null;
    if (this.state.started) this.p.keepAlive.stop();
    const h = this.p.hotspot;
    const wasHost = this.state.role === 'host';
    if (wasHost || this.state.share !== 'off') {
      this.log(`共有を停止(エコー・SOCKS・Direct を閉じる share=${this.state.share})`);
      try { h.stopSocks(); } catch {}
      try { h.stopEcho(); } catch {}
      try { h.stopHotspot(); } catch {}
      void h.stopDirect().catch(() => {});
    }
    this.nearbyDirectActive(false);
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
      started: false, role: null, peer: null, link: 'stopped', attempt: 0,
      share: 'off', shareMethod: null, peerReach: null, wifi: 'off', joinPrompt: false, joinFailure: null, vpn: 'off', plan: null,
    };
    if (emit) this.set(next);
    else this.state = { ...this.state, ...next };
  }

  // ---------- メッセージ ----------

  /**
   * 相手へアプリのメッセージを送る。
   * - ttlMs 未指定: つながるまで溜めて、つながり次第 1 回だけ届ける(受諾など)
   * - ttlMs: 溜める最長時間。0 は「溜めない」(状態表示など、古くなれば無意味なもの)
   * - key: 同じ key の未送達は新しいものに置き換える(最新だけ届ければよいもの)
   * 停止中は何もせず false。
   */
  send(body: unknown, opts: SendOptions = {}): boolean {
    if (!this.link) return false;
    this.link.send({ kind: 'tether.app', body } satisfies Wire, opts);
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
    else if (this.state.role === 'guest') this.link?.send({ kind: 'tether.need-wifi' } satisfies Wire, { key: 'need-wifi', ttlMs: 30_000 });
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
    if (!plan || !this.link || this.state.role !== 'host') return;
    this.link.send({ kind: 'tether.plan', v: PROTOCOL_VERSION, plan } satisfies Wire, { key: 'plan', ttlMs: WIFI_TTL_MS });
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
    this.link?.send({ kind: 'tether.hello', v: PROTOCOL_VERSION, rev: capsRevision(caps) } satisfies Wire, { key: 'hello', ttlMs: 30_000 });
  }

  private async sendCaps(gen: number): Promise<void> {
    const caps = await this.capabilities();
    if (gen !== this.gen) return;
    this.link?.send({ kind: 'tether.caps', v: PROTOCOL_VERSION, rev: capsRevision(caps), caps } satisfies Wire, { key: 'caps', ttlMs: 30_000 });
  }

  private async onHello(gen: number, peerId: string, v: unknown, rev: unknown): Promise<void> {
    if (typeof v !== 'number') return;
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
    this.link?.send({ kind: 'tether.caps-req', v: PROTOCOL_VERSION } satisfies Wire, { key: 'caps-req', ttlMs: 30_000 });
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
    if (!this.shareMsg || !this.link) return;
    this.link.send(this.shareMsg satisfies Wire, { key: 'wifi', ttlMs: WIFI_TTL_MS });
    this.log('接続情報を子機へ送信');
  }

  private async buildShare(gen: number, order: LinkMethod[]): Promise<WifiMsg | null> {
    const h = this.p.hotspot;
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
    const h = this.p.hotspot;
    try { h.stopSocks(); } catch {}
    try { h.stopEcho(); } catch {}
    try { h.stopHotspot(); } catch {}
    await h.stopDirect().catch(() => {});
  }

  /** 主: Wi-Fi Direct(SSID・パスフレーズを固定(ch は動的)。ペアの共有コードから導く → OS が承認を覚える) */
  private async tryDirect(gen: number, peerId: string, secret: string, socks: Socks): Promise<WifiMsg | null> {
    const h = this.p.hotspot;
    // 名前・合言葉はペアごとに固定して保存する(保存済みがあればそれを使う)。子機の承認の記憶が効く。合言葉はログに出さない
    const self = await this.identity();
    const { ssid: name, pass } = await directCreds({ hmac: (s, d) => this.p.nearby.hmac(s, d), kv: this.p.kv, selfId: self.id, peerId, secret });
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
        this.log(`Wi-Fi Direct 成功(${this.p.now() - t0}ms, ${describePlan(plan)})`);
        if (this.abandoned(gen)) { await this.dropOrphan('Wi-Fi Direct'); return null; }
        void this.record('WifiDirect', 'create', true);
        // 親機が Wi-Fi に接続したまま Direct を作れた = STA+P2P の同時動作を観測
        if (staFreq > 0) void this.observe('staP2pConcurrent', true);
        return { kind: 'tether.wifi', method: 'WifiDirect', ssid: cred.ssid, pass: cred.passphrase, port: ECHO_PORT, socks };
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
    const h = this.p.hotspot;
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
    try { this.p.nearby.setDirectActive?.(on); } catch {}
  }

  private onConnected(role: TetherRole, gen: number): void {
    if (this.peerId) this.touchPeer(this.peerId, true);
    // 親機: つながり直したら、判断と共有中の接続情報を再送する(Direct は作り直さず、子機は同じ SSID を再利用する)
    if (role === 'host') {
      this.sendPlan();
      if (this.shareMsg) this.sendShare();
    } else {
      // 子機: 接続情報より先に、能力の版を親機へ知らせる
      void this.sendHello(gen).catch(() => {});
    }
  }

  private onWire(gen: number, role: TetherRole, peerId: string, body: unknown): void {
    if (gen !== this.gen) return;
    if (!isWire(body)) return; // 知らない形式は捨てる
    this.touchPeer(peerId);
    switch (body.kind) {
      case 'tether.app':
        for (const cb of [...this.msgSubs]) {
          try { cb(body.body, { role, peerId }); } catch (e: any) { this.log('onMessage で例外: ' + (e?.message ?? e)); }
        }
        break;
      case 'tether.unpair':
        // 子機が解除した: 親機は該当ペアと direct.v1.<peerId> を消す
        if (role === 'host') void this.forgetPair(peerId).catch((e) => this.log('unpair 処理で例外: ' + (e?.message ?? e)));
        break;
      case 'tether.wifi':
        if (role === 'guest') void this.join(gen, body, false);
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
      case 'tether.plan':
        if (role === 'guest') void this.onPlan(gen, body.plan).catch((e) => this.log('plan 処理で例外: ' + (e?.message ?? e)));
        break;
      case 'tether.wifi-result':
        if (role === 'host') {
          if (this.state.shareMethod) void this.record(this.state.shareMethod, 'join', body.ok);
          this.set({ peerReach: { ok: body.ok, rttMs: body.rttMs, error: body.error } });
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
    this.set({ wifi: 'off', vpn: this.vpnHold ? 'held' : 'off' });
    this.log('Wi-Fi Direct 切断 → VPN を停止');
    // Nearby がつながっていれば、親機に接続情報をもう一度送ってもらう
    if (this.state.link === 'connected' && !this.vpnHold) {
      this.link?.send({ kind: 'tether.need-wifi' } satisfies Wire, { key: 'need-wifi', ttlMs: 30_000 });
    }
  }

  /** 受け取った接続情報で参加し、親機のポートへの到達を確かめて結果を返し、VPN を張る */
  private async join(gen: number, m: WifiMsg, force: boolean): Promise<void> {
    if (this.joining) return;
    // 同じ接続情報の再送で、動いている VPN を張り直さない(親機の再送・再接続のたびに通信が途切れるのを避ける)
    if (!force && this.state.vpn === 'on' && this.state.wifi === 'joined' && this.lastJoined && sameWifi(this.lastJoined, m)) {
      this.link?.send({ kind: 'tether.wifi-result', ok: true } satisfies Wire, { key: 'wifi-result', ttlMs: WIFI_TTL_MS });
      return;
    }
    this.lastJoined = m;
    if (this.vpnHold && !force) {
      this.log('VPN は非常口で停止中のため、接続情報を保存のみ');
      return;
    }
    this.joining = true;
    const h = this.p.hotspot;
    this.set({ wifi: 'joining', error: null, joinFailure: null });
    this.log(`接続情報を受信 ssid=${m.ssid} → 参加(端末の承認ダイアログが出たら許可)`);
    try {
      // 固定 SSID なら、承認ダイアログで「常に許可」を選んだ後は OS が覚える
      const { gateway } = await h.joinWifi(m.ssid, m.pass);
      if (gen !== this.gen) return;
      // join ok は OS が local-only ネットワークを渡しただけ。実際に親機まで届くかは、このあとの到達確認・VPN のログで見る
      this.log(`参加 ok gw=${gateway} → 到達確認(link=${this.state.link})`);
      this.set({ wifi: 'joined' });
      this.nearbyDirectActive(true);
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
      this.link?.send({ kind: 'tether.wifi-result', gateway, ...res } satisfies Wire, { key: 'wifi-result', ttlMs: WIFI_TTL_MS });
      if (res.ok) await this.startVpn(gen, gateway, m.socks);
      else this.set({ error: '親機に届きません。親機が近くにあり、共有が始まっているか確認してください' });
    } catch (e: any) {
      if (gen !== this.gen) return;
      const msg = String(e?.message ?? e);
      this.log('参加失敗: ' + msg);
      const failure = parseJoinFailure(msg);
      this.log(`参加失敗の理由: ${failure.reason} / ${joinFailureDetail(failure)}`);
      this.set({ wifi: 'failed', error: joinFailureText(failure.reason), joinFailure: failure });
      this.link?.send({ kind: 'tether.wifi-result', ok: false, error: msg } satisfies Wire, { key: 'wifi-result', ttlMs: WIFI_TTL_MS });
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
      if (!this.p.hotspot.bindToJoined()) this.log('Wi-Fi への固定に失敗');
      v.start(gateway, socks.port, socks.user, socks.pass);
      await this.p.sleep(1500);
      if (gen !== this.gen || this.vpnHold) return;
      const st = v.status();
      this.log(`VPN ${st.running ? '起動' : '失敗'}${st.error ? ' ' + st.error : ''}`);
      this.log(`参加後の状態 wifi=${this.state.wifi} vpn=${st.running ? 'on' : 'failed'} link=${this.state.link} attempt=${this.state.attempt}`);
      this.set(st.running ? { vpn: 'on', error: null } : { vpn: 'failed', error: 'VPN を起動できませんでした' + (st.error ? `: ${st.error}` : '') });
    } catch (e: any) {
      this.log('VPN 失敗: ' + (e?.message ?? e));
      this.set({ vpn: 'failed', error: 'VPN 失敗: ' + (e?.message ?? e) });
    }
  }

  // ---------- 内部 ----------

  private safeStopVpn(): void {
    try { this.p.vpn.stop(); this.p.hotspot.unbindProcess(); } catch {}
  }

  private set(patch: Partial<TetherState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
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
