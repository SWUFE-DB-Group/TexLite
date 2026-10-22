export type VimSupport = typeof import("./vimSupport");

let support: Promise<VimSupport> | null = null;

/** Share initialization across editors/projects without loading Vim by default. */
export function loadVimSupport(): Promise<VimSupport> {
  support ??= import("./vimSupport").catch((error: unknown) => {
    support = null;
    throw error;
  });
  return support;
}
