/**
 * Direct 稼働中の Nearby の扱い(keep / suspend)を、親機と子機で揃えるための純関数と定数。docs/LINK_STATE.md「方式の交換」。
 *
 * - 既定値の定義はここ 1 箇所(DEFAULT_NEARBY_WHILE_DIRECT)。TetherConfig.nearbyWhileDirect を指定しなくても両端末が同じになる。
 * - 実効方式は「両方が suspend を名乗ったときだけ suspend」。どちらかが keep、または名乗りなし(旧版)・未確定なら keep(安全側)。
 */
export type NearbyWhileDirect = 'keep' | 'suspend';

/** 既定の方式。ここを変えると両端末の既定が同時に変わる(今は keep。mobile は suspend を明示している) */
export const DEFAULT_NEARBY_WHILE_DIRECT: NearbyWhileDirect = 'keep';

/** 相手の名乗り。'legacy' = hello に名乗りがない旧版、null = まだ hello を受け取っていない */
export type PeerMode = NearbyWhileDirect | 'legacy' | null;

export interface LinkModeInfo {
  self: NearbyWhileDirect;
  peer: PeerMode;
  effective: NearbyWhileDirect;
  reason: string;
}

export const asMode = (x: unknown): NearbyWhileDirect | null => (x === 'keep' || x === 'suspend' ? x : null);

/** 実効方式を決める。self は「この端末が実際に使える方式」(suspend 未対応の Nearby 部品なら keep) */
export function decideLinkMode(self: NearbyWhileDirect, peer: PeerMode): { effective: NearbyWhileDirect; reason: string } {
  if (peer === null) return { effective: 'keep', reason: '相手の名乗り待ち(確定前は安全側)' };
  if (peer === 'legacy') return { effective: 'keep', reason: '相手は方式の交換に未対応の旧版' };
  if (self === 'suspend' && peer === 'suspend') return { effective: 'suspend', reason: '両方 suspend' };
  return { effective: 'keep', reason: self === 'keep' ? '自分が keep' : '相手が keep' };
}

export const describeLinkMode = (m: LinkModeInfo): string =>
  `方式: 自分=${m.self} 相手=${m.peer === null ? '未確定' : m.peer === 'legacy' ? '名乗りなし(旧版)' : m.peer} → 実効=${m.effective}(${m.reason})`;
