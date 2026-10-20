import * as SecureStore from 'expo-secure-store';
import { KeyValue } from './types';

/** 端末の安全な保管領域(Android Keystore)。共有コードはここにだけ置く。 */
export const secureKv: KeyValue = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  remove: (k) => SecureStore.deleteItemAsync(k),
};
