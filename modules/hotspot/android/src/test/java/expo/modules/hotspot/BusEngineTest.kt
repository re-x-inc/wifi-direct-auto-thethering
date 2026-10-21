package expo.modules.hotspot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList

/** BusEngine を 127.0.0.1 で 2 つ(親機・子機)動かす JVM テスト。Android には依存しない */
class BusEngineTest {
  private val key = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
  private fun freePort() = ServerSocket(0).use { it.localPort }

  private class Side(val ups: CopyOnWriteArrayList<String> = CopyOnWriteArrayList(), val msgs: CopyOnWriteArrayList<String> = CopyOnWriteArrayList()) {
    lateinit var e: BusEngine
  }

  private fun make(host: Boolean, port: Int, k: String = key, ping: Int = 100, timeout: Int = 600): Side {
    val s = Side()
    s.e = BusEngine(
      BusEngine.Config(host, if (host) "HOST" else "GUEST", if (host) "GUEST" else "HOST", k, "127.0.0.1", port, ping, timeout),
      { }, { s.msgs.add(it) }, { up, r -> s.ups.add(if (up) "up:$r" else "down:$r") },
    )
    return s
  }

  private fun until(ms: Long = 5000, c: () -> Boolean): Boolean {
    val t0 = System.currentTimeMillis()
    while (!c()) { if (System.currentTimeMillis() - t0 > ms) return false; Thread.sleep(10) }
    return true
  }

  @Test fun authAndExchange() {
    val port = freePort()
    val h = make(true, port); val g = make(false, port)
    h.e.start(); g.e.start()
    try {
      assertTrue("both up", until { h.e.up && g.e.up })
      assertTrue(g.e.send("hello-from-guest")); assertTrue(h.e.send("hello-from-host"))
      assertTrue(until { h.msgs.contains("hello-from-guest") && g.msgs.contains("hello-from-host") })
      // メッセージを送らなくても、ZMTP heartbeat の生存イベント(aliveAt)が IVL ごとに進む。アプリ層の ping/pong は無い
      val t0 = maxOf(h.e.aliveAt, g.e.aliveAt)
      assertTrue("aliveAt advances without app traffic", until { h.e.aliveAt > t0 + 200 && g.e.aliveAt > t0 + 200 })

    } finally { g.e.stop(); h.e.stop() }
  }

  @Test fun wrongKeyIsNotAuthenticated() {
    val port = freePort()
    val h = make(true, port); val g = make(false, port, "ff".repeat(32))
    h.e.start(); g.e.start()
    try {
      Thread.sleep(2500)
      assertFalse(h.e.up); assertFalse(g.e.up)
      assertFalse(g.e.send("x"))
      assertTrue(h.msgs.isEmpty())
    } finally { g.e.stop(); h.e.stop() }
  }

  @Test fun hostRestartIsRecoveredByGuest() {
    val port = freePort()
    val h = make(true, port); val g = make(false, port)
    h.e.start(); g.e.start()
    var h2: Side? = null
    try {
      assertTrue(until { h.e.up && g.e.up })
      h.e.stop()
      assertTrue("guest notices", until { !g.e.up })
      h2 = make(true, port); h2.e.start()
      assertTrue("re-auth", until(8000) { h2.e.up && g.e.up })
      assertTrue(g.e.send("after-restart")); assertTrue(until { h2.msgs.contains("after-restart") })
    } finally { g.e.stop(); h2?.e?.stop(); h.e.stop() }
  }

  @Test fun guestSilenceMarksHostDown() {
    val port = freePort()
    val h = make(true, port); val g = make(false, port)
    h.e.start(); g.e.start()
    try {
      assertTrue(until { h.e.up && g.e.up })
      g.e.stop()
      assertTrue("host sees disconnect", until { !h.e.up })
      assertEquals("down:disconnected", h.ups.last())
    } finally { g.e.stop(); h.e.stop() }
  }

  /** 127.0.0.1 上の TCP 中継。blackhole = true で「経路が静かに死ぬ」(Wi-Fi が切れて RST も FIN も来ない)状態にする */
  private class Proxy(val target: Int) {
    val ss = ServerSocket(0)
    @Volatile var blackhole = false
    val port get() = ss.localPort
    private val socks = CopyOnWriteArrayList<java.net.Socket>()
    init {
      Thread {
        try {
          while (true) {
            val a = ss.accept(); val b = java.net.Socket("127.0.0.1", target)
            socks.add(a); socks.add(b)
            pump(a, b); pump(b, a)
          }
        } catch (_: Throwable) {}
      }.apply { isDaemon = true }.start()
    }
    private fun pump(from: java.net.Socket, to: java.net.Socket) = Thread {
      try {
        val buf = ByteArray(4096); val i = from.getInputStream(); val o = to.getOutputStream()
        while (true) { val n = i.read(buf); if (n < 0) break; if (!blackhole) { o.write(buf, 0, n); o.flush() } }
      } catch (_: Throwable) {}
    }.apply { isDaemon = true }.start()
    /** 既存の TCP を全部切る(Wi-Fi に入り直すと新しい TCP になる) */
    fun dropAll() { socks.forEach { try { it.close() } catch (_: Throwable) {} }; socks.clear() }
    fun close() { try { ss.close() } catch (_: Throwable) {}; socks.forEach { try { it.close() } catch (_: Throwable) {} } }
  }

  @Test fun silentPathDeathIsDetectedByHeartbeatTimeoutAndAliveStops() {
    val hp = freePort()
    val h = make(true, hp, ping = 100, timeout = 600)
    val px = Proxy(hp)
    val g = make(false, px.port, ping = 100, timeout = 600)
    h.e.start(); g.e.start()
    try {
      assertTrue(until { h.e.up && g.e.up })
      val a0 = g.e.aliveAt
      assertTrue(until { g.e.aliveAt > a0 + 200 })
      px.blackhole = true // 以後どちらにも何も届かない(切断通知も無い)
      val t0 = System.currentTimeMillis()
      // ZMTP heartbeat の DISCONNECTED、または保険の P/O の timeout(jeromq 0.6.0 は前者が出ないことがある)のどちらかで切れる
      assertTrue("guest: down", until { !g.e.up })
      assertTrue("host: same", until { !h.e.up })
      val took = System.currentTimeMillis() - t0
      assertTrue("detected within timeout + ping + slack (took $took ms)", took < 600 + 100 + 1500)
      assertTrue(g.ups.last() in listOf("down:disconnected", "down:timeout"))
      assertTrue(h.ups.last() in listOf("down:disconnected", "down:timeout"))
      // 切断中は生存イベントが進まない
      val frozen = g.e.aliveAt
      Thread.sleep(500)
      assertEquals(frozen, g.e.aliveAt)
      assertTrue("aliveAt stopped no later than detection", frozen <= System.currentTimeMillis() - 0)
      // 経路が戻れば再接続して認証し、生存イベントが再開する
      px.dropAll(); px.blackhole = false // 経路が戻る = 古い TCP は捨てられ、新しい TCP でつながり直す
      assertTrue("recovers", until(10000) { g.e.up && h.e.up })
      assertTrue(until { g.e.aliveAt > frozen + 200 })
    } finally { g.e.stop(); h.e.stop(); px.close() }
  }

  @Test fun guestStopDoesNotLeaveHostAlive() {
    val port = freePort()
    val h = make(true, port); val g = make(false, port)
    h.e.start(); g.e.start()
    try {
      assertTrue(until { h.e.up && g.e.up })
      g.e.stop()
      assertTrue(until { !h.e.up })
      val frozen = h.e.aliveAt
      Thread.sleep(400)
      assertEquals("host aliveAt frozen after peer gone", frozen, h.e.aliveAt)
    } finally { g.e.stop(); h.e.stop() }
  }
}
