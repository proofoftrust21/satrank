// Wallet drivers. C1 only re-exports the Wallet interface; concrete drivers
// (LndWallet, NwcWallet, LnurlWallet) land in C3-C4.
export type { Wallet } from '../types';
