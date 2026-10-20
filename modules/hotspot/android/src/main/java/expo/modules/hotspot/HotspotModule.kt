package expo.modules.hotspot

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSuggestion
import android.net.wifi.WifiNetworkSpecifier
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.util.Log
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * M1: 親機が LocalOnlyHotspot を起動し、子機が接続情報(Nearby 経由で受領)で参加して、
 * 親機のポートへ TCP で到達できるかを確かめる。インターネット共有そのものは M2 以降(SOCKS5 / VPN)。
 */
private const val TAG = "DH-P2P"
/** 子機の参加を待つ時間。初回は利用者が「接続」を押すまで待つので長めにする。ダイアログが出ている間に取り下げない */
private const val JOIN_TIMEOUT_MS = 60_000L
private const val GROUP_READY_MS = 15_000L
/** group ready のあと、ビーコンが出始めるまで待ってから子機が join を始める時間(試験で比べるため 1 か所。0 で待たない) */
private const val JOIN_START_DELAY_MS = 2_500L

class HotspotModule : Module() {
  private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
  private var netCb: ConnectivityManager.NetworkCallback? = null
  private var suggestions: List<WifiNetworkSuggestion> = emptyList()
  private var joined: Network? = null
  private var joinedSsid: String? = null
  private var joinedGw: String? = null
  private var echo: ServerSocket? = null
  private var socks: SocksServer? = null
  private var socksRef: SocksServer? = null
  private var cellular: Network? = null
  private var cellCb: ConnectivityManager.NetworkCallback? = null
  private var p2p: WifiP2pManager? = null
  private var p2pCh: WifiP2pManager.Channel? = null
  // 子機の参加(joinWifi)の進行状態。二重要求を避け、時間切れで取り下げるため
  private val mainHandler = Handler(Looper.getMainLooper())
  private var joinPending: String? = null
  private val joinWaiters = mutableListOf<Promise>()
  private var joinGen = 0
  private var joinTimeout: Runnable? = null

  private val ctx: Context get() = appContext.reactContext ?: error("no context")
  private val cm: ConnectivityManager get() = ctx.getSystemService(ConnectivityManager::class.java)

  override fun definition() = ModuleDefinition {
    Name("Hotspot")
    Events("onHotspotStopped", "onWifiLost", "onJoinPrompt")

    // ---- 親機 ----
    AsyncFunction("startHotspot") { promise: Promise ->
      val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      try {
        wm.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
          override fun onStarted(r: WifiManager.LocalOnlyHotspotReservation) {
            reservation = r
            val (ssid, pass) = credentials(r)
            promise.resolve(mapOf("ssid" to ssid, "passphrase" to pass))
          }
          override fun onStopped() {
            reservation = null
            sendEvent("onHotspotStopped", emptyMap<String, Any>())
          }
          override fun onFailed(reason: Int) {
            promise.reject("E_HOTSPOT", "startLocalOnlyHotspot failed: reason=$reason", null)
          }
        }, Handler(Looper.getMainLooper()))
      } catch (e: Exception) {
        promise.reject("E_HOTSPOT", e.message ?: e.toString(), e)
      }
    }
    Function("stopHotspot") { reservation?.close(); reservation = null }

    // ---- 能力調査(副作用なし。詳細は CapabilityProbe.kt)----
    Function("capabilities") { CapabilityProbe.collect(ctx) }
    /** 診断レポート(網羅的な採取。副作用なし)と、そのファイル書き出し。詳細は DiagnosticReport.kt */
    Function("diagnostics") { DiagnosticReport.collect(ctx) }
    Function("saveDiagnosticFile") { name: String, text: String -> DiagnosticReport.writeFile(ctx, name, text) }
    /** LocalOnlyHotspot を一瞬だけ起動して閉じる。共有中は呼ばない(呼び出し側で防ぐ) */
    AsyncFunction("probeLohs") { promise: Promise ->
      if (reservation != null) promise.resolve(mapOf("ok" to false, "reason" to "busy"))
      else CapabilityProbe.probeLohs(ctx) { promise.resolve(it) }
    }

    /**
     * Wi-Fi Direct グループを、固定の名前・パスフレーズで作る(LocalOnlyHotspot が使えない端末向けの代替)。
     * 作成したグループには、子機が通常の Wi-Fi(WPA2)として joinWifi で参加できる。
     */
    AsyncFunction("startDirect") { fixedName: String?, fixedPass: String?, freq: Int?, promise: Promise ->
      val m = ctx.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager
      val ch = m.initialize(ctx, Looper.getMainLooper(), null)
      p2p = m; p2pCh = ch
      val alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
      fun rnd(n: Int) = (1..n).map { alphabet[java.security.SecureRandom().nextInt(alphabet.length)] }.joinToString("")
      // 固定値が渡されたときはそれを使う(子機の承認の記憶が効く)。なければ毎回ランダム
      val name = fixedName ?: ("DIRECT-dh-" + rnd(4))
      val pass = fixedPass ?: rnd(12)
      val b = WifiP2pConfig.Builder().setNetworkName(name).setPassphrase(pass).enablePersistentMode(false)
      // 帯域は 2.4GHz に固定する(子機が見つけやすい)。2.4GHz の周波数が渡されたときはそのチャンネルに、それ以外は 2.4GHz 帯の自動選択にする
      var band = "none"
      if (Build.VERSION.SDK_INT >= 29) {
        if (freq != null && freq in 2400..2500) { b.setGroupOperatingFrequency(freq); band = "2.4GHz/${freq}MHz" }
        else { b.setGroupOperatingBand(WifiP2pConfig.GROUP_OWNER_BAND_2GHZ); band = "2.4GHz/auto" }
      }
      val cfg = b.build()
      // パスフレーズは出さない
      Log.i(TAG, "startDirect ssid=$name passLen=${pass.length} passTag=${passTag(pass)} band=$band(requested freq=${freq ?: 0})")
      // 以前のグループが残っていれば消してから作る(BUSY のときは段階的に片付ける。手順と結果は DH-P2P のログ)
      clearThenCreate(m, ch, cfg, name, pass, promise)
    }
    /**
     * グループを消し、P2P チャンネルも閉じる(閉じないと p2p0 が残り、LOHS の AP インターフェースを作れなくなる)。
     * 消えるまで待つので、完了後に LOHS を試せる。
     */
    AsyncFunction("stopDirect") { promise: Promise ->
      // アプリの再起動前に作ったグループが残っていることがあるので、未初期化ならチャンネルを取り直して消す
      val m = p2p ?: (ctx.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager)
      val ch = p2pCh ?: m.initialize(ctx, Looper.getMainLooper(), null)
      p2p = null; p2pCh = null
      m.removeGroup(ch, object : WifiP2pManager.ActionListener {
        override fun onSuccess() { closeChannel(ch); promise.resolve(null) }
        override fun onFailure(reason: Int) { closeChannel(ch); promise.resolve(null) }
      })
    }

    /** 親機の SOCKS5 サーバー。携帯回線を要求して保持し、接続先への通信はそこを通す。 */
    AsyncFunction("startSocks") { port: Int, user: String, pass: String, promise: Promise ->
      try {
        socks?.stop()
        if (cellCb == null) {
          val req = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
          val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(n: Network) {
              cellular = n
              android.util.Log.i("DH-SOCKS", "cellular available: $n caps=${cm.getNetworkCapabilities(n)}")
            }
            override fun onLost(n: Network) { if (cellular == n) cellular = null }
          }
          cellCb = cb
          cm.requestNetwork(req, cb)
        }
        val srv = SocksServer(port, user, pass) { cellular ?: cm.activeNetwork }
        srv.start()
        socks = srv
        socksRef = srv
        // 携帯回線の確保を少し待つ
        Thread {
          var i = 0
          while (cellular == null && i++ < 30) Thread.sleep(100)
          promise.resolve(mapOf("network" to if (cellular != null) "cellular" else "default"))
        }.start()
      } catch (e: Exception) {
        promise.reject("E_SOCKS", e.message ?: e.toString(), e)
      }
    }
    Function("stopSocks") {
      socks?.stop(); socks = null
      cellCb?.let { runCatching { cm.unregisterNetworkCallback(it) } }
      cellCb = null; cellular = null
    }

    /** 自分自身の SOCKS に接続し、example.com:80 へ HTTP で到達できるかを確かめる(M2 の自己診断)。 */
    AsyncFunction("socksSelfTest") { port: Int, user: String, pass: String, promise: Promise ->
      Thread {
        try {
          Socket().use { s ->
            s.connect(InetSocketAddress("127.0.0.1", port), 3000)
            s.soTimeout = 15_000
            val o = s.getOutputStream(); val i = s.getInputStream()
            o.write(byteArrayOf(5, 1, 2))
            val g = ByteArray(2); i.readNBytes(g, 0, 2)
            val ub = user.toByteArray(); val pb = pass.toByteArray()
            o.write(byteArrayOf(1, ub.size.toByte()) + ub + byteArrayOf(pb.size.toByte()) + pb)
            val a = ByteArray(2); i.readNBytes(a, 0, 2)
            if (a[1].toInt() != 0) { promise.resolve(mapOf("ok" to false, "error" to "auth failed")); return@Thread }
            val host = "example.com".toByteArray()
            o.write(byteArrayOf(5, 1, 0, 3, host.size.toByte()) + host + byteArrayOf(0, 80))
            val r = ByteArray(10); i.readNBytes(r, 0, 10)
            if (r[1].toInt() != 0) { promise.resolve(mapOf("ok" to false, "error" to "connect rep=${r[1]} ${socksRef?.lastError ?: ""}")); return@Thread }
            o.write("HEAD / HTTP/1.0\r\nHost: example.com\r\n\r\n".toByteArray()); o.flush()
            val line = i.bufferedReader().readLine()
            promise.resolve(mapOf("ok" to (line?.startsWith("HTTP/") == true), "line" to (line ?: ""), "udp" to udpSelfTest(port, user, pass)))
          }
        } catch (e: Exception) {
          promise.resolve(mapOf("ok" to false, "error" to (e.message ?: e.toString())))
        }
      }.start()
    }

    /** 到達確認用の TCP エコーサーバー(受け取った文字列をそのまま返す) */
    Function("startEcho") { port: Int ->
      // JS のリロードでモジュールが作り直されても前回のソケットを閉じられるよう、静的に保持する
      activeEcho?.close(); echo?.close()
      val s = ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(port)) }
      echo = s; activeEcho = s
      Thread {
        while (!s.isClosed) {
          try {
            val c = s.accept()
            Thread {
              c.use { sock ->
                val buf = ByteArray(256)
                val n = sock.getInputStream().read(buf)
                if (n > 0) sock.getOutputStream().write(buf, 0, n)
              }
            }.start()
          } catch (_: Exception) { break }
        }
      }.start()
    }
    Function("stopEcho") { echo?.close(); activeEcho?.close(); echo = null; activeEcho = null }

    // ---- 子機 ----
    /** 接続情報で Wi-Fi に参加し、ゲートウェイ(=親機)のアドレスを返す。初回は端末の承認ダイアログが出る。 */
    AsyncFunction("joinWifi") { ssid: String, pass: String, promise: Promise ->
      // 同じ SSID に接続済みなら張り直さない(切断と承認ダイアログの再表示を避ける)
      val gw0 = joinedGw
      if (joined != null && joinedSsid == ssid && gw0 != null) {
        promise.resolve(mapOf("gateway" to gw0, "reused" to true))
        return@AsyncFunction
      }
      // 同じ SSID への参加が進行中なら、新しく requestNetwork を出さず、その結果を待つ(二重要求でダイアログが固まるのを防ぐ)
      if (joinPending == ssid) {
        Log.i(TAG, "joinWifi already in progress ssid=$ssid -> wait (no new requestNetwork)")
        joinWaiters.add(promise)
        return@AsyncFunction
      }
      leave()
      joinPending = ssid
      joinWaiters.clear()
      joinWaiters.add(promise)
      Log.i(TAG, "joinWifi accepted ssid=$ssid ssidBytes=${ssid.toByteArray(Charsets.UTF_8).size} passLen=${pass.length} passTag=${passTag(pass)} security=WPA2-PSK startDelay=${JOIN_START_DELAY_MS}ms")
      logScan(ssid, "before-join", true)
      if (JOIN_START_DELAY_MS > 0) mainHandler.postDelayed({ if (joinPending == ssid) startJoin(ssid, pass, 1) }, JOIN_START_DELAY_MS)
      else startJoin(ssid, pass, 1)
    }
    Function("leaveWifi") { leave() }

    /** セルラー回線(INTERNET 能力つき)があるか。役割(親機/子機)の自動判定に使う。 */
    /** 親機が今つないでいる Wi-Fi の周波数(MHz)。未接続は 0。Direct のチャンネルを合わせるのに使う */
    Function("wifiFrequency") {
      val w = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
      @Suppress("DEPRECATION") val i = w.connectionInfo
      if (i != null && i.networkId != -1) i.frequency else 0
    }
    /**
     * 親機として共有できる携帯回線があるか。
     * Wi-Fi 接続中は、携帯のデータ接続が切られて(要求されるまで張られない)、回線の網が見えないことがある。
     * そのため「いま網がある」か、「SIM が使える状態で、モバイルデータがオン」のどちらかなら true とする。
     * 実際に使うときは、startSocks が回線を要求して張る。
     */
    Function("hasCellular") {
      @Suppress("DEPRECATION")
      val live = cm.allNetworks.any { n ->
        val c = cm.getNetworkCapabilities(n)
        c != null && c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) &&
          c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      }
      if (live) return@Function true
      val tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as android.telephony.TelephonyManager
      val slots = maxOf(1, tm.activeModemCount)
      val simReady = (0 until slots).any { tm.getSimState(it) == android.telephony.TelephonyManager.SIM_STATE_READY }
      val dataOn = android.provider.Settings.Global.getInt(ctx.contentResolver, "mobile_data", 1) == 1
      simReady && dataOn
    }

    /**
     * WifiNetworkSuggestion で参加する。初回に一度だけ「ネットワークの提案を許可」を承認すれば、
     * 以降は承認ダイアログなしで OS が自動接続する(WifiNetworkSpecifier は毎回承認が必要)。
     * SSID が変わるたびに提案を差し替える。
     */
    AsyncFunction("suggestWifi") { ssid: String, pass: String, promise: Promise ->
      val gw0 = joinedGw
      if (joined != null && joinedSsid == ssid && gw0 != null) {
        promise.resolve(mapOf("gateway" to gw0, "reused" to true)); return@AsyncFunction
      }
      leave()
      val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      if (suggestions.isNotEmpty()) wm.removeNetworkSuggestions(suggestions)
      val sg = WifiNetworkSuggestion.Builder().setSsid(ssid).setWpa2Passphrase(pass)
        .setIsAppInteractionRequired(false).setIsMetered(false).build()
      suggestions = listOf(sg)
      val st = wm.addNetworkSuggestions(suggestions)
      android.util.Log.i("DH-SUGGEST", "addNetworkSuggestions status=$st ssid=$ssid")
      // 0=SUCCESS。4=ERROR_APP_DISALLOWED(ユーザーが未許可)。5=DUPLICATE は差し替え済みなので続行
      if (st != WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS && st != WifiManager.STATUS_NETWORK_SUGGESTIONS_ERROR_ADD_DUPLICATE) {
        promise.reject("E_SUGGEST", "addNetworkSuggestions status=$st", null); return@AsyncFunction
      }
      joinedSsid = ssid
      val done = AtomicBoolean(false)
      val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
      val cb = object : ConnectivityManager.NetworkCallback(FLAG_INCLUDE_LOCATION_INFO) {
        private var net: Network? = null
        private fun match(c: NetworkCapabilities) = (c.transportInfo as? WifiInfo)?.ssid?.trim('"') == ssid
        override fun onCapabilitiesChanged(n: Network, c: NetworkCapabilities) { if (match(c)) { net = n; joined = n } }
        override fun onLinkPropertiesChanged(n: Network, lp: LinkProperties) {
          if (n != net) return
          val gw = gatewayOf(lp) ?: return
          joinedGw = gw
          if (done.compareAndSet(false, true)) promise.resolve(mapOf("gateway" to gw))
        }
        override fun onLost(n: Network) {
          if (n != net) return
          if (joined == n) { joined = null; joinedGw = null; joinedSsid = null; cm.bindProcessToNetwork(null) }
          sendEvent("onWifiLost", emptyMap<String, Any>())
        }
      }
      netCb = cb
      cm.registerNetworkCallback(req, cb)
      Handler(Looper.getMainLooper()).postDelayed({
        if (done.compareAndSet(false, true)) promise.reject("E_SUGGEST", "suggestion で 40 秒以内に接続できず", null)
      }, 40_000)
    }

    /** このプロセスの通信を、参加した Wi-Fi に固定する(VPN のトンネルが親機へ届くようにするため)。 */
    Function("bindToJoined") {
      val n = joined
      if (n != null) cm.bindProcessToNetwork(n)
      n != null
    }
    Function("unbindProcess") { cm.bindProcessToNetwork(null) }

    /** 参加した Wi-Fi 経由で host:port へ TCP 接続し、"ping" を送って往復時間(ms)を返す。 */
    AsyncFunction("probe") { host: String, port: Int, promise: Promise ->
      val n = joined
      Thread {
        try {
          val t0 = System.nanoTime()
          val s = (n?.socketFactory?.createSocket() ?: Socket())
          s.use {
            it.connect(InetSocketAddress(host, port), 5000)
            it.soTimeout = 5000
            it.getOutputStream().write("ping".toByteArray())
            val buf = ByteArray(16)
            val len = it.getInputStream().read(buf)
            val ok = len > 0 && String(buf, 0, len) == "ping"
            promise.resolve(mapOf("ok" to ok, "rttMs" to (System.nanoTime() - t0) / 1_000_000))
          }
        } catch (e: Exception) {
          promise.resolve(mapOf("ok" to false, "error" to (e.message ?: e.toString())))
        }
      }.start()
    }
  }

  /** 合言葉の突き合わせ用に、先頭 4 桁だけの SHA-256(合言葉そのものは出さない)。親機・子機で同じ値になるはず */
  private fun passTag(pass: String): String =
    java.security.MessageDigest.getInstance("SHA-256").digest(pass.toByteArray(Charsets.UTF_8)).take(2).joinToString("") { "%02x".format(it) }

  /** 対象 SSID が子機の Wi-Fi スキャン結果に見えているか。見えなければ「見つからない」、見えていれば「認証・接続の失敗」と切り分ける */
  @Suppress("DEPRECATION", "MissingPermission")
  private fun logScan(ssid: String, why: String, kick: Boolean) {
    try {
      val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      if (kick) Log.i(TAG, "scan[$why] startScan=${wm.startScan()} (制限により false のことがある)")
      val all = wm.scanResults
      val hit = all.filter { r ->
        val n = if (Build.VERSION.SDK_INT >= 33) r.wifiSsid?.toString()?.trim('"') else r.SSID
        n == ssid
      }
      if (hit.isEmpty()) {
        val directs = all.filter { (if (Build.VERSION.SDK_INT >= 33) r2s(it) else it.SSID).startsWith("DIRECT-") }
        Log.w(TAG, "scan[$why] ssid=$ssid 見つからない total=${all.size} DIRECT-*=${directs.map { (if (Build.VERSION.SDK_INT >= 33) r2s(it) else it.SSID) + "@" + it.frequency }}")
      } else hit.forEach { r ->
        Log.i(TAG, "scan[$why] ssid=$ssid 見えている bssid=${r.BSSID} freq=${r.frequency} rssi=${r.level} caps=${r.capabilities} ageMs=${(android.os.SystemClock.elapsedRealtime() - r.timestamp / 1000)}")
      }
    } catch (e: Exception) {
      Log.w(TAG, "scan[$why] failed $e (位置情報/NEARBY_WIFI_DEVICES の権限?)")
    }
  }
  @Suppress("NewApi")
  private fun r2s(r: android.net.wifi.ScanResult): String = r.wifiSsid?.toString()?.trim('"') ?: ""

  private fun reasonName(r: Int) = when (r) {
    WifiP2pManager.ERROR -> "ERROR"
    WifiP2pManager.P2P_UNSUPPORTED -> "P2P_UNSUPPORTED"
    WifiP2pManager.BUSY -> "BUSY"
    else -> "reason=$r"
  }

  /**
   * 既存の group を消してから作る。removeGroup が BUSY のときは、
   * (1) cancelConnect + stopPeerDiscovery → 1 秒待って removeGroup をやり直す
   * (2) それでも BUSY なら persistent group を消し、チャンネルを作り直す
   * ことを試してから createGroup する。
   */
  @Suppress("MissingPermission")
  private fun clearThenCreate(m: WifiP2pManager, ch: WifiP2pManager.Channel, cfg: WifiP2pConfig, name: String, pass: String, promise: Promise) {
    // group が無ければ removeGroup は BUSY になる(AOSP: InactiveState で REMOVE_GROUP を DefaultState が処理)。先に有無を見て、無ければ何もしない
    try {
      m.requestGroupInfo(ch) { g ->
        if (g == null) {
          Log.i(TAG, "no existing group -> skip removeGroup/cleanup")
          create(m, ch, cfg, name, pass, promise, 0)
        } else {
          Log.i(TAG, "existing group ssid=${g.networkName} isGO=${g.isGroupOwner} -> removeGroup")
          removeExisting(m, ch, cfg, name, pass, promise)
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "requestGroupInfo before create failed $e -> removeGroup")
      removeExisting(m, ch, cfg, name, pass, promise)
    }
  }

  private fun removeExisting(m: WifiP2pManager, ch: WifiP2pManager.Channel, cfg: WifiP2pConfig, name: String, pass: String, promise: Promise) {
    m.removeGroup(ch, object : WifiP2pManager.ActionListener {
      override fun onSuccess() { Log.i(TAG, "removeGroup ok"); create(m, ch, cfg, name, pass, promise, 0) }
      override fun onFailure(reason: Int) {
        Log.i(TAG, "removeGroup failed reason=${reasonName(reason)} (group はあるのに BUSY: 片付けを試す)")
        if (reason != WifiP2pManager.BUSY) { create(m, ch, cfg, name, pass, promise, 0); return }
        Log.i(TAG, "cleanup step1: cancelConnect + stopPeerDiscovery")
        runCatching { m.cancelConnect(ch, null) }
        runCatching { m.stopPeerDiscovery(ch, null) }
        mainHandler.postDelayed({
          m.removeGroup(ch, object : WifiP2pManager.ActionListener {
            override fun onSuccess() { Log.i(TAG, "cleanup step1 removeGroup ok"); create(m, ch, cfg, name, pass, promise, 0) }
            override fun onFailure(r2: Int) {
              Log.w(TAG, "cleanup step1 removeGroup still failed reason=${reasonName(r2)} -> step2: delete persistent groups + re-initialize channel")
              deletePersistentGroups(m, ch)
              closeChannel(ch)
              val ch2 = m.initialize(ctx, Looper.getMainLooper(), null)
              p2pCh = ch2
              mainHandler.postDelayed({
                m.removeGroup(ch2, object : WifiP2pManager.ActionListener {
                  override fun onSuccess() { Log.i(TAG, "cleanup step2 removeGroup ok"); create(m, ch2, cfg, name, pass, promise, 0) }
                  override fun onFailure(r3: Int) { Log.w(TAG, "cleanup step2 removeGroup reason=${reasonName(r3)} -> createGroup anyway"); create(m, ch2, cfg, name, pass, promise, 0) }
                })
              }, 500L)
            }
          })
        }, 1_000L)
      }
    })
  }

  /** 記憶された persistent group を消す(公開 API が無いので reflection。無い/失敗は無視) */
  private fun deletePersistentGroups(m: WifiP2pManager, ch: WifiP2pManager.Channel) {
    val method = runCatching { WifiP2pManager::class.java.getMethod("deletePersistentGroup", WifiP2pManager.Channel::class.java, Int::class.javaPrimitiveType, WifiP2pManager.ActionListener::class.java) }.getOrNull()
    if (method == null) { Log.i(TAG, "deletePersistentGroup unavailable"); return }
    for (id in 0..7) runCatching { method.invoke(m, ch, id, null) }
    Log.i(TAG, "deletePersistentGroup requested for netId 0..7")
  }

  /** UDP ASSOCIATE の自己診断: 8.8.8.8 へ DNS(example.com の A)を引いて、応答が返れば true */
  private fun udpSelfTest(port: Int, user: String, pass: String): Boolean = try {
    Socket().use { s ->
      s.connect(InetSocketAddress("127.0.0.1", port), 3000)
      s.soTimeout = 8000
      val o = s.getOutputStream(); val i = s.getInputStream()
      o.write(byteArrayOf(5, 1, 2)); i.readNBytes(ByteArray(2), 0, 2)
      val ub = user.toByteArray(); val pb = pass.toByteArray()
      o.write(byteArrayOf(1, ub.size.toByte()) + ub + byteArrayOf(pb.size.toByte()) + pb); i.readNBytes(ByteArray(2), 0, 2)
      o.write(byteArrayOf(5, 3, 0, 1, 0, 0, 0, 0, 0, 0)); o.flush()
      val r = ByteArray(10); i.readNBytes(r, 0, 10)
      if (r[1].toInt() != 0) return@use false
      val bport = ((r[8].toInt() and 0xff) shl 8) or (r[9].toInt() and 0xff)
      val q = byteArrayOf(0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7) + "example".toByteArray() + byteArrayOf(3) + "com".toByteArray() + byteArrayOf(0, 0, 1, 0, 1)
      val pkt = byteArrayOf(0, 0, 0, 1, 8, 8, 8, 8, 0, 53) + q
      DatagramSocket().use { u ->
        u.soTimeout = 5000
        u.send(java.net.DatagramPacket(pkt, pkt.size, InetAddress.getByName("127.0.0.1"), bport))
        val buf = ByteArray(1500); val p = java.net.DatagramPacket(buf, buf.size)
        u.receive(p)
        p.length > 10 + 12 && buf[10] == 0x12.toByte() && buf[11] == 0x34.toByte()
      }
    }
  } catch (e: Exception) { false }

  private fun create(m: WifiP2pManager, ch: WifiP2pManager.Channel, cfg: WifiP2pConfig, name: String, pass: String, promise: Promise, retry: Int) {
    try {
      m.createGroup(ch, cfg, object : WifiP2pManager.ActionListener {
        override fun onSuccess() {
          // ok は「要求が受け付けられた」だけ。group が実際にできる(GO になる)まで待ってから返す
          Log.i(TAG, "createGroup accepted ssid=$name -> wait for group formed (max ${GROUP_READY_MS}ms)")
          waitGroupReady(m, ch, name, pass, promise, android.os.SystemClock.elapsedRealtime() + GROUP_READY_MS, 0)
        }
        override fun onFailure(reason: Int) {
          Log.w(TAG, "createGroup failed ssid=$name reason=${reasonName(reason)} retry=$retry")
          if (reason == WifiP2pManager.BUSY && retry < 1) {
            runCatching { m.cancelConnect(ch, null) }
            runCatching { m.stopPeerDiscovery(ch, null) }
            m.removeGroup(ch, object : WifiP2pManager.ActionListener {
              override fun onSuccess() = retryCreate()
              override fun onFailure(r: Int) = retryCreate()
              fun retryCreate() { mainHandler.postDelayed({ create(m, ch, cfg, name, pass, promise, retry + 1) }, 1_500L) }
            })
            return
          }
          promise.reject("E_DIRECT", "createGroup failed: reason=${reasonName(reason)}", null)
        }
      })
    } catch (e: Exception) {
      Log.w(TAG, "createGroup exception ssid=$name $e")
      promise.reject("E_DIRECT", e.message ?: e.toString(), e)
    }
  }

  /** requestGroupInfo を 500ms ごとに調べ、group が非 null・自分が GO・SSID 一致になったら準備完了として返す。期限までに揃わなければ失敗 */
  @Suppress("MissingPermission")
  private fun waitGroupReady(m: WifiP2pManager, ch: WifiP2pManager.Channel, want: String, pass: String, promise: Promise, deadline: Long, n: Int) {
    try {
      m.requestGroupInfo(ch) { g ->
        val ok = g != null && g.isGroupOwner && g.networkName == want
        val now = android.os.SystemClock.elapsedRealtime()
        if (ok) {
          Log.i(TAG, "group ready ssid=$want after ${n * 500}ms (polls=${n + 1})")
          logGroup(m, ch, want)
          promise.resolve(mapOf("ssid" to want, "passphrase" to pass))
        } else if (now < deadline) {
          if (n % 4 == 0) Log.i(TAG, "waiting group: info=${if (g == null) "null" else "ssid=${g.networkName} isGO=${g.isGroupOwner}"} poll=$n")
          mainHandler.postDelayed({ waitGroupReady(m, ch, want, pass, promise, deadline, n + 1) }, 500L)
        } else {
          val why = when {
            g == null -> "formed=false のまま(requestGroupInfo null)"
            !g.isGroupOwner -> "GO になっていない(ssid=${g.networkName})"
            else -> "SSID 不一致 got=${g.networkName} want=$want"
          }
          Log.w(TAG, "group NOT ready after ${GROUP_READY_MS}ms: $why")
          // 半端な状態を残さない
          m.removeGroup(ch, null)
          promise.reject("E_DIRECT", "group not formed within ${GROUP_READY_MS / 1000}s: $why", null)
        }
      }
    } catch (e: Exception) {
      Log.w(TAG, "requestGroupInfo exception $e")
      promise.reject("E_DIRECT", "requestGroupInfo: ${e.message ?: e}", e)
    }
  }

  /** 作ったグループの実際の SSID・周波数・GO アドレスをログに出す(合言葉は出さない) */
  @Suppress("MissingPermission")
  private fun logGroup(m: WifiP2pManager, ch: WifiP2pManager.Channel, want: String) {
    try {
      m.requestGroupInfo(ch) { g ->
        if (g == null) { Log.w(TAG, "requestGroupInfo null (グループ情報なし) want=$want"); return@requestGroupInfo }
        val freq = runCatching { g.javaClass.getMethod("getFrequency").invoke(g) as Int }.getOrNull() // API 36+
        Log.i(TAG, "groupInfo ssid=${g.networkName} match=${g.networkName == want} isGO=${g.isGroupOwner} freq=${freq ?: "n/a"} iface=${g.`interface`} clients=${g.clientList.size}")
      }
      m.requestConnectionInfo(ch) { i ->
        Log.i(TAG, "connectionInfo formed=${i?.groupFormed} isGO=${i?.isGroupOwner} goAddr=${i?.groupOwnerAddress?.hostAddress}")
      }
    } catch (e: Exception) {
      Log.w(TAG, "groupInfo failed $e")
    }
  }

  private fun closeChannel(ch: WifiP2pManager.Channel) {
    if (Build.VERSION.SDK_INT >= 27) runCatching { ch.close() }
  }

  /** 参加を 1 回試す。JOIN_TIMEOUT_MS で見つからなければ要求を取り下げ(ダイアログを残さない)、1 回だけやり直す */
  private fun startJoin(ssid: String, pass: String, attempt: Int) {
    val gen = ++joinGen
    val spec = WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(pass).build()
    val req = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .setNetworkSpecifier(spec)
      .build()
    joinedSsid = ssid
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(n: Network) {
        if (gen != joinGen) return
        Log.i(TAG, "join available ssid=$ssid attempt=$attempt")
        joined = n
      }
      override fun onLinkPropertiesChanged(n: Network, lp: LinkProperties) {
        if (gen != joinGen) return
        val gw = gatewayOf(lp) ?: return
        joinedGw = gw
        Log.i(TAG, "join ok ssid=$ssid gw=$gw attempt=$attempt")
        finishJoin("ok", null, gw)
      }
      override fun onUnavailable() {
        if (gen != joinGen) return
        Log.w(TAG, "join unavailable ssid=$ssid attempt=$attempt (拒否または見つからない)")
        finishJoin("declined", "network unavailable (timeout or user declined)")
      }
      override fun onLost(n: Network) {
        if (gen == joinGen && joined == n) { joined = null; joinedGw = null; joinedSsid = null; cm.bindProcessToNetwork(null) }
        sendEvent("onWifiLost", emptyMap<String, Any>())
      }
    }
    netCb = cb
    Log.i(TAG, "joinWifi requestNetwork ssid=$ssid (1 回だけ) timeout=${JOIN_TIMEOUT_MS}ms")
    sendEvent("onJoinPrompt", mapOf("ssid" to ssid, "phase" to "show", "timeoutMs" to JOIN_TIMEOUT_MS))
    cm.requestNetwork(req, cb)
    joinTimeout = Runnable {
      if (gen != joinGen || joinPending == null) return@Runnable
      logScan(ssid, "timeout", false)
      runCatching { cm.unregisterNetworkCallback(cb) } // 取り下げて、承認ダイアログを残さない
      if (netCb === cb) netCb = null
      Log.w(TAG, "join timeout ssid=$ssid after ${JOIN_TIMEOUT_MS}ms -> give up (やり直しは呼び出し側)")
      finishJoin("timeout", "network not found or not approved within ${JOIN_TIMEOUT_MS / 1000}s")
    }
    mainHandler.postDelayed(joinTimeout!!, JOIN_TIMEOUT_MS)
  }

  private fun finishJoin(phase: String, error: String?, gw: String? = null) {
    sendEvent("onJoinPrompt", mapOf("ssid" to (joinedSsid ?: ""), "phase" to phase))
    joinTimeout?.let { mainHandler.removeCallbacks(it) }
    joinTimeout = null
    val ws = joinWaiters.toList()
    joinWaiters.clear()
    joinPending = null
    for (w in ws) {
      if (error == null) w.resolve(mapOf("gateway" to gw)) else w.reject("E_JOIN", error, null)
    }
  }

  private fun leave() {
    joinTimeout?.let { mainHandler.removeCallbacks(it) }
    joinTimeout = null
    joinGen++
    if (joinPending != null) finishJoin("cancelled", "cancelled")
    cm.bindProcessToNetwork(null)
    netCb?.let { runCatching { cm.unregisterNetworkCallback(it) } }
    netCb = null
    joined = null; joinedSsid = null; joinedGw = null
  }

  private fun gatewayOf(lp: LinkProperties): String? {
    lp.routes.firstOrNull { it.isDefaultRoute && it.gateway != null }?.gateway?.hostAddress?.let { return it }
    if (Build.VERSION.SDK_INT >= 30) lp.dhcpServerAddress?.hostAddress?.let { return it }
    return null
  }

  @Suppress("DEPRECATION")
  private fun credentials(r: WifiManager.LocalOnlyHotspotReservation): Pair<String, String> {
    if (Build.VERSION.SDK_INT >= 30) {
      val c = r.softApConfiguration
      val ssid = if (Build.VERSION.SDK_INT >= 33) {
        c.wifiSsid?.bytes?.toString(Charsets.UTF_8) ?: ""
      } else (c.ssid ?: "")
      return ssid.trim('"') to (c.passphrase ?: "")
    }
    val c = r.wifiConfiguration
    return (c?.SSID ?: "").trim('"') to (c?.preSharedKey ?: "").trim('"')
  }

  companion object {
    @Volatile private var activeEcho: ServerSocket? = null
  }
}
