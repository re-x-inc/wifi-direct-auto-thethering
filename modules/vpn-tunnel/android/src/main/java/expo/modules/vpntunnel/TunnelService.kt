package expo.modules.vpntunnel

import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/** 全通信を親機の SOCKS5 へ流す VPN。DNS は mapdns でドメイン名つきの CONNECT に変換し、それ以外の UDP(QUIC・通話など)は SOCKS5 の UDP ASSOCIATE で中継する。 */
class TunnelService : VpnService() {
  private var tun: ParcelFileDescriptor? = null
  @Volatile private var watchdog: Thread? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> { stopTunnel(); stopSelf() }
      else -> if (intent != null) startTunnel(
        intent.getStringExtra("host") ?: return START_NOT_STICKY,
        intent.getIntExtra("port", 1080),
        intent.getStringExtra("user") ?: "",
        intent.getStringExtra("pass") ?: "",
      )
    }
    return START_NOT_STICKY
  }

  private fun startTunnel(host: String, port: Int, user: String, pass: String) {
    stopTunnel()
    try {
      val b = Builder()
        .setSession("配達ヘルパー")
        .setMtu(1500)
        .addAddress("198.18.0.1", 32)
        .addRoute("0.0.0.0", 0)
        .addDnsServer("198.18.0.2")
        .setBlocking(false)
      // 自アプリの通信(親機への SOCKS 接続)は VPN に入れない。ループを防ぐ。
      b.addDisallowedApplication(packageName)
      val fd = b.establish() ?: run { Log.e(TAG, "establish() が null(VPN 権限なし)"); lastError = "establish null"; return }
      tun = fd
      val cfg = File(cacheDir, "tunnel.yml")
      cfg.writeText(
        """
        tunnel:
          mtu: 1500
          ipv4: 198.18.0.1
        socks5:
          port: $port
          address: $host
          udp: 'udp'
          username: '$user'
          password: '$pass'
        mapdns:
          address: 198.18.0.2
          port: 53
          network: 100.64.0.0
          netmask: 255.192.0.0
          cache-size: 10000
        misc:
          log-level: warn
        """.trimIndent()
      )
      val ok = TProxyService.TProxyStartService(cfg.absolutePath, fd.fd)
      Log.i(TAG, "tunnel start ok=$ok host=$host:$port")
      lastError = if (ok) null else "TProxyStartService false"
      if (ok) startWatchdog(host, port)
    } catch (e: Exception) {
      Log.e(TAG, "start failed", e)
      lastError = e.message ?: e.toString()
    }
  }

  /**
   * 親機の SOCKS に届かなくなったら VPN を落とす(fail-open)。VPN は全通信を飲み込むので、
   * 行き先が消えたまま張りっぱなしだと端末の通信が全部止まる。JS が止まっていても動くよう、ここで監視する。
   */
  private fun startWatchdog(host: String, port: Int) {
    val t = Thread {
      var fails = 0
      try {
        while (!Thread.currentThread().isInterrupted) {
          Thread.sleep(5000)
          val ok = try { Socket().use { it.connect(InetSocketAddress(host, port), 3000) }; true } catch (_: Exception) { false }
          fails = if (ok) 0 else fails + 1
          if (fails >= 3) {
            Log.w(TAG, "watchdog: $host:$port に届かないため VPN を停止")
            lastError = "watchdog: 親機に届かず停止"
            val cm = getSystemService(android.net.ConnectivityManager::class.java)
            cm.bindProcessToNetwork(null)
            stopTunnel(); stopSelf()
            return@Thread
          }
        }
      } catch (_: InterruptedException) {}
    }
    t.isDaemon = true; watchdog = t; t.start()
  }

  private fun stopTunnel() {
    watchdog?.let { if (it !== Thread.currentThread()) it.interrupt() }
    watchdog = null
    runCatching { if (TProxyService.TProxyIsRunning()) TProxyService.TProxyStopService() }
    runCatching { tun?.close() }
    tun = null
  }

  override fun onRevoke() { stopTunnel(); super.onRevoke() }
  override fun onDestroy() { stopTunnel(); super.onDestroy() }

  companion object {
    const val TAG = "DH-VPN"
    const val ACTION_STOP = "stop"
    @Volatile var lastError: String? = null
  }
}
