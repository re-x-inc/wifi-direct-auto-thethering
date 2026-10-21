import type { BusPort, BusStartOptions, BusStatus } from './busControl';

/**
 * バス(ネイティブの BusEngine)の偽物。親機と子機の 2 つの BusPort を作り、両方が start されていてリンクが生きていれば
 * 「認証済み」で up になる。テストから link(false) で切れ、link(true) で戻る(戻ると両側に up が通知される)。
 * 実機のネイティブと同じく、up でないときの send は false(送らない)、切断の瞬間に空中にあったメッセージは失われる。
 */
export function fakeBusPair(now: () => number = () => Date.now()) {
  type Side = {
    port: BusPort; started: boolean; up: boolean; lastRxAt: number; connects: number;
    stateCbs: Set<(e: { up: boolean; reason: string }) => void>; msgCbs: Set<(p: string) => void>;
    opts: BusStartOptions | null;
  };
  const mk = (): Side => ({ port: null as unknown as BusPort, started: false, up: false, lastRxAt: 0, connects: 0, stateCbs: new Set(), msgCbs: new Set(), opts: null });
  const host = mk(), guest = mk();
  const ctl = {
    linkOk: true,
    /** true にすると、次の send は up のまま黙って落とす(ack が来ない状況を作る) */
    dropNext: 0,
    /** 子機が親機に送ったもの(認証後のペイロード)を記録 */
    sent: { host: [] as string[], guest: [] as string[] },
    /** start の履歴 */
    starts: [] as string[],
  };
  const other = (s: Side) => (s === host ? guest : host);
  const name = (s: Side) => (s === host ? 'host' : 'guest');
  const setUp = (up: boolean, reason: string) => {
    // 実機は親機が認証完了した直後に送っても、子機は K を先に処理するので受け取れる: 先に両方を up にしてから通知する
    const changed = [host, guest].filter((s) => s.up !== up);
    for (const s of changed) {
      s.up = up;
      if (up) { s.connects++; s.lastRxAt = now(); }
    }
    for (const s of changed) for (const cb of [...s.stateCbs]) cb({ up, reason });
  };
  const reevaluate = (reason: string) => {
    if (host.started && guest.started && ctl.linkOk) setUp(true, reason);
    else setUp(false, reason);
  };
  for (const s of [host, guest]) {
    s.port = {
      start: (o) => {
        s.started = true; s.opts = o; ctl.starts.push(name(s));
        // 実機と同じく、認証は非同期(start の直後には up にならない)
        setTimeout(() => reevaluate('auth'), 1);
        return o.host ? '192.168.49.1' : `${o.addr}:${o.port}`;
      },
      stop: () => { s.started = false; reevaluate('stopped'); },
      send: (payload) => {
        if (!s.up || !other(s).up) return false;
        ctl.sent[name(s)].push(payload);
        if (ctl.dropNext > 0) { ctl.dropNext--; return true; }
        const o = other(s);
        setTimeout(() => {
          if (!o.up || !s.up) return; // 空中で切れたものは失われる
          o.lastRxAt = now();
          for (const cb of [...o.msgCbs]) cb(payload);
        }, 0);
        return true;
      },
      status: (): BusStatus => ({ running: s.started, up: s.up, lastRxAt: s.lastRxAt, connects: s.connects, lastError: null }),
      onState: (cb) => (s.stateCbs.add(cb), () => s.stateCbs.delete(cb)),
      onMessage: (cb) => (s.msgCbs.add(cb), () => s.msgCbs.delete(cb)),
    };
  }
  return {
    host: host.port, guest: guest.port, ctl,
    /** リンクの断/復帰 */
    link: (ok: boolean) => { ctl.linkOk = ok; reevaluate(ok ? 'auth' : 'timeout'); },
    /** ping/pong の代わり: 生存信号(lastRxAt)だけ進める */
    pulse: () => { host.lastRxAt = now(); guest.lastRxAt = now(); },
    isUp: () => host.up && guest.up,
  };
}
