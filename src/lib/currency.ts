/**
 * The service is single-currency by design, and does no FX conversion.
 *
 * Upstream types `currency` as a bare string with no enum, so a foreign-currency
 * row is contractually possible. Summing one into the totals would corrupt the
 * metrics silently — a single USD credit nearly doubles `income_coverage_ratio`
 * — and the response labels every score EUR. So non-EUR rows are dropped at
 * ingest and counted, never converted and never combined. Policy:
 * docs/scoring-model.md.
 */
export const SUPPORTED_CURRENCY = 'EUR';

export function isSupportedCurrency(currency: string): boolean {
  return currency === SUPPORTED_CURRENCY;
}
