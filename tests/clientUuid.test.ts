import { describe, expect, it } from "vitest";
import { clientUuid } from "../src/client/uuid";

describe("clientUuid", () => {
  it("uses the native secure-context implementation when available", () => {
    expect(clientUuid({ randomUUID: () => "native-id" })).toBe("native-id");
  });

  it("uses getRandomValues when randomUUID is unavailable on an HTTP origin", () => {
    const id = clientUuid({
      getRandomValues(values) {
        values.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        return values;
      }
    });
    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("still produces a UUID v4 when Web Crypto is unavailable", () => {
    const id = clientUuid({});
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
