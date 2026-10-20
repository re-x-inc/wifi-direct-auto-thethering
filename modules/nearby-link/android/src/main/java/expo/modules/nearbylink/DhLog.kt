package expo.modules.nearbylink

import android.util.Log

/**
 * logcat に出すと同時に、JS へ 'log' イベントでも流す(アプリの診断ログ欄用)。
 * JS へ出す行は SSID・BSSID・端末名を伏せる。合言葉は元々ログに出さない(passTag のみ)。logcat には従来どおりの全文を残す。
 */
object DhLog {
  @Volatile var sink: ((String, String) -> Unit)? = null
  private val ssidRe = Regex("""(b?ssid)=\S+""", RegexOption.IGNORE_CASE)
  private val directRe = Regex("""DIRECT-[A-Za-z0-9]{2}-[^\s,\]\)@]*""")
  private val nameRe = Regex("""\b(name=|found )\S+""")

  fun redact(s: String): String =
    s.replace(ssidRe) { it.groupValues[1] + "=<hidden>" }.replace(directRe, "DIRECT-*").replace(nameRe) { it.groupValues[1] + "<hidden>" }

  fun i(tag: String, msg: String) { Log.i(tag, msg); emit("i", tag, msg) }
  fun w(tag: String, msg: String) { Log.w(tag, msg); emit("w", tag, msg) }
  private fun emit(level: String, tag: String, msg: String) {
    try { sink?.invoke(tag, "$level ${redact(msg)}") } catch (_: Throwable) {}
  }
}
