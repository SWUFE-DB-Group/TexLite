import { describe, expect, it } from "vitest";
import { isProjectIconName, normalizeLucideIconName, projectIconNames } from "../src/shared/projectIcons.js";

describe("project icon catalog", () => {
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
    expect(normalizeLucideIconName("lucide:file-text")).toBe("file-text");
    expect(normalizeLucideIconName("FileText")).toBeNull();
    expect(normalizeLucideIconName("file_text")).toBeNull();
    expect(normalizeLucideIconName("not/an/icon")).toBeNull();
    expect(isProjectIconName("air-vent")).toBe(false);
  });
});
