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

  private val lifecycle = object : ConnectionLifecycleCallback() {
    override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
      sendEvent("onInitiated", mapOf(
        "endpointId" to endpointId,
        "name" to info.endpointName,
        "digits" to info.authenticationDigits,
        "incoming" to info.isIncomingConnection,
      ))
    }
    override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
      if (result.status.isSuccess) sendEvent("onConnected", mapOf("endpointId" to endpointId))
      else sendEvent("onFailed", mapOf("endpointId" to endpointId, "code" to result.status.statusCode))
    }
    override fun onDisconnected(endpointId: String) {
      sendEvent("onDisconnected", mapOf("endpointId" to endpointId))
    }
  }

  /** ペアリング中だけ true。広告・探索の省電力を外す */
  @Volatile private var pairing = false

  /** 開始系の失敗を握りつぶさず、コード付きでログと JS に伝える */
  private fun report(op: String, e: Exception) {
    val code = (e as? com.google.android.gms.common.api.ApiException)?.statusCode ?: -1
    android.util.Log.w("DH-NEARBY", "$op failed code=$code ${com.google.android.gms.nearby.connection.ConnectionsStatusCodes.getStatusCodeString(code)} $e")
    sendEvent("onError", mapOf("op" to op, "code" to code))
  }

  /** 探索で見えている相手(endpointId → 広告名)。接続失敗時に「誰に繋ごうとしていたか」を知るため */
  private val foundNames = java.util.concurrent.ConcurrentHashMap<String, String>()
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

  private fun discoveryOptions() =
    DiscoveryOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).setLowPower(!pairing).build()

  private val discovery = object : EndpointDiscoveryCallback() {
    override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
      foundNames[endpointId] = info.endpointName
      sendEvent("onFound", mapOf("endpointId" to endpointId, "name" to info.endpointName))
      val r = rediscover
      if (r != null && info.endpointName == r.peerName) {
        android.util.Log.i("DH-NEARBY", "rediscover ${r.count}/$REDISCOVER_MAX found ${info.endpointName} new endpointId=$endpointId -> reconnect")
        clearRediscover()
        requestWithRetry(endpointId, r.myName, 0, r.count)
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
  private fun startRediscover(peerName: String?, myName: String, done: Int, deadline: Long, why: Int) {
    val now = android.os.SystemClock.elapsedRealtime()
    if (peerName == null || done >= REDISCOVER_MAX || now >= deadline) {
      android.util.Log.w("DH-NEARBY", "rediscover giveup peer=$peerName done=$done/$REDISCOVER_MAX remainMs=${deadline - now} code=$why")
      return
    }
    val count = done + 1
    android.util.Log.i("DH-NEARBY", "rediscover start $count/$REDISCOVER_MAX peer=$peerName code=$why remainMs=${deadline - now}")
    clearRediscover()
    val r = Rediscover(peerName, myName, count, deadline)
    r.timeout = Runnable {
      if (rediscover === r) {
        android.util.Log.w("DH-NEARBY", "rediscover timeout $count/$REDISCOVER_MAX peer=$peerName (not found)")
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
    client.stopDiscovery()
    client.startDiscovery(SERVICE_ID, discovery, discoveryOptions()).addOnFailureListener { e -> report("rediscover", e) }
  }

  /**
   * 接続の瞬間だけ省電力を外す(広告・探索は省電力のまま)。lowPower=false なら BLE 以外(Bluetooth Classic / Wi-Fi)も使える。
   * 8007 STATUS_RADIO_ERROR は一時的なことが多いので、間をおいて最大 RETRY_MAX 回まで再試行する。
   * 8003 ALREADY_CONNECTED は残骸の接続を切って繋ぎ直す。JS への失敗通知(onError)は従来どおり各回で出す。
   * 8011 は再試行せず、8007 は再試行が尽きたら、探索からやり直す(startRediscover)。
   * rediscovered は探索をやり直した回数。始めの呼び出し(JS から)は 0 で、全体の期限もそこから数える。
   */
  private fun requestWithRetry(endpointId: String, name: String, attempt: Int, rediscovered: Int = 0, deadline: Long = android.os.SystemClock.elapsedRealtime() + REDISCOVER_TOTAL_MS) {
    val peerName = foundNames[endpointId]
    val o = ConnectionOptions.Builder().setLowPower(false).build()
    client.requestConnection(name, endpointId, lifecycle, o).addOnFailureListener { e ->
      val code = (e as? com.google.android.gms.common.api.ApiException)?.statusCode ?: -1
      android.util.Log.w("DH-NEARBY", "requestConnect attempt=${attempt + 1}/${RETRY_MAX + 1} code=$code")
      report(if (attempt == 0) "requestConnect" else "requestConnect(retry$attempt)", e)
      val retry = (code == 8003 || code == 8007) && attempt < RETRY_MAX
      if (!retry) {
        if (code == 8011 || code == 8007) startRediscover(peerName, name, rediscovered, deadline, code)
        return@addOnFailureListener
      }
      if (code == 8003) client.disconnectFromEndpoint(endpointId)
      mainHandler.postDelayed({
        requestWithRetry(endpointId, name, attempt + 1, rediscovered, deadline)
      }, if (code == 8003) 700L else 1500L)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("NearbyLink")
    Events("onFound", "onLost", "onInitiated", "onConnected", "onFailed", "onDisconnected", "onMessage", "onError")

    // 1対1。待っている間(広告・探索)は省電力(BLE のみ)。接続要求だけ省電力を外す(requestWithRetry)
    Function("advertise") { name: String ->
      // ペアリング中(名前が P| で始まる)だけ省電力を外す。BLE だけだと 8007 で繋がらないことがあり、Bluetooth Classic / Wi-Fi も使えるようにする。終わったら stop() か通常の名前で省電力に戻る
      pairing = name.startsWith("P|")
      android.util.Log.i("DH-NEARBY", "advertise lowPower=${!pairing} name=$name")
      val o = AdvertisingOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).setLowPower(!pairing).build()
      // 停止→再開始で前回の広告が残っていると ALREADY_ADVERTISING になるため、先に止める(同じ client への呼び出しは順序どおり処理される)
      // 前回の接続の残骸(GMS が ALREADY_CONNECTED と思い込む)を一掃してから始める
      client.stopAllEndpoints()
      client.stopAdvertising()
      client.startAdvertising(name, SERVICE_ID, lifecycle, o).addOnFailureListener { e -> report("advertise", e) }
    }
    Function("discover") {
      android.util.Log.i("DH-NEARBY", "discover lowPower=${!pairing}")
      val o = discoveryOptions()
      clearRediscover()
      foundNames.clear()
      client.stopAllEndpoints()
      client.stopDiscovery()
      client.startDiscovery(SERVICE_ID, discovery, o).addOnFailureListener { e -> report("discover", e) }
    }
    Function("requestConnect") { endpointId: String, name: String -> requestWithRetry(endpointId, name, 0) }
    Function("accept") { endpointId: String -> client.acceptConnection(endpointId, payloads) }
    Function("reject") { endpointId: String -> client.rejectConnection(endpointId) }
    Function("send") { endpointId: String, text: String ->
      client.sendPayload(endpointId, Payload.fromBytes(text.toByteArray(Charsets.UTF_8)))
    }
    Function("disconnect") { endpointId: String -> client.disconnectFromEndpoint(endpointId) }
    Function("stop") {
      pairing = false
      clearRediscover()
      foundNames.clear()
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
