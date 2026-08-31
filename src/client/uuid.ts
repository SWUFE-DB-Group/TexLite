/**
 * Generate a UUID suitable for client-side correlation IDs.
 *
 * `crypto.randomUUID()` is restricted to secure contexts, so it is absent on
 * ordinary HTTP LAN origins. `crypto.getRandomValues()` remains available
 * there and gives us the same UUID v4 quality. The final fallback only serves
 * legacy browsers where Web Crypto itself is unavailable; these IDs are never
 * used for authentication or authorization.
 */
export interface UuidRandomSource {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
}

function fallbackRandomBytes(bytes: Uint8Array): Uint8Array {
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function formatUuidV4(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function clientUuid(source: UuidRandomSource | undefined = globalThis.crypto): string {
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  const randomBytes = typeof source?.getRandomValues === "function"
    ? source.getRandomValues(bytes)
    : fallbackRandomBytes(bytes);
  return formatUuidV4(randomBytes);
}
