import {
  Capabilities, HISTORY_TTL_MS, HistoryEntry, LinkMethod, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, Tri,
} from './capability';

/**
 * Link Planner(純関数)。親機が、自分と子機たちの能力・履歴から リンク方式を決める。
 * 入出力だけで決まり、端末にも時刻にも触らない(時刻は now で渡す)。
 * 方式は METHODS に足せば増やせる。
 */

export type { LinkMethod };

export type ReasonCode =
  // 使えない(block)
  | 'protocol-guest-outdated' | 'protocol-host-outdated'
  | 'host-no-cellular' | 'host-no-cellular-guest-has' | 'no-cellular-both'
  | 'host-permission-missing' | 'host-no-wifi-direct' | 'host-no-lohs' | 'no-common-band'
  | 'no-usable-method' | 'no-guest'
  // 台数・切り替え
  | 'guest-limit-reached' | 'wait-existing-direct' | 'switch-to-lohs-for-multi' | 'lohs-added-beside-direct'
  | 'multi-prefers-lohs' | 'multi-direct-kept-no-lohs' | 'lohs-needs-sta-off'
  // 注意・情報
  | 'history-direct-demoted' | 'history-lohs-demoted' | 'direct-approval-remembered' | 'lohs-approval-each-time'
  | 'lohs-after-direct-teardown' | 'sta-ap-not-concurrent' | 'both-have-cellular' | 'capability-unknown'
  | 'guest-vpn-consent-needed' | 'guest-permission-missing' | 'battery-optimization-on' | 'guest-caps-unknown';

export type Severity = 'info' | 'warn' | 'block';

export interface Reason {
  code: ReasonCode;
  severity: Severity;
  message: string;
  method?: LinkMethod;
  peerId?: string;
}

/** 子機が(接続の前に)すべきこと */
export type GuestTodo =
  | 'grant-permissions' | 'vpn-consent' | 'battery-optimization'
  /** LOHS: SSID が毎回変わるので、参加の承認ダイアログが毎回出る */
  | 'approve-join-each-time'
  /** Direct: 初回だけ「常に許可」を選ぶ(以後は覚えられる) */
  | 'approve-join-once'
  | 'update-app'
  /** 方式が切り替わったので、新しい接続情報でつなぎ直す */
  | 'reconnect';

export interface GuestEntry {
  peerId: string;
  /** ペア済み(共有コードを持っている)か。未ペアは無視する(理由もログに出さない) */
  paired: boolean;
  state: 'requesting' | 'connected';
  /** 能力。まだ交換できていなければ null(不明として扱う) */
  caps: Capabilities | null;
  /** connected のとき、今使っている方式 */
  method?: LinkMethod | null;
}

export interface PlanPolicy {
  /** 方式ごとの同時に受け入れる子機の上限。Direct = 1 は設計上の上限(固定 SSID はペアごとに異なる)。LOHS = 4 は暫定値(未検証) */
  maxGuests: Record<LinkMethod, number>;
  /** 既に接続中の子機がいる状態で台数が増えたとき: keep = 既存を切らない / switch = LOHS に切り替える(既存は再接続) */
  existingConnection: 'keep' | 'switch';
  /** 上限を超えた子機: defer = 空くまで待たせる / reject = 断る */
  overLimit: 'defer' | 'reject';
}

export const DEFAULT_POLICY: PlanPolicy = {
  maxGuests: { WifiDirect: 1, LocalOnlyHotspot: 4 },
  existingConnection: 'keep',
  overLimit: 'defer',
};

export interface PlanInput {
  host: Capabilities;
  /** 接続中・接続要求中の子機(各子機の能力つき) */
  guests: GuestEntry[];
  /** ペアごとの方式の結果履歴 */
  history?: Record<string, HistoryEntry[]>;
  policy?: Partial<PlanPolicy>;
  /** 履歴の新しさの判定用(ms) */
  now?: number;
}

export type Admission = 'admit' | 'defer' | 'reject';

export interface GuestPlan {
  peerId: string;
  admission: Admission;
  /** この子機が使う方式。受け入れない(defer/reject)ときは null */
  method: LinkMethod | null;
  todo: GuestTodo[];
  /** 既存の接続を切って、つなぎ直してもらう(切り替え時) */
  reconnect: boolean;
}

export interface PlanFailure {
  code: ReasonCode;
  message: string;
  /** 更新が必要な側 */
  update?: 'host' | 'guest';
}

export interface LinkPlan {
  v: number;
  ok: boolean;
  /** 新しくリンクを張るときに試す方式と順序(失敗時は空) */
  order: LinkMethod[];
  primary: LinkMethod | null;
  guests: GuestPlan[];
  /** 未ペアで無視した端末。理由は残さない */
  ignored: string[];
  reasons: Reason[];
  /** 受け入れる子機すべての「事前にすべきこと」の和集合 */
  guestTodo: GuestTodo[];
  /** 子機ごとに別の SOCKS5 資格情報を発行する(他の子機に渡さない) */
  perGuestCredentials: true;
  /** 子機・親機の両方が対応している周波数帯が分かるときだけ('2.4' | '5')。不明は null */
  band: '2.4' | '5' | null;
  failure: PlanFailure | null;
  /** 人が読める 1 行 */
  summary: string;
}

export const REASON_MESSAGES: Record<ReasonCode, string> = {
  'protocol-guest-outdated': '子機のアプリが古いため、この親機と通信できません。子機のアプリを更新してください',
  'protocol-host-outdated': '親機のアプリが古いため、この子機と通信できません。親機のアプリを更新してください',
  'host-no-cellular': '親機に携帯回線がないため、共有できる回線がありません',
  'host-no-cellular-guest-has': '親機に携帯回線がなく、子機にはあります。役割を入れ替えてください',
  'no-cellular-both': 'どちらの端末にも携帯回線がないため、共有できる回線がありません',
  'host-permission-missing': '親機に必要な権限(近くのデバイス・位置情報など)が許可されていません',
  'host-no-wifi-direct': 'この親機は Wi-Fi Direct に対応していません',
  'host-no-lohs': 'この親機は LocalOnlyHotspot を作れませんでした',
  'no-common-band': '親機と子機に共通して使える Wi-Fi の周波数帯がありません',
  'no-usable-method': '使えるリンク方式がありません',
  'no-guest': '接続の相手がいません',
  'guest-limit-reached': '同時に受け入れられる子機の数の上限に達しました',
  'wait-existing-direct': '既に Wi-Fi Direct で接続中の子機を切らないため、新しい子機は待機します',
  'switch-to-lohs-for-multi': '子機が複数になるため、LocalOnlyHotspot に切り替えます(接続中の子機はつなぎ直します)',
  'lohs-added-beside-direct': '接続中の Wi-Fi Direct はそのままに、新しい子機は LocalOnlyHotspot で受け入れます',
  'multi-prefers-lohs': '子機が複数のため、複数のクライアントに向く LocalOnlyHotspot を優先します',
  'multi-direct-kept-no-lohs': 'この親機は Wi-Fi に接続したまま LocalOnlyHotspot を作れないため、Wi-Fi Direct を維持します',
  'lohs-needs-sta-off': 'この親機は Wi-Fi 接続中に LocalOnlyHotspot を作れない可能性があります(Wi-Fi を切る必要があります)',
  'history-direct-demoted': '最近 Wi-Fi Direct が続けて失敗しているため、LocalOnlyHotspot を先に試します',
  'history-lohs-demoted': '最近 LocalOnlyHotspot が続けて失敗しているため、Wi-Fi Direct を先に試します',
  'direct-approval-remembered': 'Wi-Fi Direct は初回だけ承認が要り、以後は記憶されます',
  'lohs-approval-each-time': 'LocalOnlyHotspot は SSID が毎回変わるため、子機の承認ダイアログが毎回出ます',
  'lohs-after-direct-teardown': 'LocalOnlyHotspot は Wi-Fi Direct のグループを完全に消してから試します',
  'sta-ap-not-concurrent': '親機は Wi-Fi 接続と AP を同時に使えないため、LocalOnlyHotspot 中は親機の Wi-Fi が切れる場合があります',
  'both-have-cellular': '両方の端末に携帯回線があります。意図した役割か確認してください',
  'capability-unknown': '一部の能力が不明のため、実際に試して判断します',
  'guest-vpn-consent-needed': '子機で VPN の許可がまだです',
  'guest-permission-missing': '子機で必要な権限が許可されていません',
  'battery-optimization-on': '子機が省電力の対象です。除外すると接続が安定します',
  'guest-caps-unknown': '子機の能力をまだ受け取っていないため、既定の順序で試します',
};

const reason = (code: ReasonCode, severity: Severity, extra: Partial<Reason> = {}): Reason =>
  ({ code, severity, message: REASON_MESSAGES[code], ...extra });

// ---- 方式の定義(新しい方式はここに足す) ----

interface MethodSpec {
  /** 使えない理由(空なら使える。不明は使える側に倒す) */
  blockers(host: Capabilities): ReasonCode[];
  /** 子機が参加時にすること */
  guestTodo: GuestTodo;
  guestNote: ReasonCode;
}

export const METHODS: Record<LinkMethod, MethodSpec> = {
  WifiDirect: {
    blockers: (h) => (h.radio.wifiDirect === false ? ['host-no-wifi-direct'] : []),
    guestTodo: 'approve-join-once',
    guestNote: 'direct-approval-remembered',
  },
  LocalOnlyHotspot: {
    blockers: (h) => (h.radio.lohs === false ? ['host-no-lohs'] : []),
    guestTodo: 'approve-join-each-time',
    guestNote: 'lohs-approval-each-time',
  },
};

const DEFAULT_ORDER: LinkMethod[] = ['WifiDirect', 'LocalOnlyHotspot'];

const isUnknown = (v: Tri) => v === null;

/** 親機が Wi-Fi 接続のまま AP を作れないと分かっている(razr 型) */
const hostLohsBlockedBySta = (h: Capabilities) => h.radio.staApConcurrent === false;

/** 直近 2 件の結果がどちらも失敗か(成功が挟まればリセット) */
function failingRecently(entries: HistoryEntry[], method: LinkMethod, now: number): boolean {
  const recent = entries.filter((e) => e.method === method && now - e.at <= HISTORY_TTL_MS).slice(-2);
  return recent.length >= 2 && recent.every((e) => !e.ok);
}

function commonBand(host: Capabilities, guests: Capabilities[]): { none: boolean; hint: '2.4' | '5' | null } {
  let none = false;
  const all = (k: 'band24' | 'band5') => host.radio[k] === true && guests.length > 0 && guests.every((g) => g.radio[k] === true);
  for (const g of guests) {
    const h24 = host.radio.band24, h5 = host.radio.band5, g24 = g.radio.band24, g5 = g.radio.band5;
    const no24 = h24 === false || g24 === false;
    const no5 = h5 === false || g5 === false;
    if (no24 && no5) none = true;
  }
  const hint = all('band24') ? '2.4' : all('band5') ? '5' : null;
  return { none, hint };
}

export function isCompatibleVersion(v: number): boolean {
  return Number.isInteger(v) && v >= MIN_PROTOCOL_VERSION && v <= PROTOCOL_VERSION;
}

export function planLink(input: PlanInput): LinkPlan {
  const policy: PlanPolicy = { ...DEFAULT_POLICY, ...input.policy, maxGuests: { ...DEFAULT_POLICY.maxGuests, ...input.policy?.maxGuests } };
  const now = input.now ?? 0;
  const host = input.host;
  const reasons: Reason[] = [];
  const add = (r: Reason) => {
    if (!reasons.some((x) => x.code === r.code && x.peerId === r.peerId && x.method === r.method)) reasons.push(r);
  };

  const ignored = input.guests.filter((g) => !g.paired).map((g) => g.peerId);
  const paired = input.guests.filter((g) => g.paired);
  const finish = (p: Omit<LinkPlan, 'v' | 'perGuestCredentials' | 'summary' | 'reasons' | 'ignored' | 'guestTodo' | 'failure'> & { failure?: PlanFailure | null }): LinkPlan => {
    const todo = [...new Set(p.guests.filter((g) => g.admission === 'admit').flatMap((g) => g.todo))];
    let failure = p.failure ?? null;
    if (!p.ok && !failure) {
      const b = reasons.find((r) => r.severity === 'block') ?? reason('no-usable-method', 'block');
      failure = { code: b.code, message: b.message, update: b.code === 'protocol-guest-outdated' ? 'guest' : b.code === 'protocol-host-outdated' ? 'host' : undefined };
    }
    const summary = p.ok
      ? `${p.order.length ? p.order.join(' → ') : '現在の接続を維持'}(子機 ${p.guests.filter((g) => g.admission === 'admit').length} 台${p.guests.some((g) => g.admission !== 'admit') ? `、待機・断り ${p.guests.filter((g) => g.admission !== 'admit').length} 台` : ''})`
      : `リンクできません: ${failure!.message}`;
    return { v: PROTOCOL_VERSION, perGuestCredentials: true, reasons, ignored, guestTodo: todo, summary, ...p, failure };
  };

  if (paired.length === 0) {
    add(reason('no-guest', 'block'));
    return finish({ ok: false, order: [], primary: null, guests: [], band: null });
  }

  // ---- 版の照合(子機ごと) ----
  const outdated = new Map<string, ReasonCode>();
  for (const g of paired) {
    if (!g.caps) continue;
    if (g.caps.v < MIN_PROTOCOL_VERSION) outdated.set(g.peerId, 'protocol-guest-outdated');
    else if (g.caps.v > PROTOCOL_VERSION) outdated.set(g.peerId, 'protocol-host-outdated');
  }
  for (const [peerId, code] of outdated) add(reason(code, 'block', { peerId }));

  const live = paired.filter((g) => !outdated.has(g.peerId));
  const baseGuests = (): GuestPlan[] =>
    paired.map((g) => ({
      peerId: g.peerId, admission: 'reject' as Admission, method: null, todo: outdated.has(g.peerId) && outdated.get(g.peerId) === 'protocol-guest-outdated' ? ['update-app' as GuestTodo] : [], reconnect: false,
    }));
  const fail = (): LinkPlan => finish({ ok: false, order: [], primary: null, guests: baseGuests(), band: null });

  if (live.length === 0) return fail();

  // ---- 親機そのものの条件 ----
  const guestCellular = live.some((g) => g.caps?.network.cellular === true);
  if (host.network.cellular === false) {
    add(reason(guestCellular ? 'host-no-cellular-guest-has' : live.every((g) => g.caps?.network.cellular === false) ? 'no-cellular-both' : 'host-no-cellular', 'block'));
  } else if (host.network.cellular === true && guestCellular) {
    add(reason('both-have-cellular', 'info'));
  }
  if (host.state.missingPermissions && host.state.missingPermissions.length > 0) add(reason('host-permission-missing', 'block'));

  const bands = commonBand(host, live.flatMap((g) => (g.caps ? [g.caps] : [])));
  if (bands.none) add(reason('no-common-band', 'block'));
  if (reasons.some((r) => r.severity === 'block' && !r.peerId)) return fail();

  // ---- 方式の候補 ----
  const usable = (m: LinkMethod) => METHODS[m].blockers(host);
  const directBlock = usable('WifiDirect');
  const lohsBlock = usable('LocalOnlyHotspot');
  directBlock.forEach((c) => add(reason(c, 'warn', { method: 'WifiDirect' })));
  lohsBlock.forEach((c) => add(reason(c, 'warn', { method: 'LocalOnlyHotspot' })));
  const canDirect = directBlock.length === 0;
  const canLohs = lohsBlock.length === 0;
  if (!canDirect && !canLohs) {
    add(reason('no-usable-method', 'block'));
    return fail();
  }
  // 複数台の受け皿として LOHS を使えるか(Wi-Fi 接続中に AP を作れない機種は不可)
  const lohsForMulti = canLohs && !hostLohsBlockedBySta(host);

  const connected = live.filter((g) => g.state === 'connected');
  const requesting = live.filter((g) => g.state === 'requesting');
  const history = live.flatMap((g) => input.history?.[g.peerId] ?? []);

  // ---- 方式と受け入れ ----
  let order: LinkMethod[] = [];
  const decision = new Map<string, { admission: Admission; method: LinkMethod | null; reconnect: boolean }>();
  const set = (g: GuestEntry, admission: Admission, method: LinkMethod | null, reconnect = false) =>
    decision.set(g.peerId, { admission, method, reconnect });
  /** 上限までを受け入れ、超えた分を待機 / 断りにする */
  const fill = (method: LinkMethod, keep: GuestEntry[], newcomers: GuestEntry[]) => {
    let room = policy.maxGuests[method] - keep.length;
    for (const g of keep) set(g, 'admit', method);
    for (const g of newcomers) {
      if (room > 0) { set(g, 'admit', method); room--; }
      else {
        set(g, policy.overLimit === 'defer' ? 'defer' : 'reject', null);
        add(reason('guest-limit-reached', 'warn', { method, peerId: g.peerId }));
      }
    }
  };

  const count = live.length;
  if (count <= 1) {
    // 1 台: 従来どおり Direct を主、LOHS を予備。履歴で続けて失敗している方は後ろへ
    let seq = DEFAULT_ORDER.filter((m) => (m === 'WifiDirect' ? canDirect : canLohs));
    const dFail = failingRecently(history, 'WifiDirect', now);
    const lFail = failingRecently(history, 'LocalOnlyHotspot', now);
    if (seq.length === 2 && dFail && !lFail) {
      seq = ['LocalOnlyHotspot', 'WifiDirect'];
      add(reason('history-direct-demoted', 'info'));
    } else if (seq.length === 2 && lFail && !dFail) {
      add(reason('history-lohs-demoted', 'info')); // 既に Direct が先
    }
    order = seq;
    if (seq.includes('LocalOnlyHotspot') && seq.length === 2 && seq[0] === 'WifiDirect') add(reason('lohs-after-direct-teardown', 'info', { method: 'LocalOnlyHotspot' }));
    if (seq.includes('LocalOnlyHotspot') && host.radio.staApConcurrent === false) add(reason('sta-ap-not-concurrent', 'info', { method: 'LocalOnlyHotspot' }));
    const g = live[0];
    // 接続中ならその方式のまま
    set(g, 'admit', g.state === 'connected' && g.method ? g.method : seq[0]);
  } else {
    // 複数台
    const existingMethod = connected.find((g) => g.method)?.method ?? null;
    if (existingMethod === 'WifiDirect') {
      // 既に Direct で接続中の子機がいる状態で台数が増えた
      if (lohsForMulti && host.radio.p2pApCoexist === true) {
        // P2P と AP の同居が確認済み: 既存はそのまま、新規だけ LOHS
        order = ['LocalOnlyHotspot'];
        for (const g of connected) set(g, 'admit', 'WifiDirect');
        fill('LocalOnlyHotspot', [], requesting);
        add(reason('lohs-added-beside-direct', 'info'));
      } else if (lohsForMulti && policy.existingConnection === 'switch') {
        order = ['LocalOnlyHotspot'];
        fill('LocalOnlyHotspot', [], [...connected, ...requesting]);
        for (const g of connected) { const d = decision.get(g.peerId)!; if (d.admission === 'admit') d.reconnect = true; }
        add(reason('switch-to-lohs-for-multi', 'warn'));
      } else {
        // 既存を切らない: Direct を維持。上限を超えた新規は待機/断り
        order = ['WifiDirect'];
        fill('WifiDirect', connected, requesting);
        for (const g of requesting) {
          const d = decision.get(g.peerId)!;
          if (d.admission !== 'admit') add(reason(lohsForMulti ? 'wait-existing-direct' : 'multi-direct-kept-no-lohs', 'info', { peerId: g.peerId }));
        }
        if (!lohsForMulti && canLohs) add(reason('lohs-needs-sta-off', 'info', { method: 'LocalOnlyHotspot' }));
      }
    } else if (existingMethod === 'LocalOnlyHotspot') {
      order = ['LocalOnlyHotspot'];
      fill('LocalOnlyHotspot', connected, requesting);
    } else if (lohsForMulti) {
      // 全員これから: 複数台は LOHS を優先
      order = ['LocalOnlyHotspot'];
      fill('LocalOnlyHotspot', [], live);
      add(reason('multi-prefers-lohs', 'info'));
    } else if (canDirect) {
      // LOHS に切り替えられない機種: Direct を維持し、上限は理由コードで返す
      order = ['WifiDirect'];
      fill('WifiDirect', [], live);
      add(reason('multi-direct-kept-no-lohs', 'warn'));
      if (canLohs) add(reason('lohs-needs-sta-off', 'info', { method: 'LocalOnlyHotspot' }));
    } else {
      add(reason('no-usable-method', 'block'));
      return fail();
    }
  }

  // ---- 子機ごとの「事前にすべきこと」 ----
  const guestPlans: GuestPlan[] = paired.map((g) => {
    if (outdated.has(g.peerId)) return baseGuests().find((x) => x.peerId === g.peerId)!;
    const d = decision.get(g.peerId)!;
    const todo: GuestTodo[] = [];
    if (d.admission === 'admit' && d.method) {
      if (g.caps) {
        if (g.caps.state.missingPermissions && g.caps.state.missingPermissions.length > 0) {
          todo.push('grant-permissions');
          add(reason('guest-permission-missing', 'warn', { peerId: g.peerId }));
        }
        if (g.caps.state.vpnConsent === false) {
          todo.push('vpn-consent');
          add(reason('guest-vpn-consent-needed', 'warn', { peerId: g.peerId }));
        }
        if (g.caps.device.batteryOptimizationExempt === false) {
          todo.push('battery-optimization');
          add(reason('battery-optimization-on', 'info', { peerId: g.peerId }));
        }
      }
      todo.push(METHODS[d.method].guestTodo);
      add(reason(METHODS[d.method].guestNote, 'info', { method: d.method }));
      if (d.reconnect) todo.push('reconnect');
    }
    return { peerId: g.peerId, admission: d.admission, method: d.method, todo, reconnect: d.reconnect };
  });

  if (live.some((g) => !g.caps)) add(reason('guest-caps-unknown', 'info'));
  const unknownHost = [host.radio.wifiDirect, host.radio.lohs].some(isUnknown);
  if (unknownHost) add(reason('capability-unknown', 'info'));

  const ok = guestPlans.some((g) => g.admission === 'admit');
  return finish({ ok, order: ok ? order : [], primary: ok ? (order[0] ?? guestPlans.find((g) => g.admission === 'admit')?.method ?? null) : null, guests: guestPlans, band: bands.hint });
}

/**
 * 子機ごとに別の SOCKS5 資格情報を発行する。同じ値を 2 台に渡さない。
 * (複数子機の実行時対応で使う。値はログに出さないこと)
 */
export function issueGuestCredentials(peerIds: string[], randomHex: (bytes: number) => string): Record<string, { user: string; pass: string }> {
  const out: Record<string, { user: string; pass: string }> = {};
  const seen = new Set<string>();
  for (const id of peerIds) {
    let user = 'u' + randomHex(4);
    while (seen.has(user)) user = 'u' + randomHex(4);
    seen.add(user);
    out[id] = { user, pass: randomHex(12) };
  }
  return out;
}

const METHOD_NAMES: LinkMethod[] = ['WifiDirect', 'LocalOnlyHotspot'];
const GUEST_TODOS = new Set(['grant-permissions', 'vpn-consent', 'battery-optimization', 'approve-join-each-time', 'approve-join-once', 'update-app', 'reconnect']);

/** 受信した計画を検証して整える。形が違えば null(相手が壊れている・知らない版) */
export function parsePlan(x: unknown): LinkPlan | null {
  const o = x as any;
  if (!o || typeof o !== 'object' || typeof o.v !== 'number' || typeof o.ok !== 'boolean') return null;
  if (!Array.isArray(o.order) || !o.order.every((m: unknown) => METHOD_NAMES.includes(m as LinkMethod))) return null;
  if (!Array.isArray(o.guests) || !Array.isArray(o.reasons)) return null;
  const guests: GuestPlan[] = [];
  for (const g of o.guests.slice(0, 16)) {
    if (!g || typeof g.peerId !== 'string' || !['admit', 'defer', 'reject'].includes(g.admission)) return null;
    guests.push({
      peerId: g.peerId.slice(0, 64),
      admission: g.admission,
      method: METHOD_NAMES.includes(g.method) ? g.method : null,
      todo: Array.isArray(g.todo) ? g.todo.filter((t: unknown) => GUEST_TODOS.has(t as string)) : [],
      reconnect: g.reconnect === true,
    });
  }
  const reasons: Reason[] = o.reasons.slice(0, 64)
    .filter((r: any) => r && typeof r.code === 'string' && ['info', 'warn', 'block'].includes(r.severity))
    .map((r: any) => ({ code: r.code, severity: r.severity, message: typeof r.message === 'string' ? r.message.slice(0, 200) : '' }));
  const f = o.failure;
  return {
    v: o.v,
    ok: o.ok,
    order: o.order,
    primary: METHOD_NAMES.includes(o.primary) ? o.primary : null,
    guests,
    ignored: [],
    reasons,
    guestTodo: Array.isArray(o.guestTodo) ? o.guestTodo.filter((t: unknown) => GUEST_TODOS.has(t as string)) : [],
    perGuestCredentials: true,
    band: o.band === '2.4' || o.band === '5' ? o.band : null,
    failure: f && typeof f.code === 'string'
      ? { code: f.code, message: typeof f.message === 'string' ? f.message.slice(0, 200) : '', update: f.update === 'host' || f.update === 'guest' ? f.update : undefined }
      : null,
    summary: typeof o.summary === 'string' ? o.summary.slice(0, 200) : '',
  };
}
