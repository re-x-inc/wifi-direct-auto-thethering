# Wi-Fi Direct Tethering Auto Connect(仮称)

回線を持つ端末(親機)と持たない端末(子機)を、一度ペアにしたら人手なしで自動接続・自動復旧するテザリング。
仕様は [docs/SPEC.md](docs/SPEC.md) を参照。

## 状態
開発版。ペアリング(近くの端末を探す → 確認コードの照合 → ペアごとのランダムな共有コードを交換)は実装済み。バックグラウンド維持・機種違いの検証が未了のため配布しない。

## 開発
hev-socks5-tunnel(MIT)は git サブモジュールです。クローン時は `--recursive` を付けます。
```
git clone --recursive git@github.com:re-x-inc/wifi-direct-auto-thethering.git
# 付け忘れたとき: git submodule update --init --recursive
npm install
npx expo prebuild --platform android --no-install
cd android && ANDROID_HOME=/opt/android-sdk ./gradlew :app:assembleDebug
npx expo start --port 8081        # 監視モード。adb reverse tcp:8081 tcp:8081 を忘れずに
npm test                          # src/link のテスト
```
