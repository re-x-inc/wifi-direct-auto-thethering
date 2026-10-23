package expo.modules.hotspot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareLocksTest {
  private class Fake(val failRelease: Boolean = false, val failAcquire: Boolean = false) : ShareLocks.Held {
    var acquired = 0; var released = 0
    override fun acquire() { if (failAcquire) throw IllegalStateException("x"); acquired++ }
    override fun release() { released++; if (failRelease) throw IllegalStateException("x") }
  }

  @Test fun noDoubleAcquireAndIdempotentStop() {
    val a = Fake(); val b = Fake(); var made = 0
    val l = ShareLocks { made++; listOf(a, b) }
    l.start(); l.start()
    assertEquals(1, made); assertEquals(1, a.acquired); assertEquals(1, b.acquired); assertTrue(l.active)
    l.stop(); l.stop()
    assertEquals(1, a.released); assertEquals(1, b.released); assertFalse(l.active)
  }

  @Test fun releasesAllEvenIfOneThrows() {
    val a = Fake(failRelease = true); val b = Fake()
    val l = ShareLocks { listOf(a, b) }
    l.start(); l.stop()
    assertEquals(1, a.released); assertEquals(1, b.released)
  }

  @Test fun failedAcquireIsNotReleasedAndCanRestart() {
    val a = Fake(failAcquire = true); val b = Fake()
    val l = ShareLocks { listOf(a, b) }
    l.start(); l.stop()
    assertEquals(0, a.released); assertEquals(1, b.released)
    l.start(); l.stop()
    assertEquals(2, b.acquired); assertEquals(2, b.released)
  }

  @Test fun factoryFailureLeavesInactive() {
    val l = ShareLocks { throw IllegalStateException("no service") }
    l.start(); assertFalse(l.active); l.stop()
  }
}
