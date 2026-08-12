/// <reference types="vite/client" />

declare module "nspell" {
  interface SpellChecker {
    correct(word: string): boolean;
  }

  const nspell: (aff: string | Uint8Array, dic?: string | Uint8Array) => SpellChecker;
  export default nspell;
}
