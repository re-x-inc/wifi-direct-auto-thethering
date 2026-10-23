package expo.modules.vpntunnel

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VpnTunnelModule : Module() {
  private val ctx get() = appContext.reactContext ?: throw IllegalStateException("no context")

  override fun definition() = ModuleDefinition {
    Name("VpnTunnel")

    /** VPN の許可が済んでいれば true。未許可なら承認画面を出して false(許可後にもう一度呼ぶ)。 */
    Function("prepare") {
      val i = VpnService.prepare(ctx)
      if (i == null) true else {
        val a: Activity? = appContext.currentActivity
        if (a != null) a.startActivityForResult(i, 7001)
        else ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        false
      }
    }

    /** detachMs: リンク断がこの間続いたら自アプリを VPN から外す / reattachMs: 復帰がこの間安定したら VPN に戻す(省略時は 5000 / 3000) */
    Function("start") { host: String, port: Int, user: String, pass: String, detachMs: Double?, reattachMs: Double? ->
      TunnelService.lastError = null
      ctx.startService(Intent(ctx, TunnelService::class.java)
        .putExtra("host", host).putExtra("port", port).putExtra("user", user).putExtra("pass", pass)
        .putExtra("detachMs", detachMs?.toLong() ?: TunnelService.DEFAULT_DETACH_MS)
        .putExtra("reattachMs", reattachMs?.toLong() ?: TunnelService.DEFAULT_REATTACH_MS))
    }

    Function("stop") {
      ctx.startService(Intent(ctx, TunnelService::class.java).setAction(TunnelService.ACTION_STOP))
    }

    Function("status") {
      mapOf(
        "running" to runCatching { TProxyService.TProxyIsRunning() }.getOrDefault(false),
        "error" to TunnelService.lastError,
        "mode" to TunnelService.mode, // through / legacy-excluded / direct / off(種別だけ)
        "stats" to runCatching { TProxyService.TProxyGetStats().toList() }.getOrDefault(emptyList<Long>()),
      )
    }
  }
}
