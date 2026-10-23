import { requireNativeModule } from 'expo';

declare class VpnTunnelModule {
  prepare(): boolean;
  /** detachMs/reattachMs: リンク断が続いたら自アプリを VPN から外す/復帰が安定したら戻すまでの時間(ms) */
  start(host: string, port: number, user: string, pass: string, detachMs?: number, reattachMs?: number): void;
  stop(): void;
  /** stats = [tx_packets, tx_bytes, rx_packets, rx_bytes] */
  status(): { running: boolean; error: string | null; mode: 'through' | 'legacy-excluded' | 'direct' | 'off'; stats: number[] };
}

export default requireNativeModule<VpnTunnelModule>('VpnTunnel');
