import { digest } from "lib0/hash/sha256";

/**
 * Use the same UTF-8 SHA-256 representation as the server when a browser
 * action needs to be bound to one exact source revision.
 */
export function sourceHash(source: string): string {
  return Array.from(digest(new TextEncoder().encode(source)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
