import type { RankCode, RankInfo } from './constants.ts';
import { RANKS } from './constants.ts';

const RANK_MAP = new Map<RankCode, RankInfo>(RANKS.map((r) => [r.code, r]));

export function getRank(code: RankCode): RankInfo {
  const r = RANK_MAP.get(code);
  if (!r) {
    throw new Error(`Unknown rank code: ${code}`);
  }
  return r;
}

export function compareRanks(a: RankCode, b: RankCode): number {
  return getRank(a).seniority - getRank(b).seniority;
}

export function isSameRank(a: RankCode, b: RankCode): boolean {
  return a === b;
}
