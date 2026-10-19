/** 保存するペア。secret は、ペアリング時に生成した相手ごとのランダム値(Nearby の認証済み経路でだけ渡す) */
export interface Pair {
  peerId: string;
  peerName: string;
  secret: string;
  createdAt: number;
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
}
