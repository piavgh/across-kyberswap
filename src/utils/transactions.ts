import axios from "axios";
import { type Address } from "viem";
import { encodeFunctionData, parseAbiItem } from "viem/utils";
import { KYBERSWAP_API_URL } from "./constants.js";
import { logger } from "./logger.js";

// Function to generate the calldata for the approve function
export function generateApproveCallData(spender: Address, amount: bigint) {
  // Generate the calldata for the approve function
  const approveCallData = encodeFunctionData({
    abi: [parseAbiItem("function approve(address spender, uint256 value)")],
    args: [spender, amount],
  });

  return approveCallData;
}

// Generates the swap call data for Kyberswap swap
export async function generateSwapCallData(
  amount: string,
  tokenIn: Address,
  tokenOut: Address,
  sender: Address,
  recipient: Address,
  chain: string,
  initialQuote: boolean
) {
  try {
    const quoteRequest = await axios.get(
      `${KYBERSWAP_API_URL}/${chain}/api/v1/routes`,
      {
        params: {
          tokenIn: tokenIn,
          tokenOut: tokenOut,
          amountIn: amount,
          gasInclude: true,
        },
        headers: {
          "X-Client-Id": "AcrossTest", // replace with your actual client ID
        },
      }
    );

    const quoteData = quoteRequest.data;
    if (!quoteData) {
      throw new Error("No quote data returned");
    }
    const calldataRequest = await axios.post(
      `${KYBERSWAP_API_URL}/${chain}/api/v1/route/build`,
      {
        routeSummary: quoteData.data.routeSummary,
        sender: sender,
        recipient: recipient,
        slippageTolerance: 100
      },
      {
        headers: {
          "X-Client-Id": "AcrossTest", // replace with your actual client ID
        },
      }
    );

    const { data: calldata, routerAddress: to } = calldataRequest.data.data;
    if (!calldata) {
      throw new Error("No calldata data returned");
    }

    logger.json(initialQuote ? "Initial swap data: " : "Updated swap data: ", {
      inputToken: tokenIn,
      amount: amount,
      outputToken: tokenOut,
      to: quoteData.data.to,
      callData: calldata,
    });

    return { calldata, to };
  } catch (error) {
    console.error("Error generating swap call data:", error);
    throw error;
  }
}
