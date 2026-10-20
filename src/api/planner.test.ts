import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCapabilities, Capabilities, HistoryEntry, NativeCapabilities, PROTOCOL_VERSION, ProbeStore } from './capability';
import { GuestEntry, issueGuestCredentials, planLink, PlanInput } from './planner';

const NOW = 10_000_000_000;

const native = (o: Partial<NativeCapabilities> = {}): NativeCapabilities => ({
  manufacturer: 'X', model: 'M', sdk: 35, release: '15', batteryPercent: 80, batteryOptimizationExempt: true,
  wifiDirect: true, staApConcurrent: true, staLocalOnlyConcurrent: true, band24: true, band5: true,
  vpnConsent: true, deviceOwner: false, missingPermissions: [], ...o,
});
const mk = (o: Partial<NativeCapabilities> = {}, cellular: boolean | null = false, probe: ProbeStore | null = null): Capabilities =>
  buildCapabilities({ native: native(o), cellular, probe, now: NOW });
const probe = (p: Partial<ProbeStore>): ProbeStore => ({ buildKey: 'M|35', at: NOW, observed: {}, ...p });

const host = (o: Partial<NativeCapabilities> = {}, p: ProbeStore | null = null) => mk(o, true, p);
const guest = (peerId: string, o: Partial<GuestEntry> = {}): GuestEntry => ({ peerId, paired: true, state: 'requesting', caps: mk(), ...o });
const plan = (i: PlanInput) => planLink({ now: NOW, ...i });
const codes = (p: ReturnType<typeof planLink>) => p.reasons.map((r) => r.code);
/** razr 型: Wi-Fi 接続のまま AP を作れない(STA+P2P は可、STA+AP は不可) */
const razr = () => host({ staApConcurrent: false }, probe({ observed: { staP2pConcurrent: true } }));

// ---- 1 台 ----

test('1台・全部可: Direct が主、LOHS が予備。子機は初回承認のみ', () => {
  const p = plan({ host: host(), guests: [guest('g1')] });
  assert.equal(p.ok, true);
  assert.deepEqual(p.order, ['WifiDirect', 'LocalOnlyHotspot']);
  assert.equal(p.primary, 'WifiDirect');
  assert.deepEqual(p.guests[0].todo, ['approve-join-once']);
  assert.equal(p.band, '2.4');
  assert.equal(p.perGuestCredentials, true);
  assert.ok(codes(p).includes('lohs-after-direct-teardown'));
});

test('razr 型(STA+P2P は可・AP 不可)でも 1 台は Direct → LOHS の既定順序で、AP 不可の注意が付く', () => {
  const p = plan({ host: razr(), guests: [guest('g1')] });
  assert.deepEqual(p.order, ['WifiDirect', 'LocalOnlyHotspot']);
  assert.ok(codes(p).includes('sta-ap-not-concurrent'));
});

test('Direct 不可の親機は LOHS のみ。子機は毎回承認が必要と案内する', () => {
  const p = plan({ host: host({ wifiDirect: false }), guests: [guest('g1')] });
  assert.deepEqual(p.order, ['LocalOnlyHotspot']);
  assert.ok(codes(p).includes('host-no-wifi-direct'));
  assert.ok(p.guests[0].todo.includes('approve-join-each-time'));
  assert.ok(codes(p).includes('lohs-approval-each-time'));
});

test('Direct も LOHS も不可なら ok=false と人が読める理由', () => {
  const p = plan({ host: host({ wifiDirect: false }, probe({ lohs: { ok: false, reason: 'generic', at: NOW } })), guests: [guest('g1')] });
  assert.equal(p.ok, false);
  assert.deepEqual(p.order, []);
  assert.equal(p.failure?.code, 'no-usable-method');
  assert.match(p.failure!.message, /使えるリンク方式/);
  assert.match(p.summary, /リンクできません/);
});

test('一時的な失敗(busy/permission)の試験結果では LOHS 不可と断定しない', () => {
  const c = host({}, probe({ lohs: { ok: false, reason: 'busy', at: NOW } }));
  assert.equal(c.radio.lohs, null);
  const c2 = host({}, probe({ lohs: { ok: false, reason: 'no-channel', at: NOW } }));
  assert.equal(c2.radio.lohs, false);
  assert.equal(c2.source.lohs, 'probe');
});

test('回線なし同士 / 親機だけ回線なし / 両方回線あり', () => {
  const both = plan({ host: mk({}, false), guests: [guest('g1', { caps: mk({}, false) })] });
  assert.equal(both.ok, false);
  assert.equal(both.failure?.code, 'no-cellular-both');
  const swap = plan({ host: mk({}, false), guests: [guest('g1', { caps: mk({}, true) })] });
  assert.equal(swap.failure?.code, 'host-no-cellular-guest-has');
  const dual = plan({ host: host(), guests: [guest('g1', { caps: mk({}, true) })] });
  assert.equal(dual.ok, true);
  assert.ok(codes(dual).includes('both-have-cellular'));
});

test('回線が不明(null)なら止めずに進める', () => {
  const p = plan({ host: mk({}, null), guests: [guest('g1')] });
  assert.equal(p.ok, true);
});

test('プロトコル版の不一致: 子機が古い / 親機が古い', () => {
  const old = { ...mk(), v: 0 };
  const a = plan({ host: host(), guests: [guest('g1', { caps: old })] });
  assert.equal(a.ok, false);
  assert.equal(a.failure?.code, 'protocol-guest-outdated');
  assert.equal(a.failure?.update, 'guest');
  assert.deepEqual(a.guests[0].todo, ['update-app']);
  const newer = { ...mk(), v: PROTOCOL_VERSION + 1 };
  const b = plan({ host: host(), guests: [guest('g1', { caps: newer })] });
  assert.equal(b.failure?.code, 'protocol-host-outdated');
  assert.equal(b.failure?.update, 'host');
});

test('親機の権限不足は block。子機の権限・VPN 同意・省電力は「事前にすべきこと」', () => {
  const blocked = plan({ host: host({ missingPermissions: ['NEARBY_WIFI_DEVICES'] }), guests: [guest('g1')] });
  assert.equal(blocked.failure?.code, 'host-permission-missing');
  const p = plan({
    host: host(),
    guests: [guest('g1', { caps: mk({ missingPermissions: ['BLUETOOTH_SCAN'], vpnConsent: false, batteryOptimizationExempt: false }) })],
  });
  assert.equal(p.ok, true);
  assert.deepEqual(p.guests[0].todo, ['grant-permissions', 'vpn-consent', 'battery-optimization', 'approve-join-once']);
  assert.deepEqual(p.guestTodo, p.guests[0].todo);
});

test('共通の周波数帯がない / 片方が 5GHz 非対応なら 2.4 を案内', () => {
  const none = plan({ host: host({ band24: false }), guests: [guest('g1', { caps: mk({ band5: false }) })] });
  assert.equal(none.failure?.code, 'no-common-band');
  const only24 = plan({ host: host(), guests: [guest('g1', { caps: mk({ band5: false }) })] });
  assert.equal(only24.band, '2.4');
  const unknown = plan({ host: host({ band24: null, band5: null }), guests: [guest('g1')] });
  assert.equal(unknown.band, null);
  assert.ok(unknown.ok);
});

test('子機の能力が不明(null)でも既定の順序で進み、理由に残る', () => {
  const p = plan({ host: host(), guests: [guest('g1', { caps: null })] });
  assert.equal(p.ok, true);
  assert.deepEqual(p.order, ['WifiDirect', 'LocalOnlyHotspot']);
  assert.ok(codes(p).includes('guest-caps-unknown'));
});

test('履歴: Direct が続けて失敗していれば LOHS を先に。成功が挟まればリセット', () => {
  const h = (entries: Partial<HistoryEntry>[]): Record<string, HistoryEntry[]> => ({
    g1: entries.map((e, i) => ({ method: 'WifiDirect', stage: 'create', ok: false, at: NOW - 1000 + i, ...e })),
  });
  const a = plan({ host: host(), guests: [guest('g1')], history: h([{}, {}]) });
  assert.deepEqual(a.order, ['LocalOnlyHotspot', 'WifiDirect']);
  assert.ok(codes(a).includes('history-direct-demoted'));
  const b = plan({ host: host(), guests: [guest('g1')], history: h([{}, {}, { ok: true }]) });
  assert.deepEqual(b.order, ['WifiDirect', 'LocalOnlyHotspot']);
  const old = plan({ host: host(), guests: [guest('g1')], history: h([{ at: 1 }, { at: 2 }]) });
  assert.deepEqual(old.order[0], 'WifiDirect');
  const both = plan({ host: host(), guests: [guest('g1')], history: { g1: [
    ...h([{}, {}]).g1, { method: 'LocalOnlyHotspot', stage: 'create', ok: false, at: NOW - 10 }, { method: 'LocalOnlyHotspot', stage: 'create', ok: false, at: NOW - 9 },
  ] } });
  assert.deepEqual(both.order[0], 'WifiDirect'); // どちらも失敗なら既定のまま
});

test('能力の自己申告: 試験・観測結果は公式 API の値より優先され、版が違えば無視される', () => {
  const c = host({ staApConcurrent: true }, probe({ observed: { p2pApCoexist: false } }));
  assert.equal(c.radio.p2pApCoexist, false);
  assert.equal(c.source.p2pApCoexist, 'observed');
  assert.equal(c.source.staApConcurrent, 'api');
  assert.equal(c.state.alwaysOnVpn, null);
});

// ---- 複数台 ----

test('1台 → 2台(全員これから): LOHS を優先し、子機は毎回承認が要る', () => {
  const one = plan({ host: host(), guests: [guest('g1')] });
  assert.equal(one.primary, 'WifiDirect');
  const two = plan({ host: host(), guests: [guest('g1'), guest('g2')] });
  assert.deepEqual(two.order, ['LocalOnlyHotspot']);
  assert.ok(two.guests.every((g) => g.admission === 'admit' && g.method === 'LocalOnlyHotspot' && g.todo.includes('approve-join-each-time')));
  assert.ok(codes(two).includes('multi-prefers-lohs'));
  assert.equal(two.perGuestCredentials, true);
});

test('LOHS 不可の機種(razr 型)で 2 台: Direct を維持し、2 台目は待機 + 上限の理由コード', () => {
  const p = plan({ host: razr(), guests: [guest('g1'), guest('g2')] });
  assert.deepEqual(p.order, ['WifiDirect']);
  assert.equal(p.guests[0].admission, 'admit');
  assert.equal(p.guests[1].admission, 'defer');
  assert.equal(p.guests[1].method, null);
  assert.ok(codes(p).includes('guest-limit-reached'));
  assert.ok(codes(p).includes('multi-direct-kept-no-lohs'));
  assert.equal(p.ok, true);
});

test('LOHS 不可の機種で 2 台: 方針 reject なら断る', () => {
  const p = plan({ host: razr(), guests: [guest('g1'), guest('g2')], policy: { overLimit: 'reject' } });
  assert.equal(p.guests[1].admission, 'reject');
  assert.ok(codes(p).includes('guest-limit-reached'));
});

test('Direct 接続中 + 新規(既定 keep): 既存を切らず、新規は待機', () => {
  const p = plan({ host: host(), guests: [guest('g1', { state: 'connected', method: 'WifiDirect' }), guest('g2')] });
  assert.deepEqual(p.order, ['WifiDirect']);
  assert.equal(p.guests[0].admission, 'admit');
  assert.equal(p.guests[0].reconnect, false);
  assert.equal(p.guests[1].admission, 'defer');
  assert.ok(codes(p).includes('wait-existing-direct'));
  assert.ok(!p.guestTodo.includes('reconnect'));
});

test('Direct 接続中 + 新規(方針 switch): LOHS に切り替え、既存の子機に再接続を指示', () => {
  const p = plan({
    host: host(), policy: { existingConnection: 'switch' },
    guests: [guest('g1', { state: 'connected', method: 'WifiDirect' }), guest('g2')],
  });
  assert.deepEqual(p.order, ['LocalOnlyHotspot']);
  assert.equal(p.guests[0].reconnect, true);
  assert.ok(p.guests[0].todo.includes('reconnect'));
  assert.ok(p.guests[0].todo.includes('approve-join-each-time'));
  assert.equal(p.guests[1].reconnect, false);
  assert.ok(codes(p).includes('switch-to-lohs-for-multi'));
});

test('Direct 接続中 + 新規(razr 型で方針 switch でも): 切り替えず Direct を維持', () => {
  const p = plan({ host: razr(), policy: { existingConnection: 'switch' }, guests: [guest('g1', { state: 'connected', method: 'WifiDirect' }), guest('g2')] });
  assert.deepEqual(p.order, ['WifiDirect']);
  assert.equal(p.guests[0].reconnect, false);
  assert.equal(p.guests[1].admission, 'defer');
  assert.ok(codes(p).includes('multi-direct-kept-no-lohs'));
});

test('Direct 接続中 + 新規: P2P+AP の同居が確認済みなら、既存はそのまま新規だけ LOHS', () => {
  const h = host({}, probe({ observed: { p2pApCoexist: true } }));
  const p = plan({ host: h, guests: [guest('g1', { state: 'connected', method: 'WifiDirect' }), guest('g2')] });
  assert.equal(p.guests[0].method, 'WifiDirect');
  assert.equal(p.guests[0].reconnect, false);
  assert.equal(p.guests[1].method, 'LocalOnlyHotspot');
  assert.ok(codes(p).includes('lohs-added-beside-direct'));
});

test('LOHS 接続中に追加: そのまま受け入れ、既存は再接続なし', () => {
  const p = plan({ host: host(), guests: [guest('g1', { state: 'connected', method: 'LocalOnlyHotspot' }), guest('g2')] });
  assert.deepEqual(p.guests.map((g) => [g.admission, g.reconnect]), [['admit', false], ['admit', false]]);
});

test('台数上限超過: LOHS の上限(既定 4)を超えた分は待機。上限は方針で変えられる', () => {
  const gs = ['a', 'b', 'c', 'd', 'e'].map((id) => guest(id));
  const p = plan({ host: host(), guests: gs });
  assert.deepEqual(p.guests.map((g) => g.admission), ['admit', 'admit', 'admit', 'admit', 'defer']);
  assert.ok(codes(p).includes('guest-limit-reached'));
  const q = plan({ host: host(), guests: gs.slice(0, 3), policy: { maxGuests: { WifiDirect: 1, LocalOnlyHotspot: 2 }, overLimit: 'reject' } });
  assert.deepEqual(q.guests.map((g) => g.admission), ['admit', 'admit', 'reject']);
});

test('未ペア端末の要求は無視される(台数に数えず、理由も残さない)', () => {
  const p = plan({ host: host(), guests: [guest('g1'), guest('stranger', { paired: false })] });
  assert.deepEqual(p.ignored, ['stranger']);
  assert.deepEqual(p.guests.map((g) => g.peerId), ['g1']);
  assert.equal(p.primary, 'WifiDirect'); // 1 台扱い
  assert.ok(!JSON.stringify(p.reasons).includes('stranger'));
  const only = plan({ host: host(), guests: [guest('stranger', { paired: false })] });
  assert.equal(only.ok, false);
  assert.equal(only.failure?.code, 'no-guest');
});

test('複数台のうち 1 台だけ版が古い: その子機だけ断り、他は進む', () => {
  const p = plan({ host: host(), guests: [guest('g1'), guest('g2', { caps: { ...mk(), v: 0 } })] });
  assert.equal(p.ok, true);
  assert.equal(p.guests[1].admission, 'reject');
  assert.deepEqual(p.guests[1].todo, ['update-app']);
  assert.equal(p.primary, 'WifiDirect');
});

test('子機ごとに別の SOCKS5 資格情報を発行する', () => {
  let n = 0;
  const rnd = (b: number) => Array.from({ length: b }, () => ((n++ * 7) % 256).toString(16).padStart(2, '0')).join('');
  const c = issueGuestCredentials(['g1', 'g2', 'g3'], rnd);
  const users = Object.values(c).map((x) => x.user);
  const passes = Object.values(c).map((x) => x.pass);
  assert.equal(new Set(users).size, 3);
  assert.equal(new Set(passes).size, 3);
  assert.deepEqual(Object.keys(c), ['g1', 'g2', 'g3']);
});

test('計画に共有コード・資格情報・パスフレーズが含まれない', () => {
  const p = plan({ host: host(), guests: [guest('g1'), guest('g2')] });
  const s = JSON.stringify(p).toLowerCase();
  for (const w of ['secret', 'passphrase', 'password', '"pass"', '"user"']) assert.ok(!s.includes(w), w);
});
