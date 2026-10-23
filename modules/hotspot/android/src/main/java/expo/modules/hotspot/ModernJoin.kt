package expo.modules.hotspot

import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build

/**
 * 子機の Wi-Fi 参加の新経路(API 29+ 専用)。WifiNetworkSpecifier は API 29 のクラスなので、API 28 でクラスロードされないよう
 * HotspotModule とは別のファイルに分け、JoinPath が MODERN のときにしか呼ばない。
 */
internal object ModernJoin {
  class Built(val request: NetworkRequest, val usedBand: Boolean)

  /** @param wantBand setBand(2.4GHz) を付けるか(API 33+・呼び出し側で判断済み)。付けられなければ usedBand=false */
  fun build(ssid: String, pass: String, wantBand: Boolean): Built {
    val sb = WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(pass)
    var usedBand = false
    if (wantBand && Build.VERSION.SDK_INT >= 33) {
      try { sb.setBand(android.net.wifi.ScanResult.WIFI_BAND_24_GHZ); usedBand = true } catch (e: Throwable) { DhLog.w("DH-P2P", "setBand(2.4GHz) failed $e") }
    }
    val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).setNetworkSpecifier(sb.build()).build()
    return Built(req, usedBand)
  }
}
