/**
 * Parses an optional "YYYY-MM-DD" valid-until date into an ISO timestamp at the
 * end of that local day. Returns null for blank input; throws on bad input.
 */
export function parseValidUntil(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Valid-until date must look like YYYY-MM-DD');
  const [, y, m, d] = match.map(Number);
  const endOfDay = new Date(y, m - 1, d, 23, 59, 59);
  if (endOfDay.getMonth() !== m - 1 || endOfDay.getDate() !== d) {
    throw new Error('Valid-until is not a real date');
  }
  if (endOfDay.getTime() <= Date.now()) {
    throw new Error('Valid-until must be in the future');
  }
  return endOfDay.toISOString();
}
