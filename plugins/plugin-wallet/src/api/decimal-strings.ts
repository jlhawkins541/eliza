/**
 * Exact arithmetic on plain non-negative decimal strings ("12", "0.0001") for
 * the terminal's exchange orders, where amounts must never pass through
 * floating point. Every helper rejects any other shape (exponents, signs,
 * blanks) with {@link DecimalStringError} instead of guessing, so a venue
 * value or setting that is not a plain decimal fails loudly at the caller.
 */

const PLAIN_DECIMAL = /^\d+(?:\.\d+)?$/;

export class DecimalStringError extends Error {
  constructor(readonly value: string) {
    super(`"${value}" is not a plain decimal number.`);
    this.name = "DecimalStringError";
  }
}

/** True when `value` is a plain non-negative decimal string. */
export function isPlainDecimal(value: string): boolean {
  return PLAIN_DECIMAL.test(value);
}

function checked(value: string): string {
  if (!PLAIN_DECIMAL.test(value)) throw new DecimalStringError(value);
  return value;
}

function scaleOf(...values: string[]): number {
  return Math.max(...values.map((value) => (value.split(".")[1] ?? "").length));
}

function scaled(value: string, scale: number): bigint {
  const [whole, fraction = ""] = checked(value).split(".");
  return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
}

function unscaled(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Compare two decimal strings exactly: -1, 0 or 1. */
export function compareDecimals(a: string, b: string): number {
  const scale = scaleOf(a, b);
  const left = scaled(a, scale);
  const right = scaled(b, scale);
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Multiply two decimal strings exactly. */
export function multiplyDecimals(a: string, b: string): string {
  const scaleA = scaleOf(a);
  const scaleB = scaleOf(b);
  return unscaled(scaled(a, scaleA) * scaled(b, scaleB), scaleA + scaleB);
}

/** `a - b` exactly, or "0" when `b` is larger: nothing is left. */
export function subtractDecimalsFloor(a: string, b: string): string {
  const scale = scaleOf(a, b);
  const difference = scaled(a, scale) - scaled(b, scale);
  return difference > 0n ? unscaled(difference, scale) : "0";
}

/** The larger of two decimal strings. */
export function maxDecimal(a: string, b: string): string {
  return compareDecimals(a, b) >= 0 ? a : b;
}

/** True when `value` is a whole multiple of `step`. */
export function isMultipleOf(value: string, step: string): boolean {
  const scale = scaleOf(value, step);
  const divisor = scaled(step, scale);
  return divisor > 0n && scaled(value, scale) % divisor === 0n;
}
