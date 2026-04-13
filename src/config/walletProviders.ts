// Wallet provider → Lightning pubkey mapping
// Used by /api/decide to compute P_path from the agent's actual position in the graph
// instead of from SatRank's position.
//
// Each entry maps a provider name to the pubkey of their main routing node.
// Agents pass walletProvider: "phoenix" and SatRank runs queryRoutes from ACINQ's node.

export const WALLET_PROVIDERS: Record<string, string> = {
  phoenix:  '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f', // ACINQ
  wos:      '035e4ff418fc8b5554c5d9eea66396c227bd429a3251c8cbc711002ba215bfc226', // WalletOfSatoshi.com
  strike:   '03c8e5f583585cac1de2b7503a6ccd3c12ba477cfd139cd4905be504c2f48e86bd', // Strike
  blink:    '02dfb4c1dd59216fa6a28d0f012e188516f63517db68c4e4b82c3af41343a05bc4', // routing.blinkbtc.com
  breez:    '0264a62a4307d701c04a46994ce5f5323b1ca28c80c66b73c631dbcb0990d6e835', // Breez
  zeus:     '031b301307574bbe9b9ac7b79cbe1700e31e544513eae0b5d7497483083f99e581', // Olympus by ZEUS
  coinos:   '021294fff596e497ad2902cd5f19673e9020953d90625d68c22e91b51a45c032d3', // ln.coinos.io
  cashapp:  '027100442c3b79f606f80f322d98d499eefcb060599efc5d4ecb00209c2cb54190', // block-iad-1
};

export const VALID_PROVIDERS = Object.keys(WALLET_PROVIDERS);
