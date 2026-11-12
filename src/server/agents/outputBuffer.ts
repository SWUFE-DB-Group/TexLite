/** Bounded chunk storage plus input modes that may outlive the retained output.
 * This is not a screen emulator: old scrollback and screen cells can be lost.
 */
export class AgentOutputBuffer {
  private chunks: string[] = [];
  private length = 0;
  private head = 0;
  private sequence = "";
  private state: "text" | "escape" | "csi" | "string" | "stringEscape" = "text";
  private modes = new Map<string, boolean>();
  private keypad: boolean | null = null;
  private truncated = false;
  constructor(private readonly limit = 256 * 1024) {}

  append(data: string): void {
    if (!data) return;
    for (const char of data) this.track(char);
    this.chunks.push(data);
    this.length += data.length;
    while (this.length > this.limit && this.head < this.chunks.length) {
      this.truncated = true;
      const chunk = this.chunks[this.head];
      const excess = this.length - this.limit;
      if (chunk.length <= excess) {
        this.length -= chunk.length;
        this.chunks[this.head++] = "";
      } else {
        let cut = excess;
        if (/^[\uDC00-\uDFFF]$/.test(chunk[cut] ?? "")) cut++;
        this.chunks[this.head] = chunk.slice(cut);
        this.length -= cut;
      }
    }
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  replay(): string {
    const output = this.chunks.slice(this.head).join("");
    if (!this.truncated) return output;
    // CAN cancels a partial escape at the end of truncated output. Reapply
    // only input modes, not alternate-screen switches that can clear cells.
    return output + "\x18" + [...this.modes].map(([mode, enabled]) => `\x1b[?${mode}${enabled ? "h" : "l"}`).join("")
      + (this.keypad === null ? "" : this.keypad ? "\x1b=" : "\x1b>")
      + (this.state === "csi" ? `\x1b[${this.sequence}` : this.state === "escape" ? "\x1b" : "");
  }

  private track(char: string): void {
    if (this.state === "string") {
      if (char === "\x07") this.state = "text";
      else if (char === "\x1b") this.state = "stringEscape";
      return;
    }
    if (this.state === "stringEscape") {
      this.state = char === "\\" ? "text" : "string";
      return;
    }
    if (char === "\x1b") { this.state = "escape"; return; }
    if (this.state === "escape") {
      if (char === "[") { this.state = "csi"; this.sequence = ""; }
      else if ("]P_^X".includes(char)) this.state = "string";
      else {
        if (char === "=" || char === ">") this.keypad = char === "=";
        if (char === "c") { this.modes.clear(); this.keypad = null; }
        this.state = "text";
      }
      return;
    }
    if (this.state !== "csi") return;
    if (char >= "@" && char <= "~") {
      if ((char === "h" || char === "l") && /^\?[\d;]+$/.test(this.sequence)) {
        for (const mode of this.sequence.slice(1).split(";")) {
          if (["1", "1000", "1002", "1003", "1004", "1005", "1006", "1015", "2004"].includes(mode)) this.modes.set(mode, char === "h");
        }
      }
      this.state = "text";
    } else if (this.sequence.length < 128) this.sequence += char;
    else this.state = "text";
  }
}
