import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultConfigPath,
  defaultDataDirectory,
  packageClientDirectory,
  packageServerEntry,
  resolveConfigPath,
  texliteConfigDirectory,
  xdgConfigHome,
  xdgDataHome
} from "../src/server/runtimePaths.js";

describe("runtime paths", () => {
  it("uses XDG directories when they are configured", () => {
    const environment = { XDG_CONFIG_HOME: "/tmp/texlite-config", XDG_DATA_HOME: "/tmp/texlite-data" };
    expect(xdgConfigHome(environment)).toBe("/tmp/texlite-config");
    expect(xdgDataHome(environment)).toBe("/tmp/texlite-data");
    expect(texliteConfigDirectory(environment)).toBe("/tmp/texlite-config/texlite");
    expect(defaultConfigPath(environment)).toBe("/tmp/texlite-config/texlite/texlite.config.json");
    expect(defaultDataDirectory(environment)).toBe("/tmp/texlite-data/texlite");
  });

  it("falls back to the user's home directory", () => {
    const environment = {};
    const home = "/tmp/texlite-home";
    expect(xdgConfigHome(environment, home)).toBe(path.join(home, ".config"));
    expect(xdgDataHome(environment, home)).toBe(path.join(home, ".local", "share"));
    expect(defaultConfigPath(environment, home)).toBe(path.join(home, ".config", "texlite", "texlite.config.json"));
    expect(defaultDataDirectory(environment, home)).toBe(path.join(home, ".local", "share", "texlite"));
  });

  it("gives explicit and environment configuration paths precedence", () => {
    const environment = { TEXLITE_CONFIG: "/tmp/from-environment.json", XDG_CONFIG_HOME: "/tmp/xdg" };
    expect(resolveConfigPath(undefined, environment)).toBe("/tmp/from-environment.json");
    expect(resolveConfigPath("relative.json", environment)).toBe(path.resolve("relative.json"));
  });

  it("locates production client assets beside the compiled server", () => {
    expect(packageClientDirectory("file:///opt/texlite/dist/server/runtimePaths.js")).toBe("/opt/texlite/dist/client");
  });

  it("keeps source execution pointed at the repository build output", () => {
    expect(packageClientDirectory("file:///workspace/texlite/src/server/runtimePaths.ts")).toBe("/workspace/texlite/dist/client");
  });

  it("uses the dedicated service entry for managed processes", () => {
    expect(packageServerEntry("file:///opt/texlite/dist/server/runtimePaths.js")).toBe("/opt/texlite/dist/server/service.js");
  });
});
