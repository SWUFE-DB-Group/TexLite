import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/server/cli.js";

describe("CLI argument parsing", () => {
  it("accepts a command followed by an explicit config path", () => {
    expect(parseArgs(["start", "--config", "./custom.json"])).toEqual({
      command: "start",
      configPath: "./custom.json",
      checkGit: false
    });
  });

  it("accepts global options before the command", () => {
    expect(parseArgs(["--config=/tmp/texlite.json", "doctor", "--git"])).toEqual({
      command: "doctor",
      configPath: "/tmp/texlite.json",
      checkGit: true
    });
  });

  it("rejects an option without its value", () => {
    expect(() => parseArgs(["init", "--config"])).toThrow(/--config 需要一个配置文件路径/);
  });
});
