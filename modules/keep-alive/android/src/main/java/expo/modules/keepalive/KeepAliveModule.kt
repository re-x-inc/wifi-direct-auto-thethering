package expo.modules.keepalive

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KeepAliveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KeepAlive")

    Function("start") {
      val ctx = appContext.reactContext ?: return@Function null
      ContextCompat.startForegroundService(ctx, Intent(ctx, KeepAliveService::class.java))
    }
    Function("stop") {
      val ctx = appContext.reactContext ?: return@Function null
      ctx.stopService(Intent(ctx, KeepAliveService::class.java))
    }
  }
}
