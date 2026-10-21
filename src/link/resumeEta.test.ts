import test from 'node:test';
import assert from 'node:assert/strict';
import { formatResumeEta, isResumeWaitingName, remainingSec, resumeEtaIntervalMs, shouldLogResumeEta } from './resumeEta';

test('remainingSec は切り上げ、0 以下・非数は 0', () => {
  assert.equal(remainingSec(150_000), 150);
  assert.equal(remainingSec(1), 1);
  assert.equal(remainingSec(0), 0);
  assert.equal(remainingSec(-5), 0);
  assert.equal(remainingSec(NaN), 0);
});

test('間隔は 10〜15 秒に丸める', () => {
  assert.equal(resumeEtaIntervalMs(), 12_000);
  assert.equal(resumeEtaIntervalMs(1000), 10_000);
  assert.equal(resumeEtaIntervalMs(60_000), 15_000);
  assert.equal(resumeEtaIntervalMs(NaN), 12_000);
});

test('shouldLogResumeEta: 初回は即、以降は間隔ごと', () => {
  assert.equal(shouldLogResumeEta(null, 1000), true);
  assert.equal(shouldLogResumeEta(1000, 12_999, 12_000), false);
  assert.equal(shouldLogResumeEta(1000, 13_000, 12_000), true);
  assert.equal(shouldLogResumeEta(5000, 1000), true); // 時計が戻った
});

test('formatResumeEta: 残り秒・理由・試行回数。秘密になりうる語を含まない', () => {
  const s = formatResumeEta(97_300, 'silence', 2);
  assert.equal(s, '再開待ち: Nearby 再開まであと 98s(理由=silence、試行 2 回目)');
  assert.equal(formatResumeEta(0, null, null), '再開待ち: Nearby 再開まであと 0s(理由=不明、試行 - 回目)');
});

test('対象の状態名', () => {
  assert.equal(isResumeWaitingName('direct-retrying'), true);
  assert.equal(isResumeWaitingName('direct-rebuilding'), true);
  assert.equal(isResumeWaitingName('direct-active'), false);
});
