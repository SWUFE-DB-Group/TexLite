/*
 * tex-fmt publishes the generated wasm-bindgen glue with `sideEffects: false`.
 * That is correct for most bundlers, but it lets Rollup remove the package's
 * tiny entry module (which performs the WASM initialization) when the formatter
 * is loaded lazily.  Keep the initialization explicit so the browser runtime
 * always receives the WASM exports before `main` is called.
 */
import * as wasmModule from "../../node_modules/tex-fmt/tex_fmt_bg.wasm";
// @ts-expect-error tex-fmt's generated glue intentionally ships without a TS declaration.
import { __wbg_set_wasm, main } from "../../node_modules/tex-fmt/tex_fmt_bg.js";

const wasm = wasmModule as typeof wasmModule & {
  __wbindgen_start: () => void;
};

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();

export { main };
