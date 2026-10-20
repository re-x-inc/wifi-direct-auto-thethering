import { NativeModule, requireNativeModule } from 'expo';

type Events = {
  /** ネイティブのログ(DH-NEARBY)。SSID・端末名は伏せ済み。line は "i|w 本文" */
  log(e: { tag: string; line: string }): void;
  onFound(e: { endpointId: string; name: string }): void;
  onLost(e: { endpointId: string }): void;
  onInitiated(e: { endpointId: string; name: string; digits: string; incoming: boolean }): void;
  onConnected(e: { endpointId: string }): void;
  onFailed(e: { endpointId: string; code: number }): void;
  onDisconnected(e: { endpointId: string }): void;
  onMessage(e: { endpointId: string; text: string }): void;
};

declare class NearbyLinkModule extends NativeModule<Events> {
  advertise(name: string): void;
  discover(): void;
  requestConnect(endpointId: string, name: string): void;
  accept(endpointId: string): void;
  reject(endpointId: string): void;
  send(endpointId: string, text: string): void;
  disconnect(endpointId: string): void;
  stop(): void;
  hmac(secret: string, data: string): string;
}

export default requireNativeModule<NearbyLinkModule>('NearbyLink');
