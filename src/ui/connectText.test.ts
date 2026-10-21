import test from 'node:test';
import assert from 'node:assert/strict';
import { internetText, linkSummary, nearbyErrorHint, pairingHeading, wifiJoinHint } from './connectText';

test('8007 は無線をオンにする案内', () => {
  const t = nearbyErrorHint(8007);
  assert.match(t, /Wi-Fi/); assert.match(t, /Bluetooth/); assert.match(t, /位置情報/);
});
test('8011 は近づく・相手の画面を開く案内', () => {
  const t = nearbyErrorHint(8011);
  assert.match(t, /近づ/); assert.match(t, /相手のアプリの画面/);
});
test('8003 / 8009 / 未知コードは固有の文言になり、コード数値は含めない', () => {
  assert.match(nearbyErrorHint(8003), /すでに/);
  assert.match(nearbyErrorHint(8009), /停止/);
  for (const c of [8003, 8009, 8007, 8011, 12345]) assert.doesNotMatch(nearbyErrorHint(c), /\d{4}/);
  assert.match(nearbyErrorHint(12345), /もう一度/);
});
test('Wi-Fi Direct の検索タイムアウトは親機に近づく案内。本文は出さない', () => {
  const t = wifiJoinHint('Timeout while searching ssid=DIRECT-dh-ab12 pass=secret');
  assert.match(t, /親機に近づ/);
  assert.doesNotMatch(t, /DIRECT|secret/);
  assert.match(wifiJoinHint('user denied'), /許可/);
  assert.match(wifiJoinHint('boom'), /もう一度/);
});
test('つながった後は緑、つないでいる最中は区別される', () => {
  assert.deepEqual(linkSummary('connected'), { text: 'つながっています', tone: 'ok' });
  assert.equal(linkSummary('connecting').tone, 'warn');
  assert.match(linkSummary('connecting').text, /つないでいます/);
  assert.equal(linkSummary('waiting', 'X').text, 'X');
  assert.equal(linkSummary('idle').tone, 'idle');
});
test('ペアリング見出し', () => {
  assert.equal(pairingHeading({ confirm: false, found: false }), '相手を探しています');
  assert.equal(pairingHeading({ confirm: false, found: true }), '相手が見つかりました');
  assert.equal(pairingHeading({ confirm: false, found: true, connecting: true }), '相手とつないでいます');
  assert.equal(pairingHeading({ confirm: true, found: true }), '数字を確かめます');
  assert.equal(pairingHeading({ confirm: true, found: true, waiting: true }), '相手を待っています');
});

test('インターネット到達の文言: 状態ごとの見出し。子機の unknown は出さない。実装名を含まない', () => {
  assert.equal(internetText('ok', null, 'guest')?.title, 'インターネットにつながっています');
  assert.equal(internetText('ng', 'upstream', 'guest')?.title, '親機の回線につながっていません');
  assert.equal(internetText('ng', 'portal', 'guest')?.title, '親機の回線で通信が制限されているかもしれません');
  assert.equal(internetText('unknown', null, 'guest'), null);
  assert.equal(internetText('ng', null, 'host')?.title, '子機がインターネットに出られていません');
  assert.equal(internetText('unknown', null, 'host')?.title, '子機のインターネット: 確認中です');
  for (const st of ['ok', 'ng', 'unknown'] as const) for (const w of ['guest', 'host'] as const) {
    const t = internetText(st, 'dns', w);
    assert.ok(!t || !/SOCKS|VPN|Direct|バス|probe/i.test(t.title + (t.note ?? '')));
  }
});
