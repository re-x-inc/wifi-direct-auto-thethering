package expo.modules.hotspot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList

/** 偽の SOCKS5 中継(127.0.0.1)に対して ProbeClient を動かす JVM テスト。Android には依存しない */
class ProbeClientTest {
  private fun freePort() = ServerSocket(0).use { it.localPort }

  /** mode: 中継の振る舞い。http は CONNECT 後に返す応答(null = 返さない) */
  private class FakeSocks(
    val user: String = "u", val pass: String = "p",
    val greeting: Boolean = true, val authOk: Boolean = true, val connectRep: Int = 0,
    val http: String? = "HTTP/1.1 204 No Content\r\n\r\n", val closeAfterConnect: Boolean = false,
  ) : AutoCloseable {
    val server = ServerSocket(0)
    val port get() = server.localPort
    val requests = CopyOnWriteArrayList<String>()
    val connects = CopyOnWriteArrayList<String>()
    @Volatile var stopped = false
    private val t = Thread {
      while (!stopped) {
        val c = try { server.accept() } catch (e: Exception) { break }
        Thread { try { handle(c) } catch (_: Exception) {} finally { try { c.close() } catch (_: Exception) {} } }.start()
      }
    }.apply { isDaemon = true; start() }

    private fun readN(i: InputStream, n: Int) = ByteArray(n).also { var o = 0; while (o < n) { val k = i.read(it, o, n - o); if (k < 0) throw java.io.EOFException(); o += k } }

    private fun handle(c: Socket) {
      val i = c.getInputStream(); val o = c.getOutputStream()
      val g = readN(i, 2); readN(i, g[1].toInt())
      if (!greeting) { Thread.sleep(3000); return }
      o.write(byteArrayOf(5, 2)); o.flush()
      readN(i, 1)
      val ul = i.read(); val u = String(readN(i, ul)); val pl = i.read(); val p = String(readN(i, pl))
      val ok = authOk && u == user && p == pass
      o.write(byteArrayOf(1, if (ok) 0 else 1)); o.flush()
      if (!ok) return
      val h = readN(i, 5) // VER CMD RSV ATYP LEN
      val host = String(readN(i, h[4].toInt())); val pt = readN(i, 2)
      connects.add("$host:${((pt[0].toInt() and 0xff) shl 8) or (pt[1].toInt() and 0xff)}")
      o.write(byteArrayOf(5, connectRep.toByte(), 0, 1, 0, 0, 0, 0, 0, 0)); o.flush()
      if (connectRep != 0) return
      if (closeAfterConnect) return
      // 要求(ヘッダーの終わりまで)を記録
      val bo = ByteArrayOutputStream(); var last4 = 0
      while (true) { val b = i.read(); if (b < 0) break; bo.write(b); last4 = (last4 shl 8) or b; if (last4 == 0x0d0a0d0a) break }
      requests.add(bo.toString())
      if (http == null) { Thread.sleep(3000); return }
      o.write(http.toByteArray()); o.flush()
    }
    override fun close() { stopped = true; server.close() }
  }

  private fun target(host: String = "connectivitycheck.example", path: String = "/generate_204") = ProbeClient.Target(host, 80, path)
  private fun one(s: FakeSocks, timeout: Long = 1500, u: String = "u", p: String = "p", t: ProbeClient.Target = target()) =
    ProbeClient.probeOne({ Socket() }, "127.0.0.1", s.port, u, p, t, timeout)

  @Test fun ok204_andRequestIsMinimal() {
    FakeSocks().use { s ->
      val r = one(s)
      assertTrue(r.ok); assertEquals(204, r.http); assertNull(r.reason)
      assertEquals(listOf("connectivitycheck.example:80"), s.connects.toList()) // 名前解決は親機側(ドメイン名のまま CONNECT)
      assertEquals(
        "GET /generate_204 HTTP/1.1\r\nHost: connectivitycheck.example\r\nUser-Agent: ${ProbeClient.USER_AGENT}\r\nConnection: close\r\n\r\n",
        s.requests[0], // 識別子・クッキー・余計なヘッダーは付けない
      )
    }
  }

  @Test fun portal_200_302_511() {
    for (code in listOf("200 OK", "302 Found", "511 Network Authentication Required")) {
      FakeSocks(http = "HTTP/1.1 $code\r\nLocation: http://x/\r\n\r\n<html>").use { s ->
        val r = one(s)
        assertFalse(r.ok); assertEquals("portal", r.reason); assertEquals(code.take(3).toInt(), r.http)
      }
    }
  }

  @Test fun http5xx_andGarbage() {
    FakeSocks(http = "HTTP/1.1 503 Service Unavailable\r\n\r\n").use { assertEquals("http", one(it).reason) }
    FakeSocks(http = "garbage\r\n").use { assertEquals("http", one(it).reason) }
  }

  @Test fun timeoutAfterConnect() {
    FakeSocks(http = null).use { s ->
      val t0 = System.currentTimeMillis()
      val r = one(s, timeout = 400)
      assertEquals("timeout", r.reason)
      assertTrue("budget respected", System.currentTimeMillis() - t0 < 1500)
    }
  }

  @Test fun authFailure() {
    FakeSocks().use { assertEquals("auth", one(it, p = "wrong").reason) }
    FakeSocks(authOk = false).use { assertEquals("auth", one(it).reason) }
  }

  @Test fun relayUnreachableIsLink() {
    val dead = freePort() // 何も待ち受けていない
    val r = ProbeClient.probeOne({ Socket() }, "127.0.0.1", dead, "u", "p", target(), 500)
    assertEquals("link", r.reason)
    FakeSocks(greeting = false).use { assertEquals("link", one(it, timeout = 300).reason) } // あいさつに応答しない
  }

  @Test fun connectReplyCodesAndClosedSession() {
    FakeSocks(connectRep = 4).use { assertEquals("upstream", one(it).reason) }
    FakeSocks(connectRep = 5).use { assertEquals("connect", one(it).reason) }
    FakeSocks(connectRep = 6).use { assertEquals("timeout", one(it).reason) }
    assertEquals("upstream", ProbeClient.reasonForReply(4)); assertEquals("upstream", ProbeClient.reasonForReply(1))
    assertEquals("connect", ProbeClient.reasonForReply(5)); assertEquals("timeout", ProbeClient.reasonForReply(6))
    FakeSocks(closeAfterConnect = true).use { assertEquals("upstream", one(it).reason) }
  }

  @Test fun roundAnyOneSuccess() {
    val bad = FakeSocks(http = "HTTP/1.1 503 x\r\n\r\n")
    bad.use { s ->
      // 1 つ目が 503、2 つ目が 204 → 成功(同じ中継では宛先で応答を変えられないので、1 つ目に portal を返す別サーバで確認)
      assertFalse(ProbeClient.probeRound({ Socket() }, "127.0.0.1", s.port, "u", "p", listOf(target("a.example"), target("b.example")), 800).ok)
      assertEquals(2, s.connects.size) // 全宛先を試した
    }
    FakeSocks().use { s ->
      val r = ProbeClient.probeRound({ Socket() }, "127.0.0.1", s.port, "u", "p", listOf(target("a.example"), target("b.example")), 800)
      assertTrue(r.ok); assertEquals(1, s.connects.size) // 最初が 204 なら次は試さない
    }
  }

  @Test fun roundStopsOnLinkAndAuthAndPrefersPortal() {
    val dead = freePort()
    var tries = 0
    val r = ProbeClient.probeRound({ tries++; Socket() }, "127.0.0.1", dead, "u", "p", listOf(target("a"), target("b")), 300)
    assertEquals("link", r.reason); assertEquals(1, tries) // 同じ中継なので 2 つ目は試さない
    FakeSocks(http = "HTTP/1.1 302 Found\r\n\r\n").use { s ->
      assertEquals("portal", ProbeClient.probeRound({ Socket() }, "127.0.0.1", s.port, "u", "p", listOf(target("a"), target("b")), 800).reason)
    }
  }

  @Test fun noLeakWhenRelayIsAbsent() {
    // 中継に届かなければ、他の経路で成功することはない(宛先は常に中継)
    val dead = freePort()
    assertFalse(ProbeClient.probeRound({ Socket() }, "127.0.0.1", dead, "u", "p", listOf(target()), 300).ok)
  }

  @Test fun parseUrl() {
    assertEquals(ProbeClient.Target("cp.cloudflare.com", 80, "/generate_204"), ProbeClient.parseUrl("http://cp.cloudflare.com/generate_204"))
    assertEquals(ProbeClient.Target("a.example", 8080, "/"), ProbeClient.parseUrl("http://a.example:8080"))
    assertNull(ProbeClient.parseUrl("https://a.example/x"))
    assertNull(ProbeClient.parseUrl("http://a.example/x\r\nX: y"))
    assertNull(ProbeClient.parseUrl("http://user@a.example/"))
    assertNull(ProbeClient.parseUrl("http://a.example:99999/"))
  }
}
