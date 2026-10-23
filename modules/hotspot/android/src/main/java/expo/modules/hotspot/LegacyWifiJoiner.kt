package expo.modules.hotspot

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager

/**
 * 子機の Wi-Fi 参加の旧経路(API 28 以下専用)。WifiConfiguration + addNetwork + enableNetwork は API 29 で非推奨、Q+ の OS では動かない。
 * 呼び出し側は必ず SDK_INT < 29 の内側からだけ使う(HotspotModule.startJoin が JoinPath.pathFor で分ける)。
 * API 29+ のクラス(WifiNetworkSpecifier など)はこのファイルに置かない。
 *
 * 参加の検知: WIFI の NetworkRequest を requestNetwork で出し(インターネット能力は要求しない)、
 * 接続中の networkId が自分の追加した設定と一致した Network だけを参加済みとみなす。
 * 「接続はあるがインターネットなし」の Wi-Fi は、要求が出ている間は OS に不要と見なされにくい。呼び出し側は参加後に bindProcessToNetwork する。
 * ログは種別と結果コードだけ(SSID・合言葉は出さない)。
 */
@Suppress("DEPRECATION")
internal class LegacyWifiJoiner(private val ctx: Context, private val cm: ConnectivityManager) {
  interface Listener {
    fun onJoined(n: Network)
    fun onLink(n: Network, lp: LinkProperties)
    fun onLost(n: Network)
  }

  enum class Start { OK, BAD_PASSPHRASE, ADD_FAILED, DENIED }

  private val wm: WifiManager get() = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
  private var netId = -1
  private var prevNetId = -1
  private var cb: ConnectivityManager.NetworkCallback? = null

  @Suppress("MissingPermission")
  fun start(ssid: String, pass: String, l: Listener): Start {
    stop()
    if (!JoinPath.validPassphrase(pass)) { DhLog.w(TAG, "legacy join: passphrase 形式が不正"); return Start.BAD_PASSPHRASE }
    try {
      val w = wm
      if (!w.isWifiEnabled) DhLog.i(TAG, "legacy join: wifi off -> setWifiEnabled=${w.setWifiEnabled(true)}")
      prevNetId = runCatching { w.connectionInfo?.networkId ?: -1 }.getOrDefault(-1)
      // 前回の自分の設定が残っていれば消す(消せるのは自分が作ったものだけ)
      val q = JoinPath.quote(ssid)
      runCatching { w.configuredNetworks?.filter { it.SSID == q }?.forEach { w.removeNetwork(it.networkId) } }
      val c = WifiConfiguration().apply {
        SSID = q
        preSharedKey = JoinPath.psk(pass)
        allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK)
        allowedProtocols.set(WifiConfiguration.Protocol.RSN)
        allowedPairwiseCiphers.set(WifiConfiguration.PairwiseCipher.CCMP)
        allowedGroupCiphers.set(WifiConfiguration.GroupCipher.CCMP)
        status = WifiConfiguration.Status.ENABLED
        hiddenSSID = false
      }
      netId = w.addNetwork(c)
      DhLog.i(TAG, "legacy join: addNetwork result=${if (netId < 0) "fail" else "ok"}")
      if (netId < 0) return Start.ADD_FAILED
      val callback = object : ConnectivityManager.NetworkCallback() {
        private fun ours() = JoinPath.isOurs(runCatching { wm.connectionInfo?.networkId ?: -1 }.getOrDefault(-1), netId)
        override fun onAvailable(n: Network) { if (ours()) l.onJoined(n) }
        override fun onLinkPropertiesChanged(n: Network, lp: LinkProperties) { if (ours()) l.onLink(n, lp) }
        override fun onLost(n: Network) { l.onLost(n) }
      }
      cb = callback
      // 先に要求を出してから接続を始める。インターネット能力は要求しない(検証に通らない Wi-Fi でも要求を満たす)
      cm.requestNetwork(NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), callback)
      val en = w.enableNetwork(netId, true)
      val rc = w.reconnect()
      DhLog.i(TAG, "legacy join: enableNetwork=$en reconnect=$rc")
      return if (en) Start.OK else Start.DENIED
    } catch (e: SecurityException) {
      DhLog.w(TAG, "legacy join: SecurityException")
      return Start.DENIED
    }
  }

  /** 要求の取り下げ、自分の設定の削除、元の接続の復元 */
  fun stop() {
    cb?.let { runCatching { cm.unregisterNetworkCallback(it) } }
    cb = null
    if (netId >= 0) {
      val w = wm
      runCatching { w.disableNetwork(netId); w.removeNetwork(netId) }
      if (JoinPath.shouldRestore(prevNetId, netId)) runCatching { w.enableNetwork(prevNetId, true); w.reconnect() }
      DhLog.i(TAG, "legacy join: cleaned up restore=${JoinPath.shouldRestore(prevNetId, netId)}")
    }
    netId = -1; prevNetId = -1
  }

  companion object { private const val TAG = "DH-P2P" }
}
