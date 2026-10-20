import { COMPILER_VERSION_TOOLS, type CompilerVersionsResponse } from "../shared/compilerVersions.js";
import type { EnvironmentTool } from "./environment.js";

const cacheDurationMs = 60_000;

/** Shared across users, refreshed on demand only. Never expose probe errors or paths. */
export class CompilerVersionService {
  private cached: CompilerVersionsResponse | null = null;
  private expiresAt = 0;
  private pending: Promise<CompilerVersionsResponse> | null = null;

  constructor(private readonly probe: () => Promise<EnvironmentTool[]>, private readonly now = Date.now) {}

  getVersions(): Promise<CompilerVersionsResponse> {
    if (this.cached && this.now() < this.expiresAt) return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    this.pending = this.load().then((result) => {
      this.cached = result;
      this.expiresAt = this.now() + cacheDurationMs;
      return result;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async load(): Promise<CompilerVersionsResponse> {
    const tools = await this.probe().catch(() => []);
    const banners = new Map(tools.map((tool) => [tool.id, tool.status === "installed" ? tool.version : null]));
    // Some distribution packages omit tlmgr. Engine banners still identify TeX Live.
    const texlive = ["texlive", "pdflatex", "xelatex", "lualatex"]
      .map((id) => banners.get(id)?.match(/\bTeX Live\b.*?\b(20\d{2})\b/i)?.[1])
      .find(Boolean) ?? null;
    return { tools: COMPILER_VERSION_TOOLS.map(({ id }) => ({
      id, version: id === "texlive" ? texlive : softwareVersion(banners.get(id))
    })) };
  }
}

function softwareVersion(banner: string | null | undefined): string | null {
  if (!banner) return null;
  // Keep meaningful suffixes (BibTeX 0.99d, LuaHBTeX 1.21.0, pdfTeX 3.1415-2.6-1.40).
  const numericVersion = "v?(\\d+(?:\\.\\d+)+(?:-\\d+(?:\\.\\d+)*)*[a-z]?)";
  return banner.match(new RegExp(`\\bversion\\s*:?\\s*${numericVersion}`, "i"))?.[1]
    ?? banner.match(new RegExp(`\\b${numericVersion}`, "i"))?.[1]
    ?? null;
}
