/**
 * 機種ごとの診断レポート(JSON)を並べて比較する。
 * 使い方: pnpm exec tsx scripts/compare-diag.ts docs/device-reports [--diff]
 *   引数のフォルダ(または JSON ファイル)から tether-diag-*.json を読み、Markdown の比較表を標準出力へ出す。
 *   --diff を付けると、機種間で値が違う項目だけにする。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { comparisonMarkdown, DiagnosticReport } from '../src/api/diagnostics';

const args = process.argv.slice(2);
const onlyDiffs = args.includes('--diff');
const targets = args.filter((a) => !a.startsWith('--'));
const files: string[] = [];
for (const t of targets.length ? targets : ['docs/device-reports']) {
  if (statSync(t).isDirectory()) {
    for (const f of readdirSync(t)) if (/^tether-diag-.*\.json$/.test(f)) files.push(join(t, f));
  } else files.push(t);
}
const reports: DiagnosticReport[] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
if (reports.length === 0) {
  console.error('比較するレポートがありません(tether-diag-*.json を docs/device-reports に置いてください)');
  process.exit(1);
}
console.log(comparisonMarkdown(reports, onlyDiffs));
