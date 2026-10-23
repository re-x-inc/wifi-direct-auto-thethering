package expo.modules.vpntunnel

import android.content.Intent
import android.net.ConnectivityManager
import android.net.IpPrefix
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket

/**
 * 全通信を親機の SOCKS5 へ流す VPN。DNS は mapdns でドメイン名つきの CONNECT に変換し、それ以外の UDP(QUIC・通話など)は SOCKS5 の UDP ASSOCIATE で中継する。
 *
 * 子機アプリ自身の通信(地図タイル・JS の fetch)も VPN に通す。親機との間の通信(トンネルの SOCKS 接続・制御バス・外形監視)だけは
 * 親機のアドレス(/32)を VPN の対象から外して(excludeRoute。API 33+)、VPN を通らず参加した Wi-Fi へ直接出す。
 *
 * 状態(mode。ログと status() には種別だけを出す):
 *   through          自アプリも VPN を通る(親機の /32 だけ対象外)
 *   legacy-excluded  API 33 未満など excludeRoute が使えないとき。従来どおり自アプリを VPN から外して establish
 *   direct           親機とのリンクが切れた間。VPN を閉じ、プロセスの Wi-Fi 固定も外して、自アプリは土台のネットワークへ直接出る
 *
 *   through/legacy-excluded --(リンク断が detachMs 続いた)--> direct --(リンク復帰が reattachMs 安定)--> through/legacy-excluded
 *
 * 切断の判定は watchdog(5 秒ごとに親機の SOCKS へ TCP 接続。protect 済みのソケット)。direct の間は 1 秒ごとに親機の網を探して確かめる。
 */
class TunnelService : VpnService() {
  private class Params(val host: String, val port: Int, val user: String, val pass: String, val detachMs: Long, val reattachMs: Long)

  private val lock = Any()
  private var tun: ParcelFileDescriptor? = null
  @Volatile private var watchdog: Thread? = null
  private var gen = 0

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> { stopTunnel(); stopSelf() }
      else -> if (intent != null) startTunnel(Params(
        intent.getStringExtra("host") ?: return START_NOT_STICKY,
        intent.getIntExtra("port", 1080),
        intent.getStringExtra("user") ?: "",
        intent.getStringExtra("pass") ?: "",
        intent.getLongExtra("detachMs", DEFAULT_DETACH_MS),
        intent.getLongExtra("reattachMs", DEFAULT_REATTACH_MS),
      ))
    }
    return START_NOT_STICKY
  }

  private fun startTunnel(p: Params) {
    val myGen = synchronized(lock) { stopTunnel(); gen }
    val ok = synchronized(lock) { if (myGen == gen) establish(p) else false }
    if (ok) startWatchdog(p, myGen)
  }

  /** VPN を張って hev を動かす。呼び出しは lock の中。成功したら mode を through / legacy-excluded にする */
  private fun establish(p: Params): Boolean {
    try {
      val b = Builder()
        .setSession("配達ヘルパー")
        .setMtu(1500)
        .addAddress("198.18.0.1", 32)
        .addRoute("0.0.0.0", 0)
        .addDnsServer("198.18.0.2")
        .setBlocking(false)
      // 親機との通信(SOCKS 接続・制御バス・外形監視)が VPN に戻って二重に中継されないよう、親機のアドレスだけ VPN の対象から外す。
      // 使えない(API 33 未満・アドレスが IP でない)ときは、従来どおり自アプリ全体を VPN から外す。
      var m = MODE_THROUGH
      val excluded = Build.VERSION.SDK_INT >= 33 && runCatching {
        b.excludeRoute(IpPrefix(InetAddress.getByName(p.host), 32)); true
      }.getOrDefault(false)
      if (!excluded) { b.addDisallowedApplication(packageName); m = MODE_LEGACY }
      val fd = b.establish() ?: run { Log.e(TAG, "establish() が null(VPN 権限なし)"); lastError = "establish null"; return false }
      tun = fd
      val cfg = File(cacheDir, "tunnel.yml")
      cfg.writeText(
        """
        tunnel:
          mtu: 1500
          ipv4: 198.18.0.1
        socks5:
          port: ${p.port}
          address: ${p.host}
          udp: 'udp'
          username: '${p.user}'
          password: '${p.pass}'
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
      lastError = if (ok) null else "TProxyStartService false"
      if (!ok) { closeSession(); setMode(MODE_OFF); return false }
      setMode(m)
      return true
    } catch (e: Exception) {
      Log.e(TAG, "start failed", e)
      lastError = e.message ?: e.toString()
      closeSession()
      return false
    }
  }

  /** hev と tun を閉じる(lock の中)。watchdog は止めない */
  private fun closeSession() {
    runCatching { if (TProxyService.TProxyIsRunning()) TProxyService.TProxyStopService() }
    runCatching { tun?.close() }
    tun = null
  }

  private fun setMode(m: String) {
    if (mode != m) Log.i(TAG, "vpn mode $mode -> $m")
    mode = m
  }

  /** 親機の SOCKS へ届くか。ソケットは protect 済み(VPN に入れない)。net があればその網(参加した Wi-Fi)で作る */
  private fun probe(host: String, port: Int, net: Network?): Boolean = try {
    (net?.socketFactory?.createSocket() ?: Socket()).use {
      // VPN を閉じている間(net あり)は protect の結果を見ない
      if (!protect(it) && net == null) throw java.io.IOException("protect")
      it.connect(InetSocketAddress(host, port), 3000)
    }
    true
  } catch (_: Exception) { false }

  /** 親機のアドレスへ直接届く Wi-Fi の網(参加した Wi-Fi)。既定経路ではなく、親機を含む部分網の経路を持つもの */
  private fun parentNetwork(host: String): Network? {
    val cm = getSystemService(ConnectivityManager::class.java)
    val addr = runCatching { InetAddress.getByName(host) }.getOrNull() ?: return null
    @Suppress("DEPRECATION")
    return cm.allNetworks.firstOrNull { n ->
      val c = cm.getNetworkCapabilities(n)
      c != null && c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !c.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
        cm.getLinkProperties(n)?.routes?.any { !it.isDefaultRoute && it.matches(addr) } == true
    }
  }

  /**
   * 親機との間が切れたら、自アプリを VPN から外す(VPN を閉じる)。親機に届かない VPN は端末の通信を全部止めるので、fail-open も兼ねる。
   * 「切断が detachMs 続いてから外す・復帰が reattachMs 安定してから戻す」で、短いゆれのたびに VPN を張り直さない。
   * JS が止まっていても動くよう、ここ(ネイティブ)で監視する。
   */
  private fun startWatchdog(p: Params, myGen: Int) {
    val t = Thread {
      var failSince = 0L
      var okSince = 0L
      try {
        while (!Thread.currentThread().isInterrupted) {
          val direct = mode == MODE_DIRECT
          Thread.sleep(if (direct) DIRECT_TICK_MS else UP_TICK_MS)
          val net = if (direct) parentNetwork(p.host) else null
          val ok = (!direct || net != null) && probe(p.host, p.port, net)
          val now = SystemClock.elapsedRealtime()
          synchronized(lock) {
            if (myGen != gen) return@Thread
            if (!direct) {
              if (ok) failSince = 0 else {
                if (failSince == 0L) failSince = now
                if (now - failSince >= p.detachMs) {
                  closeSession()
                  setMode(MODE_DIRECT)
                  lastError = "リンク断のため VPN を閉じ、自アプリを直接通信にした"
                  getSystemService(ConnectivityManager::class.java).bindProcessToNetwork(null)
                  okSince = 0
                }
              }
            } else {
              if (!ok) okSince = 0 else {
                if (okSince == 0L) okSince = now
                if (now - okSince >= p.reattachMs) {
                  // 先にプロセスを参加した Wi-Fi に固定し直してから VPN を張る(親機との通信が Wi-Fi に出るように)
                  val cm = getSystemService(ConnectivityManager::class.java)
                  cm.bindProcessToNetwork(net)
                  if (establish(p)) { failSince = 0 } else { cm.bindProcessToNetwork(null); okSince = 0 }
                }
              }
            }
          }
        }
      } catch (_: InterruptedException) {}
    }
    t.isDaemon = true; watchdog = t; t.start()
  }

  private fun stopTunnel() {
    synchronized(lock) {
      gen++
      watchdog?.let { if (it !== Thread.currentThread()) it.interrupt() }
      watchdog = null
      closeSession()
      setMode(MODE_OFF)
    }
  }

  override fun onRevoke() { stopTunnel(); super.onRevoke() }
  override fun onDestroy() { stopTunnel(); super.onDestroy() }

  companion object {
    const val TAG = "DH-VPN"
    const val ACTION_STOP = "stop"
    const val MODE_OFF = "off"
    const val MODE_THROUGH = "through"
    const val MODE_LEGACY = "legacy-excluded"
    const val MODE_DIRECT = "direct"
    const val DEFAULT_DETACH_MS = 5_000L
    const val DEFAULT_REATTACH_MS = 3_000L
    private const val UP_TICK_MS = 5_000L
    private const val DIRECT_TICK_MS = 1_000L
    @Volatile var lastError: String? = null
    @Volatile var mode: String = MODE_OFF
  }
}
