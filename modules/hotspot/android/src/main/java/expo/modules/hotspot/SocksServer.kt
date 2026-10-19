package expo.modules.hotspot

import android.net.Network
import android.util.Log
import java.io.DataInputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import javax.net.SocketFactory

/**
 * 最小の SOCKS5 サーバー(CONNECT のみ、ユーザー名/パスワード認証必須)。
 * 接続先への通信は [network](携帯回線)を通す。UDP ASSOCIATE は未対応(M3 で追加)。
 */
class SocksServer(
  private val port: Int,
  private val user: String,
  private val pass: String,
  private val network: () -> Network?,
) {
  private var server: ServerSocket? = null
  /** 直近の接続失敗の理由(自己診断で表示する) */
  @Volatile var lastError: String? = null

  fun start() {
    val s = ServerSocket()
    s.reuseAddress = true
    s.bind(InetSocketAddress(port))
    server = s
    Thread {
      while (!s.isClosed) {
        try {
          val c = s.accept()
          Thread { runCatching { handle(c) } }.start()
        } catch (_: Exception) { break }
      }
    }.start()
  }

  fun stop() { server?.close(); server = null }

  private fun handle(client: Socket) = client.use {
    client.soTimeout = 30_000
    val inp = DataInputStream(client.getInputStream())
    val out = client.getOutputStream()

    if (inp.readUnsignedByte() != 5) return
    val methods = ByteArray(inp.readUnsignedByte()).also { inp.readFully(it) }
    if (!methods.contains(2.toByte())) { out.write(byteArrayOf(5, -1)); return }
    out.write(byteArrayOf(5, 2))

    if (inp.readUnsignedByte() != 1) return
    val u = ByteArray(inp.readUnsignedByte()).also { inp.readFully(it) }
    val p = ByteArray(inp.readUnsignedByte()).also { inp.readFully(it) }
    val ok = String(u) == user && String(p) == pass
    out.write(byteArrayOf(1, if (ok) 0 else 1))
    if (!ok) return

    inp.readUnsignedByte() // VER
    val cmd = inp.readUnsignedByte()
    inp.readUnsignedByte() // RSV
    val host = when (inp.readUnsignedByte()) {
      1 -> InetAddress.getByAddress(ByteArray(4).also { inp.readFully(it) }).hostAddress!!
      3 -> String(ByteArray(inp.readUnsignedByte()).also { inp.readFully(it) })
      4 -> InetAddress.getByAddress(ByteArray(16).also { inp.readFully(it) }).hostAddress!!
      else -> { reply(out, 8); return }
    }
    val dport = inp.readUnsignedShort()
    if (cmd != 1) { reply(out, 7); return }

    val remote = connect(host, dport)
    if (remote == null) { reply(out, 4); return }
    reply(out, 0)
    client.soTimeout = 0
    remote.use { relay(client, remote) }
  }

  /** 回線指定への結びつけが拒否された(別の VPN などが動いている)場合は、以後は既定の経路を使う */
  @Volatile private var noBind = false

  private fun connect(host: String, port: Int): Socket? {
    if (!noBind) {
      val s = tryConnect(network(), host, port)
      if (s != null) return s
      if (lastError?.contains("EPERM") != true) return null
      noBind = true
      Log.w("DH-SOCKS", "回線への結びつけが拒否されたため、既定の経路に切り替えます")
    }
    return tryConnect(null, host, port)
  }

  private fun tryConnect(net: Network?, host: String, port: Int): Socket? {
    val via = if (net != null) "network=$net" else "default"
    val addrs = try { net?.getAllByName(host) ?: InetAddress.getAllByName(host) } catch (e: Exception) {
      lastError = "dns($via): ${e.javaClass.simpleName}: ${e.message}"; Log.w("DH-SOCKS", lastError!!); return null
    }
    val factory = net?.socketFactory ?: SocketFactory.getDefault()
    for (a in addrs) {
      try {
        val s = factory.createSocket()
        s.connect(InetSocketAddress(a, port), 10_000)
        lastError = null
        return s
      } catch (e: Exception) {
        lastError = "connect($via) ${a.hostAddress}:$port: ${e.javaClass.simpleName}: ${e.message}"; Log.w("DH-SOCKS", lastError!!)
      }
    }
    return null
  }

  private fun reply(out: OutputStream, code: Int) {
    out.write(byteArrayOf(5, code.toByte(), 0, 1, 0, 0, 0, 0, 0, 0))
    out.flush()
  }

  private fun relay(a: Socket, b: Socket) {
    val t = Thread { runCatching { a.getInputStream().copyTo(b.getOutputStream()) }; runCatching { b.shutdownOutput() } }
    t.start()
    runCatching { b.getInputStream().copyTo(a.getOutputStream()) }
    runCatching { a.shutdownOutput() }
    t.join(2000)
  }
}
