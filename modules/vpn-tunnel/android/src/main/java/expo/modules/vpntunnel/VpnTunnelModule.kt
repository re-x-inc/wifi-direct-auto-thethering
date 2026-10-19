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

    Function("start") { host: String, port: Int, user: String, pass: String ->
      TunnelService.lastError = null
      ctx.startService(Intent(ctx, TunnelService::class.java)
        .putExtra("host", host).putExtra("port", port).putExtra("user", user).putExtra("pass", pass))
    }

    Function("stop") {
      ctx.startService(Intent(ctx, TunnelService::class.java).setAction(TunnelService.ACTION_STOP))
    }

    Function("status") {
      mapOf(
        "running" to runCatching { TProxyService.TProxyIsRunning() }.getOrDefault(false),
        "error" to TunnelService.lastError,
        "stats" to runCatching { TProxyService.TProxyGetStats().toList() }.getOrDefault(emptyList<Long>()),
      )
    }
  }
}
