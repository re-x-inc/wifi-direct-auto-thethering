import { requireNativeModule } from 'expo';

declare class VpnTunnelModule {
  prepare(): boolean;
  start(host: string, port: number, user: string, pass: string): void;
  stop(): void;
  /** stats = [tx_packets, tx_bytes, rx_packets, rx_bytes] */
  status(): { running: boolean; error: string | null; stats: number[] };
}

export default requireNativeModule<VpnTunnelModule>('VpnTunnel');
