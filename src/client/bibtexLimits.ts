function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function citationBibtexLimit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Citation BibTeX limit must be a positive integer.");
  }
  return maxBytes;
}

export function citationBibtexLimitLabel(maxBytes: number): string {
  return `${Math.round(citationBibtexLimit(maxBytes) / 1024)} KB`;
}

export function isBibtexTooLarge(source: string, maxBytes: number): boolean {
  return byteLength(source) > citationBibtexLimit(maxBytes);
}
