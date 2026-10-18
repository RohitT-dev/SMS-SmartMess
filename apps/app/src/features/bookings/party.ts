import {
  RELATION_LABELS,
  getRank,
  type GuestDemand,
  type GuestRelation,
  type RankCode,
} from '@sms/core';

/** Short label for one person in a party: rank (or relation for civilians) and gender. */
export function describeGuest(g: {
  gender: string;
  rankCode?: RankCode | string | null;
  /** Database rows (booking_guests) carry the rank in snake_case. */
  rank_code?: RankCode | string | null;
  relation?: GuestRelation | string | null;
}): string {
  const gender = g.gender === 'F' ? 'Female' : 'Male';
  const rankCode = g.rankCode ?? g.rank_code;
  if (rankCode) {
    const role = g.relation === 'PRIMARY' ? ' · Primary' : '';
    let rank = String(rankCode);
    try {
      rank = getRank(rankCode as RankCode).label;
    } catch {
      // unknown code: show it as is
    }
    return `${rank}${role} • ${gender}`;
  }
  const relation = RELATION_LABELS[(g.relation as GuestRelation) ?? 'OTHER'] ?? 'Civilian';
  return `${relation} (civilian) • ${gender}`;
}
