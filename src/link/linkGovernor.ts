import type { NearbyApi } from './nearbyTransport';
import { GuardAction, GuardEvent, GuardPhase, GuardState, GuardTiming, initialGuard, nearbyShouldBeOff, stepGuard } from './directGuard';
import type { HotspotPort } from '../api/types';
import type { DataPath, NearbyPhase, Overall } from './dataPath';
import type { InternetStatus, RemoteInternet } from './internetMonitor';
import { labelOf, LinkStateInfo, LinkStateName, Transition, WaitingFor } from './stateLabels';

/** 画面表示用に Tether が渡す、状態機械の外側の情報 */
export interface LinkContext {
  /** 運び先(Tether が渡す)。省略時は control=nearby・appPending=0 */
  carriers?: { control: 'nearby' | 'bus'; appPending: number };
  role: 'host' | 'guest' | null;
  started: boolean;
  /** Nearby 部品が suspend() を持つか。false は旧部品の縮退動作(Direct 中も Nearby を止められない) */
  suspend: boolean;
  /** 親機の share / 子機の wifi（'starting'|'joining' などの作成中判定用） */
  creating: boolean;
  joining: boolean;
  /** (suspend 未対応の旧部品)Direct が張れている */
  directUp: boolean;
  nearbyUp: boolean;
  /** Nearby を再開した理由（再開してまだ Direct に戻っていない間だけ） */
  resumedBecause: string | null;
  attempt: { n: number; max: number } | null;
  overall: Overall;
  nearby: NearbyPhase;
  data: DataPath;
  /** 起動した時刻（stopped/縮退時の enteredAt 用） */
  since: number;
  /** 有効な設定値（resolveTiming の結果と GuardTiming）。秘密を含まない */
  timing: unknown;
  /** 外形監視(子機の自分の状態 / 親機が受けた子機の報告)。省略時は unknown / null */
  internet?: InternetStatus;
  remoteInternet?: RemoteInternet | null;
}

export interface LinkSnapshot {
  state: LinkStateInfo;
  overall: Overall;
  /** データ経路の内訳 */
  path: { nearby: NearbyPhase; group: boolean | null; reach: DataPath['reach'];
    /** 最後に Direct の生存を確認した時刻(LinkGovernor が保持。無ければ null) */
    lastAliveAt: number | null;
    /** Direct 上のバス: authenticated / disconnected / off(使っていない) */
    bus: DataPath['bus'] };
  /** データ経路の内訳(state.data と同じ値。lastAliveAt / bus を含む) */
  data: DataPath | null;
  /** インターネットへの到達(外形監視)。overall とは別の軸。state.internet と同じ値 */
  internet: InternetStatus | null;
  /** 親機: 子機の報告 */
  remoteInternet: RemoteInternet | null;
  /** 直近の遷移（古い順、最大 HISTORY_MAX 件）。秘密・SSID・パスは含まない */
  history: Transition[];
  timing: unknown;
  at: number;
  /** 内部制御(tether.* の hello/caps/wifi/plan など)のいまの運び先 */
  controlCarrier: 'nearby' | 'bus';
  /** アプリのメッセージ(tether.send)の運び先。常にバス(Nearby には載せない) */
  appCarrier: 'bus';
  /** バスに溜まっていて未送達のアプリのメッセージ数 */
  appPending: number;
}

const HISTORY_MAX = 50;

/**
 * Nearby と Wi-Fi Direct の使い分けの責任者。状態機械(directGuard.ts の遷移表。docs/LINK_STATE.md の図と一対一)を持ち、
 * Nearby と Direct に触る操作を必ずここを通す。ネイティブの部品(NearbyApi / HotspotPort)は Tether が governor の `nearby` / `hotspot`
 * 経由でしか使わない(Tether はこの2つ以外のネイティブ参照を持たない)ので、不変条件を迂回できない。
 *
 * 不変条件(違反は拒否して DH-LINK に記録。strict=true(テスト)では例外):
 *  I1  Direct 稼働中(direct / retrying / rejoining)は Nearby の advertise・discover・requestConnect を出さない
 *  I2  Nearby の再開(resume)は T_direct(親機)/ T_nearby(子機)の経過後、または親機が再接続を使い切ったときだけ。早すぎる再開は拒否
 *  I3  再接続の順序: 接続情報の再送 → Nearby を閉じて完了を待つ → 固定グループの作成。Nearby が止まる前の startDirect は拒否
 *  I6  joinWifi（子機の Direct 参加）は**どの phase でも許す**。理由: ①初回の参加は Nearby で接続情報を受け取った直後（phase = nearby / settling）に
 *      Nearby 接続中のまま行う設計で、禁止すると確立できない ②再接続・作り直しの参加は Nearby を止めたまま行う（retrying / rejoining）③参加は子機が
 *      Wi-Fi クライアントとして入るだけで、Nearby の接続・帯域アップグレードを起こさない（P2P の GO 側のリソースは親機）。ただし追跡できるよう
 *      phase と Nearby 停止の有無を DH-LINK に1行残す（違反ではない）
 *  I4  遷移は表にある (状態, 事象) だけ。それ以外は無視して記録(directGuard.stepGuard が表)
 *  I5  時間は now を注入する(テストで差し替え)。タイマーは持たない: tick を呼ぶ側が駆動する
 */
export class LinkViolation extends Error {
  constructor(public rule: string, msg: string) {
    super(`${rule}: ${msg}`);
    this.name = 'LinkViolation';
  }
}

export interface GovernorOptions {
  timing: GuardTiming;
  now: () => number;
  /** DH-LINK のログ(1 行)。ssid / pass / secret を含めないこと */
  log: (line: string) => void;
  /** true: 不変条件の違反で例外を投げる(テスト)。false: 拒否してログのみ(本番) */
  strict?: boolean;
  /** 状態遷移で出た動作(suspend / resume / retry)を実行する */
  onAction: (a: Exclude<GuardAction, { type: 'note' }>) => void;
  /** 画面表示用の文脈（snapshot で使う）。省略時は最小限 */
  context?: () => LinkContext;
}

export class LinkGovernor {
  private s: GuardState;
  /** Nearby を実際に止め終えた(suspend 完了)か。I3 の判定に使う */
  private nearbyStopped = false;
  /** rebuild 手順中(接続情報を送った → Nearby を閉じる → グループ作成) */
  private rebuilding = false;
  /** 生存信号の最終時刻(max。古い時刻へは戻さない)。0 = まだ無い。送り手に依存しない */
  private aliveMax = 0;
  readonly violations: string[] = [];
  private hist: Transition[] = [];
  private subs = new Set<(s: LinkSnapshot) => void>();

  constructor(private o: GovernorOptions) {
    this.s = initialGuard(o.now());
  }

  get state(): GuardState { return this.s; }
  get phase(): GuardPhase { return this.s.phase; }
  get timing(): GuardTiming { return this.o.timing; }
  get nearbyAllowed(): boolean { return !nearbyShouldBeOff(this.s.phase); }

  /** 事象を入れる。遷移は stepGuard の表どおり(表に無い事象は状態を変えない) */
  dispatch(ev: GuardEvent): void {
    if (ev.t === 'reset') this.aliveMax = 0;
    const prev = this.s;
    const [next, acts] = stepGuard(prev, ev, this.o.now(), this.o.timing);
    this.s = next;
    if (next.phase !== prev.phase) {
      this.o.log(`transition ${prev.phase} → ${next.phase} on ${ev.t}${'reason' in ev ? `(${ev.reason})` : ''}`);
      const act = acts.find((a) => a.type === 'retry' || a.type === 'resume') as { reason: string } | undefined;
      this.record({ at: this.o.now(), from: prev.phase, to: next.phase, event: ev.t, reason: ('reason' in ev ? ev.reason : act?.reason) ?? null });
    }
    if (ev.t === 'rebuild-start') this.rebuilding = true;
    if (next.phase === 'direct') this.rebuilding = false;
    for (const a of acts) {
      if (a.type === 'note') { this.o.log(a.msg); continue; }
      if (a.type === 'resume') {
        // I2: 早すぎる再開は拒否(表が正しければ起きない。表の変更で壊れたときの安全網)
        const waited = this.o.now() - prev.base;
        const early = prev.phase === 'retrying' && a.reason === 'direct-timeout' && waited < this.o.timing.resumeAtMs;
        if (early) { this.violate('I2', `Nearby 再開が早すぎる waited=${waited}ms < ${this.o.timing.resumeAtMs}ms`); continue; }
        this.rebuilding = false;
      }
      this.o.onAction(a);
    }
  }

  /** 差し替え(start のたびに役割ごとの時間を入れる) */
  setTiming(t: GuardTiming): void {
    this.o.timing = t;
  }
  setStrict(v: boolean | undefined): void {
    this.o.strict = v;
  }
  /** JS が止まっていた(Doze)あとの数え直し: direct 中なら生存確認の時刻を今にする */
  grace(): void {
    if (this.s.phase === 'direct') this.s = { ...this.s, aliveAt: this.o.now() };
  }

  /** 新しい Direct のセッションに入った: 生存信号の最終時刻を忘れる(前のセッションの時刻を持ち越さない) */
  forgetAlive(): void { this.aliveMax = 0; }

  /** 最後に生存を確認した時刻。まだ無ければ null */
  get lastAliveAt(): number | null { return this.aliveMax || null; }

  /**
   * 生存信号の時刻を受け取る**唯一の入口**。送り手(バス・ZMTP heartbeat など)は問わない。
   * 時刻はイベントが起きた時刻(ネイティブが添える)なので、JS が止まっていて遅れて届いても、その時刻で更新する。
   * 未来の時刻は now に丸め、古い時刻(いまの値以下)は無視する。戻り値 = 進んだか
   */
  noteAliveAt(at: number): boolean {
    const t = Math.min(at, this.o.now());
    if (!Number.isFinite(t) || t <= this.aliveMax) return false;
    this.aliveMax = t;
    if (this.s.phase === 'direct') this.s = { ...this.s, aliveAt: Math.max(this.s.aliveAt, t) };
    return true;
  }

  /** ネイティブのハートビートが最後に成功した時刻(JS の now 以前)へ、生存確認の基準を合わせる。JS が止まっていた間の時間を無通信に数えない */
  setAliveAt(at: number): void {
    if (this.s.phase === 'direct') this.s = { ...this.s, aliveAt: Math.min(at, this.o.now()) };
  }

  /** suspend が完了した / 再開した(Tether が実際の Nearby 操作を終えたら知らせる) */
  markNearbyStopped(stopped: boolean): void {
    this.nearbyStopped = stopped;
  }

  /** リセット(停止・ペアリングなど)。Nearby は誰でも使える状態に戻る */
  reset(): void {
    if (this.s.phase !== 'nearby') this.record({ at: this.o.now(), from: this.s.phase, to: 'nearby', event: 'reset', reason: null });
    this.s = initialGuard(this.o.now());
    this.nearbyStopped = false;
    this.rebuilding = false;
  }

  private record(t: Transition): void {
    this.hist.push(t);
    if (this.hist.length > HISTORY_MAX) this.hist.shift();
    this.notify();
  }

  /** 購読（画面用）。遷移のたびと、Tether が notify() したときに呼ばれる。戻り値で解除 */
  subscribe(cb: (s: LinkSnapshot) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  notify(): void {
    if (this.subs.size === 0) return;
    const snap = this.snapshot();
    for (const cb of [...this.subs]) {
      try { cb(snap); } catch {}
    }
  }

  /** いまの状態・次の遷移までの残り・試行回数・遷移履歴・総合状態とデータ経路・有効な設定値 */
  snapshot(): LinkSnapshot {
    const now = this.o.now();
    const c = this.o.context?.() ?? null;
    const tm = this.o.timing;
    const s = this.s;
    const suspend = !c || c.suspend;
    let name: LinkStateName;
    let waiting: { for: WaitingFor; deadlineAt: number } | null = null;
    const attempt = c?.attempt ?? null;
    let enteredAt = s.at;
    if (c && !c.started) { name = 'stopped'; enteredAt = c.since; }
    else if (!suspend) {
      enteredAt = c!.since;
      name = c!.creating ? 'direct-creating' : c!.joining ? 'direct-joining' : c!.directUp ? 'keep-mode' : c!.nearbyUp ? 'nearby-connected' : c!.role === 'host' ? 'nearby-waiting' : 'nearby-searching';
    } else {
      switch (s.phase) {
        case 'settling': name = 'direct-settling'; waiting = { for: 'settle', deadlineAt: s.at + tm.settleMs }; break;
        case 'direct': name = 'direct-active'; waiting = { for: 'T_echo', deadlineAt: s.aliveAt + tm.echoMs }; break;
        case 'retrying': name = 'direct-retrying'; waiting = { for: tm.resumeAtMs === tm.directMs ? 'T_direct' : 'T_nearby', deadlineAt: s.base + tm.resumeAtMs }; break;
        case 'rejoining': name = 'direct-rebuilding'; waiting = { for: 'rejoin', deadlineAt: s.at + tm.rejoinMs }; break;
        default:
          name = c?.creating ? 'direct-creating' : c?.joining ? 'direct-joining' : c?.resumedBecause && !c.nearbyUp ? 'nearby-resumed' : c?.nearbyUp ? 'nearby-connected' : c?.role === 'host' ? 'nearby-waiting' : 'nearby-searching';
      }
    }
    const state: LinkStateInfo = {
      name, label: labelOf(name, attempt), phase: suspend ? s.phase : null, enteredAt, elapsedSec: Math.max(0, Math.round((now - enteredAt) / 1000)),
      waiting: waiting ? { ...waiting, remainingMs: Math.max(0, waiting.deadlineAt - now) } : null, attempt,
    };
    const d = c?.data;
    return {
      state, overall: c?.overall ?? 'disconnected',
      path: { nearby: c?.nearby ?? 'down', group: d?.group ?? null, reach: d?.reach ?? null, lastAliveAt: this.aliveMax || null, bus: d?.bus ?? 'off' },
      data: d ? { ...d, aliveAt: this.aliveMax || d.aliveAt } : null,
      internet: c?.internet ?? null, remoteInternet: c?.remoteInternet ?? null,
      history: [...this.hist], timing: c?.timing ?? tm, at: now,
      controlCarrier: c?.carriers?.control ?? 'nearby', appCarrier: 'bus', appPending: c?.carriers?.appPending ?? 0,
    };
  }

  private violate(rule: string, msg: string): boolean {
    const line = `violation ${rule}: ${msg} (phase=${this.s.phase})`;
    this.violations.push(line);
    this.o.log(line);
    if (this.o.strict) throw new LinkViolation(rule, msg);
    return false;
  }

  /** I1: Nearby の接続系操作の門番。許されなければ拒否(呼び出しは無視)して記録 */
  private nearbyOk(op: string): boolean {
    if (this.nearbyAllowed) return true;
    return this.violate('I1', `${op} を拒否: Direct 稼働中は Nearby を使わない`);
  }

  /** Nearby の薄いラッパー。advertise / discover / requestConnect は I1 を守る。他は通す(止める・切る・送るは常に許す) */
  wrapNearby(api: NearbyApi): NearbyApi {
    const g = this;
    return {
      ...api,
      advertise: (n) => { if (g.nearbyOk('advertise')) api.advertise(n); },
      discover: () => { if (g.nearbyOk('discover')) api.discover(); },
      requestConnect: (id, n) => { if (g.nearbyOk('requestConnect')) api.requestConnect(id, n); },
      suspend: api.suspend ? () => api.suspend!() : undefined,
      resume: api.resume ? () => api.resume!() : undefined,
      note: api.note ? (l) => api.note!(l) : undefined,
      on: (ev, cb) => api.on(ev, cb),
    } as NearbyApi;
  }

  /** Direct の薄いラッパー。startDirect は I3(rebuild 中は Nearby が止まってから)を守る */
  wrapHotspot(h: HotspotPort): HotspotPort {
    const g = this;
    return new Proxy(h, {
      get(t, k, r) {
        if (k === 'joinWifi') {
          return (...a: Parameters<HotspotPort['joinWifi']>) => {
            g.o.log(`joinWifi（I6: 許可）phase=${g.s.phase} nearbyStopped=${g.nearbyStopped} timeout=${a[2] ?? 'default'}ms`);
            return t.joinWifi(...a);
          };
        }
        if (k === 'startDirect') {
          return (...a: Parameters<HotspotPort['startDirect']>) => {
            if (g.rebuilding && !g.nearbyStopped) {
              g.violate('I3', 'startDirect を拒否: Nearby を閉じて完了を待つ前にグループを作らない');
              return Promise.reject(new Error('I3: nearby not stopped'));
            }
            return t.startDirect(...a);
          };
        }
        return Reflect.get(t, k, r);
      },
    });
  }
}
