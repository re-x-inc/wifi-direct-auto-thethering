// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  // ネイティブモジュールの生のアダプターは、LinkGovernor（不変条件 I1〜I6）を通さずに Nearby/Direct を触れてしまう。
  // import してよいのは組み立て部分（src/api/native.ts・src/nearbyApi.ts・公開エクスポートの src/api/index.ts）だけ。
  // 利用側は getTether() と Tether のメソッドだけを使う（Nearby のエラーは tether.onNearbyError）
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/api/native.ts', 'src/nearbyApi.ts', 'src/api/index.ts', 'modules/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/modules/hotspot', '**/modules/nearby-link', '**/modules/keep-alive', '**/modules/vpn-tunnel', '**/modules/*'], message: 'ネイティブモジュールは直接 import しない。getTether() / Tether 経由で使う（LinkGovernor の不変条件を迂回するため）。組み立ては src/api/native.ts のみ' },
          { group: ['**/nearbyApi', '**/api/native', './native'], message: '生のアダプター（nearbyApi / native）は src/api/native.ts と公開エクスポート以外から import しない' },
        ],
      }],
    },
  },
]);
