import { createAcrossClient } from "@across-protocol/app-sdk";
import dotenv from "dotenv";
import { formatUnits } from "viem";
import {
  destinationChain,
  inputAmount,
  kyberTokenIn,
  kyberTokenOut,
  originChain,
  originDepositToken,
} from "./config.js";
import { INTEGRATOR_ID } from "./utils/constants.js";
import {
  createTransactionUrl,
  createUserWallet,
  getBalance,
} from "./utils/helpers.js";
import { logger } from "./utils/logger.js";
import {
  generateApproveCallData,
  generateSwapCallData,
} from "./utils/transactions.js";
import { type CrossChainMessage } from "./utils/types.js";

dotenv.config();

// Function to execute the swap
async function executeSwap() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY is not set");
  }

  // Origin chain RPC URL
  // If not provided, defaults to RPC URL for the origin chain
  const rpcUrl = process.env.RPC_URL || originChain.rpcUrls.default.http[0];
  if (!rpcUrl) {
    throw new Error("RPC_URL is not set");
  }

  try {
    logger.step("Initializing clients");
    // Create a wallet client using the origin chain to make Across deposit transaction
    const { client: walletClient, address: userAddress } = createUserWallet(
      privateKey,
      rpcUrl,
      originChain
    );

    // Check if user has enough balance to make the origin chain deposit
    const balance = await getBalance(
      originChain,
      userAddress,
      originDepositToken.address
    );
    if (balance < inputAmount) {
      throw new Error(
        `Insufficient balance. Required: ${formatUnits(
          inputAmount,
          originDepositToken.decimals
        )}, Available: ${formatUnits(balance, originDepositToken.decimals)}`
      );
    }
    logger.success(
      `Balance check passed. Available: ${formatUnits(
        balance,
        originDepositToken.decimals
      )}`
    );

    // sets up the AcrossClient and configures chains
    const client = createAcrossClient({
      integratorId: INTEGRATOR_ID,
      chains: [originChain, destinationChain.chain],
    });

    logger.success("Clients initialized successfully");

    // Generates the initial swap call data
    // This is used to estimate the gas for the swap
    // The gas estimation is used for the Across bridge fee
    const { to, calldata } = await generateSwapCallData(
      inputAmount.toString(),
      kyberTokenIn,
      kyberTokenOut,
      userAddress,
      userAddress,
      destinationChain.name,
      true
    );

    logger.json("Initial to address", to);
    logger.json("Initial swap call data", calldata);

    // Define the transactions executed after bridge transaction
    const crossChainMessage: CrossChainMessage = {
      actions: [
        // Approve the swap contract to spend the input amount
        {
          target: kyberTokenIn,
          // Generate the approve call data
          callData: generateApproveCallData(to, inputAmount),
          value: 0n,
          // we use the update function to update the calldata based on the output amount from the quote
          update: (updatedOutputAmount: bigint) => {
            return {
              callData: generateApproveCallData(to, updatedOutputAmount),
            };
          },
        },
        {
          // Kyberswap contract address
          target: to,
          // Generates the exchange call data
          callData: calldata,
          value: 0n,
          // we use the update function to update the calldata based on the output amount from the quote
          update: async (updatedOutputAmount: bigint) => {
            const { calldata: updatedCalldata, to: updatedTo } =
              await generateSwapCallData(
                updatedOutputAmount.toString(),
                kyberTokenIn,
                kyberTokenOut,
                userAddress,
                userAddress,
                destinationChain.name,
                false
              );

            // For PoC purposes, throwing an error if the swap contract address changes
            if (to !== updatedTo) {
              throw new Error("Swap contract address changed");
            }
            return {
              callData: updatedCalldata,
            };
          },
        },
      ],
      // address to send the output token to if the swap fails or any leftover tokens
      fallbackRecipient: userAddress,
    };

    // Retrieves a quote for the bridge with approval and swap actions
    const quote = await client.getQuote({
      route: {
        originChainId: originChain.id,
        destinationChainId: destinationChain.chain.id,
        inputToken: originDepositToken.address,
        outputToken: kyberTokenIn,
      },
      inputAmount: inputAmount,
      crossChainMessage,
    });

    logger.step("Quote fetched");
    logger.json("Quote parameters", quote.deposit);

    logger.step("Executing transactions");
    await client.executeQuote({
      walletClient,
      deposit: quote.deposit, // returned by `getQuote`
      onProgress: (progress: any) => {
        if (progress.step === "approve" && progress.status === "txSuccess") {
          // if approving an ERC20, you have access to the approval receipt
          const { txReceipt } = progress;
          logger.success(
            `Approve TX: ${createTransactionUrl(
              originChain,
              txReceipt.transactionHash
            )}`
          );
        }

        if (progress.step === "deposit" && progress.status === "txSuccess") {
          // once deposit is successful you have access to depositId and the receipt
          const { depositId, txReceipt } = progress;
          logger.success(
            `Deposit TX: ${createTransactionUrl(
              originChain,
              txReceipt.transactionHash
            )}`
          );
          logger.success(`Deposit ID: ${depositId}`);
        }

        if (progress.step === "fill" && progress.status === "txSuccess") {
          // if the fill is successful, you have access the following data
          const { txReceipt, actionSuccess } = progress;
          // actionSuccess is a boolean flag, telling us if your cross chain messages were successful
          logger.success(
            `Fill TX: ${createTransactionUrl(
              destinationChain.chain,
              txReceipt.transactionHash
            )}`
          );
          logger.success(
            actionSuccess ? "Swap completed successfully" : "Swap failed"
          );
        }
      },
    });

    logger.step("Bridge transaction completed");
  } catch (error) {
    logger.error("Failed to execute swap", error);
    throw error;
  }
}

executeSwap();
