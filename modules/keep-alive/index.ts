import { requireNativeModule } from 'expo';

declare class KeepAliveModule {
  start(): void;
  stop(): void;
}

export default requireNativeModule<KeepAliveModule>('KeepAlive');
