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
  setDirectActive(on: boolean): void;
  /** 広告・探索・接続・stopAllEndpoints を止め、後始末が済むまで待つ。resume() まで advertise / discover / requestConnect は無視される */
  suspend(): Promise<void>;
  resume(): void;
  /** DH-LINK に 1 行残す(JS 側の判定理由・状態遷移・違反を logcat で追うため) */
  note(line: string): void;
}

export default requireNativeModule<NearbyLinkModule>('NearbyLink');
