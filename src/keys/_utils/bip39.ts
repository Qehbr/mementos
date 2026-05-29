/**
 * Lazy-load the `@scure/bip39` functions together with the English wordlist. Kept lazy:
 * the library and its ~160 KB wordlist load only when a mnemonic is actually generated,
 * encoded, or decoded — not on every CLI startup.
 */
export async function loadBip39(): Promise<
  typeof import('@scure/bip39') & { wordlist: string[] }
> {
  const bip39 = await import('@scure/bip39')
  const { wordlist } = await import('@scure/bip39/wordlists/english')
  return { ...bip39, wordlist }
}
