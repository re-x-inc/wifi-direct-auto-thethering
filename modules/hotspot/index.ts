import { NativeModule, requireNativeModule } from 'expo';

type Events = {
  onHotspotStopped(e: Record<string, never>): void;
  onWifiLost(e: Record<string, never>): void;
  /** 子機の Wi-Fi 参加。phase 'show' = 端末の許可画面が出る(「接続」を押してもらう)。ok/declined/timeout/cancelled = 終わり */
  onJoinPrompt(e: { ssid: string; phase: 'show' | 'ok' | 'declined' | 'timeout' | 'cancelled'; timeoutMs?: number }): void;
};

declare class HotspotModule extends NativeModule<Events> {
  startHotspot(): Promise<{ ssid: string; passphrase: string }>;
  stopHotspot(): void;
  /** name/pass/freq を渡すと固定(例: 'DIRECT-dh-xxxx', 12文字, 2437)。省略はランダム */
  startDirect(name?: string | null, pass?: string | null, freq?: number | null): Promise<{ ssid: string; passphrase: string }>;
  stopDirect(): Promise<void>;
  startSocks(port: number, user: string, pass: string): Promise<{ network: 'cellular' | 'default' }>;
  stopSocks(): void;
  socksSelfTest(port: number, user: string, pass: string): Promise<{ ok: boolean; line?: string; error?: string }>;
  startEcho(port: number): void;
  stopEcho(): void;
  joinWifi(ssid: string, pass: string): Promise<{ gateway: string; reused?: boolean }>;
  leaveWifi(): void;
  /** セルラー回線(INTERNET 能力つき)があるか */
  hasCellular(): boolean;
  suggestWifi(ssid: string, pass: string): Promise<{ gateway: string; reused?: boolean }>;
  bindToJoined(): boolean;
  unbindProcess(): void;
  probe(host: string, port: number): Promise<{ ok: boolean; rttMs?: number; error?: string }>;
}

export default requireNativeModule<HotspotModule>('Hotspot');
