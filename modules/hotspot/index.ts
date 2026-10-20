import { NativeModule, requireNativeModule } from 'expo';

type Events = {
  onHotspotStopped(e: Record<string, never>): void;
  onWifiLost(e: Record<string, never>): void;
  /** 子機の Wi-Fi 参加。phase 'show' = 端末の許可画面が出る(「接続」を押してもらう)。ok/declined/timeout/cancelled = 終わり */
  onJoinPrompt(e: { ssid: string; phase: 'show' | 'ok' | 'declined' | 'timeout' | 'cancelled'; timeoutMs?: number }): void;
};

export interface NativeCapabilities {
  manufacturer: string | null;
  model: string | null;
  sdk: number | null;
  release: string | null;
  batteryPercent: number | null;
  batteryOptimizationExempt: boolean | null;
  wifiDirect: boolean | null;
  staApConcurrent: boolean | null;
  staLocalOnlyConcurrent: boolean | null;
  band24: boolean | null;
  band5: boolean | null;
  vpnConsent: boolean | null;
  deviceOwner: boolean | null;
  missingPermissions: string[];
}

declare class HotspotModule extends NativeModule<Events> {
  startHotspot(): Promise<{ ssid: string; passphrase: string }>;
  stopHotspot(): void;
  /** 端末の能力(副作用なし)。取得できない項目は null */
  capabilities(): NativeCapabilities;
  /** LocalOnlyHotspot を一瞬だけ起動して閉じる(共有中は reason:'busy')。Wi-Fi が一時的に切れる機種がある */
  probeLohs(): Promise<{ ok: boolean; reason?: string }>;
  /** 診断レポート用の網羅的な採取(副作用なし)。各項目は { v, minApi, why?, official? } */
  diagnostics(): { schema: number; sections: Record<string, Record<string, unknown>> };
  /** 診断レポートをこのアプリ専用のファイル領域に書き、パスを返す */
  saveDiagnosticFile(name: string, text: string): string;
  /** name/pass/freq を渡すと固定(例: 'DIRECT-dh-xxxx', 12文字, 2437。null はシステム任せ)。省略はランダム */
  startDirect(name?: string | null, pass?: string | null, freq?: number | null, bandHint?: string | null, why?: string | null): Promise<{ ssid: string; passphrase: string }>;
  stopDirect(): Promise<void>;
  startSocks(port: number, user: string, pass: string): Promise<{ network: 'cellular' | 'default' }>;
  stopSocks(): void;
  socksSelfTest(port: number, user: string, pass: string): Promise<{ ok: boolean; line?: string; error?: string; udp?: boolean }>;
  startEcho(port: number): void;
  stopEcho(): void;
  joinWifi(ssid: string, pass: string): Promise<{ gateway: string; reused?: boolean }>;
  leaveWifi(): void;
  /** セルラー回線(INTERNET 能力つき)があるか */
  /** 今つないでいる Wi-Fi の周波数(MHz)。未接続は 0 */
  wifiFrequency(): number;
  hasCellular(): boolean;
  suggestWifi(ssid: string, pass: string): Promise<{ gateway: string; reused?: boolean }>;
  bindToJoined(): boolean;
  unbindProcess(): void;
  probe(host: string, port: number): Promise<{ ok: boolean; rttMs?: number; error?: string }>;
}

export default requireNativeModule<HotspotModule>('Hotspot');
