import { describe, expect, it } from "vitest";
import { AgentOutputBuffer } from "../src/server/agents/outputBuffer";

describe("agent output replay", () => {
  it("retains bounded chunks and preserves split input-mode changes across truncation", () => {
    const output = new AgentOutputBuffer(32);
    output.append("\x1b[?20"); output.append("04h");
    output.append("x".repeat(100));
    expect(output.replay()).toBe("x".repeat(32) + "\x18\x1b[?2004h");
    output.append("\x1b[?2004l");
    expect(output.replay()).toContain("\x18\x1b[?2004l");
    output.append("\x1b[?100");
    expect(output.replay()).toMatch(/\x18\x1b\[\?2004l\x1b\[\?100$/);
    output.append("6h");
    expect(output.replay()).toContain("\x1b[?1006h");
  });

  it("does not mistake title-string content for terminal modes or split a surrogate pair", () => {
    const output = new AgentOutputBuffer(5);
    output.append("\x1b]0;title \x1b[?2004h\x07");
    output.append("ab😀cde");
    expect(output.replay()).toBe("😀cde\x18");
    const untouched = new AgentOutputBuffer();
    untouched.append("\x1b[?2004hHello");
    expect(untouched.replay()).toBe("\x1b[?2004hHello");
  });
});
