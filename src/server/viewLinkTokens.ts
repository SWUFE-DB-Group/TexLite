import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import type { ViewLinkRow } from "./viewLinks.js";
import { digestToken } from "./security.js";

/** Keep this file alongside the database when backing up read-only links. */
export const VIEW_LINK_KEY_FILE = "view-link-token.key";

function encryptionKey(config: Pick<Config, "dataDir">, create: boolean): Buffer {
  const file = path.join(config.dataDir, VIEW_LINK_KEY_FILE);
  if (create && !fs.existsSync(file)) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error("Invalid read-only link encryption key");
  return key;
}

type Binding = Pick<ViewLinkRow, "id" | "project_id">;
const associatedData = (row: Binding) => Buffer.from(JSON.stringify(["TexLite view link", row.project_id, row.id]));

export function encryptViewLinkToken(config: Pick<Config, "dataDir">, row: Binding, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(config, true), iv);
  cipher.setAAD(associatedData(row));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

/** Missing legacy secrets or an unavailable key must not hide revocation controls. */
export function decryptViewLinkToken(config: Pick<Config, "dataDir">, row: ViewLinkRow): string | null {
  if (!row.token_ciphertext) return null;
  try {
    const [version, iv, tag, ciphertext, extra] = row.token_ciphertext.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext || extra !== undefined) return null;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(config, false), Buffer.from(iv, "base64url"));
    decipher.setAAD(associatedData(row));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const token = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    return /^[A-Za-z0-9_-]{43}$/.test(token) && digestToken(token) === row.token_hash ? token : null;
  } catch { return null; }
}
