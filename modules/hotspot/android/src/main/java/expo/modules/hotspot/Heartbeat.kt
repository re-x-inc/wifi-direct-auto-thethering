package expo.modules.hotspot

import android.content.Context
import android.net.Network
import android.os.PowerManager
import android.os.SystemClock
import java.net.InetSocketAddress
import java.net.Socket

/**
 * 子機のハートビート(親機のエコー 9000 への定期接続)をネイティブで続ける。
 *
 * JS のタイマ(p.sleep)は、アプリが裏に回る・画面オフ・Doze で止まる。このクラスは専用スレッドで動くので JS が止まっても続き、
 * 結果(最後の成功/失敗の時刻・理由・連続失敗回数)をここに保持する。JS は起きたときに [status] を読む。
 * 親機側は変えない: 親機はエコーの accept で最終受信時刻を更新するだけ。
 *
 * 接続は既存の probe と同じ経路(参加した Wi-Fi の Network.socketFactory。VPN が全体を横取りしていても親機に届く)。
 * 接続→"ping" 1 回→応答 1 回→close の短い TCP。時刻は System.currentTimeMillis(JS の Date.now() と同じ時計)。
 */
class Heartbeat(
  private val netProvider: () -> Network?,
  private val emit: (Map<String, Any?>) -> Unit,
) {
  private val lock = Object()
  private var thread: Thread? = null
  private var wakeLock: PowerManager.WakeLock? = null

  // 設定(start で決まる)
  private var host = ""
  private var port = 0
  private var intervalMs = 5_000L
  private var timeoutMs = 3_000L
  private var offIntervalMs = 0L
  private var power: PowerManager? = null

  // 結果(lock の中で読み書き)
  private var running = false
  private var startedAt = 0L
  private var lastAttemptAt = 0L
  private var lastOkAt = 0L
  private var lastFailAt = 0L
  private var lastError: String? = null
  private var lastRttMs = -1L
  private var consecutiveFailures = 0
  private var attempts = 0L
  private var lastOkLog = 0L

  fun start(ctx: Context, host: String, port: Int, intervalMs: Long, timeoutMs: Long, screenOffIntervalMs: Long, useWakeLock: Boolean) {
    stop("restart")
    val pm = ctx.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
    synchronized(lock) {
      this.host = host; this.port = port
      this.intervalMs = intervalMs.coerceIn(500L, 600_000L)
      this.timeoutMs = timeoutMs.coerceIn(500L, 30_000L)
      // 画面オフ中の間隔(0=変えない)。通常より短くはしない
      this.offIntervalMs = if (screenOffIntervalMs > this.intervalMs) screenOffIntervalMs.coerceAtMost(600_000L) else 0L
      this.power = pm
      running = true
      startedAt = System.currentTimeMillis()
      lastAttemptAt = 0; lastOkAt = 0; lastFailAt = 0; lastError = null; lastRttMs = -1; consecutiveFailures = 0; attempts = 0; lastOkLog = 0
    }
    if (useWakeLock) {
      try {
        // 前面サービスの間だけ CPU を眠らせない(ハートビートが動いている間だけ保持する。stop で必ず解放)
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tether:heartbeat").apply { setReferenceCounted(false); acquire() }
      } catch (e: Exception) { DhLog.w(TAG_HB, "wakeLock 取得失敗 ${e.message}") }
    }
    val t = Thread({ loop() }, "dh-heartbeat").apply { isDaemon = true }
    thread = t
    t.start()
    DhLog.i(TAG_HB, "start host=$host port=$port interval=${intervalMs}ms timeout=${timeoutMs}ms screenOffInterval=${offIntervalMs}ms wakeLock=$useWakeLock")
  }

  fun stop(why: String = "stop") {
    val t: Thread?
    synchronized(lock) {
      val was = running
      running = false
      t = thread; thread = null
      lock.notifyAll()
      if (was) DhLog.i(TAG_HB, "stop ($why) attempts=$attempts failures=$consecutiveFailures")
    }
    t?.interrupt()
    try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
    wakeLock = null
  }

  fun status(): Map<String, Any?> = synchronized(lock) { snapshot() }

  private fun snapshot(): Map<String, Any?> = mapOf(
    "running" to running,
    "startedAt" to startedAt,
    "lastAttemptAt" to lastAttemptAt,
    "lastOkAt" to lastOkAt,
    "lastFailAt" to lastFailAt,
    "lastError" to lastError,
    "lastRttMs" to lastRttMs,
    "consecutiveFailures" to consecutiveFailures,
    "attempts" to attempts,
    "intervalMs" to intervalMs,
  )

  private fun currentInterval(): Long {
    val p = power
    return if (offIntervalMs > 0 && p != null && !p.isInteractive) offIntervalMs else intervalMs
  }

  private fun loop() {
    val me = Thread.currentThread()
    while (true) {
      val t0 = System.nanoTime()
      val host: String; val port: Int; val timeout: Long
      synchronized(lock) { if (!running || thread !== me) return; host = this.host; port = this.port; timeout = timeoutMs }
      var err: String? = null
      var rtt = -1L
      try {
        val n = netProvider()
        val s = n?.socketFactory?.createSocket() ?: Socket()
        s.use {
          it.connect(InetSocketAddress(host, port), timeout.toInt())
          it.soTimeout = timeout.toInt()
          it.getOutputStream().write("ping".toByteArray())
          val buf = ByteArray(16)
          val len = it.getInputStream().read(buf)
          if (len > 0 && String(buf, 0, len) == "ping") rtt = (System.nanoTime() - t0) / 1_000_000 else err = "bad echo len=$len"
        }
      } catch (e: InterruptedException) { return
      } catch (e: Exception) { err = e.message ?: e.javaClass.simpleName }
      val now = System.currentTimeMillis()
      val snap: Map<String, Any?>
      synchronized(lock) {
        if (!running || thread !== me) return
        attempts++; lastAttemptAt = now
        if (err == null) {
          val recovered = consecutiveFailures > 0
          lastOkAt = now; lastRttMs = rtt; consecutiveFailures = 0
          val e = SystemClock.elapsedRealtime()
          if (recovered || e - lastOkLog > 30_000L) { DhLog.i(TAG_HB, "ok rtt=${rtt}ms${if (recovered) " (回復)" else " (成功は 30 秒に 1 回だけ記録)"}"); lastOkLog = e }
        } else {
          lastFailAt = now; lastError = err; consecutiveFailures++
          DhLog.w(TAG_HB, "失敗 #$consecutiveFailures: $err (最後の成功から ${if (lastOkAt > 0) now - lastOkAt else -1}ms)")
        }
        snap = snapshot()
      }
      emit(snap)
      // 次の実行まで待つ(stop / 間隔変更で起こされる)。所要時間を差し引いて、周期がずれないようにする
      synchronized(lock) {
        val wait = currentInterval() - (System.nanoTime() - t0) / 1_000_000
        if (wait > 0 && running && thread === me) { try { lock.wait(wait) } catch (e: InterruptedException) { return } }
      }
    }
  }

  companion object { const val TAG_HB = "DH-HB" }
}
