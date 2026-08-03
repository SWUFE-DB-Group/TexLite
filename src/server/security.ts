import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
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
