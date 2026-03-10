/**
 * Pyth adapter: encodes price update bytes for the Pyth oracle.
 *
 * Both testnet (Base Sepolia) and mainnet use the real Pyth contract, which
 * requires raw Hermes VAA bytes passed directly to parsePriceFeedUpdates.
 * Wormhole signatures are validated on-chain.
 *
 * The IS_TESTNET flag controls only whether the pricePusher job runs —
 * it no longer affects encoding.
 */

import { type ParsedPrice } from "../services/hermesClient.js";

/**
 * Build priceUpdate bytes[] for a given set of parsed prices.
 *
 * @param _parsed     Decoded price entries from Hermes (unused; kept for API compatibility)
 * @param binaryData  Raw hex-encoded VAA bytes from Hermes (one per feed, same order as parsed)
 * @returns  Array of hex-encoded VAA bytes, one per feed — ready to pass to settleMarket
 */
export function buildUpdateData(_parsed: ParsedPrice[], binaryData: string[]): string[] {
  return binaryData.map((hex) => (hex.startsWith("0x") ? hex : `0x${hex}`));
}

/**
 * Build a single-feed priceUpdate bytes[] from parsed data.
 * Convenience wrapper used by settleMarkets when processing one market at a time.
 */
export function buildSingleFeedUpdate(parsed: ParsedPrice, binaryHex: string): string[] {
  return buildUpdateData([parsed], [binaryHex]);
}
