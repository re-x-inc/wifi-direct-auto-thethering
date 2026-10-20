import test from 'node:test';
import assert from 'node:assert/strict';
import { joinFailureDetail, joinFailureText, parseJoinFailure, type JoinFailureReason } from './joinFailure';
import { pairedFakes } from './fakePlatform';
import { Tether } from './tether';

const ALL: JoinFailureReason[] = ['not-found', 'rejected', 'awaiting-approval', 'timeout', 'unavailable', 'other'];
const FORBIDDEN = /暗号化しています|絶対|完璧|だけ|完全/;
const INTERNAL = /SSID|DIRECT|P2P|Wi-Fi Direct|onUnavailable|ASSOCIATION/i;

test('native の 1 行を、理由・スキャンの要約に読む', () => {
  const f = parseJoinFailure('join-failed reason=not-found direct=0 total=15 expected=0 freq=-');
  assert.deepEqual(f, { reason: 'not-found', direct: 0, total: 15, expectedSeen: false, freq: null });
  const g = parseJoinFailure('join-failed reason=rejected direct=2 total=9 expected=1 freq=2437');
  assert.deepEqual(g, { reason: 'rejected', direct: 2, total: 9, expectedSeen: true, freq: 2437 });
  const h = parseJoinFailure('join-failed reason=timeout direct=? total=? expected=? freq=-');
  assert.deepEqual(h, { reason: 'timeout', direct: null, total: null, expectedSeen: null, freq: null });
});

test('未知の理由・古いメッセージは other(timeout の語句だけ timeout)', () => {
  assert.equal(parseJoinFailure('join-failed reason=zzz direct=0 total=1 expected=0 freq=-').reason, 'other');
  assert.equal(parseJoinFailure('network unavailable (timeout or user declined)').reason, 'timeout');
  assert.equal(parseJoinFailure('boom').reason, 'other');
});

test('理由ごとに文言が別で、見つからない・断られた・確認待ちが区別できる', () => {
  const texts = ALL.map(joinFailureText);
  assert.equal(new Set(texts.filter((_, i) => i < 4)).size, 4);
  assert.match(joinFailureText('not-found'), /親機の Wi-Fi が見つかりません。親機を近づけて、親機のアプリを開いたままに/);
  assert.match(joinFailureText('rejected'), /親機に接続を断られました。親機のアプリを開き直して/);
  assert.match(joinFailureText('awaiting-approval'), /「接続」を押して/);
  assert.match(joinFailureText('timeout'), /時間内/);
});

test('文言と詳細の 1 行に、禁止語と内部用語を含めない', () => {
  for (const r of ALL) {
    const t = joinFailureText(r);
    assert.doesNotMatch(t, FORBIDDEN, t);
    assert.doesNotMatch(t, INTERNAL, t);
  }
  for (const f of [
    parseJoinFailure('join-failed reason=not-found direct=0 total=15 expected=0 freq=-'),
    parseJoinFailure('join-failed reason=rejected direct=2 total=9 expected=1 freq=2437'),
    parseJoinFailure('boom'),
  ]) {
    const d = joinFailureDetail(f);
    assert.doesNotMatch(d, FORBIDDEN, d);
    assert.doesNotMatch(d, INTERNAL, d);
  }
});

test('詳細の 1 行: 見えた数と、親機が見えたか', () => {
  assert.equal(
    joinFailureDetail(parseJoinFailure('join-failed reason=not-found direct=0 total=15 expected=0 freq=-')),
    '周辺の無線 15 件(機器どうしの接続用 0 件)・親機の Wi-Fi: 見えません',
  );
  assert.match(joinFailureDetail(parseJoinFailure('join-failed reason=rejected direct=1 total=4 expected=1 freq=2437')), /見えています/);
  assert.match(joinFailureDetail(parseJoinFailure('boom')), /不明.*確認できませんでした/);
});

test('子機の参加失敗は、理由の状態と文言が画面用の error / joinFailure に入る。次の参加で消える', async () => {
  const f = await pairedFakes({ joinError: 'join-failed reason=not-found direct=0 total=15 expected=0 freq=-' });
  const cfg = { link: { baseMs: 5, maxMs: 20, pingTimeoutMs: 200 }, connectTimeoutMs: 100, probeIntervalMs: 1 };
  const host = new Tether(f.host.platform, cfg);
  const guest = new Tether(f.guest.platform, cfg);
  await host.start(); await guest.start();
  const t0 = Date.now();
  while (guest.getState().wifi !== 'failed') {
    if (Date.now() - t0 > 2000) throw new Error('wifi never failed');
    await new Promise((r) => setTimeout(r, 5));
  }
  const s = guest.getState();
  assert.equal(s.joinFailure?.reason, 'not-found');
  assert.equal(s.joinFailure?.expectedSeen, false);
  assert.equal(s.error, joinFailureText('not-found'));
  host.stop(); guest.stop();
  assert.equal(guest.getState().joinFailure, null);
});
