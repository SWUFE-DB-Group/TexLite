import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isProjectIconName, normalizeLucideIconName, projectIconNames } from "../src/shared/projectIcons.js";
import { lucideIconSvg, resolveLucideIconName } from "../src/server/lucideIcons.js";
import { legacyLucideBrandIcons } from "../src/shared/legacyLucideBrandIcons.js";

describe("project icon catalog", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["missing", "permission", "json", "shape"])("reports a %s generated icon manifest instead of rejecting a valid icon name", async (failure) => {
    vi.resetModules();
    const icons = await import("../src/server/lucideIcons.js");
    const read = vi.spyOn(fs, "readFileSync");
    if (failure === "missing" || failure === "permission") {
      read.mockImplementationOnce(() => { throw Object.assign(new Error("manifest unavailable"), { code: failure === "missing" ? "ENOENT" : "EACCES" }); });
    } else {
      read.mockReturnValueOnce(failure === "json" ? "not-json" : '{"selectableIconNames": [42]}');
    }
    expect(() => icons.resolveLucideIconName("file-text")).toThrow();
    read.mockRestore();
    expect(icons.resolveLucideIconName("file-text")).toBe("file-text");
  });

  it("propagates icon stat failures and retries failed SVG reads rather than caching the error as a missing icon", async () => {
    vi.resetModules();
    const icons = await import("../src/server/lucideIcons.js");
    const failure = Object.assign(new Error("icon permission denied"), { code: "EACCES" });
    const stat = vi.spyOn(fs, "statSync").mockImplementationOnce(() => { throw failure; });
    expect(() => icons.resolveLucideIconName("file-text")).toThrow(failure);
    stat.mockRestore();
    const read = vi.spyOn(fs.promises, "readFile").mockRejectedValueOnce(failure);
    await expect(icons.lucideIconSvg("atom")).rejects.toBe(failure);
    await expect(icons.lucideIconSvg("atom")).resolves.toMatch(/^<svg\b/);
    expect(read).toHaveBeenCalledTimes(2);
    read.mockRestore();
    expect(icons.resolveLucideIconName("not-a-texlite-icon")).toBeNull();
    await expect(icons.lucideIconSvg("not-a-texlite-icon")).resolves.toBeNull();
  });

  it("keeps persisted icon names within the curated catalog", () => {
    expect(projectIconNames).toHaveLength(70);
    expect(new Set(projectIconNames).size).toBe(70);
    expect(projectIconNames).toContain("file-text");
    expect(projectIconNames).toContain("brain-circuit");
    expect(projectIconNames).toContain("folder-git-2");
    expect(projectIconNames).toContain("calendar-days");
    expect(isProjectIconName("database")).toBe(true);
    expect(isProjectIconName("not-an-icon")).toBe(false);
    expect(isProjectIconName(null)).toBe(false);
  });

  it("accepts official Lucide slugs without widening the curated picker", () => {
    expect(normalizeLucideIconName("file-text")).toBe("file-text");
    expect(normalizeLucideIconName(" file-text ")).toBe("file-text");
    expect(normalizeLucideIconName("lucide:file-text")).toBeNull();
    expect(normalizeLucideIconName("Lucide:file-text")).toBeNull();
    expect(normalizeLucideIconName("FileText")).toBeNull();
    expect(normalizeLucideIconName("file_text")).toBeNull();
    expect(normalizeLucideIconName("not/an/icon")).toBeNull();
    expect(isProjectIconName("air-vent")).toBe(false);
  });

  it("accepts curated and official catalog names without accepting old generated spellings", () => {
    for (const name of [...projectIconNames, "file-code-2", "building-2", "history", "album", "alarm-clock-minus"]) {
      expect(resolveLucideIconName(name), name).toBe(name);
    }
    expect(resolveLucideIconName("file-code2")).toBeNull();
    expect(resolveLucideIconName("building2")).toBeNull();
    expect(resolveLucideIconName("lucide:alarm-clock-minus")).toBeNull();
    expect(resolveLucideIconName("Github")).toBeNull();
  });

  it("displays legacy icons without allowing them as new project selections", async () => {
    for (const name of Object.keys(legacyLucideBrandIcons)) {
      expect(resolveLucideIconName(name), name).toBeNull();
      expect(await lucideIconSvg(name), name).toMatch(/^<svg\b/);
    }
    expect(await lucideIconSvg("file-code2")).toMatch(/^<svg\b/);
    expect(await lucideIconSvg("lucide:file-text")).toBeNull();
  });
});
