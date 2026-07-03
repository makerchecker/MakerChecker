// MOVED. The canonical signature table now lives at ./lib/signatures.mjs and is
// the single source of truth. This shim re-exports it so any old import path keeps
// working. Do not add signatures here — edit ./lib/signatures.mjs.
export { SIGNATURES, IRREVERSIBLE_VERBS } from './lib/signatures.mjs';
