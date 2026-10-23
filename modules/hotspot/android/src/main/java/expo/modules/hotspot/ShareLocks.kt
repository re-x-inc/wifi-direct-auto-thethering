package expo.modules.hotspot

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager

/**
 * 親機が共有(SOCKS 中継と Direct/テザリングのグループ)を提供している間だけ、CPU(PARTIAL WakeLock)と Wi-Fi(WifiLock)を起こしておく。
 * [start] は二重に取らない。[stop] は何度呼んでもよく、個々の解放で例外が出ても残りを必ず解放する。
 * 時間切れの自動解放(acquire の timeout)は付けない: 解放は共有の停止とモジュールの破棄(onDestroy)の両方で行う。
 */
class ShareLocks(private val log: (warn: Boolean, msg: String) -> Unit = { _, _ -> }, private val make: () -> List<Held>) {
  /** 取得・解放できる 1 つのロック(テストでは差し替える) */
  interface Held { fun acquire(); fun release() }

  private val lock = Any()
  private var held: List<Held> = emptyList()
  private var on = false

  val active: Boolean get() = synchronized(lock) { on }

  fun start() {
    synchronized(lock) {
      if (on) return
      val made = try { make() } catch (e: Throwable) { log(true, "ロックの用意に失敗 ${e.javaClass.simpleName}"); return }
      val got = ArrayList<Held>()
      for (h in made) {
        try { h.acquire(); got.add(h) } catch (e: Throwable) { log(true, "ロック取得失敗 ${e.javaClass.simpleName}") }
      }
      held = got; on = got.isNotEmpty()
      log(false, "start locks=${got.size}")
    }
  }

  fun stop() {
    synchronized(lock) {
      if (!on) return
      val hs = held
      held = emptyList(); on = false
      for (h in hs) { try { h.release() } catch (e: Throwable) { log(true, "ロック解放失敗 ${e.javaClass.simpleName}") } }
      log(false, "stop locks=${hs.size}")
    }
  }

  companion object {
    private const val TAG = "DH-LOCKS"

    /** WifiLock のモード: API 29 以上は低遅延、それ未満は高性能 */
    fun wifiMode(sdk: Int): Int = if (sdk >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF

    fun android(ctx: Context): ShareLocks = ShareLocks({ w, m -> if (w) DhLog.w(TAG, m) else DhLog.i(TAG, m) }) {
      val app = ctx.applicationContext
      val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
      val wm = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
      val wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tether:share").apply { setReferenceCounted(false) }
      val wifi = wm.createWifiLock(wifiMode(Build.VERSION.SDK_INT), "tether:share").apply { setReferenceCounted(false) }
      listOf(
        object : Held { override fun acquire() = wake.acquire(); override fun release() { if (wake.isHeld) wake.release() } },
        object : Held { override fun acquire() = wifi.acquire(); override fun release() { if (wifi.isHeld) wifi.release() } },
      )
    }
  }
}
