declare module "nspell" {
  interface SpellChecker {
    correct(word: string): boolean;
  }

  const nspell: (dictionary: { aff: Uint8Array; dic: Uint8Array }) => SpellChecker;
  export default nspell;
}
