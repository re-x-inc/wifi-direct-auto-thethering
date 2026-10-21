/**
 * @re-x/wifi-direct-tether の公開 API。
 * 使い方は docs/API.md を参照。ネイティブモジュール(modules/*)は、利用側アプリが
 * `expo.autolinking.searchPaths` でこのリポジトリの modules/ を指して取り込む。
 */
export { Tether } from './tether';
// nativePlatform（生の Nearby/Hotspot を持つ部品）は公開しない: 公開すると LinkGovernor（不変条件 I1〜I6）を迂回して Nearby/Direct を触れてしまう。
// 利用側は getTether() だけを使う（getTether が内部で nativePlatform を使い、Tether が governor 経由でネイティブを包む）
export { getTether } from './native';
export { TetherError } from './types';
export { joinFailureDetail, joinFailureText, parseJoinFailure } from './joinFailure';
export type { JoinFailure, JoinFailureReason } from './joinFailure';
export {
  buildCapabilities, capsRevision, describeCapabilities, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, sanitizeCapabilities,
} from './capability';
export type { Capabilities, CapabilityPort, HistoryEntry, NativeCapabilities, RadioKey, Tri } from './capability';
export {
  buildDiagnosticReport, compareReports, comparisonMarkdown, DIAG_SCHEMA, looksPersonal, redactItem, reportFileName, reportToJson, summarizeReport,
} from './diagnostics';
export type { ComparisonRow, DiagItem, DiagnosticReport, DiagSource, NativeDiagnostics } from './diagnostics';
export { DEFAULT_POLICY, isCompatibleVersion, issueGuestCredentials, METHODS, parsePlan, planLink, REASON_MESSAGES } from './planner';
export type {
  Admission, GuestEntry, GuestPlan, GuestTodo, LinkMethod, LinkPlan, PlanFailure, PlanInput, PlanPolicy, Reason, ReasonCode, Severity,
} from './planner';
export type {
  Confirm,
  Found,
  HandshakeEvent,
  HotspotPort,
  Identity,
  LinkPhase,
  MessageMeta,
  Pair,
  PairingResult,
  SendOptions,
  StartOptions,
  TetherConfig,
  TetherErrorCode,
  TetherPlatform,
  TetherRole,
  TetherState,
  VpnPort,
} from './types';
