import { describe, expect, it } from "vitest";
import { processName } from "../src/server/pm2.js";
import { defaultConfigPath } from "../src/server/runtimePaths.js";

describe("PM2 instance identity", () => {
  it("is stable for one absolute configuration path", () => {
    expect(processName("/tmp/texlite.json")).toBe(processName("/tmp/./texlite.json"));
  });

  it("uses the conventional name for the XDG default configuration", () => {
    expect(processName(defaultConfigPath())).toBe("texlite");
  });

  it("separates independent configuration paths", () => {
    expect(processName("/tmp/texlite-a.json")).not.toBe(processName("/tmp/texlite-b.json"));
  });

  it("does not expose the configuration path in the process name", () => {
    expect(processName("/tmp/private/with secrets/texlite.json")).toMatch(/^texlite-[0-9a-f]{8}$/);
  });
});
