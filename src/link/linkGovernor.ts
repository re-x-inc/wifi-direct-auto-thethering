import type { NearbyApi } from './nearbyTransport';
import { GuardAction, GuardEvent, GuardPhase, GuardState, GuardTiming, initialGuard, nearbyShouldBeOff, stepGuard } from './directGuard';
import type { HotspotPort } from '../api/types';

/**
 * Nearby と Wi-Fi Direct の使い分けの責任者。状態機械(directGuard.ts の遷移表。docs/LINK_STATE.md の図と一対一)を持ち、
 * Nearby と Direct に触る操作を必ずここを通す。ネイティブの部品(NearbyApi / HotspotPort)は Tether が governor の `nearby` / `hotspot`
 * 経由でしか使わない(Tether はこの2つ以外のネイティブ参照を持たない)ので、不変条件を迂回できない。
 *
 * 不変条件(違反は拒否して DH-LINK に記録。strict=true(テスト)では例外):
 *  I1  Direct 稼働中(direct / retrying / rejoining)は Nearby の advertise・discover・requestConnect を出さない
 *  I2  Nearby の再開(resume)は T_direct(親機)/ T_nearby(子機)の経過後、または親機が再接続を使い切ったときだけ。早すぎる再開は拒否
 *  I3  再接続の順序: 接続情報の再送 → Nearby を閉じて完了を待つ → 固定グループの作成。Nearby が止まる前の startDirect は拒否
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
}

export class LinkGovernor {
  private s: GuardState;
  /** Nearby を実際に止め終えた(suspend 完了)か。I3 の判定に使う */
  private nearbyStopped = false;
  /** rebuild 手順中(接続情報を送った → Nearby を閉じる → グループ作成) */
  private rebuilding = false;
  readonly violations: string[] = [];

  constructor(private o: GovernorOptions) {
    this.s = initialGuard(o.now());
  }

  get state(): GuardState { return this.s; }
  get phase(): GuardPhase { return this.s.phase; }
  get timing(): GuardTiming { return this.o.timing; }
  get nearbyAllowed(): boolean { return !nearbyShouldBeOff(this.s.phase); }

  /** 事象を入れる。遷移は stepGuard の表どおり(表に無い事象は状態を変えない) */
  dispatch(ev: GuardEvent): void {
    const prev = this.s;
    const [next, acts] = stepGuard(prev, ev, this.o.now(), this.o.timing);
    this.s = next;
    if (next.phase !== prev.phase) this.o.log(`transition ${prev.phase} → ${next.phase} on ${ev.t}${'reason' in ev ? `(${ev.reason})` : ''}`);
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

  /** suspend が完了した / 再開した(Tether が実際の Nearby 操作を終えたら知らせる) */
  markNearbyStopped(stopped: boolean): void {
    this.nearbyStopped = stopped;
  }

  /** リセット(停止・ペアリングなど)。Nearby は誰でも使える状態に戻る */
  reset(): void {
    this.s = initialGuard(this.o.now());
    this.nearbyStopped = false;
    this.rebuilding = false;
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
