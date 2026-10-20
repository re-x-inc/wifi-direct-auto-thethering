import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeNearbyPair } from '../link/fakeNearby';
import { buildCapabilities } from './capability';
import {
  buildDiagnosticReport, compareReports, comparisonMarkdown, looksPersonal, NativeDiagnostics, redactItem, reportFileName, summarizeReport,
} from './diagnostics';
import { fakePlatform } from './fakePlatform';
import { Tether } from './tether';

const caps = (model: string, sdk: number) =>
  buildCapabilities({
    native: { manufacturer: 'Sony', model, sdk, release: '14', batteryPercent: 50, batteryOptimizationExempt: null, wifiDirect: true, staApConcurrent: null, staLocalOnlyConcurrent: null, band24: null, band5: true, vpnConsent: null, deviceOwner: null, missingPermissions: null },
    cellular: false, probe: null, now: 1,
  });

const native = (extra: Record<string, unknown> = {}): NativeDiagnostics => ({
  schema: 1,
  sections: {
    build: {
      manufacturer: { v: 'Sony', minApi: null },
      model: { v: 'XQ-XX', minApi: null },
      sdkInt: { v: 34, minApi: null },
      securityPatch: { v: '2024-08-05', minApi: 23 },
      fingerprint: { v: 'Sony/XQ/XQ:14/65.1.A.0.1/123456:user/release-keys', minApi: null },
      ...extra,
    },
    wifi: { band6: { v: null, minApi: 30, why: 'sdk<30' }, wapi: { v: null, minApi: 30, why: 'ex:SecurityException' } },
    dpc: { tetherWifiRegexCount: { v: 2, minApi: null, official: false } },
  },
});

test('個人を特定できそうな値の検出: MAC・IMEI・電話番号・メール。日付・指紋は誤検出しない', () => {
  assert.ok(looksPersonal('aa:bb:cc:dd:ee:ff'));
  assert.ok(looksPersonal('AA-BB-CC-DD-EE-FF'));
  assert.ok(looksPersonal('358240051111110'));
  assert.ok(looksPersonal('+81 90 1234 5678'));
  assert.ok(looksPersonal('090-1234-5678'));
  assert.ok(looksPersonal('someone@example.com'));
  assert.ok(!looksPersonal('2024-08-05'));
  assert.ok(!looksPersonal('Sony/XQ/XQ:14/65.1.A.0.1/123456:user/release-keys'));
  assert.ok(!looksPersonal('android.permission.BLUETOOTH_SCAN'));
});

test('redactItem: 個人らしい値は項目ごと null にし、配列・入れ子の中も落とす', () => {
  const a = redactItem({ v: 'aa:bb:cc:dd:ee:ff', minApi: null });
  assert.equal(a.v, null);
  assert.equal(a.why, 'redacted');
  const b = redactItem({ v: ['ok', 'x@y.example'], minApi: 3 });
  assert.equal(b.v, null);
  const c = redactItem({ v: { a: ['ok'], b: 5 }, minApi: 3 });
  assert.deepEqual(c.v, { a: ['ok'], b: 5 });
  const d = redactItem(true);
  assert.equal(d.v, true);
  assert.equal(d.source, 'api');
});

test('レポート: 項目ごとに source・必要 API レベル・不明の理由を持つ。試験・観測結果は別 source', () => {
  const r = buildDiagnosticReport({
    native: native(),
    capabilities: caps('XQ-XX', 34),
    probe: { buildKey: 'XQ-XX|34', at: 5, observed: { staP2pConcurrent: true }, lohs: { ok: false, reason: 'no-channel', at: 5 } },
    now: 10,
  });
  assert.equal(r.deviceKey, 'sony-xq-xx-api34');
  assert.equal(reportFileName(r), 'tether-diag-sony-xq-xx-api34.json');
  assert.equal(r.sections.build.securityPatch.v, '2024-08-05');
  assert.equal(r.sections.build.securityPatch.minApi, 23);
  assert.equal(r.sections.wifi.band6.v, null);
  assert.equal(r.sections.wifi.band6.why, 'sdk<30');
  assert.equal(r.sections.wifi.band6.minApi, 30);
  assert.equal(r.sections.dpc.tetherWifiRegexCount.official, false);
  assert.equal(r.sections.probe.lohsCreated.v, false);
  assert.equal(r.sections.probe.lohsCreated.source, 'probe');
  assert.equal(r.sections.probe.lohsReason.v, 'no-channel');
  assert.equal(r.sections.probe.staP2pConcurrent.source, 'observed');
  assert.equal(r.sections.probe.p2pApCoexist.v, null);
  assert.equal(r.sections.probe.p2pApCoexist.why, 'not-observed');
  // JSON に出して戻せる
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('レポートに個人らしい値が混ざっても出力されない', () => {
  const r = buildDiagnosticReport({
    native: native({ serial: { v: 'aa:bb:cc:dd:ee:ff', minApi: null }, phone: { v: '+819012345678', minApi: null } }),
    capabilities: caps('XQ-XX', 34), probe: null, now: 1,
  });
  const json = JSON.stringify(r);
  assert.ok(!json.includes('aa:bb:cc'));
  assert.ok(!json.includes('819012345678'));
  assert.equal(r.sections.build.serial.why, 'redacted');
});

test('人が読める要約: 不明は理由つき、非公式の取り方は明示', () => {
  const r = buildDiagnosticReport({ native: native(), capabilities: caps('XQ-XX', 34), probe: null, now: 1 });
  const s = summarizeReport(r);
  assert.match(s, /\[build\]/);
  assert.match(s, /band6: 不明\(sdk<30\)/);
  assert.match(s, /tetherWifiRegexCount: 2 \*非公式/);
  assert.match(s, /lohsCreated: 不明\(not-probed\)/);
});

test('機種比較: 差のある項目を拾い、Markdown の表にできる', () => {
  const a = buildDiagnosticReport({ native: native(), capabilities: caps('XQ-A', 34), probe: null, now: 1 });
  const bNative = native();
  bNative.sections!.wifi.band6 = { v: true, minApi: 30 };
  bNative.sections!.build.model = { v: 'XQ-B', minApi: null };
  const b = buildDiagnosticReport({ native: bNative, capabilities: caps('XQ-B', 34), probe: null, now: 1 });
  const rows = compareReports([a, b]);
  const band6 = rows.find((r) => r.path === 'wifi.band6')!;
  assert.equal(band6.differs, true);
  assert.equal(band6.values[a.deviceKey], '不明(sdk<30)');
  assert.equal(band6.values[b.deviceKey], 'はい');
  assert.equal(rows.find((r) => r.path === 'build.manufacturer')!.differs, false);
  const md = comparisonMarkdown([a, b], true);
  assert.match(md, /wifi\.band6/);
  assert.ok(!md.includes('build.manufacturer'));
});

test('Tether: 診断レポートの作成と保存。Planner 用の能力を含み、ファイルに書かれる', async () => {
  const net = fakeNearbyPair();
  const f = fakePlatform(net.host, { cellular: true, model: 'Pixel 7a' });
  const t = new Tether(f.platform);
  const r = await t.diagnosticReport();
  assert.deepEqual(r.capabilities, await t.capabilities());
  assert.equal(r.sections.build.model.v, 'Pixel 7a');
  const saved = await t.saveDiagnosticReport();
  assert.equal(saved.fileName, 'tether-diag-fake-pixel-7a-api35.json');
  assert.equal(saved.path, '/fake/diagnostics/tether-diag-fake-pixel-7a-api35.json');
  assert.deepEqual(JSON.parse(f.files[saved.fileName]), saved.report);
  assert.match(saved.summary, /診断レポート/);
});

test('診断の部品が無い環境でも、能力だけのレポートが作れる(保存先は null)', async () => {
  const f = fakePlatform(fakeNearbyPair().host);
  delete f.platform.capability;
  const t = new Tether(f.platform);
  const saved = await t.saveDiagnosticReport();
  assert.equal(saved.path, null);
  assert.deepEqual(Object.keys(saved.report.sections), ['probe']);
});
