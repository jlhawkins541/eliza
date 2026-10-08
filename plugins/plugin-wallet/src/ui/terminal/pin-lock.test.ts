/**
 * Tests of the terminal PIN lock over real Web Crypto PBKDF2 (with a lower
 * work factor for speed): PIN rules, salted records that never hold the PIN,
 * verification, the escalating wrong-PIN cooldown, the no-Web-Crypto state,
 * and parsing of stored records. Deterministic apart from the random salt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkPin,
  createPinLock,
  isValidPin,
  PIN_COOLDOWN_BASE_MS,
  PIN_COOLDOWN_MAX_MS,
  type PinLockRecord,
  parsePinLock,
} from "./pin-lock";

const PIN = "2580";
const FAST = 1_000;

async function record(pin = PIN): Promise<PinLockRecord> {
  const created = await createPinLock(pin, 15, FAST);
  if (!created.ok) throw new Error(`fixture PIN rejected: ${created.reason}`);
  return created.record;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isValidPin and createPinLock", () => {
  it("accepts 4 to 8 digits only", () => {
    expect(["1234", "12345678"].every(isValidPin)).toBe(true);
    expect(["123", "123456789", "12a4", " 1234", ""].some(isValidPin)).toBe(
      false,
    );
  });

  it("refuses an invalid PIN without hashing", async () => {
    expect(await createPinLock("12", 15, FAST)).toEqual({
      ok: false,
      reason: "invalid-pin",
    });
  });

  it("stores a salted hash, never the PIN", async () => {
    const first = await record();
    const second = await record();
    expect(first).toMatchObject({
      version: 1,
      iterations: FAST,
      autoLockMinutes: 15,
      failures: 0,
      lockedUntil: null,
    });
    expect(atob(first.salt)).toHaveLength(16);
    expect(atob(first.hash)).toHaveLength(32);
    expect(JSON.stringify(first)).not.toContain(PIN);
    expect(second.salt).not.toBe(first.salt);
    expect(second.hash).not.toBe(first.hash);
  });
});

describe("checkPin", () => {
  it("accepts the right PIN and clears earlier failures", async () => {
    const saved = await record();
    const wrong = await checkPin(saved, "1111", 0);
    expect(wrong).toMatchObject({ status: "wrong", attemptsLeft: 4 });
    if (wrong.status !== "wrong") return;
    const right = await checkPin(wrong.record, PIN, 1);
    expect(right).toMatchObject({
      status: "ok",
      record: { failures: 0, lockedUntil: null },
    });
  });

  it("cools down after five wrong PINs, doubling each round up to the cap", async () => {
    let current = await record();
    let now = 1_000_000;
    const failRound = async (): Promise<number> => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const checked = await checkPin(current, "9999", now);
        if (checked.status === "unavailable") throw new Error("no crypto");
        current = checked.record;
        if (checked.status === "cooling-down") return checked.retryAt - now;
        expect(checked.status).toBe("wrong");
      }
      throw new Error("no cooldown after five wrong PINs");
    };

    expect(await failRound()).toBe(PIN_COOLDOWN_BASE_MS);
    // Even the right PIN is not checked during the cooldown.
    const blocked = await checkPin(current, PIN, now + 1);
    expect(blocked).toMatchObject({ status: "cooling-down" });
    if (blocked.status !== "cooling-down") return;
    expect(blocked.record).toBe(current);

    now += PIN_COOLDOWN_BASE_MS;
    expect(await failRound()).toBe(PIN_COOLDOWN_BASE_MS * 2);
    for (let round = 0; round < 6; round += 1) {
      now += PIN_COOLDOWN_MAX_MS;
      await failRound();
    }
    now += PIN_COOLDOWN_MAX_MS;
    expect(await failRound()).toBe(PIN_COOLDOWN_MAX_MS);

    now += PIN_COOLDOWN_MAX_MS;
    expect(await checkPin(current, PIN, now)).toMatchObject({ status: "ok" });
  });

  it("reports unavailable without Web Crypto instead of a weaker check", async () => {
    const saved = await record();
    vi.stubGlobal("crypto", {});
    expect(await createPinLock(PIN, 15, FAST)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await checkPin(saved, PIN, 0)).toEqual({ status: "unavailable" });
  });
});

describe("parsePinLock", () => {
  it("is empty when nothing is stored and round-trips a saved lock", async () => {
    expect(parsePinLock(null)).toEqual({ status: "empty", record: null });
    const saved = await record();
    expect(parsePinLock(JSON.stringify(saved))).toEqual({
      status: "ok",
      record: saved,
    });
  });

  it("reports unreadable records", async () => {
    const saved = await record();
    const cases: Array<[string, RegExp]> = [
      ["{broken", /not valid JSON/],
      [JSON.stringify({ ...saved, version: 2 }), /unexpected shape/],
      [JSON.stringify({ ...saved, iterations: 1 }), /unexpected shape/],
      [JSON.stringify({ ...saved, autoLockMinutes: 7 }), /unexpected shape/],
      [JSON.stringify({ ...saved, hash: "%%%" }), /unexpected shape/],
      [JSON.stringify({ ...saved, failures: -1 }), /unexpected shape/],
    ];
    for (const [raw, error] of cases) {
      const parsed = parsePinLock(raw);
      expect(parsed.status).toBe("invalid");
      if (parsed.status === "invalid") expect(parsed.error).toMatch(error);
    }
  });
});
