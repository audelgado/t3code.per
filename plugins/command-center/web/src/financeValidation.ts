/** Same cents bound accepted by the finance service; decimal notation only. */
export function financeAmount(value: string): number | null {
  const text = value.trim();
  if (!/^(?:\d+(?:[.,]\d{0,2})?|[.,]\d{1,2})$/.test(text)) return null;
  const cents = Math.round(Number(text.replace(",", ".")) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 1e12 ? cents : null;
}
