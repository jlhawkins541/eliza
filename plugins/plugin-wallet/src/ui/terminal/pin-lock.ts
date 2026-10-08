/**
 * PIN lock for the crypto terminal: a salted PBKDF2-SHA-256 hash of a 4 to 8
 * digit PIN, the idle auto-lock setting, and the wrong-PIN cooldown, as
 * functions over a plain persisted record.
 *
 * The lock hides the terminal in this browser. It does not encrypt terminal
 * data and holds no wallet keys, which stay with the agent's wallet backend.
 * The PIN itself is never stored, and a check compares derived bytes in
 * constant time. Hashing needs Web Crypto, which browsers expose only in a
 * secure context; without it every operation reports `unavailable` rather
 * than falling back to a weaker check. Persisted input is untrusted and goes
 * through {@link parsePinLock}.
 */

export const PIN_PATTERN = /^\d{4,8}$/;
/** PBKDF2-SHA-256 work factor for new PINs (OWASP 2023 guidance). */
export const PIN_HASH_ITERATIONS = 600_000;
export const PIN_FAILURES_BEFORE_COOLDOWN = 5;
export const PIN_COOLDOWN_BASE_MS = 30_000;
export const PIN_COOLDOWN_MAX_MS = 15 * 60_000;
export const AUTO_LOCK_CHOICES = [5, 15, 30] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_CHOICES)[number];
export const DEFAULT_AUTO_LOCK_MINUTES: AutoLockMinutes = 15;

const MIN_ITERATIONS = 1_000;
const MAX_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

export interface PinLockRecord {
  version: 1;
  /** Base64 random salt. */
  salt: string;
  /** Base64 PBKDF2-SHA-256 output for the PIN. */
  hash: string;
  iterations: number;
  autoLockMinutes: AutoLockMinutes;
  /** Wrong PINs since the last correct one. */
  failures: number;
  /** Epoch milliseconds before which no PIN is checked. */
  lockedUntil: number | null;
}

export type ParsedPinLock =
  | { status: "empty"; record: null }
  | { status: "ok"; record: PinLockRecord }
  | { status: "invalid"; record: null; error: string };

export type PinCheck =
  | { status: "ok"; record: PinLockRecord }
  | { status: "wrong"; record: PinLockRecord; attemptsLeft: number }
  | { status: "cooling-down"; record: PinLockRecord; retryAt: number }
  | { status: "unavailable" };

export function isValidPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

function subtle(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function derive(
  crypto: SubtleCrypto,
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/** Hash a new PIN; the caller validates it with {@link isValidPin} first. */
export async function createPinLock(
  pin: string,
  autoLockMinutes: AutoLockMinutes,
  iterations: number = PIN_HASH_ITERATIONS,
): Promise<
  | { ok: true; record: PinLockRecord }
  | { ok: false; reason: "invalid-pin" | "unavailable" }
> {
  if (!isValidPin(pin)) return { ok: false, reason: "invalid-pin" };
  const crypto = subtle();
  if (!crypto) return { ok: false, reason: "unavailable" };
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(crypto, pin, salt, iterations);
  return {
    ok: true,
    record: {
      version: 1,
      salt: toBase64(salt),
      hash: toBase64(hash),
      iterations,
      autoLockMinutes,
      failures: 0,
      lockedUntil: null,
    },
  };
}

function cooldownFor(failures: number): number {
  const rounds = Math.floor(failures / PIN_FAILURES_BEFORE_COOLDOWN);
  return Math.min(
    PIN_COOLDOWN_BASE_MS * 2 ** (rounds - 1),
    PIN_COOLDOWN_MAX_MS,
  );
}

/**
 * Check a PIN. A wrong PIN is counted, and every fifth wrong PIN in a row
 * starts a cooldown that doubles each time, up to fifteen minutes. During a
 * cooldown no PIN is hashed or compared.
 */
export async function checkPin(
  record: PinLockRecord,
  pin: string,
  now: number,
): Promise<PinCheck> {
  if (record.lockedUntil !== null && now < record.lockedUntil) {
    return { status: "cooling-down", record, retryAt: record.lockedUntil };
  }
  const crypto = subtle();
  if (!crypto) return { status: "unavailable" };
  const derived = await derive(
    crypto,
    pin,
    fromBase64(record.salt),
    record.iterations,
  );
  if (sameBytes(derived, fromBase64(record.hash))) {
    return {
      status: "ok",
      record: { ...record, failures: 0, lockedUntil: null },
    };
  }
  const failures = record.failures + 1;
  if (failures % PIN_FAILURES_BEFORE_COOLDOWN === 0) {
    const retryAt = now + cooldownFor(failures);
    return {
      status: "cooling-down",
      record: { ...record, failures, lockedUntil: retryAt },
      retryAt,
    };
  }
  return {
    status: "wrong",
    record: { ...record, failures, lockedUntil: null },
    attemptsLeft:
      PIN_FAILURES_BEFORE_COOLDOWN - (failures % PIN_FAILURES_BEFORE_COOLDOWN),
  };
}

function isBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    fromBase64(value);
    return true;
  } catch {
    // error-policy:J3 malformed base64 makes the whole record invalid.
    return false;
  }
}

/** Parse a stored lock. An unreadable record is reported, never ignored. */
export function parsePinLock(raw: string | null): ParsedPinLock {
  if (raw === null) return { status: "empty", record: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // error-policy:J3 an unreadable record becomes an explicit invalid result.
    return {
      status: "invalid",
      record: null,
      error: "Saved PIN lock was not valid JSON",
    };
  }
  const record = value as Partial<Record<keyof PinLockRecord, unknown>> | null;
  const valid =
    record?.version === 1 &&
    isBase64(record.salt) &&
    isBase64(record.hash) &&
    typeof record.iterations === "number" &&
    Number.isInteger(record.iterations) &&
    record.iterations >= MIN_ITERATIONS &&
    record.iterations <= MAX_ITERATIONS &&
    AUTO_LOCK_CHOICES.includes(record.autoLockMinutes as AutoLockMinutes) &&
    typeof record.failures === "number" &&
    Number.isInteger(record.failures) &&
    record.failures >= 0 &&
    (record.lockedUntil === null ||
      (typeof record.lockedUntil === "number" &&
        Number.isFinite(record.lockedUntil)));
  if (!valid) {
    return {
      status: "invalid",
      record: null,
      error: "Saved PIN lock had an unexpected shape",
    };
  }
  return { status: "ok", record: record as PinLockRecord };
}
