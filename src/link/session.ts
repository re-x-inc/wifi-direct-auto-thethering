import { NearbyApi, NearbyOptions, NearbyTransport } from './nearbyTransport';
import { LinkSupervisor, Options } from './supervisor';

/** 保存済みの相手へ自動接続・自動復帰する端末間リンクを作る。run() で開始、stop() で終了。 */
export function createLink(
  api: NearbyApi,
  nearby: NearbyOptions,
  onReceive: (body: unknown) => void,
  opts: Partial<Options> = {},
): LinkSupervisor {
  return new LinkSupervisor(() => new NearbyTransport(api, nearby), onReceive, opts);
}
