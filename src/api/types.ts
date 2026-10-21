import type { NearbyApi } from '../link/nearbyTransport';
import type { DataPath, NearbyPhase, Overall } from '../link/dataPath';
import type { LinkTimingConfig } from '../link/timingConfig';
import type { LinkStateInfo } from '../link/stateLabels';
import type { Options as LinkTiming, SendOptions } from '../link/supervisor';
import type { KeyValue } from '../pairing/types';
import type { CapabilityPort } from './capability';
import type { JoinFailure } from './joinFailure';
import type { LinkPlan, PlanPolicy } from './planner';

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

export interface NativeHeartbeatStatus {
  running: boolean;
  lastAttemptAt: number;
  lastOkAt: number;
  lastFailAt: number;
  lastError: string | null;
  lastRttMs: number;
  consecutiveFailures: number;
  attempts: number;
  intervalMs: number;
}

export interface HotspotPort {
  startHotspot(): Promise<{ ssid: string; passphrase: string }>;
  stopHotspot(): void;
  startDirect(name: string | null, pass: string | null, freq: number | null, bandHint?: '2.4' | '5' | null, why?: string | null): Promise<{ ssid: string; passphrase: string }>;
  stopDirect(): Promise<void>;
  startSocks(port: number, user: string, pass: string): Promise<{ network: 'cellular' | 'default' }>;
  stopSocks(): void;
  socksSelfTest(port: number, user: string, pass: string): Promise<{ ok: boolean; line?: string; error?: string; udp?: boolean }>;
  startEcho(port: number): void;
  stopEcho(): void;
  /** timeoutMs: 参加の待ち時間(省略は初回の承認待ちを見込んだ長い既定)。保存済みの接続情報での再接続は短く指定する */
  joinWifi(ssid: string, pass: string, timeoutMs?: number): Promise<{ gateway: string; reused?: boolean }>;
  leaveWifi(): void;
  /** 親機が今つないでいる Wi-Fi の周波数(MHz)。未接続は 0 */
  wifiFrequency(): number;
  hasCellular(): boolean;
  bindToJoined(): boolean;
  unbindProcess(): void;
  probe(host: string, port: number): Promise<{ ok: boolean; rttMs?: number; error?: string }>;
  /**
   * 子機: ハートビート(親機のエコーへの定期接続)をネイティブで続ける(省略可。無い部品では JS の heartbeatLoop で動く)。
   * JS が止まっても(裏・画面オフ・Doze)続く。参加した Wi-Fi に bind して接続する(probe と同じ経路)。
   */
  heartbeatStart?(o: { host: string; port: number; intervalMs: number; timeoutMs: number; screenOffIntervalMs?: number; wakeLock?: boolean }): void;
  heartbeatStop?(): void;
  /** ネイティブが保持する最新の結果。時刻は Date.now() と同じ時計(0 = まだ無い) */
  heartbeatStatus?(): NativeHeartbeatStatus;
  /** ネイティブのハートビート結果が出るたび(JS が起きている間)。戻り値で購読解除 */
  onHeartbeat?(cb: (st: NativeHeartbeatStatus) => void): () => void;
  /** Wi-Fi 切断(参加先が消えた)の通知。戻り値で購読解除 */
  onWifiLost(cb: () => void): () => void;
  /** 親機: Direct グループの変化(消滅・クライアント数)。省略可(古いネイティブでは来ない=グループの有無は不明として扱う) */
  onDirectGroup?(cb: (e: { up: boolean; clients: number; appInitiated?: boolean }) => void): () => void;
  /** 親機: エコー(9000)への子機の接続(子機のハートビート)。省略可 */
  onEchoAccept?(cb: () => void): () => void;
  /**
   * 子機: 端末の Wi-Fi 接続許可の画面が出る/閉じる通知(省略可)。phase 'show' = 出ている。
   * ok/declined/timeout/cancelled = 終わり。戻り値で購読解除
   */
  onJoinPrompt?(cb: (e: { ssid: string; phase: 'show' | 'ok' | 'declined' | 'timeout' | 'cancelled'; timeoutMs?: number }) => void): () => void;
}

export interface VpnPort {
  /** VPN の許可が済んでいれば true。未許可なら許可ダイアログを出して false */
  prepare(): boolean;
  start(host: string, port: number, user: string, pass: string): void;
  stop(): void;
  status(): { running: boolean; error: string | null };
}

export interface TetherPlatform {
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
  /** VPN 許可待ちの最長(秒)。既定 60 */
  vpnPermissionWaitSec?: number;
  /** 親機: 子機の能力を待つ最長時間(ms)。キャッシュがあれば待たない。既定 5000 */
  capsWaitMs?: number;
  /**
   * Wi-Fi Direct が生きている間の Nearby の扱い(両端末で同じにする。片方だけ 'suspend' のときは 'keep' のまま動く)。
   * 'keep'    = 従来どおり(Direct 中も Nearby をつなぎ続ける)
   * 'suspend' = Direct が確立したら Nearby の広告・探索・接続を止め、Direct が切れたときだけ再開する
   * 既定 'keep'(実機確認後に 'suspend' へ変える想定)
   */
  /** true: Nearby/Direct の不変条件(src/link/linkGovernor.ts)に違反したら例外を投げる(テスト用)。既定 false=拒否して DH-LINK にログ */
  strictLinkGuard?: boolean;
  /**
   * Direct 稼働中の Nearby の扱い。既定は DEFAULT_NEARBY_WHILE_DIRECT(src/link/linkMode.ts)。
   * これは**自分の希望**で、実効の方式は接続の最初の hello で相手と交換して決まる(両方 suspend のときだけ suspend。linkSnapshot().mode)。
   */
  nearbyWhileDirect?: 'keep' | 'suspend';
  /** 子機のハートビートを画面オフ中だけ延ばす間隔(ms)。省略=延ばさない。T_echo の半分を超えない範囲に丸める */
  hbScreenOffIntervalMs?: number;
  /** ネイティブのハートビートが動いている間 PARTIAL_WAKE_LOCK を保持するか。既定 true */
  hbWakeLock?: boolean;
  /**
   * 時間の設定（開始待ち・タイムアウト・閾値。すべて任意）。範囲外は既定に丸めてログ、T_echo < T_direct < T_nearby は補正してログ。
   * 型・既定・範囲は src/link/timingConfig.ts。start() のたびに「既定 < ここ < setTimingOverride で保存した値」で決まり、
   * suspend 方式の子機は共有分（閾値・hb・再接続）を親機の値に揃える。
   */
  timing?: Partial<LinkTimingConfig>;
  /** true: timing の範囲チェックを省く（テスト用に短い時間を使う） */
  timingUnchecked?: boolean;
  /** 方式判断の方針(台数の上限・既存接続の扱いなど) */
  planPolicy?: Partial<PlanPolicy>;
}

/** 交換・判断の進行を知らせるイベント(onHandshake) */
export type HandshakeEvent =
  | { type: 'caps-received'; peerId: string; cached: boolean; model: string | null }
  | { type: 'plan'; side: 'host' | 'guest'; plan: LinkPlan }
  /** 更新が必要。who = 更新すべき側 */
  | { type: 'update-required'; who: 'host' | 'guest' };
