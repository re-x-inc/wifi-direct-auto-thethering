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
      // ping/pong が lastRxAt を進める(メッセージを送らなくても)
      val t0 = h.e.lastRxAt
      assertTrue("lastRxAt advances by ping", until { h.e.lastRxAt > t0 + 200 && g.e.lastRxAt > t0 })
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
      assertTrue("host sees timeout", until { !h.e.up })
      assertEquals("down:timeout", h.ups.last())
    } finally { g.e.stop(); h.e.stop() }
  }
}
