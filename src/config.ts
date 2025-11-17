import { parseUnits, type Address } from "viem";
import { arbitrum, base } from "viem/chains";

/**
 * KYBERSWAP CONFIGURATION
 *
 * This section contains information that Kyberswap already has in its UI.
 */

// Input amount to be used for bridge transaction.
// The amount is scaled to the inputToken's decimals (6 decimals for USDC).
const inputAmount = parseUnits("5", 6);

// Destination chain where funds are received and the Kyberswap swap is made.
const destinationChain = { name: "arbitrum", chain: arbitrum };

// Token used as input for the Kyberswap swap on the destination chain.
const kyberTokenIn = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// Token used as output for the Kyberswap swap on the destination chain.
const kyberTokenOut = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

/**
 * ACROSS CONFIGURATION
 *
 * This section contains new parameters to use for Across.
 */

// Origin chain where the Across deposit is made by the user.
const originChain = base;

// Origin deposit token used for the Across deposit.
// This should be the same asset (USDC, WETH, WBTC, etc.) as the Kyberswap origin token.
const originDepositToken = {
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  decimals: 6,
};

export {
  destinationChain, inputAmount, kyberTokenIn,
  kyberTokenOut, originChain, originDepositToken
};
