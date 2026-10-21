package expo.modules.hotspot

import android.content.Context
import android.net.Network
import android.os.PowerManager
import android.os.SystemClock
import java.net.Socket

/**
 * 外形監視の供給元(ProbeRunner)。子機のネイティブで、親機の中継経由のインターネット到達を定期的に確かめる。
 * tether のコアはこれを知らない: JS の src/api/internetProbe.ts が結果を update(success, at, reason) に渡す(使わない選択もできる)。
 *
 * Heartbeat と同じ作り: 専用スレッド(dh-probe)、PARTIAL_WAKE_LOCK(tether:probe。setReferenceCounted(false)、stop で必ず解放)、
 * 参加した Wi-Fi の Network.socketFactory。**start の直後に最初の 1 周をすぐ実行**し、以後は間隔ごと、失敗の直後は確認間隔
 * (連続失敗が failThreshold に達するまで)。画面オフ中は screenOffIntervalMs。時刻は System.currentTimeMillis(JS の Date.now() と同じ)。
 */
class ExternalProbe(
  private val netProvider: () -> Network?,
  private val emit: (Map<String, Any?>) -> Unit,
) {
  private val lock = Object()
  private var thread: Thread? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var power: PowerManager? = null

  private var socksHost = ""; private var socksPort = 0; private var user = ""; private var pass = ""
  private var targets: List<ProbeClient.Target> = emptyList()
  private var intervalMs = 60_000L; private var offIntervalMs = 0L; private var confirmMs = 10_000L; private var timeoutMs = 5_000L
  private var failThreshold = 3

  private var running = false
  private var attempts = 0L
  private var lastAttemptAt = 0L; private var lastOkAt = 0L; private var lastFailAt = 0L
  private var lastReason: String? = null; private var lastRttMs = -1L; private var lastHttp = 0
  private var consecutiveFailures = 0
  private var failStreak = 0 // link を含む連続失敗(間隔の選択用)
  private var lastOkLog = 0L

  fun start(ctx: Context, o: Config) {
    stop("restart")
    val parsed = o.urls.mapNotNull { ProbeClient.parseUrl(it) }
    if (parsed.isEmpty()) { DhLog.w(TAG, "宛先が不正のため開始しない"); return }
    val pm = ctx.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
    synchronized(lock) {
      socksHost = o.socksHost; socksPort = o.socksPort; user = o.user; pass = o.pass; targets = parsed
      intervalMs = o.intervalMs.coerceIn(1_000L, 600_000L)
      offIntervalMs = if (o.screenOffIntervalMs > intervalMs) o.screenOffIntervalMs.coerceAtMost(600_000L) else 0L
      confirmMs = o.confirmIntervalMs.coerceIn(500L, intervalMs)
      timeoutMs = o.timeoutMs.coerceIn(500L, 15_000L)
      failThreshold = o.failThreshold.coerceIn(1, 10)
      power = pm; running = true
      attempts = 0; lastAttemptAt = 0; lastOkAt = 0; lastFailAt = 0; lastReason = null; lastRttMs = -1; lastHttp = 0; consecutiveFailures = 0; failStreak = 0; lastOkLog = 0
    }
    if (o.wakeLock) {
      try { wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tether:probe").apply { setReferenceCounted(false); acquire() } }
      catch (e: Exception) { DhLog.w(TAG, "wakeLock 取得失敗 ${e.message}") }
    }
    val t = Thread({ loop() }, "dh-probe").apply { isDaemon = true }
    thread = t; t.start()
    DhLog.i(TAG, "start interval=${intervalMs}ms confirm=${confirmMs}ms offInterval=${offIntervalMs}ms timeout=${timeoutMs}ms targets=${parsed.size} failThreshold=$failThreshold wakeLock=${o.wakeLock}")
  }

  fun stop(why: String = "stop") {
    val t: Thread?
    synchronized(lock) {
      val was = running
      running = false; t = thread; thread = null
      lock.notifyAll()
      if (was) DhLog.i(TAG, "stop ($why) attempts=$attempts failures=$consecutiveFailures")
    }
    t?.interrupt()
    try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
    wakeLock = null
  }

  fun status(): Map<String, Any?> = synchronized(lock) { snapshot() }

  private fun snapshot(): Map<String, Any?> = mapOf(
    "running" to running, "attempts" to attempts, "lastAttemptAt" to lastAttemptAt, "lastOkAt" to lastOkAt, "lastFailAt" to lastFailAt,
    "lastReason" to lastReason, "lastRttMs" to lastRttMs, "lastHttp" to lastHttp, "consecutiveFailures" to consecutiveFailures,
  )

  private fun nextWait(): Long {
    val p = power
    val normal = if (offIntervalMs > 0 && p != null && !p.isInteractive) offIntervalMs else intervalMs
    // 失敗の直後は確認間隔(ng になるまでの検知を早める)。ng 後は通常の間隔に戻して続ける
    return if (failStreak in 1 until failThreshold) confirmMs else normal
  }

  private fun loop() {
    val me = Thread.currentThread()
    while (true) { // 最初の 1 周は待たずにすぐ実行する
      val t0 = System.nanoTime()
      val h: String; val po: Int; val u: String; val pw: String; val ts: List<ProbeClient.Target>; val to: Long
      synchronized(lock) { if (!running || thread !== me) return; h = socksHost; po = socksPort; u = user; pw = pass; ts = targets; to = timeoutMs }
      val res = try {
        ProbeClient.probeRound({ netProvider()?.socketFactory?.createSocket() ?: Socket() }, h, po, u, pw, ts, to)
      } catch (e: InterruptedException) { return } catch (e: Exception) { ProbeClient.Result(false, "link", 0, 0) }
      val now = System.currentTimeMillis()
      val snap: Map<String, Any?>
      synchronized(lock) {
        if (!running || thread !== me) return
        attempts++; lastAttemptAt = now; lastRttMs = res.rttMs; lastHttp = res.http
        if (res.ok) {
          val recovered = failStreak > 0
          lastOkAt = now; lastReason = null; consecutiveFailures = 0; failStreak = 0
          val e = SystemClock.elapsedRealtime()
          if (recovered || e - lastOkLog > 30_000L) { DhLog.i(TAG, "ok rtt=${res.rttMs}ms${if (recovered) " (回復)" else " (成功は 30 秒に 1 回だけ記録)"}"); lastOkLog = e }
        } else {
          lastFailAt = now; lastReason = res.reason; failStreak++
          // 親機の中継に届かない(link)は外形監視の失敗には数えない(Direct 側の問題)
          consecutiveFailures = if (res.reason == "link") 0 else consecutiveFailures + 1
          DhLog.w(TAG, "失敗 #$failStreak reason=${res.reason} http=${res.http} rtt=${res.rttMs}ms (最後の成功から ${if (lastOkAt > 0) now - lastOkAt else -1}ms)")
        }
        snap = snapshot()
      }
      emit(snap)
      synchronized(lock) {
        val wait = nextWait() - (System.nanoTime() - t0) / 1_000_000
        if (wait > 0 && running && thread === me) { try { lock.wait(wait) } catch (e: InterruptedException) { return } }
      }
    }
  }

  data class Config(
    val socksHost: String, val socksPort: Int, val user: String, val pass: String, val urls: List<String>,
    val intervalMs: Long, val screenOffIntervalMs: Long, val confirmIntervalMs: Long, val timeoutMs: Long, val failThreshold: Int, val wakeLock: Boolean,
  )

  companion object { const val TAG = "DH-PROBE" }
}
