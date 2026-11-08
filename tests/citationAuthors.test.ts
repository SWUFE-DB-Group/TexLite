import { describe, expect, it } from "vitest";
import { formatCitationAuthors } from "../src/client/citationAuthors";

const labels = {
  authorsTruncated: (names: string, count: number) => `${names} et al. (${count} authors)`,
  authorsOthers: (names: string) => `${names} et al.`
};

describe("citation author display", () => {
  it("lists up to three authors and shortens longer lists to the first author", () => {
    expect(formatCitationAuthors("Smith, Ada and Jones, Bob and Lee, C.", labels)).toBe("Smith, Ada; Jones, Bob; Lee, C.");
    expect(formatCitationAuthors("A and B and C and D", labels)).toBe("A et al. (4 authors)");
  });

  it("splits on the TeX source, then shows each name as readable text", () => {
    expect(formatCitationAuthors(`G{\\"o}del, Kurt and {Barnes and Noble} and Erd{\\H{o}}s, Paul`, labels))
      .toBe("Gödel, Kurt; Barnes and Noble; Erdős, Paul");
  });

  it("marks an `and others` list without inventing a total", () => {
    expect(formatCitationAuthors("A and others", labels)).toBe("A et al.");
    expect(formatCitationAuthors("A and B and C and D and others", labels)).toBe("A et al.");
  });
});
