const units = ["B", "KB", "MB", "GB"] as const;
type ByteUnit = typeof units[number];

/** Binary-size units, using the KB/MB labels already used throughout the UI. */
export function formatBytes(bytes: number, options: {
  minimumUnit?: ByteUnit;
  maximumUnit?: ByteUnit;
  trimTrailingZero?: boolean;
} = {}): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  const minimum = units.indexOf(options.minimumUnit ?? "B");
  const maximum = units.indexOf(options.maximumUnit ?? "GB");
  let unit = minimum;
  while (unit < maximum && bytes >= 1024 ** (unit + 1)) unit++;
  const value = bytes / 1024 ** unit;
  const number = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${options.trimTrailingZero ? Number(number) : number} ${units[unit]}`;
}
