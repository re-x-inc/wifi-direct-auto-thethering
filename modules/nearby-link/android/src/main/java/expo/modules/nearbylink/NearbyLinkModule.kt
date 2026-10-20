package expo.modules.nearbylink

import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionOptions
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

private const val SERVICE_ID = "info.rex.tether.link"
private const val RETRY_MAX = 2
private const val REDISCOVER_MAX = 2
private const val REDISCOVER_TOTAL_MS = 30_000L
// 8012(IO_ERROR)・8009(OUT_OF_ORDER_API_CALL)のあと、失敗した接続の後始末(disconnectFromEndpoint)が済むまで待つ時間。
// この間は、どの endpoint にも次の requestConnection を出さない(後始末の途中に重ねると 8009 になる)
private const val SETTLE_MS = 1_500L
// ペア保存後の通常接続: つながっていない間だけ省電力にする(BLE だけだと 8007 で繋がらないため、はじめは lowPower=false)。
// つながっている間は常に lowPower=false。切れたら、また下の時間割を頭から数える
private const val LINK_FULL_POWER_MS = 120_000L // つながらないまま続いたら省電力に落とす
private const val LINK_CYCLE_MS = 60_000L // 以降はこの間隔で
private const val LINK_BURST_MS = 20_000L // この長さだけ lowPower=false で試す
private const val LINK_STALE_MS = 300_000L // 動きが止まってこれだけ経ったら、はじめからやり直す
private const val LINK_TICK_MS = 5_000L

/**
 * Nearby に使わせる medium の切り替え(試験で比べるため 1 か所):
 *  "default" = 従来どおり(Nearby が WIFI_LAN・WIFI_HOTSPOT・WIFI_DIRECT へ帯域を自動で切り替える)
 *  "bt"      = Bluetooth Classic + BLE だけ。Wi-Fi 系(LAN/Aware/Hotspot/Direct)・NFC・WebRTC を使わせず、帯域の自動アップグレードも止める
 *  "ble"     = BLE だけ(Classic も使わない。8007 で繋がらないことがある)
 *  "public"  = 非公開フィールドは触らず、公開 API(connectionType=NON_DISRUPTIVE・disruptiveUpgrade=false)だけ(既定)
 * 注意: "bt"/"ble" の reflection は GMS に「Invalid advertising/discovery options for non-exempt client」で拒否される(2026-10-20 実機)。
 *       non-exempt client(通常のアプリ)では bt/ble は使えない。試験用に残しているだけ。
 * 公開 API には medium を選ぶ設定が無い(connectionType・disruptiveUpgrade・lowPower のみ)ため、
 * Options 内の非公開フィールドを reflection で書き換える。フィールド名は play-services-nearby 19.3.0 の実物
 * (toString の並びと既定値で確認)。名前が合わない版では何もせず、ログに出す。
 */
private const val NEARBY_MEDIUMS = "public"

/** GMS が Options を「Invalid … options for non-exempt client」で拒否したら true にし、以後は reflection なし(公開 API だけ)で作る */
@Volatile private var mediumsFallback = false

private fun isInvalidOptions(e: Exception) = e is IllegalStateException && (e.message ?: "").contains("Invalid")

private fun setBool(o: Any, field: String, v: Boolean) {
  val f = o.javaClass.getDeclaredField(field)
  if (f.type != Boolean::class.javaPrimitiveType) error("$field is ${f.type}")
  f.isAccessible = true
  f.setBoolean(o, v)
}

/** NEARBY_MEDIUMS に従い、Options 内の medium フラグを書き換える。fields: [bluetooth, ble, wifiLan, nfc, wifiAware, wifiHotspot, wifiDirect, webRtc, autoUpgrade](無い項目は null) */
private fun applyMediums(o: Any, kind: String, fields: Array<String?>): String {
  if (mediumsFallback) return "$kind mediums=public(fallback)"
  if (NEARBY_MEDIUMS != "bt" && NEARBY_MEDIUMS != "ble") return "$kind mediums=$NEARBY_MEDIUMS"
  val bt = NEARBY_MEDIUMS == "bt"
  val want = booleanArrayOf(bt, true, false, false, false, false, false, false, false)
  return try {
    for (i in fields.indices) fields[i]?.let { setBool(o, it, want[i]) }
    "$kind mediums=$NEARBY_MEDIUMS applied: $o"
  } catch (e: Throwable) {
    "$kind mediums=$NEARBY_MEDIUMS FAILED to apply ($e) -> default のまま"
  }
}

private val ADV_FIELDS = arrayOf<String?>("zzd", "zze", "zzi", "zzj", "zzk", null, null, "zzm", "zzb")
private val DISC_FIELDS = arrayOf<String?>("zzc", "zzd", "zzg", "zzh", "zzi", null, null, null, null)
private val CONN_FIELDS = arrayOf<String?>("zzb", "zzc", "zzd", "zze", "zzf", "zzg", "zzh", "zzj", null)

/**
 * Nearby Connections の薄いラッパー。受け入れ可否・認証の方針は JS 側で決める
 * (既知の相手は共有コードの HMAC で確認して自動承認、初回だけ認証コードを人が確認)。
 */
class NearbyLinkModule : Module() {
  private val client: ConnectionsClient
    get() = Nearby.getConnectionsClient(appContext.reactContext ?: error("no context"))

  private val payloads = object : PayloadCallback() {
    override fun onPayloadReceived(endpointId: String, payload: Payload) {
      payload.asBytes()?.let {
        sendEvent("onMessage", mapOf("endpointId" to endpointId, "text" to String(it, Charsets.UTF_8)))
      }
    }
    override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) = Unit
  }

  /**
   * requestConnection は endpoint ごとに 1 つだけ進行中にする(onConnectionResult / onDisconnected / 失敗確定まで)。
   * 進行中の endpoint に重ねて出すと、GMS が 8009 STATUS_OUT_OF_ORDER_API_CALL を返す。
   */
  private val inFlight = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
  /** 失敗した接続の後始末が済むまで、次の requestConnection を出さない時刻(elapsedRealtime) */
  @Volatile private var settleUntil = 0L

  /** 8012 などを次の実機で切り分けるための、接続ごとの記録 */
  private class ConnDiag(val startedAt: Long, val lowPowerReq: Boolean, val curLow: Boolean?) {
    @Volatile var lastCb = "requestConnection"
    @Volatile var lastCbAt = startedAt
    @Volatile var quality = -1
    @Volatile var attempts = 1
  }
  private val diags = java.util.concurrent.ConcurrentHashMap<String, ConnDiag>()

  private fun markCb(endpointId: String, name: String) {
    diags[endpointId]?.let { it.lastCb = name; it.lastCbAt = android.os.SystemClock.elapsedRealtime() }
  }

  private fun release(endpointId: String) {
    inFlight.remove(endpointId)
  }

  /** 失敗時に、使っていた medium・lowPower・経過 ms・直前のコールバックなどを 1 行で出す(grep: "conn-fail") */
  private fun logConnFail(endpointId: String, code: Int, peerName: String?) {
    val now = android.os.SystemClock.elapsedRealtime()
    val d = diags[endpointId]
    val q = when (d?.quality) { 1 -> "LOW(BT/BLE)"; 2 -> "MEDIUM"; 3 -> "HIGH(Wi-Fi系)"; 0 -> "UNKNOWN"; else -> "none" }
    DhLog.w("DH-NEARBY",
      "conn-fail code=$code(${com.google.android.gms.nearby.connection.ConnectionsStatusCodes.getStatusCodeString(code)}) ep=$endpointId peer=$peerName " +
      "mediums=$NEARBY_MEDIUMS lowPowerReq=${d?.lowPowerReq} discLowPower=${d?.curLow} elapsedMs=${d?.let { now - it.startedAt }} " +
      "lastCb=${d?.lastCb} lastCbAgoMs=${d?.let { now - it.lastCbAt }} bandwidth=$q attempt=${d?.attempts} " +
      "connected=${connected.size} inFlight=${inFlight.size} pairing=$pairing ${wifiState()}")
  }

  /**
   * 実機確認用: アップグレード時に現れる P2P の状態を DH-NEARBY に残す(グループの ssid・GO IP・interface、p2p らしいネットワークの interface/アドレス/種類)。
   * 副作用なし(グループは作らない・消さない)。権限が無いなどで取れない項目は ? になる
   */
  @Suppress("DEPRECATION")
  private fun dumpP2p(why: String) {
    val c = appContext.reactContext ?: return
    try {
      val cm = c.getSystemService(android.net.ConnectivityManager::class.java)
      val nets = cm.allNetworks.mapNotNull { n ->
        val lp = cm.getLinkProperties(n) ?: return@mapNotNull null
        val cap = cm.getNetworkCapabilities(n)
        val tr = listOf(android.net.NetworkCapabilities.TRANSPORT_WIFI to "WIFI", android.net.NetworkCapabilities.TRANSPORT_WIFI_AWARE to "AWARE", android.net.NetworkCapabilities.TRANSPORT_CELLULAR to "CELL", android.net.NetworkCapabilities.TRANSPORT_BLUETOOTH to "BT")
          .filter { cap?.hasTransport(it.first) == true }.joinToString("+") { it.second }
        "${lp.interfaceName}[$tr inet=${cap?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)} ${lp.linkAddresses.joinToString(",") { it.address.hostAddress ?: "?" }}]"
      }
      val m = c.getSystemService(android.content.Context.WIFI_P2P_SERVICE) as android.net.wifi.p2p.WifiP2pManager
      val ch = m.initialize(c, android.os.Looper.getMainLooper(), null)
      m.requestConnectionInfo(ch) { info ->
        m.requestGroupInfo(ch) { g ->
          DhLog.i("DH-NEARBY", "p2p@upgrade why=$why groupFormed=${info?.groupFormed} isGO=${info?.isGroupOwner} goAddr=${info?.groupOwnerAddress?.hostAddress} " +
            "group.ssid=${g?.networkName} group.iface=${g?.`interface`} group.isGO=${g?.isGroupOwner} clients=${g?.clientList?.size} nets=$nets")
          runCatching { if (android.os.Build.VERSION.SDK_INT >= 27) ch.close() }
        }
      }
    } catch (e: Exception) {
      DhLog.w("DH-NEARBY", "p2p@upgrade why=$why dump failed $e")
    }
  }

  /** Wi-Fi との共存を見る手がかり。取れなければ空 */
  private fun wifiState(): String = try {
    val wm = appContext.reactContext?.applicationContext?.getSystemService(android.content.Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
    val i = wm?.connectionInfo
    val on = wm?.isWifiEnabled
    "wifiOn=$on wifiSsid=${if (i != null && i.networkId != -1) "connected" else "none"} wifiFreq=${i?.frequency} wifiRssi=${i?.rssi}"
  } catch (e: Exception) { "wifi=?($e)" }

  private val lifecycle = object : ConnectionLifecycleCallback() {
    override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
      markCb(endpointId, "onConnectionInitiated")
      sendEvent("onInitiated", mapOf(
        "endpointId" to endpointId,
        "name" to info.endpointName,
        "digits" to info.authenticationDigits,
        "incoming" to info.isIncomingConnection,
      ))
    }
    override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
      markCb(endpointId, "onConnectionResult(${result.status.statusCode})")
      if (!result.status.isSuccess) logConnFail(endpointId, result.status.statusCode, foundNames[endpointId] ?: knownNames[endpointId])
      release(endpointId)
      if (result.status.isSuccess) {
        linkUp(endpointId)
        sendEvent("onConnected", mapOf("endpointId" to endpointId))
      } else {
        linkDown(endpointId)
        sendEvent("onFailed", mapOf("endpointId" to endpointId, "code" to result.status.statusCode))
      }
    }
    override fun onBandwidthChanged(endpointId: String, info: com.google.android.gms.nearby.connection.BandwidthInfo) {
      // quality: 0=UNKNOWN 1=LOW(BT/BLE) 2=MEDIUM 3=HIGH(Wi-Fi 系)。medium 名そのものは API に無い
      val q = when (info.quality) { 1 -> "LOW(BT/BLE)"; 2 -> "MEDIUM"; 3 -> "HIGH(Wi-Fi系)"; else -> "UNKNOWN" }
      val prevQ = when (diags[endpointId]?.quality) { 1 -> "LOW(BT/BLE)"; 2 -> "MEDIUM"; 3 -> "HIGH(Wi-Fi系)"; 0 -> "UNKNOWN"; else -> "none" }
      DhLog.i("DH-NEARBY", "bandwidth changed ep=$endpointId quality=$prevQ->$q mediums=$NEARBY_MEDIUMS")
      dumpP2p("bandwidth $prevQ->$q ep=$endpointId")
      diags[endpointId]?.quality = info.quality
      markCb(endpointId, "onBandwidthChanged($q)")
      sendEvent("onBandwidth", mapOf("endpointId" to endpointId, "quality" to info.quality))
    }
    override fun onDisconnected(endpointId: String) {
      markCb(endpointId, "onDisconnected")
      release(endpointId)
      linkDown(endpointId)
      sendEvent("onDisconnected", mapOf("endpointId" to endpointId))
    }
  }

  /** ペアリング中だけ true。広告・探索の省電力を外す */
  @Volatile private var pairing = false

  /** 開始系の失敗を握りつぶさず、コード付きでログと JS に伝える */
  private fun report(op: String, e: Exception) {
    val code = (e as? com.google.android.gms.common.api.ApiException)?.statusCode ?: -1
    DhLog.w("DH-NEARBY", "$op failed code=$code ${com.google.android.gms.nearby.connection.ConnectionsStatusCodes.getStatusCodeString(code)} $e")
    if (code == 8034) dumpPermissions(op)
    sendEvent("onError", mapOf("op" to op, "code" to code))
  }

  /**
   * 8034 MISSING_PERMISSION_*: GMS が「このアプリに無い」と見た権限の手がかりを残す(実機: Wi-Fi Direct 参加の約 11 秒後に discover が 8034)。
   * アプリが持つ権限・位置情報のモード・つながっているネットワークの種類を並べる。個人情報は含まない。
   */
  private fun dumpPermissions(op: String) {
    try {
      val ctx = appContext.reactContext ?: return
      val perms = listOf(
        "ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "NEARBY_WIFI_DEVICES",
        "BLUETOOTH_SCAN", "BLUETOOTH_ADVERTISE", "BLUETOOTH_CONNECT", "ACCESS_LOCAL_NETWORK",
      ).joinToString(" ") {
        val granted = ctx.checkSelfPermission("android.permission.$it") == android.content.pm.PackageManager.PERMISSION_GRANTED
        "$it=$granted"
      }
      val lm = ctx.getSystemService(android.content.Context.LOCATION_SERVICE) as? android.location.LocationManager
      val cm = ctx.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as? android.net.ConnectivityManager
      val nets = cm?.allNetworks?.joinToString(",") { n ->
        val c = cm.getNetworkCapabilities(n)
        val kind = listOf("WIFI" to android.net.NetworkCapabilities.TRANSPORT_WIFI, "CELL" to android.net.NetworkCapabilities.TRANSPORT_CELLULAR, "VPN" to android.net.NetworkCapabilities.TRANSPORT_VPN)
          .filter { c?.hasTransport(it.second) == true }.joinToString("+") { it.first }
        val local = if (c?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) == true) "" else "(no-internet)"
        kind + local
      }
      DhLog.w("DH-NEARBY", "8034 diag op=$op sdk=${android.os.Build.VERSION.SDK_INT} $perms locationEnabled=${lm?.isLocationEnabled} networks=[$nets]")
    } catch (t: Throwable) {
      DhLog.w("DH-NEARBY", "8034 diag failed $t")
    }
  }

  // ---- 通常接続(ペア保存後)の省電力制御 ----
  private var linkSince: Long? = null // つながっていない状態が始まった時刻(つながっている間は null)
  private val connected = java.util.concurrent.ConcurrentHashMap.newKeySet<String>() // いまつながっている相手
  private var lastActivity = 0L
  private var advName: String? = null
  private var discovering = false
  private var curLow: Boolean? = null
  private val powerTick = object : Runnable {
    override fun run() {
      if (pairing || (advName == null && !discovering)) return
      val low = lowNow()
      if (low != curLow) {
        DhLog.i("DH-NEARBY", "link power switch lowPower=$low (advertise=${advName != null} discover=$discovering)")
        advName?.let { startAdv(it) }
        if (discovering) startDisc()
      }
      mainHandler.postDelayed(this, LINK_TICK_MS)
    }
  }

  /** つながった。つながっている間は lowPower=false のまま(省電力に落とさない) */
  private fun linkUp(endpointId: String) {
    connected.add(endpointId)
    linkSince = null
    DhLog.i("DH-NEARBY", "link up connected=${connected.size} lowPower=false (つながっている間は省電力にしない)")
  }

  /** つながりが切れた/つながれなかった。誰ともつながっていなければ、ここから「つながっていない時間」を数え直す */
  private fun linkDown(endpointId: String) {
    connected.remove(endpointId)
    if (connected.isEmpty() && !pairing) {
      val now = android.os.SystemClock.elapsedRealtime()
      linkSince = now
      lastActivity = now
      DhLog.i("DH-NEARBY", "link down connected=0 -> full power ${LINK_FULL_POWER_MS / 1000}s, then power-save cycle")
    }
  }

  /** いまの広告・探索を lowPower にするか。ペアリング中とつながっている間は常に false。通常接続は、つながっていない経過時間で決める */
  private fun lowNow(): Boolean {
    if (pairing || connected.isNotEmpty()) return false
    val since = linkSince ?: return false
    val el = android.os.SystemClock.elapsedRealtime() - since
    if (el < LINK_FULL_POWER_MS) return false
    return (el - LINK_FULL_POWER_MS) % LINK_CYCLE_MS >= LINK_BURST_MS
  }

  private fun touchLink() {
    if (connected.isNotEmpty()) return // つながっている間は数えない
    val now = android.os.SystemClock.elapsedRealtime()
    if (linkSince == null || now - lastActivity > LINK_STALE_MS) linkSince = now
    lastActivity = now
  }

  private fun startAdv(name: String) {
    val low = lowNow()
    curLow = low
    DhLog.i("DH-NEARBY", "advertise lowPower=$low name=$name")
    val ab = AdvertisingOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).setLowPower(low)
    if (NEARBY_MEDIUMS != "default") ab.setConnectionType(com.google.android.gms.nearby.connection.ConnectionType.NON_DISRUPTIVE).setDisruptiveUpgrade(false)
    val o = ab.build()
    DhLog.i("DH-NEARBY", applyMediums(o, "advertise", ADV_FIELDS))
    client.stopAdvertising()
    client.startAdvertising(name, SERVICE_ID, lifecycle, o).addOnFailureListener { e ->
      if (!mediumsFallback && isInvalidOptions(e)) {
        DhLog.w("DH-NEARBY", "advertise rejected ($e) -> 一度だけ公開 API のみの Options で始め直す")
        mediumsFallback = true
        startAdv(name)
      } else report("advertise", e)
    }
  }

  private fun startDisc() {
    val low = lowNow()
    curLow = low
    DhLog.i("DH-NEARBY", "discover lowPower=$low")
    foundNames.clear()
    client.stopDiscovery()
    client.startDiscovery(SERVICE_ID, discovery, discoveryOptions()).addOnFailureListener { e ->
      if (!mediumsFallback && isInvalidOptions(e)) {
        DhLog.w("DH-NEARBY", "discover rejected ($e) -> 一度だけ公開 API のみの Options で始め直す")
        mediumsFallback = true
        startDisc()
      } else report("discover", e)
    }
  }

  /** 広告名から相手の識別部分を取り出す。`P|<id>|<label>` なら id、そうでなければ名前そのまま(通常接続は selfId) */
  private fun peerKey(name: String): String =
    if (name.startsWith("P|")) name.split('|').getOrElse(1) { name } else name

  /** 探索で見えている相手(endpointId → 広告名)。接続失敗時に「誰に繋ごうとしていたか」を知るため */
  private val foundNames = java.util.concurrent.ConcurrentHashMap<String, String>()
  private val knownNames = java.util.concurrent.ConcurrentHashMap<String, String>()
  private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

  /** 探索のやり直し中の状態。同じ広告名の相手が再び見つかったら、新しい endpointId で接続し直す */
  private class Rediscover(val peerName: String, val myName: String, val count: Int, val deadline: Long) {
    var timeout: Runnable? = null
  }
  @Volatile private var rediscover: Rediscover? = null

  private fun clearRediscover() {
    rediscover?.timeout?.let { mainHandler.removeCallbacks(it) }
    rediscover = null
  }

  private fun discoveryOptions(): DiscoveryOptions {
    val o = DiscoveryOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).setLowPower(lowNow()).build()
    DhLog.i("DH-NEARBY", applyMediums(o, "discover", DISC_FIELDS))
    return o
  }

  private val discovery = object : EndpointDiscoveryCallback() {
    override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
      foundNames[endpointId] = info.endpointName
      if (knownNames.size > 64) knownNames.clear()
      knownNames[endpointId] = info.endpointName
      sendEvent("onFound", mapOf("endpointId" to endpointId, "name" to info.endpointName))
      val r = rediscover
      if (r != null && peerKey(info.endpointName) == peerKey(r.peerName)) {
        DhLog.i("DH-NEARBY", "rediscover ${r.count}/$REDISCOVER_MAX found ${info.endpointName} new endpointId=$endpointId -> reconnect")
        clearRediscover()
        if (inFlight.add(endpointId)) requestWithRetry(endpointId, r.myName, 0, r.count, r.deadline, r.peerName)
        else DhLog.i("DH-NEARBY", "rediscover: requestConnection already in flight ep=$endpointId -> skip")
      }
    }
    override fun onEndpointLost(endpointId: String) {
      foundNames.remove(endpointId)
      sendEvent("onLost", mapOf("endpointId" to endpointId))
    }
  }

  /**
   * 8011 STATUS_ENDPOINT_UNKNOWN(Nearby 側でもう失われた endpointId)や、8007 の再試行が尽きたとき、
   * stopDiscovery → startDiscovery で探索からやり直す。同じ広告名の相手が見つかったら新しい endpointId で接続し直す。
   * 回数は REDISCOVER_MAX、全体の時間は REDISCOVER_TOTAL_MS まで。尽きたら何もせず(失敗は onError で通知済み)終える。
   */
  private fun startRediscover(peerName: String?, myName: String, done: Int, deadlineIn: Long, why: Int) {
    val now = android.os.SystemClock.elapsedRealtime()
    // 全体の期限は、最初の探索やり直しを始めた時点から数える(0 = まだ始めていない)
    val deadline = if (deadlineIn == 0L) now + REDISCOVER_TOTAL_MS else deadlineIn
    if (peerName == null || done >= REDISCOVER_MAX || now >= deadline) {
      DhLog.w("DH-NEARBY", "rediscover giveup peer=$peerName done=$done/$REDISCOVER_MAX remainMs=${deadline - now} code=$why")
      return
    }
    val count = done + 1
    DhLog.i("DH-NEARBY", "rediscover start $count/$REDISCOVER_MAX peer=$peerName code=$why remainMs=${deadline - now}")
    clearRediscover()
    val r = Rediscover(peerName, myName, count, deadline)
    r.timeout = Runnable {
      if (rediscover === r) {
        DhLog.w("DH-NEARBY", "rediscover timeout $count/$REDISCOVER_MAX peer=$peerName (not found)")
        rediscover = null
        // 見つからなかったときは、時間が残っていれば次の回へ
        startRediscover(peerName, myName, count, deadline, why)
      }
    }
    rediscover = r
    // 1回の待ちは、残り時間と回数で割った長さ(最低 5 秒)
    val slice = maxOf(5_000L, (deadline - now) / (REDISCOVER_MAX - done))
    mainHandler.postDelayed(r.timeout!!, minOf(slice, deadline - now))
    foundNames.clear()
    curLow = lowNow()
    client.stopDiscovery()
    client.startDiscovery(SERVICE_ID, discovery, discoveryOptions()).addOnFailureListener { e ->
      if (!mediumsFallback && isInvalidOptions(e)) {
        DhLog.w("DH-NEARBY", "rediscover rejected ($e) -> 公開 API のみで始め直す")
        mediumsFallback = true
        client.stopDiscovery()
        client.startDiscovery(SERVICE_ID, discovery, discoveryOptions()).addOnFailureListener { e2 -> report("rediscover", e2) }
      } else report("rediscover", e)
    }
  }

  /**
   * 接続の瞬間だけ省電力を外す(広告・探索は省電力のまま)。lowPower=false なら BLE 以外(Bluetooth Classic / Wi-Fi)も使える。
   * 8007 STATUS_RADIO_ERROR は一時的なことが多いので、間をおいて最大 RETRY_MAX 回まで再試行する。
   * 8003 ALREADY_CONNECTED は残骸の接続を切って繋ぎ直す。JS への失敗通知(onError)は従来どおり各回で出す。
   * 8011 は再試行せず、8007 は再試行が尽きたら、探索からやり直す(startRediscover)。
   * rediscovered は探索をやり直した回数。始めの呼び出し(JS から)は 0 で、全体の期限もそこから数える。
   */
  private fun requestWithRetry(endpointId: String, name: String, attempt: Int, rediscovered: Int = 0, deadline: Long = 0L, peerIn: String? = null) {
    // 相手の広告名: 引き継いだもの → 探索で見えているもの → 以前見えたもの の順。stop() で探索の記録が消えても追えるようにする
    val peerName = peerIn ?: foundNames[endpointId] ?: knownNames[endpointId]
    // 直前の失敗の後始末が済むまで待つ(重ねると 8009)。待つ間も、この endpoint の枠(inFlight)は持ったまま
    val waitMs = settleUntil - android.os.SystemClock.elapsedRealtime()
    if (waitMs > 0) {
      DhLog.i("DH-NEARBY", "requestConnect wait ${waitMs}ms (前の失敗の後始末中) ep=$endpointId")
      mainHandler.postDelayed({ requestWithRetry(endpointId, name, attempt, rediscovered, deadline, peerIn) }, waitMs)
      return
    }
    val cb = ConnectionOptions.Builder().setLowPower(false)
    if (NEARBY_MEDIUMS != "default") cb.setConnectionType(com.google.android.gms.nearby.connection.ConnectionType.NON_DISRUPTIVE).setDisruptiveUpgrade(false)
    val o = cb.build()
    DhLog.i("DH-NEARBY", applyMediums(o, "requestConnection", CONN_FIELDS))
    val startedAt = android.os.SystemClock.elapsedRealtime()
    val prev = diags[endpointId]
    // 試行をまたいで「最初の要求からの経過」を数える(再試行でも startedAt は最初のまま)
    diags[endpointId] = if (prev != null && attempt > 0) prev.also { it.attempts = attempt + 1; it.lastCb = "requestConnection(retry$attempt)"; it.lastCbAt = startedAt }
                        else ConnDiag(startedAt, false, curLow)
    client.requestConnection(name, endpointId, lifecycle, o).addOnFailureListener { e ->
      if (!mediumsFallback && isInvalidOptions(e)) {
        DhLog.w("DH-NEARBY", "requestConnection rejected ($e) -> 一度だけ公開 API のみの Options で始め直す")
        mediumsFallback = true
        requestWithRetry(endpointId, name, attempt, rediscovered, deadline, peerIn)
        return@addOnFailureListener
      }
      val code = (e as? com.google.android.gms.common.api.ApiException)?.statusCode ?: -1
      DhLog.w("DH-NEARBY", "requestConnect attempt=${attempt + 1}/${RETRY_MAX + 1} code=$code peer=$peerName")
      markCb(endpointId, "requestConnection failed($code)")
      logConnFail(endpointId, code, peerName)
      report(if (attempt == 0) "requestConnect" else "requestConnect(retry$attempt)", e)
      if (code == 8012 || code == 8009) {
        // IO_ERROR / OUT_OF_ORDER_API_CALL: 失敗した接続を片付け、後始末が済むまで(SETTLE_MS)待ってから、探索からやり直す。
        // 待つ間は枠(inFlight)も settleUntil も保ち、次の requestConnection を出させない。
        client.disconnectFromEndpoint(endpointId)
        settleUntil = android.os.SystemClock.elapsedRealtime() + SETTLE_MS
        DhLog.i("DH-NEARBY", "cleanup code=$code ep=$endpointId disconnectFromEndpoint -> ${SETTLE_MS}ms 待って rediscover")
        mainHandler.postDelayed({
          release(endpointId)
          diags.remove(endpointId)
          startRediscover(peerName, name, rediscovered, deadline, code)
        }, SETTLE_MS)
        return@addOnFailureListener
      }
      val retry = (code == 8003 || code == 8007) && attempt < RETRY_MAX
      if (!retry) {
        release(endpointId)
        diags.remove(endpointId)
        if (code == 8011 || code == 8007) startRediscover(peerName, name, rediscovered, deadline, code)
        return@addOnFailureListener
      }
      if (code == 8003) client.disconnectFromEndpoint(endpointId)
      mainHandler.postDelayed({
        requestWithRetry(endpointId, name, attempt + 1, rediscovered, deadline, peerName)
      }, if (code == 8003) 700L else 1500L)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("NearbyLink")
    Events("onFound", "onLost", "onInitiated", "onConnected", "onFailed", "onDisconnected", "onMessage", "onError", "onBandwidth", "log")
    OnCreate { DhLog.sink = { tag, line -> sendEvent("log", mapOf("tag" to tag, "line" to line)) } }
    OnDestroy { DhLog.sink = null }

    // 1対1。待っている間(広告・探索)は省電力(BLE のみ)。接続要求だけ省電力を外す(requestWithRetry)
    Function("advertise") { name: String ->
      // ペアリング中(名前が P| で始まる)だけ省電力を外す。BLE だけだと 8007 で繋がらないことがあり、Bluetooth Classic / Wi-Fi も使えるようにする。終わったら stop() か通常の名前で省電力に戻る
      pairing = name.startsWith("P|")
      if (!pairing) touchLink()
      // 停止→再開始で前回の広告が残っていると ALREADY_ADVERTISING になるため、先に止める(同じ client への呼び出しは順序どおり処理される)
      // stopAllEndpoints はクライアント全体のリセットなので、ここでは呼ばない(advertise の直後に discover を呼ぶと、広告が消える)。
      // 残骸の一掃は、呼び出し側が最初に1回だけ stop() で行う
      advName = name
      startAdv(name)
      mainHandler.removeCallbacks(powerTick)
      if (!pairing) mainHandler.postDelayed(powerTick, LINK_TICK_MS)
    }
    Function("discover") {
      if (!pairing) touchLink()
      clearRediscover()
      client.stopDiscovery()
      discovering = true
      startDisc()
      mainHandler.removeCallbacks(powerTick)
      if (!pairing) mainHandler.postDelayed(powerTick, LINK_TICK_MS)
    }
    Function("requestConnect") { endpointId: String, name: String ->
      // endpoint ごとに 1 つだけ進行中。進行中なら新しく出さない(JS の onFound 重複・探索やり直しとの二重呼び出しを止める)
      if (inFlight.add(endpointId)) requestWithRetry(endpointId, name, 0)
      else DhLog.i("DH-NEARBY", "requestConnect skipped: already in flight ep=$endpointId")
    }
    Function("accept") { endpointId: String -> client.acceptConnection(endpointId, payloads) }
    Function("reject") { endpointId: String -> client.rejectConnection(endpointId) }
    Function("send") { endpointId: String, text: String ->
      client.sendPayload(endpointId, Payload.fromBytes(text.toByteArray(Charsets.UTF_8)))
    }
    Function("disconnect") { endpointId: String ->
      release(endpointId)
      client.disconnectFromEndpoint(endpointId)
      linkDown(endpointId) // 自分から切ったときは onDisconnected が来ないので、ここで「つながっていない」に戻す
    }
    Function("stop") {
      pairing = false
      connected.clear()
      advName = null
      discovering = false
      curLow = null
      mainHandler.removeCallbacks(powerTick)
      lastActivity = android.os.SystemClock.elapsedRealtime()
      clearRediscover()
      foundNames.clear()
      inFlight.clear()
      diags.clear()
      settleUntil = 0L
      client.stopAdvertising(); client.stopDiscovery(); client.stopAllEndpoints()
    }

    /** HMAC-SHA256(secret, data) を16進で返す。共有コードの認証に使う。 */
    Function("hmac") { secret: String, data: String ->
      val mac = Mac.getInstance("HmacSHA256")
      mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
      mac.doFinal(data.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
  }
}
