/** "CONFIRMED" → "Confirmed", "OUT_OF_SERVICE" → "Out of service". For status enums shown to people. */
export function humanizeStatus(value: string | null | undefined): string {
  if (!value) return '';
  const words = value.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
