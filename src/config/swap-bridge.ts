import { parseUnits, type Address } from "viem";
import { arbitrum, base } from "viem/chains";

// KyberSwap expects this address for native ETH
export const EVM_NATIVE_TOKEN =
    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

// SpokePoolPeriphery contract address on Base
export const spokePoolPeripheryAddress =
    "0x89415a82d909a7238d69094c3dd1dcc1acbda85c" as Address;
export const swapProxyAddress =
    "0x4D6d2A149A46D9D8C4473FbaA269f3738247eB60" as Address;

// SpokePool contract address on Base
export const spokePoolAddress =
    "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64" as Address;

// SpokePool contract address on Arbitrum (destination)
export const destinationSpokePoolAddress =
    "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A" as Address;

/**
 * SWAP-BRIDGE-SWAP CONFIGURATION
 *
 * Configuration for the extended flow: Swap (origin) -> Bridge -> Swap (destination)
 */

// Origin chain where the Kyberswap swap is made by the user.
// const originChain = arbitrum;
export const originChain = base;

// User's initial token on origin chain (to be swapped before bridging)
export const originSwapTokenIn = {
    address: "0x4200000000000000000000000000000000000006" as Address, // WETH on Base (used for swapToken param)
    decimals: 18,
    isNative: true, // Set to true if user has native ETH, false if they have WETH
};

// Amount of origin swap token to use
// This will be swapped to the bridge token (USDC) before bridging
export const originSwapAmount = parseUnits("0.002", 18); // 0.002 ETH/WETH

// Slippage tolerance for the Kyberswap swap on the origin chain, e.g: 0.1% = 10 basis points
export const originSwapSlippageBps = 10;

/**
 * ACROSS CONFIGURATION
 *
 * This section contains new parameters to use for Across.
 */

// Origin deposit token used for the Across deposit.
// This should be the same asset (USDC, WETH, WBTC, etc.) as the Kyberswap origin token.
export const originDepositToken = {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    decimals: 6,
    isNative: false,
};
// const originDepositToken = {
//   address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as Address,
//   decimals: 18,
//   isNative: true, // Set to true if user has native ETH, false if they have WETH
// };

// Destination chain where funds are received and the Kyberswap swap is made.
export const destinationChain = { name: "arbitrum", chain: arbitrum };
// const destinationChain = { name: "base", chain: base };

// Token in for the Kyberswap swap on the destination chain.
export const destinationSwapTokenIn = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
// const destinationSwapTokenIn = "0x4200000000000000000000000000000000000006";

// Token out for the Kyberswap swap on the destination chain.
export const destinationSwapTokenOut = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
// const destinationSwapTokenOut = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
// const destinationSwapTokenOut = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

// Slippage tolerance for the Kyberswap swap on the destination chain, e.g: 0.1% = 10 basis points
export const destinationSwapSlippageBps = 10;
