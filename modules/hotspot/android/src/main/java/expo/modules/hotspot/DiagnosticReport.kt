package expo.modules.hotspot

import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.app.usage.UsageStatsManager
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.VpnService
import android.net.wifi.WifiManager
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.p2p.WifiP2pManager
import android.net.wifi.rtt.WifiRttManager
import android.nfc.NfcAdapter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.UserManager
import android.provider.Settings
import android.telephony.TelephonyManager
import java.io.File

/**
 * 診断レポート: 端末から取れるものを網羅的に採取する。副作用なし(ダイアログ・無線の切り替えを起こさない)。
 *
 * 各項目は {v, minApi, why?, official?}。
 *  - v: 値。取れなかった項目は null(推測しない)
 *  - minApi: その API が追加された Android API レベル(SDK の api-versions.xml による)。null = 版に依存しない
 *  - why: v が null の理由(sdk<N = Android 版が足りない / ex:クラス名 = 例外 / unavailable = サービスが無い)
 *  - official: false = 公式 SDK に載っていない取り方(非公開の設定キー・リソース名)。無い場合は null
 * 個人を特定できる値(IMEI・電話番号・SSID・MAC・アカウント・端末名・位置・シリアル)は採取しない。
 */
object DiagnosticReport {
  private val sdk get() = Build.VERSION.SDK_INT

  private fun item(minApi: Int?, official: Boolean = true, f: () -> Any?): Map<String, Any?> {
    var why: String? = null
    var v: Any? = null
    if (minApi != null && sdk < minApi) why = "sdk<$minApi"
    else try { v = f(); if (v == null) why = "unavailable" } catch (e: Throwable) { why = "ex:" + e.javaClass.simpleName }
    val m = LinkedHashMap<String, Any?>()
    m["v"] = v
    m["minApi"] = minApi
    if (why != null) m["why"] = why
    if (!official) m["official"] = false
    return m
  }

  fun collect(ctx: Context): Map<String, Any?> {
    val app = ctx.applicationContext
    val pm = app.packageManager
    val wm = app.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    val cm = app.getSystemService(ConnectivityManager::class.java)
    val sections = LinkedHashMap<String, Any?>()

    // ---- Build ----
    sections["build"] = mapOf(
      "manufacturer" to item(null) { Build.MANUFACTURER },
      "brand" to item(null) { Build.BRAND },
      "model" to item(null) { Build.MODEL },
      "device" to item(null) { Build.DEVICE },
      "product" to item(null) { Build.PRODUCT },
      "hardware" to item(null) { Build.HARDWARE },
      "board" to item(null) { Build.BOARD },
      "sdkInt" to item(null) { Build.VERSION.SDK_INT },
      "release" to item(null) { Build.VERSION.RELEASE },
      "codename" to item(null) { Build.VERSION.CODENAME },
      "securityPatch" to item(23) { Build.VERSION.SECURITY_PATCH },
      "previewSdkInt" to item(23) { Build.VERSION.PREVIEW_SDK_INT },
      "buildId" to item(null) { Build.ID },
      "display" to item(null) { Build.DISPLAY },
      "type" to item(null) { Build.TYPE },
      "tags" to item(null) { Build.TAGS },
      "fingerprint" to item(null) { Build.FINGERPRINT },
      "supportedAbis" to item(21) { Build.SUPPORTED_ABIS.toList() },
      "supported64BitAbis" to item(21) { Build.SUPPORTED_64_BIT_ABIS.toList() },
      "radioVersion" to item(null) { Build.getRadioVersion() },
    )

    // ---- このアプリ ----
    val pi = try { @Suppress("DEPRECATION") pm.getPackageInfo(app.packageName, PackageManager.GET_PERMISSIONS) } catch (e: Throwable) { null }
    sections["app"] = mapOf(
      "packageName" to item(null) { app.packageName },
      "versionName" to item(null) { pi?.versionName },
      "versionCode" to item(null) { @Suppress("DEPRECATION") pi?.versionCode },
      "targetSdk" to item(null) { app.applicationInfo.targetSdkVersion },
    )

    // ---- Wi-Fi(WifiManager) ----
    fun w(minApi: Int?, f: (WifiManager) -> Any?) = item(minApi) { f(wm!!) }
    val standards = mapOf(1 to "legacy", 4 to "11n", 5 to "11ac", 6 to "11ax", 7 to "11ad", 8 to "11be")
    sections["wifi"] = linkedMapOf(
      "wifiEnabled" to w(null) { it.isWifiEnabled },
      "band24" to w(31) { it.is24GHzBandSupported },
      "band5" to w(21) { it.is5GHzBandSupported },
      "band6" to w(30) { it.is6GHzBandSupported },
      "band60" to w(31) { it.is60GHzBandSupported },
      "standardsSupported" to w(30) { m -> standards.filter { (k, _) -> (k < 8 || sdk >= 33) && m.isWifiStandardSupported(k) }.values.toList() },
      "p2pSupported" to w(21) { it.isP2pSupported },
      "staApConcurrent" to w(30) { it.isStaApConcurrencySupported },
      "staConcurrentLocalOnly" to w(31) { it.isStaConcurrencyForLocalOnlyConnectionsSupported },
      "staConcurrentMultiInternet" to w(33) { it.isStaConcurrencyForMultiInternetSupported },
      "bridgedApConcurrent" to w(31) { it.isBridgedApConcurrencySupported },
      "staBridgedApConcurrent" to w(31) { it.isStaBridgedApConcurrencySupported },
      "dualBandSimultaneous" to w(34) { it.isDualBandSimultaneousSupported },
      "makeBeforeBreakSwitching" to w(31) { it.isMakeBeforeBreakWifiSwitchingSupported },
      "tdls" to w(21) { it.isTdlsSupported },
      "preferredNetworkOffload" to w(21) { it.isPreferredNetworkOffloadSupported },
      "deviceToApRtt" to w(21) { it.isDeviceToApRttSupported },
      "enhancedPowerReporting" to w(21) { it.isEnhancedPowerReportingSupported },
      "easyConnect" to w(29) { it.isEasyConnectSupported },
      "enhancedOpen" to w(29) { it.isEnhancedOpenSupported },
      "wpa3Sae" to w(29) { it.isWpa3SaeSupported },
      "wpa3SuiteB" to w(29) { it.isWpa3SuiteBSupported },
      "wpa3SaeH2e" to w(31) { it.isWpa3SaeH2eSupported },
      "wapi" to w(30) { it.isWapiSupported },
      "wep" to w(35) { it.isWepSupported },
      "decoratedIdentity" to w(31) { it.isDecoratedIdentitySupported },
      "trustOnFirstUse" to w(33) { it.isTrustOnFirstUseSupported },
      "scanThrottleEnabled" to w(30) { it.isScanThrottleEnabled },
      "maxSuggestionsPerApp" to w(29) { it.maxNumberOfNetworkSuggestionsPerApp },
      "maxSignalLevel" to w(30) { it.maxSignalLevel },
    )

    // ---- Wi-Fi Direct(WifiP2pManager)----
    val p2p = app.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    fun p(minApi: Int?, f: (WifiP2pManager) -> Any?) = item(minApi) { f(p2p!!) }
    sections["wifiP2p"] = linkedMapOf(
      "service" to item(null) { p2p != null },
      "channelConstrainedDiscovery" to p(33) { it.isChannelConstrainedDiscoverySupported },
      "setVendorElements" to p(33) { it.isSetVendorElementsSupported },
      "groupClientRemoval" to p(33) { it.isGroupClientRemovalSupported },
      "groupOwnerIPv6LinkLocal" to p(34) { it.isGroupOwnerIPv6LinkLocalAddressProvided },
      "wifiDirectR2" to p(36) { it.isWiFiDirectR2Supported },
      "pccMode" to p(36) { it.isPccModeSupported },
    )

    // ---- Wi-Fi Aware / RTT ----
    val aware = app.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
    val rtt = app.getSystemService(Context.WIFI_RTT_RANGING_SERVICE) as? WifiRttManager
    sections["wifiAwareRtt"] = linkedMapOf(
      "awareAvailable" to item(26) { aware!!.isAvailable },
      "awareMaxServiceNameLength" to item(26) { aware!!.characteristics?.maxServiceNameLength },
      "awareMaxServiceSpecificInfoLength" to item(26) { aware!!.characteristics?.maxServiceSpecificInfoLength },
      "awareInstantCommunicationEnabled" to item(31) { aware!!.isInstantCommunicationModeEnabled },
      "rttAvailable" to item(28) { rtt!!.isAvailable },
    )

    // ---- Bluetooth ----
    val bt: BluetoothAdapter? = try { (app.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter } catch (e: Throwable) { null }
    fun b(minApi: Int?, f: (BluetoothAdapter) -> Any?) = item(minApi) { f(bt!!) }
    val btStates = mapOf(10 to "off", 11 to "turning_on", 12 to "on", 13 to "turning_off")
    sections["bluetooth"] = linkedMapOf(
      "adapterPresent" to item(null) { bt != null },
      "state" to b(null) { btStates[it.state] ?: it.state.toString() },
      "le2MPhy" to b(26) { it.isLe2MPhySupported },
      "leCodedPhy" to b(26) { it.isLeCodedPhySupported },
      "leExtendedAdvertising" to b(26) { it.isLeExtendedAdvertisingSupported },
      "lePeriodicAdvertising" to b(26) { it.isLePeriodicAdvertisingSupported },
      "leMaxAdvertisingDataLength" to b(26) { it.leMaximumAdvertisingDataLength },
      "multipleAdvertisement" to b(21) { it.isMultipleAdvertisementSupported },
      "offloadedFiltering" to b(21) { it.isOffloadedFilteringSupported },
      "offloadedScanBatching" to b(21) { it.isOffloadedScanBatchingSupported },
    )

    // ---- NFC / UWB ----
    val nfc = try { NfcAdapter.getDefaultAdapter(app) } catch (e: Throwable) { null }
    sections["nfcUwb"] = linkedMapOf(
      "nfcAdapterPresent" to item(null) { nfc != null },
      "nfcEnabled" to item(null) { nfc!!.isEnabled },
      "secureNfcSupported" to item(29) { nfc!!.isSecureNfcSupported },
      "uwbFeature" to item(34) { pm.hasSystemFeature("android.hardware.uwb") },
    )

    // ---- セルラー(個人を特定する値は採取しない)----
    val tm = app.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
    fun t(minApi: Int?, f: (TelephonyManager) -> Any?) = item(minApi) { f(tm!!) }
    val simStates = mapOf(0 to "unknown", 1 to "absent", 2 to "pin_required", 3 to "puk_required", 4 to "network_locked", 5 to "ready", 6 to "not_ready", 7 to "perm_disabled", 8 to "card_io_error", 9 to "card_restricted", 10 to "loaded", 11 to "present")
    val phoneTypes = mapOf(0 to "none", 1 to "gsm", 2 to "cdma", 3 to "sip")
    sections["cellular"] = linkedMapOf(
      "telephonyService" to item(null) { tm != null },
      "phoneType" to t(null) { phoneTypes[it.phoneType] ?: it.phoneType.toString() },
      "simState" to t(null) { simStates[it.simState] ?: it.simState.toString() },
      "voiceCapable" to t(22) { it.isVoiceCapable },
      "smsCapable" to t(null) { it.isSmsCapable },
      "dataCapable" to t(31) { it.isDataCapable },
      "dataEnabled" to t(26) { it.isDataEnabled },
      "dataNetworkType" to t(24) { it.dataNetworkType },
      "multiSimSupported" to t(29) { when (it.isMultiSimSupported) { 0 -> "supported"; 1 -> "not_supported_by_hardware"; 2 -> "not_supported_by_carrier"; else -> "unknown" } },
      "activeModemCount" to t(30) { it.activeModemCount },
      "supportedModemCount" to t(30) { it.supportedModemCount },
      "rttSupported" to t(29) { it.isRttSupported },
      // 公式 SDK にテザリング可否の API は無い。システム設定の正規表現リソースの有無だけを読む(非公開リソース名)
      "tetherWifiRegexCount" to item(null, official = false) { sysArrayCount("config_tether_wifi_regexs") },
      "tetherBluetoothRegexCount" to item(null, official = false) { sysArrayCount("config_tether_bluetooth_regexs") },
      "tetherUsbRegexCount" to item(null, official = false) { sysArrayCount("config_tether_usb_regexs") },
    )

    // ---- 電源 ----
    val pw = app.getSystemService(Context.POWER_SERVICE) as PowerManager
    val bi: Intent? = try { app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) } catch (e: Throwable) { null }
    val bmgr = app.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
    val buckets = mapOf(5 to "exempted", 10 to "active", 20 to "working_set", 30 to "frequent", 40 to "rare", 45 to "restricted", 50 to "never")
    val thermal = mapOf(0 to "none", 1 to "light", 2 to "moderate", 3 to "severe", 4 to "critical", 5 to "emergency", 6 to "shutdown")
    sections["power"] = linkedMapOf(
      "batteryPercent" to item(null) { val l = bi!!.getIntExtra(BatteryManager.EXTRA_LEVEL, -1); val s = bi.getIntExtra(BatteryManager.EXTRA_SCALE, -1); if (l >= 0 && s > 0) l * 100 / s else null },
      "batteryStatus" to item(null) { bi!!.getIntExtra(BatteryManager.EXTRA_STATUS, -1) },
      "batteryPlugged" to item(null) { bi!!.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) },
      "batteryHealth" to item(null) { bi!!.getIntExtra(BatteryManager.EXTRA_HEALTH, -1) },
      "batteryTemperatureDeciC" to item(null) { bi!!.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE).takeIf { it != Int.MIN_VALUE } },
      "isCharging" to item(23) { bmgr!!.isCharging },
      "powerSaveMode" to item(21) { pw.isPowerSaveMode },
      "deviceIdleMode" to item(23) { pw.isDeviceIdleMode },
      "deviceLightIdleMode" to item(33) { pw.isDeviceLightIdleMode },
      "lowPowerStandbyEnabled" to item(33) { pw.isLowPowerStandbyEnabled },
      "interactive" to item(20) { pw.isInteractive },
      "ignoringBatteryOptimizations" to item(23) { pw.isIgnoringBatteryOptimizations(app.packageName) },
      "thermalStatus" to item(29) { thermal[pw.currentThermalStatus] ?: pw.currentThermalStatus.toString() },
      "sustainedPerformanceSupported" to item(24) { pw.isSustainedPerformanceModeSupported },
      "appStandbyBucket" to item(28) { val b = (app.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager).appStandbyBucket; buckets[b] ?: b.toString() },
      "backgroundRestricted" to item(28) { (app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).isBackgroundRestricted },
      "restrictBackgroundStatus" to item(24) { when (cm.restrictBackgroundStatus) { 1 -> "disabled"; 2 -> "whitelisted"; 3 -> "enabled"; else -> "unknown" } },
    )

    // ---- 権限(宣言済み・付与済みの全一覧)----
    val req = pi?.requestedPermissions
    val flags = pi?.requestedPermissionsFlags
    sections["permissions"] = linkedMapOf(
      "declared" to item(null) { req?.toList() },
      "granted" to item(null) { req?.indices?.filter { (flags!![it] and android.content.pm.PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0 }?.map { req[it] } },
      "denied" to item(null) { req?.indices?.filter { (flags!![it] and android.content.pm.PackageInfo.REQUESTED_PERMISSION_GRANTED) == 0 }?.map { req[it] } },
    )

    // ---- VPN ----
    sections["vpn"] = linkedMapOf(
      "consentGiven" to item(14) { VpnService.prepare(app) == null },
      // VpnService.isAlwaysOn / isLockdownEnabled は VPN サービス稼働中の自分でしか判定できない
      "alwaysOnThisApp" to item(29) { null },
      "alwaysOnPackage" to item(null, official = false) { Settings.Secure.getString(app.contentResolver, "always_on_vpn_app") },
      "otherVpnActive" to item(23) { cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true } },
    )

    // ---- DPC(Device Owner / Profile Owner)----
    val dpm = app.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
    val um = app.getSystemService(Context.USER_SERVICE) as? UserManager
    sections["dpc"] = linkedMapOf(
      "deviceOwnerThisApp" to item(18) { dpm!!.isDeviceOwnerApp(app.packageName) },
      "profileOwnerThisApp" to item(21) { dpm!!.isProfileOwnerApp(app.packageName) },
      "activeAdminCount" to item(8) { dpm!!.activeAdmins?.size ?: 0 },
      "orgOwnedWithManagedProfile" to item(30) { dpm!!.isOrganizationOwnedDeviceWithManagedProfile },
      "isManagedProfile" to item(30) { um!!.isManagedProfile },
      "isSystemUser" to item(23) { um!!.isSystemUser },
      "isDemoUser" to item(25) { um!!.isDemoUser },
    )

    // ---- システム機能(PackageManager.hasSystemFeature)----
    val prefixes = listOf(
      "android.hardware.wifi", "android.hardware.bluetooth", "android.hardware.nfc", "android.hardware.uwb",
      "android.hardware.telephony", "android.hardware.ethernet", "android.hardware.usb", "android.hardware.location",
      "android.hardware.thread_network", "android.hardware.consumerir", "android.hardware.radio",
      "android.software.device_admin", "android.software.managed_users", "android.software.secure_lock_screen",
      "android.software.companion_device_setup", "android.software.ipsec_tunnel", "android.software.vpn",
      "android.software.verified_boot", "android.software.connectionservice", "android.software.sip",
    )
    val present = pm.systemAvailableFeatures.mapNotNull { it.name }.filter { n -> prefixes.any { n.startsWith(it) } }.sorted()
    val queried = listOf(
      "android.hardware.wifi", "android.hardware.wifi.direct", "android.hardware.wifi.aware", "android.hardware.wifi.rtt",
      "android.hardware.wifi.passpoint", "android.hardware.bluetooth", "android.hardware.bluetooth_le", "android.hardware.nfc",
      "android.hardware.nfc.hce", "android.hardware.uwb", "android.hardware.telephony", "android.hardware.telephony.data",
      "android.hardware.telephony.messaging", "android.hardware.telephony.subscription", "android.hardware.telephony.radio.access",
      "android.hardware.telephony.calling", "android.hardware.telephony.ims", "android.hardware.telephony.euicc",
      "android.hardware.telephony.gsm", "android.hardware.telephony.cdma", "android.hardware.ethernet", "android.hardware.usb.host",
      "android.hardware.usb.accessory", "android.hardware.location.gps", "android.hardware.thread_network",
      "android.software.device_admin", "android.software.managed_users", "android.software.secure_lock_screen",
      "android.software.ipsec_tunnels", "android.software.companion_device_setup",
    )
    sections["features"] = linkedMapOf(
      "present" to item(null) { present },
      "queried" to item(null) { queried.associateWith { pm.hasSystemFeature(it) } },
    )

    // ---- ネットワーク(NetworkCapabilities の全能力・transport)----
    val capNames = linkedMapOf(
      0 to "MMS", 1 to "SUPL", 2 to "DUN", 3 to "FOTA", 4 to "IMS", 5 to "CBS", 6 to "WIFI_P2P", 7 to "IA", 8 to "RCS", 9 to "XCAP",
      10 to "EIMS", 11 to "NOT_METERED", 12 to "INTERNET", 13 to "NOT_RESTRICTED", 14 to "TRUSTED", 15 to "NOT_VPN", 16 to "VALIDATED",
      17 to "CAPTIVE_PORTAL", 18 to "NOT_ROAMING", 19 to "FOREGROUND", 20 to "NOT_CONGESTED", 21 to "NOT_SUSPENDED", 23 to "MCX",
      25 to "TEMPORARILY_NOT_METERED", 29 to "ENTERPRISE", 32 to "HEAD_UNIT", 33 to "MMTEL", 34 to "PRIORITIZE_LATENCY",
      35 to "PRIORITIZE_BANDWIDTH", 36 to "LOCAL_NETWORK", 37 to "NOT_BANDWIDTH_CONSTRAINED",
    )
    val transports = linkedMapOf(0 to "CELLULAR", 1 to "WIFI", 2 to "BLUETOOTH", 3 to "ETHERNET", 4 to "VPN", 5 to "WIFI_AWARE", 6 to "LOWPAN", 8 to "USB", 9 to "THREAD", 10 to "SATELLITE")
    sections["network"] = linkedMapOf(
      "networks" to item(23) {
        val active = cm.activeNetwork
        cm.allNetworks.mapNotNull { n ->
          val c = cm.getNetworkCapabilities(n) ?: return@mapNotNull null
          mapOf(
            "active" to (n == active),
            "transports" to transports.filter { (k, _) -> try { c.hasTransport(k) } catch (e: Throwable) { false } }.values.toList(),
            "capabilities" to capNames.filter { (k, _) -> try { c.hasCapability(k) } catch (e: Throwable) { false } }.values.toList(),
            "downstreamKbps" to c.linkDownstreamBandwidthKbps,
            "upstreamKbps" to c.linkUpstreamBandwidthKbps,
          )
        }
      },
      "activeNetworkMetered" to item(16) { cm.isActiveNetworkMetered },
      "defaultNetworkActive" to item(21) { cm.isDefaultNetworkActive },
    )

    return mapOf("schema" to 1, "sections" to sections)
  }

  /** システムリソースの文字列配列の要素数(無ければ null)。リソース名は非公開 */
  private fun sysArrayCount(name: String): Int? {
    val r = android.content.res.Resources.getSystem()
    val id = r.getIdentifier(name, "array", "android")
    return if (id == 0) null else r.getStringArray(id).size
  }

  /** 診断レポートを、このアプリ専用の外部ファイル領域に書く(adb pull / 共有で取り出せる)。ファイル名は英数字・.-_ のみ */
  fun writeFile(ctx: Context, name: String, text: String): String {
    val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(120)
    val base = ctx.getExternalFilesDir(null) ?: ctx.filesDir
    val dir = File(base, "diagnostics").apply { mkdirs() }
    val f = File(dir, safe)
    f.writeText(text)
    return f.absolutePath
  }
}
