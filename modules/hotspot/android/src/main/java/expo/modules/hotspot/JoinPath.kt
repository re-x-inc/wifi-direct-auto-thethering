package expo.modules.hotspot

/**
 * 子機の Wi-Fi 参加の経路の選び方と、旧 API 用の値の整形(純粋なロジック。Android のクラスに触れない)。
 * - MODERN: API 29+。WifiNetworkSpecifier で「ローカル専用」の接続を要求する(従来どおり)
 * - LEGACY: API 28 以下。WifiConfiguration + addNetwork + enableNetwork(API 29 で非推奨・Q+ では動かない)
 */
object JoinPath {
  enum class Path { MODERN, LEGACY }

  fun pathFor(sdkInt: Int): Path = if (sdkInt >= 29) Path.MODERN else Path.LEGACY

  /** WifiConfiguration.SSID は引用符つきの文字列で渡す */
  fun quote(s: String): String = "\"" + s + "\""

  /** WPA2-PSK の合言葉として使える形か: 8〜63 文字の文字列、または 64 桁の 16 進 */
  fun validPassphrase(p: String): Boolean = p.length in 8..63 || (p.length == 64 && p.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' })

  /** WifiConfiguration.preSharedKey: 64 桁 16 進はそのまま、それ以外は引用符つき */
  fun psk(p: String): String = if (p.length == 64) p else quote(p)

  /** 今つながっている接続が、自分が追加した設定か(networkId は未接続で -1) */
  fun isOurs(currentNetId: Int, ourNetId: Int): Boolean = ourNetId >= 0 && currentNetId == ourNetId

  /** 後始末で元の接続を戻すか(元が無い・自分の設定そのものなら戻さない) */
  fun shouldRestore(prevNetId: Int, ourNetId: Int): Boolean = prevNetId >= 0 && prevNetId != ourNetId
}
