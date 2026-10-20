/** 保存するペア。secret は、ペアリング時に生成した相手ごとのランダム値(Nearby の認証済み経路でだけ渡す) */
export interface Pair {
  peerId: string;
  peerName: string;
  secret: string;
  createdAt: number;
  /** ペアリングで利用者が選んだ、この端末の役割。host=親機(回線を共有) / guest=子機。古いペアには無い */
  role?: 'host' | 'guest';
}

/** 端末の永続的な識別。id は広告名・接続の照合に使う(秘密ではない) */
export interface Identity {
  id: string;
  name: string;
}

/** SecureStore などの最小インターフェース。テストでは Map で差し替える */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** 削除(未対応の実装では directCreds が空文字で上書きして無効にする) */
  remove?(key: string): Promise<void>;
}

/** 画面に出す端末名(端末IDの末尾から作る)。広告名には載せない(低電力の広告は名前に使える余地が小さい) */
export const labelOf = (id: string) => `端末-${id.slice(-4).toUpperCase()}`;
