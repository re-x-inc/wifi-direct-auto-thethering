package expo.modules.hotspot

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.VpnService
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager

/**
 * 端末の能力の自己調査。副作用なし(ダイアログ・無線の切り替えを起こさない)。
 * 取得できない項目(Android 版が足りない・公式 API が無い)は null を返す。推測しない。
 */
object CapabilityProbe {
  private inline fun <T> orNull(f: () -> T): T? = try { f() } catch (_: Throwable) { null }

  fun collect(ctx: Context): Map<String, Any?> {
    val sdk = Build.VERSION.SDK_INT
    val app = ctx.applicationContext
    val wm = app.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    val pm = app.packageManager

    // Wi-Fi Direct: WifiManager.isP2pSupported()(SDK の api-versions.xml では API 21)。取れなければ FEATURE_WIFI_DIRECT
    val wifiDirect: Boolean? =
      if (wm != null) orNull { wm.isP2pSupported } ?: orNull { pm.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT) }
      else orNull { pm.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT) }
    // STA + AP の同時動作: API 30+
    val staAp: Boolean? = if (sdk >= 30 && wm != null) orNull { wm.isStaApConcurrencySupported } else null
    // 子機側: 別 Wi-Fi につないだまま「ローカル専用」接続(WifiNetworkSpecifier)を張れるか: API 31+
    val staLocalOnly: Boolean? = if (sdk >= 31 && wm != null) orNull { wm.isStaConcurrencyForLocalOnlyConnectionsSupported } else null
    // 周波数帯: 5GHz は API 21+、2.4GHz の明示 API は API 31+
    val band5: Boolean? = if (wm != null) orNull { wm.is5GHzBandSupported } else null
    val band24: Boolean? = if (sdk >= 31 && wm != null) orNull { wm.is24GHzBandSupported } else null

    val battery: Int? = orNull {
      val i: Intent? = app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val level = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
      if (level >= 0 && scale > 0) level * 100 / scale else null
    }
    val batteryExempt: Boolean? = orNull {
      (app.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(app.packageName)
    }
    // VPN 同意済みか。prepare() は Intent を返すだけでダイアログは出さない(null = 同意済み)
    val vpnConsent: Boolean? = orNull { VpnService.prepare(app) == null }
    val deviceOwner: Boolean? = orNull {
      (app.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager).isDeviceOwnerApp(app.packageName)
    }

    // 必要権限(その Android 版で存在するものだけ)
    val need = ArrayList<Pair<String, Int>>()
    need += Manifest.permission.ACCESS_FINE_LOCATION to 1
    need += "android.permission.BLUETOOTH_SCAN" to 31
    need += "android.permission.BLUETOOTH_ADVERTISE" to 31
    need += "android.permission.BLUETOOTH_CONNECT" to 31
    need += "android.permission.NEARBY_WIFI_DEVICES" to 33
    need += "android.permission.POST_NOTIFICATIONS" to 33
    need += "android.permission.ACCESS_LOCAL_NETWORK" to 37
    val missing = need.filter { sdk >= it.second && app.checkSelfPermission(it.first) != PackageManager.PERMISSION_GRANTED }
      .map { it.first.substringAfterLast('.') }

    return mapOf(
      "manufacturer" to Build.MANUFACTURER,
      "model" to Build.MODEL,
      "sdk" to sdk,
      "release" to Build.VERSION.RELEASE,
      "batteryPercent" to battery,
      "batteryOptimizationExempt" to batteryExempt,
      "wifiDirect" to wifiDirect,
      "staApConcurrent" to staAp,
      "staLocalOnlyConcurrent" to staLocalOnly,
      "band24" to band24,
      "band5" to band5,
      "vpnConsent" to vpnConsent,
      "deviceOwner" to deviceOwner,
      "missingPermissions" to missing,
    )
  }

  /**
   * LocalOnlyHotspot を一瞬だけ起動して、すぐ閉じる。作れるかどうかだけを見る。
   * 承認ダイアログは出ないが、機種によっては Wi-Fi(STA)が一時的に切れる。呼ぶ側は共有中・Direct 稼働中に呼ばないこと。
   */
  fun probeLohs(ctx: Context, done: (Map<String, Any?>) -> Unit) {
    val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    var finished = false
    val main = Handler(Looper.getMainLooper())
    fun finish(m: Map<String, Any?>) { if (!finished) { finished = true; done(m) } }
    main.postDelayed({ finish(mapOf("ok" to false, "reason" to "timeout")) }, 15_000)
    try {
      wm.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
        override fun onStarted(r: WifiManager.LocalOnlyHotspotReservation) {
          r.close()
          finish(mapOf("ok" to true))
        }
        override fun onStopped() {}
        override fun onFailed(reason: Int) {
          val name = when (reason) {
            ERROR_NO_CHANNEL -> "no-channel"
            ERROR_GENERIC -> "generic"
            ERROR_INCOMPATIBLE_MODE -> "incompatible-mode"
            ERROR_TETHERING_DISALLOWED -> "tethering-disallowed"
            else -> "unknown-$reason"
          }
          finish(mapOf("ok" to false, "reason" to name))
        }
      }, main)
    } catch (e: SecurityException) {
      finish(mapOf("ok" to false, "reason" to "permission"))
    } catch (e: Exception) {
      finish(mapOf("ok" to false, "reason" to "error"))
    }
  }
}
