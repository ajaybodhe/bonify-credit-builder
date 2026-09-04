/**
 * The one currency this service scores. Upstream types `currency` as a bare
 * string with no enum, so a foreign row is contractually possible; what happens
 * to one is `sync/service.ts`, and why is docs/scoring-model.md.
 */
export const SUPPORTED_CURRENCY = 'EUR';

export function isSupportedCurrency(currency: string): boolean {
  return currency === SUPPORTED_CURRENCY;
}
