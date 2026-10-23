package expo.modules.hotspot

import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * 親機の SOCKS5 失敗応答コード(RFC 1928)の決め方。例外から応答コードとログ用の分類を出すだけの純粋なロジック。
 * DNS 失敗は従来どおり 4(host unreachable)のまま(古い子機は 4 しか知らない)。ログ上は dns と区別する。
 */
object SocksReply {
  const val HOST_UNREACHABLE = 4
  const val REFUSED = 5
  const val TTL_EXPIRED = 6 // タイムアウトに使う

  data class Failure(val code: Int, val kind: String)

  fun classify(e: Throwable, duringDns: Boolean): Failure = when {
    duringDns || e is UnknownHostException -> Failure(HOST_UNREACHABLE, "dns")
    e is SocketTimeoutException -> Failure(TTL_EXPIRED, "timeout")
    e is NoRouteToHostException -> Failure(HOST_UNREACHABLE, "unreachable")
    e is ConnectException -> {
      val m = (e.message ?: "").lowercase()
      when {
        "refused" in m || "econnrefused" in m -> Failure(REFUSED, "refused")
        "timed out" in m || "etimedout" in m -> Failure(TTL_EXPIRED, "timeout")
        else -> Failure(HOST_UNREACHABLE, "unreachable") // ENETUNREACH / EHOSTUNREACH など
      }
    }
    else -> Failure(HOST_UNREACHABLE, "unreachable")
  }

  /** 宛先が複数のアドレスを持つとき、全部失敗した場合に返すコード。相手に届いた(5)>時間切れ(6)>届かない(4) */
  fun worst(codes: List<Int>): Int = when {
    codes.contains(REFUSED) -> REFUSED
    codes.contains(TTL_EXPIRED) -> TTL_EXPIRED
    else -> HOST_UNREACHABLE
  }
}
