package expo.modules.hotspot

import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException

/**
 * 外形監視の 1 回分: 親機の中継(SOCKS5)へつなぎ、ドメイン名つき CONNECT → 平文 HTTP/1.1 の generate_204 を 1 回出して、
 * 結果を分類する(docs/EXTERNAL_PROBE.md §3)。Android に依存しない(JVM 単体テストで偽 SOCKS サーバに対して動かす)。
 *
 * 経路の安全: TCP の宛先は常に親機の中継(socks)。そこに届かなければ失敗するだけで、別の経路(子機自身の回線)に漏れて成功することはない。
 * 送るのは「リクエスト行 + Host + 固定の User-Agent + Connection: close」だけ。端末識別子・クッキーは付けず、応答本文は読まない。
 */
object ProbeClient {
  data class Target(val host: String, val port: Int, val path: String)
  data class Result(val ok: Boolean, val reason: String?, val http: Int, val rttMs: Long)

  const val USER_AGENT = "Mozilla/5.0 (Linux; Android)"
  private val URL_RE = Regex("""^http://([A-Za-z0-9]([A-Za-z0-9.-]{0,120}[A-Za-z0-9])?)(?::(\d{1,5}))?(/[\x21-\x7e]{0,150})?$""")

  /** 平文 http の URL だけ受ける(ヘッダー注入を避けるため文字も制限)。不正は null */
  fun parseUrl(url: String): Target? {
    if (url.length > 200) return null
    val m = URL_RE.matchEntire(url) ?: return null
    val port = m.groupValues[3].ifEmpty { "80" }.toInt()
    if (port !in 1..65535) return null
    return Target(m.groupValues[1], port, m.groupValues[4].ifEmpty { "/" })
  }

  private enum class Stage { LINK, AUTH, CONNECT, HTTP }

  /** 1 宛先。newSocket は参加した Wi-Fi の Network.socketFactory で作ったソケットを返す(テストでは素のソケット) */
  fun probeOne(newSocket: () -> Socket, socksHost: String, socksPort: Int, user: String, pass: String, t: Target, timeoutMs: Long): Result {
    val t0 = System.nanoTime()
    val deadline = t0 + timeoutMs * 1_000_000
    fun rtt() = (System.nanoTime() - t0) / 1_000_000
    fun fail(reason: String, http: Int = 0) = Result(false, reason, http, rtt())
    val s = try { newSocket() } catch (e: Exception) { return fail("link") }
    var stage = Stage.LINK
    return try {
      s.use {
        it.connect(InetSocketAddress(socksHost, socksPort), timeoutMs.toInt().coerceAtLeast(1))
        fun arm() {
          val rem = (deadline - System.nanoTime()) / 1_000_000
          if (rem <= 0) throw SocketTimeoutException("deadline")
          it.soTimeout = rem.toInt()
        }
        val out = it.getOutputStream(); val inp = it.getInputStream()
        // ① あいさつ(ユーザー名/パスワード認証だけ)
        arm(); out.write(byteArrayOf(5, 1, 2)); out.flush()
        val g = readN(inp, 2)
        if (g[0].toInt() != 5) return fail("link")
        if (g[1].toInt() != 2) return fail("auth")
        // ② 認証(RFC 1929)
        stage = Stage.AUTH
        val u = user.toByteArray(); val p = pass.toByteArray()
        if (u.size > 255 || p.size > 255) return fail("auth")
        arm(); out.write(byteArrayOf(1, u.size.toByte()) + u + byteArrayOf(p.size.toByte()) + p); out.flush()
        val a = readN(inp, 2)
        if (a[1].toInt() != 0) return fail("auth")
        // ③ CONNECT(ドメイン名つき。名前解決は親機側)
        stage = Stage.CONNECT
        val h = t.host.toByteArray()
        arm()
        out.write(byteArrayOf(5, 1, 0, 3, h.size.toByte()) + h + byteArrayOf((t.port shr 8).toByte(), t.port.toByte())); out.flush()
        val r = readN(inp, 4)
        val rep = r[1].toInt() and 0xff
        if (rep != 0) return fail(reasonForReply(rep))
        readN(inp, when (r[3].toInt()) { 1 -> 4 + 2; 4 -> 16 + 2; 3 -> (readN(inp, 1)[0].toInt() and 0xff) + 2; else -> return fail("upstream") })
        // ④ HTTP
        stage = Stage.HTTP
        arm(); writeRequest(out, t)
        val code = readStatus(inp, ::arm)
        when {
          code == 204 -> Result(true, null, 204, rtt())
          code in 200..399 || code == 511 -> fail("portal", code) // 204 以外の 2xx/3xx/511 = 案内ページなどの可能性
          code > 0 -> fail("http", code)
          else -> fail("http")
        }
      }
    } catch (e: SocketTimeoutException) {
      fail(if (stage == Stage.CONNECT || stage == Stage.HTTP) "timeout" else "link")
    } catch (e: Exception) {
      fail(when (stage) { Stage.LINK, Stage.AUTH -> "link"; else -> "upstream" }) // 中継に届かない/途中で切れた
    }
  }

  /** 親機の SOCKS5 失敗応答コード → 理由。4(DNS 失敗・到達不能。古い親機は常にこれ)は upstream、5(接続拒否)は connect、6(時間切れ)は timeout */
  fun reasonForReply(rep: Int): String = when (rep) { 5 -> "connect"; 6 -> "timeout"; else -> "upstream" }

  /** 宛先を順に試し、どれか 1 つが 204 なら成功。中継に届かない(link)・認証失敗(auth)は同じ中継なので打ち切る */
  fun probeRound(newSocket: () -> Socket, socksHost: String, socksPort: Int, user: String, pass: String, targets: List<Target>, timeoutMs: Long): Result {
    var worst: Result? = null
    for (t in targets) {
      val r = probeOne(newSocket, socksHost, socksPort, user, pass, t, timeoutMs)
      if (r.ok) return r
      if (r.reason == "link" || r.reason == "auth") return r
      if (worst == null || rank(r.reason) > rank(worst.reason)) worst = r
    }
    return worst ?: Result(false, "http", 0, 0)
  }

  // 全部失敗したときに報告する分類の優先(portal がいちばん手がかりになる)
  private fun rank(r: String?) = listOf("upstream", "connect", "timeout", "http", "tls", "portal").indexOf(r)

  private fun writeRequest(out: OutputStream, t: Target) {
    val hostHdr = if (t.port == 80) t.host else "${t.host}:${t.port}"
    out.write("GET ${t.path} HTTP/1.1\r\nHost: $hostHdr\r\nUser-Agent: $USER_AGENT\r\nConnection: close\r\n\r\n".toByteArray())
    out.flush()
  }

  private fun readN(inp: InputStream, n: Int): ByteArray {
    val b = ByteArray(n); var o = 0
    while (o < n) { val k = inp.read(b, o, n - o); if (k < 0) throw EOFException(); o += k }
    return b
  }

  /** ステータス行だけ読む(最大 256 バイト。本文・ヘッダーの残りは読まない)。解釈できなければ 0 */
  private fun readStatus(inp: InputStream, arm: () -> Unit): Int {
    val sb = StringBuilder()
    while (sb.length < 256) {
      arm()
      val c = inp.read()
      if (c < 0) { if (sb.isEmpty()) throw EOFException(); break } // 何も返さず切れた = 先で切れた(upstream)
      if (c == '\n'.code) break
      sb.append(c.toChar())
    }
    val m = Regex("""^HTTP/1\.[01] (\d{3})""").find(sb.toString()) ?: return 0
    return m.groupValues[1].toInt()
  }
}
