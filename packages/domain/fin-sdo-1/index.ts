/**
 * FIN-SDO-1 money rules. Never parse plan amounts with Number/parseFloat.
 * User/API unit: millions RUB with exactly 2 fractional digits.
 * Database unit: RUB NUMERIC(20,2), transferred as decimal strings.
 */
export class FinPlanInputError extends Error {
  constructor(readonly code: 'FIN_MONEY_INVALID' | 'FIN_QUARTER_TOTAL_BELOW_MIN' | 'FIN_QUARTER_TOTAL_OVERFLOW', message: string = code) {
    super(message);
    this.name = 'FinPlanInputError';
  }
}

export const FIN_MIN_QUARTER_RUB_KOPEKS = 1_000_000_000n; // 10,000,000 RUB
const MAX_RUB_KOPEKS = 10n ** 20n - 1n; // NUMERIC(20,2) range

export function millionRubToKopeks(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,13})\.\d{2}$/.test(value)) {
    throw new FinPlanInputError('FIN_MONEY_INVALID', 'Expected canonical decimal string of millions RUB (e.g. 10.00)');
  }
  const [whole, fractions] = value.split('.');
  const kopeks = BigInt(whole) * 100_000_000n + BigInt(fractions) * 1_000_000n;
  if (kopeks > MAX_RUB_KOPEKS) throw new FinPlanInputError('FIN_QUARTER_TOTAL_OVERFLOW');
  return kopeks;
}

export function kopeksToRub(value: bigint): string {
  if (value < 0n || value > MAX_RUB_KOPEKS) throw new FinPlanInputError('FIN_QUARTER_TOTAL_OVERFLOW');
  return (value / 100n).toString() + '.' + (value % 100n).toString().padStart(2, '0');
}

export function rubToMillionRub(value: string): string {
  if (!/^(?:0|[1-9]\d*)\.\d{2}$/.test(value)) throw new FinPlanInputError('FIN_MONEY_INVALID');
  const [whole, fraction] = value.split('.');
  const kop = BigInt(whole) * 100n + BigInt(fraction);
  if (kop > MAX_RUB_KOPEKS || kop % 1_000_000n !== 0n)
    throw new FinPlanInputError('FIN_MONEY_INVALID', 'Plan RUB must be a multiple of 10,000.00');
  return (kop / 100_000_000n).toString() + '.' + ((kop % 100_000_000n) / 1_000_000n).toString().padStart(2, '0');
}

export function sumPlanLinesMln(amounts: readonly string[]): { totalKopeks: bigint; totalRub: string; totalMln: string } {
  let total = 0n;
  for (const amount of amounts) total += millionRubToKopeks(amount);
  if (total > MAX_RUB_KOPEKS) throw new FinPlanInputError('FIN_QUARTER_TOTAL_OVERFLOW');
  const totalRub = kopeksToRub(total);
  const totalMln = (total / 100_000_000n).toString() + '.' +
    ((total % 100_000_000n) / 1_000_000n).toString().padStart(2, '0');
  return { totalKopeks: total, totalRub, totalMln };
}

export function requireQuarterMinimum(amounts: readonly string[]) {
  const result = sumPlanLinesMln(amounts);
  if (result.totalKopeks < FIN_MIN_QUARTER_RUB_KOPEKS) {
    throw new FinPlanInputError('FIN_QUARTER_TOTAL_BELOW_MIN', 'Total quarter plan must be at least 10.00 million RUB');
  }
  return result;
}
export const FIN_PLAN_READ_ROLES = [
  'SDO', 'SDO_HEAD', 'GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR', 'ADMIN'
] as const;
export const FIN_PLAN_WRITE_ROLES = ['SDO', 'SDO_HEAD', 'ADMIN'] as const;
export function canReadFinPlan(role: string): boolean {
  return (FIN_PLAN_READ_ROLES as readonly string[]).includes(role);
}
export function canWriteFinPlan(role: string): boolean {
  return (FIN_PLAN_WRITE_ROLES as readonly string[]).includes(role);
}
