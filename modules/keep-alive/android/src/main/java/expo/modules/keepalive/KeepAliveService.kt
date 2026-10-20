package expo.modules.keepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.os.IBinder

/** アプリが裏に回っても、端末間の接続と中継(SOCKS5 / VPN のトンネル)を止められないようにする常駐サービス。 */
class KeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(CHANNEL, "接続の維持", NotificationManager.IMPORTANCE_LOW))
    val n = Notification.Builder(this, CHANNEL)
      .setContentTitle("Tether Auto Connect 動作中")
      .setContentText("端末間の接続を維持しています")
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= 29) {
      // 位置情報タイプは、位置情報の権限が許可済みのときだけ付ける(API 34 以降は無いと SecurityException)。付けると背面でも Nearby の探索が拒否されにくい
      var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
      val locOk = checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
      if (locOk) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
      Log.i("DH-KEEPALIVE", "startForeground type=$type location=$locOk")
      try {
        startForeground(ID, n, type)
      } catch (e: SecurityException) {
        Log.w("DH-KEEPALIVE", "startForeground with location failed ($e) -> connectedDevice のみ")
        startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      }
    } else startForeground(ID, n)
    return START_STICKY
  }

  companion object {
    private const val CHANNEL = "keepalive"
    private const val ID = 1001
  }
}
