import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Plugin } from "vite";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const minimumBytes = 2 * 1024;
const maximumRatio = 0.9;

/** Public, fingerprinted assets only. The runtime-injected HTML is never compressed here. */
export function precompressAssets(): Plugin {
  return {
    name: "texlite-precompress-assets",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      async handler(_options, bundle) {
        const assets = Object.values(bundle).filter((item) =>
          item.fileName.startsWith("assets/") && /\.(?:js|mjs|css|wasm)$/i.test(item.fileName));
        // Bound compression work and memory. Worker scripts and WASM are
        // emitted assets in this bundle and follow the same path as chunks.
        for (let offset = 0; offset < assets.length; offset += 4) {
          await Promise.all(assets.slice(offset, offset + 4).map(async (item) => {
            const source = item.type === "chunk" ? item.code : item.source;
            const original = typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source);
            if (original.length < minimumBytes) return;
            const [gz, br] = await Promise.all([
              gzipAsync(original, { level: 6 }),
              brotliAsync(original, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
            ]);
            for (const [suffix, compressed] of [["gz", gz], ["br", br]] as const) {
              if (compressed.length <= original.length * maximumRatio) {
                this.emitFile({ type: "asset", fileName: `${item.fileName}.${suffix}`, source: compressed });
              }
            }
          }));
        }
      }
    }
  };
}
