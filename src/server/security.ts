import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";
import { httpError } from "./http.js";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, "PASSWORD_TOO_SHORT", { minLength: MIN_PASSWORD_LENGTH });
  }
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltText, keyText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !keyText) return false;
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(keyText, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSessionToken(): { token: string; digest: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, digest: digestToken(token) };
}

export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface AttemptRecord {
  count: number;
  firstAttemptMs: number;
  lockedUntilMs: number;
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;

  constructor(options: { maxAttempts?: number; windowMs?: number; lockoutMs?: number } = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.lockoutMs = options.lockoutMs ?? 15 * 60_000;
  }

  isLocked(key: string): boolean {
    const now = Date.now();
    const record = this.attempts.get(key);
    if (!record) return false;
    if (record.lockedUntilMs > now) return true;
    if (now - record.firstAttemptMs > this.windowMs && record.lockedUntilMs <= now) {
      this.attempts.delete(key);
      return false;
    }
    return false;
  }

  recordFailure(key: string): { locked: boolean; remainingAttempts: number; retryAfterSeconds: number } {
    const now = Date.now();
    let record = this.attempts.get(key);
    if (!record || (now - record.firstAttemptMs > this.windowMs && record.lockedUntilMs <= now)) {
      record = { count: 1, firstAttemptMs: now, lockedUntilMs: 0 };
      this.attempts.set(key, record);
      return { locked: false, remainingAttempts: this.maxAttempts - 1, retryAfterSeconds: 0 };
    }

    record.count += 1;
    if (record.count >= this.maxAttempts) {
      record.lockedUntilMs = now + this.lockoutMs;
      return { locked: true, remainingAttempts: 0, retryAfterSeconds: Math.ceil(this.lockoutMs / 1000) };
    }

    return {
      locked: false,
      remainingAttempts: Math.max(0, this.maxAttempts - record.count),
      retryAfterSeconds: 0
    };
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  clear(): void {
    this.attempts.clear();
  }

  prune(): void {
    const now = Date.now();
    for (const [key, record] of this.attempts.entries()) {
      if (record.lockedUntilMs <= now && now - record.firstAttemptMs > this.windowMs) {
        this.attempts.delete(key);
      }
    }
  }
}
