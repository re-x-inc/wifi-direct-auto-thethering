package expo.modules.hotspot

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class SocksReplyTest {
  @Test fun dnsStays4ButIsLoggedAsDns() {
    val f = SocksReply.classify(UnknownHostException("x"), duringDns = true)
    assertEquals(4, f.code); assertEquals("dns", f.kind)
    assertEquals(4, SocksReply.classify(IOException("x"), duringDns = true).code)
  }

  @Test fun refusedIs5() {
    val f = SocksReply.classify(ConnectException("failed to connect: ECONNREFUSED (Connection refused)"), false)
    assertEquals(5, f.code); assertEquals("refused", f.kind)
  }

  @Test fun timeoutIs6() {
    assertEquals(6, SocksReply.classify(SocketTimeoutException("connect timed out"), false).code)
    assertEquals(6, SocksReply.classify(ConnectException("ETIMEDOUT (Connection timed out)"), false).code)
  }

  @Test fun unreachableIs4() {
    assertEquals(4, SocksReply.classify(NoRouteToHostException("x"), false).code)
    assertEquals(4, SocksReply.classify(ConnectException("ENETUNREACH (Network is unreachable)"), false).code)
    assertEquals(4, SocksReply.classify(IOException("other"), false).code)
  }

  @Test fun worstPrefersReachedThenTimeout() {
    assertEquals(5, SocksReply.worst(listOf(4, 6, 5)))
    assertEquals(6, SocksReply.worst(listOf(4, 6)))
    assertEquals(4, SocksReply.worst(listOf(4, 4)))
    assertEquals(4, SocksReply.worst(emptyList()))
  }
}
