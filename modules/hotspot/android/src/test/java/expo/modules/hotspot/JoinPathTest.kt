package expo.modules.hotspot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JoinPathTest {
  @Test fun pathBySdk() {
    assertEquals(JoinPath.Path.LEGACY, JoinPath.pathFor(28))
    assertEquals(JoinPath.Path.LEGACY, JoinPath.pathFor(26))
    assertEquals(JoinPath.Path.MODERN, JoinPath.pathFor(29))
    assertEquals(JoinPath.Path.MODERN, JoinPath.pathFor(36))
  }

  @Test fun quoting() {
    assertEquals("\"DIRECT-ab-X\"", JoinPath.quote("DIRECT-ab-X"))
    assertEquals("\"password1\"", JoinPath.psk("password1"))
    val hex = "a".repeat(64)
    assertEquals(hex, JoinPath.psk(hex))
  }

  @Test fun passphrase() {
    assertFalse(JoinPath.validPassphrase("short"))
    assertTrue(JoinPath.validPassphrase("12345678"))
    assertTrue(JoinPath.validPassphrase("x".repeat(63)))
    assertFalse(JoinPath.validPassphrase("x".repeat(64)))
    assertTrue(JoinPath.validPassphrase("0123456789abcdefABCDEF".padEnd(64, '0')))
  }

  @Test fun ownership() {
    assertTrue(JoinPath.isOurs(5, 5))
    assertFalse(JoinPath.isOurs(-1, -1))
    assertFalse(JoinPath.isOurs(4, 5))
    assertTrue(JoinPath.shouldRestore(3, 5))
    assertFalse(JoinPath.shouldRestore(-1, 5))
    assertFalse(JoinPath.shouldRestore(5, 5))
  }
}
