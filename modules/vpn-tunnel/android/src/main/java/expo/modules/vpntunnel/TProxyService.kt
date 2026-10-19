package expo.modules.vpntunnel

/** hev-socks5-tunnel の JNI。クラス名・パッケージ名は Application.mk の PKGNAME/CLSNAME と一致させる。 */
object TProxyService {
  external fun TProxyStartService(configPath: String, fd: Int): Boolean
  external fun TProxyStopService(): Boolean
  external fun TProxyIsRunning(): Boolean
  external fun TProxyGetStats(): LongArray

  init { System.loadLibrary("hev-socks5-tunnel") }
}
