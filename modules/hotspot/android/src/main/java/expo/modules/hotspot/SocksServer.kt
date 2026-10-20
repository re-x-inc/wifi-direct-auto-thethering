package expo.modules.hotspot

import android.net.Network
import android.util.Log
import java.io.DataInputStream
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import javax.net.SocketFactory

/**
 * 最小の SOCKS5 サーバー(CONNECT と UDP ASSOCIATE、ユーザー名/パスワード認証必須)。
 * 接続先への通信は [network](携帯回線)を通す。UDP は、制御用の TCP 接続が続く間だけ中継する。
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
    if (cmd == 3) { udpAssociate(client, out); return }
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

  /**
   * UDP ASSOCIATE。子機は返した UDP ポートへ、SOCKS5 の UDP ヘッダつきでパケットを送る。
   * 外へは1つの UDP ソケット(携帯回線に結びつけ)から出し、戻りのパケットはヘッダを付けて子機へ返す。
   * 制御用の TCP 接続が閉じたら、すべて閉じる(RFC 1928)。
   */
  private fun udpAssociate(client: Socket, out: OutputStream) {
    val clientIp = client.inetAddress
    val inSock = DatagramSocket(0)
    val outSock = DatagramSocket()
    try {
      val net = network()
      if (net != null && !noBind) runCatching { net.bindSocket(outSock) }.onFailure { Log.w("DH-SOCKS", "UDP の結びつけに失敗: $it") }
      val local = (client.localAddress as? Inet4Address)?.address ?: byteArrayOf(0, 0, 0, 0)
      val bp = inSock.localPort
      out.write(byteArrayOf(5, 0, 0, 1) + local + byteArrayOf((bp shr 8).toByte(), bp.toByte()))
      out.flush()
      client.soTimeout = 0

      val clientAddr = java.util.concurrent.atomic.AtomicReference<InetSocketAddress?>(null)

      val up = Thread {
        val buf = ByteArray(65535)
        while (!inSock.isClosed) {
          try {
            val p = DatagramPacket(buf, buf.size)
            inSock.receive(p)
            if (p.address != clientIp) continue // 制御接続を張った子機以外は無視
            clientAddr.set(InetSocketAddress(p.address, p.port))
            val d = p.data; val n = p.length
            if (n < 10 || d[2].toInt() != 0) continue // 断片化は未対応
            var i = 4
            val addr: InetAddress = when (d[3].toInt()) {
              1 -> { val a = InetAddress.getByAddress(d.copyOfRange(i, i + 4)); i += 4; a }
              4 -> { val a = InetAddress.getByAddress(d.copyOfRange(i, i + 16)); i += 16; a }
              3 -> {
                val len = d[i].toInt() and 0xff
                val name = String(d, i + 1, len); i += 1 + len
                runCatching { network()?.getByName(name) ?: InetAddress.getByName(name) }.getOrNull() ?: continue
              }
              else -> continue
            }
            val dport = ((d[i].toInt() and 0xff) shl 8) or (d[i + 1].toInt() and 0xff); i += 2
            outSock.send(DatagramPacket(d, i, n - i, addr, dport))
          } catch (_: Exception) { if (inSock.isClosed) break }
        }
      }
      val down = Thread {
        val buf = ByteArray(65535)
        while (!outSock.isClosed) {
          try {
            val p = DatagramPacket(buf, buf.size)
            outSock.receive(p)
            val to = clientAddr.get() ?: continue
            val ip = p.address.address
            val h = byteArrayOf(0, 0, 0, if (ip.size == 4) 1 else 4) + ip + byteArrayOf((p.port shr 8).toByte(), p.port.toByte())
            val data = h + buf.copyOfRange(p.offset, p.offset + p.length)
            inSock.send(DatagramPacket(data, data.size, to))
          } catch (_: Exception) { if (outSock.isClosed) break }
        }
      }
      up.start(); down.start()
      // 制御用の TCP 接続が閉じるまで待つ
      try { while (client.getInputStream().read() != -1) { /* 読み捨て */ } } catch (_: Exception) {}
    } finally {
      inSock.close(); outSock.close()
    }
  }
}
