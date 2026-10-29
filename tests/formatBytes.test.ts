import { describe, expect, it } from "vitest";
import { formatBytes } from "../src/client/formatBytes";

describe("byte-size formatting", () => {
  it.each([
    [0, "0 B"], [1023, "1023 B"], [1024, "1.0 KB"],
    [1536, "1.5 KB"], [1024 ** 2, "1.0 MB"], [1024 ** 3, "1.0 GB"]
  ])("formats %s bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("preserves compact snapshot sizes without trailing zeros", () => {
    expect(formatBytes(128 * 1024 ** 2, { trimTrailingZero: true })).toBe("128 MB");
    expect(formatBytes(1.5 * 1024, { trimTrailingZero: true })).toBe("1.5 KB");
  });

  it("keeps memory values in MB or GB, including small samples", () => {
    const options = { minimumUnit: "MB", trimTrailingZero: true } as const;
    expect(formatBytes(0, options)).toBe("0 MB");
    expect(formatBytes(512 * 1024, options)).toBe("0.5 MB");
    expect(formatBytes(1024 ** 3, options)).toBe("1 GB");
  });

  it("preserves MB as the upper unit for upload and resource descriptions", () => {
    expect(formatBytes(1024 ** 3, { maximumUnit: "MB" })).toBe("1024.0 MB");
    expect(formatBytes(1024, { maximumUnit: "MB" })).toBe("1.0 KB");
  });

  it.each([NaN, Infinity, -1])("omits invalid sizes (%s), as PDF metadata requires", (bytes) => {
    expect(formatBytes(bytes)).toBe("");
  });
});
