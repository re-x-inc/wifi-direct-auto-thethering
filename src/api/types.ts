import type { NearbyApi } from '../link/nearbyTransport';
import type { BusLinkState, DataPath, NearbyPhase, Overall } from '../link/dataPath';
export type { BusLinkState };
import type { LinkTimingConfig } from '../link/timingConfig';
import type { LinkStateInfo } from '../link/stateLabels';
import type { Options as LinkTiming, SendOptions } from '../link/supervisor';
import type { KeyValue } from '../pairing/types';
import type { CapabilityPort } from './capability';
import type { JoinFailure } from './joinFailure';
import type { LinkPlan, PlanPolicy } from './planner';
import type { BusPort } from '../link/busControl';
import type { InternetConfig, InternetStatus, RemoteInternet } from '../link/internetMonitor';
export type { InternetConfig, InternetStatus, RemoteInternet };
export type { InternetReason, InternetStateName } from '../link/internetMonitor';

export type { SendOptions };
export type { Confirm, Found, PairingResult } from '../pairing/pairing';
export type { Identity, Pair } from '../pairing/types';

/** host = 親機(回線を持ち、共有する) / guest = 子機(親機の回線を借りる) */
export type TetherRole = 'host' | 'guest';

/** 端末間リンク(Nearby)の状態 */
export type LinkPhase = 'stopped' | 'connecting' | 'waiting' | 'connected';

export interface TetherState {
  /** start() 済みで stop() していない */
  started: boolean;
  /** 実際に動いている役割。停止中は null */
  role: TetherRole | null;
  /** 回線の有無から自動判定した役割(セルラーあり=親機) */
  autoRole: TetherRole;
  /** 使っているペア。ペアリング前は null */
  peer: { peerId: string; peerName: string } | null;
  link: LinkPhase;
  /** 再接続の試行回数(connecting のとき意味がある) */
  attempt: number;
  /** 親機: 回線の共有(Wi-Fi Direct / LOHS + SOCKS5)の状態 */
  share: 'off' | 'starting' | 'on' | 'failed';
  /** 親機: 共有に使っている方式 */
  shareMethod: 'WifiDirect' | 'LocalOnlyHotspot' | null;
  /** 親機: 子機が接続情報で親機のポートに届いたか(子機からの報告) */
  peerReach: { ok: boolean; rttMs?: number; error?: string } | null;
  /** 子機: Wi-Fi への参加の状態 */
  wifi: 'off' | 'joining' | 'joined' | 'failed';
  /** 子機: 端末の Wi-Fi 接続許可の画面が出ている(画面で「『接続』を押してください」と知らせる)。native の onJoinPrompt から */
  joinPrompt: boolean;
  /** 子機: 直近の参加失敗の理由とスキャンの要約(「詳細」に 1 行出す用)。参加を始めるか停止すると null */
  joinFailure: JoinFailure | null;
  /**
   * 子機: VPN の状態。
   * awaiting-permission = 端末の VPN 許可ダイアログ待ち / held = 利用者が非常口で止めた(resumeVpn まで自動では張らない)
   */
  vpn: 'off' | 'awaiting-permission' | 'starting' | 'on' | 'failed' | 'held';
  /** 直近の方式判断(親機が決め、子機へ通知されたもの)。まだ無ければ null */
  plan: LinkPlan | null;
  /**
   * Nearby(制御用)の状態。up = つながっている / down = つながっていない(探索・再接続中) / suspended = Direct が生きている間、意図して止めている。
   * 'suspended' は異常ではない。「つながっているか」は overall を見る(nearby は制御メッセージが届くかの参考)
   */
  nearby: NearbyPhase;
  /** データ経路の詳細(親機: グループの有無・子機のエコー最終受付 / 子機: Wi-Fi 参加・ハートビート・到達確認) */
  data: DataPath;
  /**
   * 総合状態。**データ経路だけ**で決まる(Nearby の link には依存しない)。
   * connected = データが流れる / degraded = 経路の一部はあるが確認できていない / disconnected = データ経路がない
   */
  overall: Overall;
  /**
   * 子機: インターネットへの到達(外形監視)。overall とは別の軸。ok / ng / unknown(未判定・無効・判定できない)。
   * 親機は常に unknown(親機は監視しない。子機の報告は remoteInternet)
   */
  internet: InternetStatus;
  /** 親機: 子機が報告したインターネットへの到達。報告が無い・途絶・バス断・無効のとき null か state=unknown */
  remoteInternet: RemoteInternet | null;
  /**
   * 画面用の「いまの状態」（内部名・日本語ラベル・経過秒・次の遷移までの残り・再接続 n/3）。履歴など全体は tether.linkSnapshot() / onLink()。
   * 後方互換のため追加のみ。
   */
  linkState: LinkStateInfo;
  /** 切断中などで、まだ相手に届いていない送信メッセージの数 */
  pending: number;
  /** 直近の失敗(画面に出す用)。成功したら null に戻る */
  error: string | null;
}

export type TetherErrorCode = 'no-pair' | 'unsupported' | 'permission-denied' | 'busy';

export class TetherError extends Error {
  constructor(public code: TetherErrorCode, message: string, public missing?: string[]) {
    super(message);
    this.name = 'TetherError';
  }
}

export interface StartOptions {
  /** 'auto'(既定)= セルラー回線があれば親機、なければ子機 */
  role?: TetherRole | 'auto';
  /** 複数ペアがあるときの相手。省略は最後に保存したペア */
  peerId?: string;
  /** 親機: 起動と同時に回線の共有を始める(既定 true)。false なら共有は shareNow() で */
  autoShare?: boolean;
}

export interface MessageMeta {
  role: TetherRole;
  peerId: string;
}

// ---- 端末側の部品(テストでは偽物に差し替える) ----

/** probe 供給元(ネイティブ)の 1 周ごとの結果。時刻は Date.now() と同じ時計(0 = まだ無い) */
export interface NativeExternalProbeStatus {
  running: boolean;
  /** 試行した回数(増えたら新しい結果がある) */
  attempts: number;
  lastAttemptAt: number;
  lastOkAt: number;
  lastFailAt: number;
  /** 直近の失敗の分類(InternetReason)。成功のとき null */
  lastReason: string | null;
  lastRttMs: number;
  /** 直近の HTTP ステータス(0 = 応答なし) */
  lastHttp: number;
  consecutiveFailures: number;
}

export interface ExternalProbeStartOptions {
  /** 親機の中継(SOCKS5)。ネイティブは参加した Wi-Fi の Network でここへ直接つなぐ */
  socksHost: string;
  socksPort: number;
  user: string;
  pass: string;
  /** 平文 http の generate_204。どれか 1 つが 204 なら成功 */
  urls: string[];
  intervalMs: number;
  screenOffIntervalMs: number;
  confirmIntervalMs: number;
  timeoutMs: number;
  failThreshold: number;
  wakeLock: boolean;
}

export interface HotspotPort {
  startHotspot(): Promise<{ ssid: string; passphrase: string }>;
  stopHotspot(): void;
  startDirect(name: string | null, pass: string | null, freq: number | null, bandHint?: '2.4' | '5' | null, why?: string | null): Promise<{ ssid: string; passphrase: string }>;
  stopDirect(): Promise<void>;
  startSocks(port: number, user: string, pass: string): Promise<{ network: 'cellular' | 'default' }>;
  stopSocks(): void;
  socksSelfTest(port: number, user: string, pass: string): Promise<{ ok: boolean; line?: string; error?: string; udp?: boolean }>;
  /** timeoutMs: 参加の待ち時間(省略は初回の承認待ちを見込んだ長い既定)。保存済みの接続情報での再接続は短く指定する */
  joinWifi(ssid: string, pass: string, timeoutMs?: number): Promise<{ gateway: string; reused?: boolean }>;
  leaveWifi(): void;
  /** 親機が今つないでいる Wi-Fi の周波数(MHz)。未接続は 0 */
  wifiFrequency(): number;
  hasCellular(): boolean;
  bindToJoined(): boolean;
  unbindProcess(): void;
  /**
   * 子機: probe 供給元(ネイティブ)。省略可(無い部品では enable() だけでは動かず、update() を外から呼ぶ)。
   * 始めたら**すぐ 1 回**実行し、以後は間隔ごと(失敗の直後は確認間隔)。JS が止まっても動く
   */
  externalProbeStart?(o: ExternalProbeStartOptions): void;
  externalProbeStop?(): void;
  externalProbeStatus?(): NativeExternalProbeStatus;
  /** 1 周終わるたび(JS が起きている間)。戻り値で購読解除 */
  onExternalProbe?(cb: (st: NativeExternalProbeStatus) => void): () => void;
  /** Wi-Fi 切断(参加先が消えた)の通知。戻り値で購読解除 */
  onWifiLost(cb: () => void): () => void;
  /** 親機: Direct グループの変化(消滅・クライアント数)。省略可(古いネイティブでは来ない=グループの有無は不明として扱う) */
  onDirectGroup?(cb: (e: { up: boolean; clients: number; appInitiated?: boolean }) => void): () => void;
  /**
   * 子機: 端末の Wi-Fi 接続許可の画面が出る/閉じる通知(省略可)。phase 'show' = 出ている。
   * ok/declined/timeout/cancelled = 終わり。戻り値で購読解除
   */
  onJoinPrompt?(cb: (e: { ssid: string; phase: 'show' | 'ok' | 'declined' | 'timeout' | 'cancelled'; timeoutMs?: number }) => void): () => void;
}

export interface VpnPort {
  /** VPN の許可が済んでいれば true。未許可なら許可ダイアログを出して false */
  prepare(): boolean;
  /** detachMs/reattachMs: リンク断が続いたら自アプリを VPN から外す/復帰が安定したら戻すまで(ms)。省略は 5000/3000 */
  start(host: string, port: number, user: string, pass: string, detachMs?: number, reattachMs?: number): void;
  stop(): void;
  /** mode: through=自アプリも VPN を通る / legacy-excluded=自アプリ除外(API33未満) / direct=リンク断で VPN を閉じている / off */
  status(): { running: boolean; error: string | null; mode?: string };
}

export interface TetherPlatform {
  /**
   * Direct 上の制御バス(省略可。無い/旧版の相手のときは従来どおり Nearby だけ)。
   * 実体は modules/hotspot の BusEngine(ZeroMQ)。src/link/busControl.ts
   */
  bus?: BusPort;
  nearby: NearbyApi;
  /** ネイティブ(DH-P2P / DH-NEARBY)のログを購読する。tether.onLog に流れる。戻り値で解除 */
  onNativeLog?(cb: (tag: string, line: string) => void): () => void;
  /** 共有コードの保管先(本番は SecureStore) */
  kv: KeyValue;
  hotspot: HotspotPort;
  vpn: VpnPort;
  /** 能力調査の部品。無ければ(古い利用側)ほぼすべて「不明」として扱う */
  capability?: CapabilityPort;
  /** 常駐(フォアグラウンドサービス)の開始・停止 */
  keepAlive: { start(): void; stop(): void };
  /** Nearby / 近隣 Wi-Fi / 通知などの権限を求める。すべて許可なら true */
  requestPermissions(): Promise<boolean>;
  /** 画面を出さずに、足りない実行時権限(android.permission.* のフルネーム)を返す。無ければ beginPairing は従来どおり再要求する */
  missingPermissions?(): Promise<string[]>;
  /** 「常に許可」の位置情報が許可済みか。API 28 以下は常に true */
  backgroundLocationGranted?(): Promise<boolean>;
  /** このアプリの設定画面を開く(「常に許可」を選ばせる) */
  openAppSettings?(): Promise<void>;
  randomHex(bytes: number): string;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface TetherConfig {
  /** リンクの再接続タイミング(テスト用に短くできる) */
  link?: Partial<LinkTiming>;
  connectTimeoutMs?: number;
  /** ペアリング全体の制限時間(既定 120 秒) */
  pairingTimeoutMs?: number;
  /** 子機の到達確認の再試行(回数・間隔)。既定 10 回・2 秒 */
  probeRetries?: number;
  probeIntervalMs?: number;
  /** 子機の到達確認: 親機の制御バス(ZMQ)の認証を待つ最長(ms)。既定 15000 */
  busReachMs?: number;
  /** VPN 許可待ちの最長(秒)。既定 60 */
  vpnPermissionWaitSec?: number;
  /** 親機: 子機の能力を待つ最長時間(ms)。キャッシュがあれば待たない。既定 5000 */
  capsWaitMs?: number;
  /** true: Nearby/Direct の不変条件(src/link/linkGovernor.ts)に違反したら例外を投げる(テスト用)。既定 false=拒否して DH-LINK にログ */
  strictLinkGuard?: boolean;
  /**
   * 時間の設定（開始待ち・タイムアウト・閾値。すべて任意）。範囲外は既定に丸めてログ、T_echo < T_direct < T_nearby は補正してログ。
   * 型・既定・範囲は src/link/timingConfig.ts。start() のたびに「既定 < ここ < setTimingOverride で保存した値」で決まり、
   * 子機は共有分（閾値・hb・再接続）を親機の値に揃える。
   */
  timing?: Partial<LinkTimingConfig>;
  /** true: timing の範囲チェックを省く（テスト用に短い時間を使う） */
  timingUnchecked?: boolean;
  /**
   * インターネット外形監視の設定(すべて任意。型・既定・範囲は src/link/internetMonitor.ts)。start() のたびに
   * 「既定 < ここ < setInternetOverride で保存した値 < enable() で渡した値」で決まり、子機は親機の値(間隔・閾値・宛先)に揃える
   */
  internet?: Partial<InternetConfig>;
  /** 方式判断の方針(台数の上限・既存接続の扱いなど) */
  planPolicy?: Partial<PlanPolicy>;
}

/** 交換・判断の進行を知らせるイベント(onHandshake) */
export type HandshakeEvent =
  | { type: 'caps-received'; peerId: string; cached: boolean; model: string | null }
  | { type: 'plan'; side: 'host' | 'guest'; plan: LinkPlan }
  /** 更新が必要。who = 更新すべき側 */
  | { type: 'update-required'; who: 'host' | 'guest' };
