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

  /** 開始系の失敗を握りつぶさず、コード付きでログと JS に伝える */
  private fun report(op: String, e: Exception) {
    val code = (e as? com.google.android.gms.common.api.ApiException)?.statusCode ?: -1
    android.util.Log.w("DH-NEARBY", "$op failed code=$code ${com.google.android.gms.nearby.connection.ConnectionsStatusCodes.getStatusCodeString(code)} $e")
    sendEvent("onError", mapOf("op" to op, "code" to code))
  }

  private val discovery = object : EndpointDiscoveryCallback() {
    override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
      sendEvent("onFound", mapOf("endpointId" to endpointId, "name" to info.endpointName))
    }
    override fun onEndpointLost(endpointId: String) {
      sendEvent("onLost", mapOf("endpointId" to endpointId))
    }
  }

  override fun definition() = ModuleDefinition {
    Name("NearbyLink")
    Events("onFound", "onLost", "onInitiated", "onConnected", "onFailed", "onDisconnected", "onMessage", "onError")

    // 1対1。制御用の小さなデータだけなので省電力(Bluetooth のみ)に固定し、Wi-Fi 共有(ホットスポット/Wi-Fi Direct)と無線を取り合わない
    Function("advertise") { name: String ->
      val o = AdvertisingOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).setLowPower(true).build()
      // 停止→再開始で前回の広告が残っていると ALREADY_ADVERTISING になるため、先に止める(同じ client への呼び出しは順序どおり処理される)
      // 前回の接続の残骸(GMS が ALREADY_CONNECTED と思い込む)を一掃してから始める
      client.stopAllEndpoints()
      client.stopAdvertising()
      client.startAdvertising(name, SERVICE_ID, lifecycle, o).addOnFailureListener { e -> report("advertise", e) }
    }
    Function("discover") {
      val o = DiscoveryOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT).setLowPower(true).build()
      client.stopAllEndpoints()
      client.stopDiscovery()
      client.startDiscovery(SERVICE_ID, discovery, o).addOnFailureListener { e -> report("discover", e) }
    }
    Function("requestConnect") { endpointId: String, name: String ->
      client.requestConnection(name, endpointId, lifecycle, ConnectionOptions.Builder().setLowPower(true).build())
        .addOnFailureListener { e ->
          report("requestConnect", e)
          // 8003 ALREADY_CONNECTED_TO_ENDPOINT: 残骸の接続を切ってから、一度だけ繋ぎ直す
          if ((e as? com.google.android.gms.common.api.ApiException)?.statusCode == 8003) {
            client.disconnectFromEndpoint(endpointId)
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
              client.requestConnection(name, endpointId, lifecycle, ConnectionOptions.Builder().setLowPower(true).build())
                .addOnFailureListener { e2 -> report("requestConnect(retry)", e2) }
            }, 700)
          }
        }
    }
    Function("accept") { endpointId: String -> client.acceptConnection(endpointId, payloads) }
    Function("reject") { endpointId: String -> client.rejectConnection(endpointId) }
    Function("send") { endpointId: String, text: String ->
      client.sendPayload(endpointId, Payload.fromBytes(text.toByteArray(Charsets.UTF_8)))
    }
    Function("disconnect") { endpointId: String -> client.disconnectFromEndpoint(endpointId) }
    Function("stop") {
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
