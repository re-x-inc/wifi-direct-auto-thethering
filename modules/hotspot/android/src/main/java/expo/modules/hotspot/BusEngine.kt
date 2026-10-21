package expo.modules.hotspot

import org.zeromq.SocketType
import org.zeromq.ZContext
import org.zeromq.ZMQ
import org.zeromq.ZMsg
import java.net.Inet4Address
import java.net.NetworkInterface
import java.security.SecureRandom
import java.util.concurrent.ConcurrentLinkedQueue
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Direct 上の制御メッセージバス(ZeroMQ = jeromq、純 Java)。親機 = ROUTER(bind)、子機 = DEALER(connect)の 1 対 1。
 * Android にも JS にも依存しない(JVM の単体テストで動く)。接続の保持・認証・生存確認はここ(ネイティブのスレッド)で行う。
 *
 * 生存確認 = ZMTP 3.1 の heartbeat(ZMQ_HEARTBEAT_IVL / TIMEOUT / TTL)+ socket monitor(CONNECTED / ACCEPTED / DISCONNECTED)が主。
 *   ZMTP heartbeat は「最後に受けた時刻」を出さない。無応答が TIMEOUT 続けば jeromq が接続を閉じ monitor に DISCONNECTED が出る
 *   (親機の再起動・RST・FIN・多くの無通信は即座に/TIMEOUT 以内にこれで分かる)。
 *   ただし jeromq 0.6.0 の heartbeat timeout は、経路が静かに死んでも発火しないことがある(実測: 両側 heartbeat・IVL100/TIMEOUT600 で
 *   約 6 割の接続が 5 秒以上切れなかった。BusEngineTest / 仕様は docs/GATEWAY_BUS.md)。そこで **背後の保険** として
 *   アプリ層の P/O を残す(送受信とも IVL ごと。判定は TIMEOUT + IVL)。P/O は時刻の取得源でもある。
 *   「生きている」イベントの時刻 aliveAt は、接続中(DISCONNECTED 無し)かつ保険の受信が新しいあいだ IVL ごとに進む。
 *   時刻の保持・max での更新・判定は JS の LinkGovernor が持つ。ここは「生きた/切れた」の事実と、その時刻だけを出す。
 *
 * 線の上(ZMQ の 1 フレーム = UTF-8 文字列。JSON パーサを使わない行形式):
 *   H:<guestId>            子機 → 親機  認証の開始
 *   C:<nS>                 親機 → 子機  チャレンジ(接続ごとの乱数)
 *   A:<nC>:<tagC>          子機 → 親機  tagC = HMAC(K, "c|nS|nC|guestId|hostId")
 *   K:<tagS>               親機 → 子機  tagS = HMAC(K, "s|nS|nC|guestId|hostId")(子機が親機を確認)
 *   R                      親機 → 子機  未認証のフレームを受けた(親機が再起動した等) → 子機は H からやり直す
 *   P / O                  ping / pong(認証後。ZMTP heartbeat の保険。受信で lastRxAt / aliveAt を更新)
 *   M:<payload>            アプリのメッセージ(認証後のみ受け付ける。payload は JS が作る文字列)
 * 鍵 K は JS が「ペアの共有コード」から導いた値(HMAC(secret, "dh-bus/v1"))を hex で受け取る。共有コード自体は渡さない。
 * 再接続は jeromq(RECONNECT_IVL)。heartbeat は pingMs = IVL、timeoutMs = TIMEOUT = TTL。
 * メッセージの到達保証(ack・再送・順序・ttl)は持たない: 切断中に積んだ分は失われうるので、JS 側(BusControl)が持つ。
 */
class BusEngine(
  private val cfg: Config,
  private val log: (String) -> Unit,
  private val onMessage: (String) -> Unit,
  private val onState: (up: Boolean, reason: String) -> Unit,
  private val clock: () -> Long = { System.currentTimeMillis() },
) {
  class Config(
    val host: Boolean,
    val selfId: String,
    val peerId: String,
    /** HMAC の鍵(hex)。共有コードそのものではなく、導出済みの値 */
    val keyHex: String,
    /** 子機: 親機のアドレス。親機: bind するアドレス(null = p2p インターフェースを探す。無ければ全て) */
    val addr: String?,
    val port: Int,
    val pingMs: Int,
    val timeoutMs: Int,
  )

  @Volatile var lastRxAt = 0L; private set
  /** 直近の「生きている」イベントの時刻(epoch ms、0 = まだ無い)。認証済みで接続中のあいだ IVL ごとに進む。切断中は進まない */
  @Volatile var aliveAt = 0L; private set
  /** 直近の切断イベントの時刻(0 = まだ無い) */
  @Volatile var disconnectedAt = 0L; private set
  /** monitor が数えた、いまの TCP 接続の数(親機は子機の再接続の途中で 2 になりうる) */
  @Volatile var connections = 0; private set
  /** heartbeat の timeout などで jeromq が接続を閉じた回数(切断イベントの数) */
  @Volatile var disconnects = 0; private set
  @Volatile var up = false; private set
  @Volatile var connects = 0; private set
  @Volatile var lastError: String? = null; private set
  @Volatile var boundTo: String? = null; private set

  private val outbox = ConcurrentLinkedQueue<String>()
  private val running = java.util.concurrent.atomic.AtomicBoolean(false)
  private var ctx: ZContext? = null
  private var thread: Thread? = null
  private var wakeTx: ZMQ.Socket? = null
  private var monRx: ZMQ.Socket? = null
  private val wakeLock = Any()
  private val rnd = SecureRandom()
  private val hostId get() = if (cfg.host) cfg.selfId else cfg.peerId
  private val guestId get() = if (cfg.host) cfg.peerId else cfg.selfId

  // 親機の認証状態(1 台だけ)
  private var peerIdentity: ByteArray? = null
  private var nS: String? = null
  private var authed = false
  private var failures = 0
  private var failWindowAt = 0L
  private var blockedUntil = 0L

  /** 開始。親機は bind できなければ例外。戻り値は bind 先(ログ用。秘密は含まない) */
  fun start(): String {
    check(running.compareAndSet(false, true)) { "already running" }
    val c = ZContext(1)
    ctx = c
    val wakeRx = c.createSocket(SocketType.PAIR)
    val wakeName = "inproc://bus-wake-${System.identityHashCode(this)}"
    wakeRx.bind(wakeName)
    val tx = c.createSocket(SocketType.PAIR)
    tx.connect(wakeName)
    wakeTx = tx
    val sock = c.createSocket(if (cfg.host) SocketType.ROUTER else SocketType.DEALER)
    val monName = "inproc://bus-mon-${System.identityHashCode(this)}"
    sock.monitor(monName, ZMQ.EVENT_CONNECTED or ZMQ.EVENT_ACCEPTED or ZMQ.EVENT_DISCONNECTED)
    val mon = c.createSocket(SocketType.PAIR)
    mon.connect(monName)
    monRx = mon
    sock.heartbeatIvl = cfg.pingMs
    sock.heartbeatTimeout = cfg.timeoutMs
    sock.heartbeatTtl = cfg.timeoutMs
    sock.linger = 0
    val bound: String
    try {
      if (cfg.host) {
        val ip = cfg.addr ?: findP2pAddress()
        bound = ip ?: "*"
        if (ip == null) log("p2p インターフェースが見つからない: 全インターフェースで待ち受け(認証で守る)")
        sock.setRouterHandover(true) // 子機が再接続したとき、古い接続を捨てて新しい方に切り替える
        sock.bind("tcp://$bound:${cfg.port}")
      } else {
        sock.identity = guestId.toByteArray(Charsets.UTF_8)
        sock.reconnectIVL = 200
        sock.reconnectIVLMax = 3_000
        bound = "${cfg.addr}:${cfg.port}"
        sock.connect("tcp://$bound")
      }
    } catch (e: Throwable) {
      running.set(false)
      c.close()
      ctx = null; wakeTx = null
      throw e
    }
    boundTo = bound
    val t = Thread({ loop(sock, wakeRx, mon) }, "dh-bus")
    t.isDaemon = true
    thread = t
    t.start()
    return bound
  }

  /** 認証済みのときだけ積む(false なら積まない = JS が保留する) */
  fun send(payload: String): Boolean {
    if (!up || !running.get()) return false
    outbox.add("M:$payload")
    wake()
    return true
  }

  fun stop() {
    if (!running.compareAndSet(true, false)) return
    wake()
    try { thread?.join(2000) } catch (_: InterruptedException) {}
    thread = null
    up = false
  }

  private fun wake() {
    synchronized(wakeLock) { try { wakeTx?.send("w", ZMQ.DONTWAIT) } catch (_: Throwable) {} }
  }

  private fun loop(sock: ZMQ.Socket, wakeRx: ZMQ.Socket, mon: ZMQ.Socket) {
    val c = ctx!!
    val poller = c.createPoller(3)
    poller.register(wakeRx, ZMQ.Poller.POLLIN)
    poller.register(sock, ZMQ.Poller.POLLIN)
    poller.register(mon, ZMQ.Poller.POLLIN)
    var lastHiAt = 0L
    var lastPingAt = 0L
    try {
      while (running.get()) {
        poller.poll(250)
        if (poller.pollin(0)) { while (wakeRx.recv(ZMQ.DONTWAIT) != null) { /* drain */ } }
        // 接続イベントを先に処理する(切断 → 再接続 → 新しい H の順に見るため)
        while (true) {
          val ev = ZMQ.Event.recv(mon, ZMQ.DONTWAIT) ?: break
          onMonitor(ev.event, sock)
          lastHiAt = 0
        }
        if (poller.pollin(1)) {
          while (true) {
            val m = ZMsg.recvMsg(sock, ZMQ.DONTWAIT) ?: break
            try { if (cfg.host) onHostFrame(sock, m) else onGuestFrame(sock, m) } finally { m.destroy() }
          }
        }
        val now = clock()
        // 送信キュー
        while (true) {
          val s = outbox.poll() ?: break
          if (up) sendRaw(sock, s)
        }
        // 生存イベント: 認証済みで接続中(heartbeat timeout の切断が無い)なら、IVL ごとに「生きている」を進める
        if (up && connections > 0) {
          if (!cfg.host && now - lastPingAt >= cfg.pingMs) { sendRaw(sock, "P"); lastPingAt = now }
          // 保険: ZMTP が切断を出さなくても、アプリ層の受信が TIMEOUT + IVL 途絶えたら切る
          if (now - lastRxAt > cfg.timeoutMs + cfg.pingMs) setDown("timeout", sock)
          else if (now - aliveAt >= cfg.pingMs) aliveAt = now
        }
        if (!cfg.host && !up && connections > 0 && now - lastHiAt >= 1_000) {
          sendRaw(sock, "H:$guestId"); lastHiAt = now
        }
      }
    } catch (e: Throwable) {
      lastError = e.javaClass.simpleName + ": " + (e.message ?: "")
      log("バスのループが異常終了: $lastError")
    } finally {
      try { poller.close() } catch (_: Throwable) {}
      monRx = null
      val was = up
      up = false
      try { c.close() } catch (_: Throwable) {}
      ctx = null
      if (was) onState(false, "stopped")
    }
  }

  private fun sendRaw(sock: ZMQ.Socket, s: String) {
    val bytes = s.toByteArray(Charsets.UTF_8)
    if (cfg.host) {
      val id = peerIdentity ?: return
      val m = ZMsg()
      m.add(id); m.add(bytes)
      m.send(sock)
    } else {
      sock.send(bytes, ZMQ.DONTWAIT)
    }
  }

  /** socket monitor のイベント。CONNECTED(子機)/ACCEPTED(親機)= 接続が増えた、DISCONNECTED = 切れた(heartbeat timeout を含む) */
  private fun onMonitor(event: Int, sock: ZMQ.Socket) {
    val now = clock()
    when (event) {
      ZMQ.EVENT_CONNECTED, ZMQ.EVENT_ACCEPTED -> { connections++; log("TCP 接続 connections=$connections") }
      ZMQ.EVENT_DISCONNECTED -> {
        connections = maxOf(0, connections - 1); disconnects++; disconnectedAt = now
        log("TCP 切断 connections=$connections disconnects=$disconnects")
        if (connections == 0) setDown("disconnected", sock)
      }
    }
  }

  private fun setUp(reason: String) {
    if (up) return
    up = true; connects++
    lastRxAt = clock(); aliveAt = lastRxAt
    log("バス接続 reason=$reason connects=$connects")
    onState(true, reason)
  }

  private fun setDown(reason: String, sock: ZMQ.Socket?) {
    authed = false
    val was = up
    up = false
    if (was) { log("バス切断 reason=$reason"); onState(false, reason) }
  }

  // ---- 親機 ----
  private fun onHostFrame(sock: ZMQ.Socket, m: ZMsg) {
    if (m.size < 2) return
    val id = m.pop().data
    val s = String(m.pop().data, Charsets.UTF_8)
    val now = clock()
    if (s.startsWith("H:")) {
      if (now < blockedUntil) return
      if (s.substring(2) != guestId) { log("想定外の端末からの接続要求(拒否)"); return }
      peerIdentity = id
      if (authed) { authed = false; if (up) { up = false; onState(false, "reauth") } }
      nS = randomHex(16)
      sendRaw(sock, "C:$nS")
      return
    }
    if (s.startsWith("A:")) {
      if (now < blockedUntil || !id.contentEquals(peerIdentity ?: return)) return
      val parts = s.split(":")
      val ns = nS
      if (parts.size != 3 || ns == null) return
      val want = tag("c", ns, parts[1])
      if (!constantTimeEq(want, parts[2])) {
        if (now - failWindowAt > 60_000) { failWindowAt = now; failures = 0 }
        failures++
        log("認証失敗 ($failures)")
        if (failures >= 5) { blockedUntil = now + 30_000; log("認証失敗が続いたため 30 秒受け付けない") }
        nS = null
        return
      }
      nS = null; authed = true
      sendRaw(sock, "K:" + tag("s", ns, parts[1]))
      setUp("auth")
      return
    }
    if (!authed || !id.contentEquals(peerIdentity ?: return)) {
      // 未認証のフレーム(親機が再起動した後に子機が ping してくる等): やり直しを促す。内容は見ない
      if (peerIdentity != null && id.contentEquals(peerIdentity!!)) sendRaw(sock, "R")
      return
    }
    lastRxAt = now; aliveAt = now
    when {
      s == "P" -> sendRaw(sock, "O")
      s.startsWith("M:") -> onMessage(s.substring(2))
    }
  }

  // ---- 子機 ----
  private var nC: String? = null
  private var sentChallenge: String? = null

  private fun onGuestFrame(sock: ZMQ.Socket, m: ZMsg) {
    val s = String(m.last.data, Charsets.UTF_8)
    when {
      s.startsWith("C:") -> {
        val ns = s.substring(2)
        val nc = randomHex(16)
        nC = nc; sentChallenge = ns
        sendRaw(sock, "A:$nc:" + tag("c", ns, nc))
      }
      s.startsWith("K:") -> {
        val ns = sentChallenge; val nc = nC
        if (ns == null || nc == null) return
        if (!constantTimeEq(tag("s", ns, nc), s.substring(2))) { log("親機の確認に失敗(切断)"); lastError = "server-auth"; nC = null; sentChallenge = null; return }
        nC = null; sentChallenge = null
        setUp("auth")
      }
      s == "R" -> { if (up) setDown("reauth", sock) }
      !up -> {}
      else -> {
        lastRxAt = clock(); aliveAt = lastRxAt
        when {
          s == "P" -> sendRaw(sock, "O")
          s.startsWith("M:") -> onMessage(s.substring(2))
        }
      }
    }
  }

  private fun tag(label: String, ns: String, nc: String): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(hexToBytes(cfg.keyHex), "HmacSHA256"))
    val bytes = mac.doFinal("$label|$ns|$nc|$guestId|$hostId".toByteArray(Charsets.UTF_8))
    return bytes.joinToString("") { "%02x".format(it) }
  }

  private fun randomHex(n: Int): String { val b = ByteArray(n); rnd.nextBytes(b); return b.joinToString("") { "%02x".format(it) } }

  companion object {
    fun hexToBytes(h: String): ByteArray = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    fun constantTimeEq(a: String, b: String): Boolean = java.security.MessageDigest.isEqual(a.toByteArray(), b.toByteArray())

    /** Wi-Fi Direct のグループのインターフェース(p2p-*)の IPv4。無ければ null */
    fun findP2pAddress(): String? {
      try {
        for (ni in NetworkInterface.getNetworkInterfaces()) {
          if (!ni.name.startsWith("p2p") || !ni.isUp) continue
          for (a in ni.inetAddresses) if (a is Inet4Address && !a.isLoopbackAddress) return a.hostAddress
        }
      } catch (_: Throwable) {}
      return null
    }
  }
}
