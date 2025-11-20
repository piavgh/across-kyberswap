import {
  addressToBytes32,
  createAcrossClient,
  type BuildMessageParams,
} from "@across-protocol/app-sdk";
import dotenv from "dotenv";
import { formatUnits, type Address } from "viem";
import {
  destinationChain,
  destinationSpokePoolAddress,
  destinationSwapSlippageBps,
  destinationSwapTokenIn,
  destinationSwapTokenOut,
  originChain,
  originDepositToken,
  originSwapAmount,
  originSwapSlippageBps,
  originSwapTokenIn,
  spokePoolAddress,
  spokePoolPeripheryAddress,
  swapProxyAddress,
} from "./config/swap-bridge.js";
import {
  executeSwapAndBridge,
  type SwapAndBridgeProgress,
} from "./executeSwapAndBridge.js";
import { INTEGRATOR_ID } from "./utils/constants.js";
import {
  createTransactionUrl,
  createUserWallet,
  getBalance,
} from "./utils/helpers.js";
import { logger } from "./utils/logger.js";
import {
  TransferType,
  type BaseDepositData,
  type SwapAndDepositData,
} from "./utils/peripheryAbi.js";
import {
  generateApproveCallData,
  generateSwapCallData,
} from "./utils/transactions.js";

dotenv.config();

// Function to execute the swap-bridge-swap flow
async function executeSwapBridgeSwap() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY is not set");
  }

  const rpcUrl = process.env.RPC_URL || originChain.rpcUrls.default.http[0];
  if (!rpcUrl) {
    throw new Error("RPC_URL is not set");
  }

  // Initialize Across client
  const client = createAcrossClient({
    integratorId: INTEGRATOR_ID,
    chains: [originChain, destinationChain.chain],
  });

  logger.success("Across client initialized successfully");

  try {
    logger.step("Initializing wallet client");

    // Create wallet client for origin chain
    const { client: walletClient, address: userAddress } = createUserWallet(
      privateKey,
      rpcUrl,
      originChain
    );

    logger.success("Wallet client initialized successfully");

    // Create client for origin chain
    const originClient = client.getPublicClient(originChain.id);

    logger.success("Origin client initialized successfully");

    // Create client for destination chain
    const destinationClient = client.getPublicClient(destinationChain.chain.id);

    logger.success("Destination client initialized successfully");

    // Check user balance of swap token (ETH or WETH)
    const balance = await getBalance(
      originChain,
      userAddress,
      originSwapTokenIn.isNative ? null : originSwapTokenIn.address
    );
    if (balance < originSwapAmount) {
      throw new Error(
        `Insufficient balance. Required: ${formatUnits(
          originSwapAmount,
          originSwapTokenIn.decimals
        )}, Available: ${formatUnits(balance, originSwapTokenIn.decimals)}`
      );
    }
    logger.success(
      `Balance check passed. Available: ${formatUnits(
        balance,
        originSwapTokenIn.decimals
      )} ${originSwapTokenIn.isNative ? "ETH" : "WETH"}`
    );

    // Step 1: Generate origin swap calldata (ETH/WETH -> USDC on Base via KyberSwap)
    logger.step("Generating origin swap calldata (ETH/WETH -> USDC)");

    // Use native token address for KyberSwap if swapping from ETH
    // const swapTokenForKyber = originSwapToken.isNative
    //   ? EVM_NATIVE_TOKEN
    //   : originSwapToken.address;
    const swapTokenForKyber = originSwapTokenIn.address;

    const {
      to: originExchange,
      calldata: originSwapCalldata,
      amountOut: originSwapAmountOut,
    } = await generateSwapCallData(
      originSwapAmount.toString(),
      swapTokenForKyber,
      originDepositToken.address,
      originSwapSlippageBps,
      spokePoolPeripheryAddress, // sender is the periphery contract
      swapProxyAddress, // recipient is the swap proxy contract
      "base",
      true
    );

    // Calculate minExpectedInputTokenAmount with slippage
    // originSwapAmountOut is the expected output token amount from the swap
    // We apply slippage to get the minimum acceptable amount
    const minExpectedSwapOutputAmount =
      (BigInt(originSwapAmountOut) * (10000n - BigInt(originSwapSlippageBps))) / 10000n;

    logger.json("Origin swap details", {
      exchange: originExchange,
      expectedAmountOut: originSwapAmountOut,
      minExpectedAmount: minExpectedSwapOutputAmount.toString(),
      slippageBps: originSwapSlippageBps,
    });

    // Step 2: Generate destination swap calldata for gas estimation
    // Use the minExpectedUSDC from the origin swap for gas estimation
    logger.step("Generating destination swap calldata for gas estimation");

    const { calldata: destSwapCalldata, to: destExchange } =
      await generateSwapCallData(
        minExpectedSwapOutputAmount.toString(),
        destinationSwapTokenIn,
        destinationSwapTokenOut,
        destinationSwapSlippageBps,
        userAddress,
        userAddress,
        destinationChain.name,
        true
      );

    // Step 3: Build cross-chain message for destination swap
    const crossChainMessage: BuildMessageParams = {
      actions: [
        {
          target: destinationSwapTokenIn as Address,
          callData: generateApproveCallData(
            destExchange as Address,
            originSwapAmountOut
          ),
          value: 0n,
          update: (updatedOutputAmount: bigint) => {
            return {
              callData: generateApproveCallData(
                destExchange as Address,
                updatedOutputAmount
              ),
            };
          },
        },
        {
          target: destExchange as Address,
          callData: destSwapCalldata as `0x${string}`,
          value: 0n,
          update: async (updatedOutputAmount: bigint) => {
            const { calldata: updatedCalldata, to: updatedTo } =
              await generateSwapCallData(
                updatedOutputAmount.toString(),
                destinationSwapTokenIn,
                destinationSwapTokenOut,
                destinationSwapSlippageBps,
                userAddress,
                userAddress,
                destinationChain.name,
                false
              );

            if (destExchange !== updatedTo) {
              throw new Error("Destination swap contract address changed");
            }
            return {
              callData: updatedCalldata as `0x${string}`,
            };
          },
        },
      ],
      fallbackRecipient: userAddress,
    };

    // Step 4: Get Across quote
    logger.step("Getting Across quote");

    // Build the URL manually to show what will be requested
    const apiUrl = "https://app.across.to/api";
    const searchParams = new URLSearchParams({
      originChainId: originChain.id.toString(),
      destinationChainId: destinationChain.chain.id.toString(),
      inputToken: originDepositToken.address,
      outputToken: destinationSwapTokenIn as Address,
      amount: minExpectedSwapOutputAmount.toString(),
      message: "0x", // This will be replaced by the actual message
      allowUnmatchedDecimals: "true",
    });

    console.log("\n========== ACROSS API REQUEST ==========");
    console.log("Across Request API URL:", `${apiUrl}/suggested-fees?${searchParams.toString()}`);
    console.log("========================================\n");

    const quote = await client.getQuote({
      route: {
        originChainId: originChain.id,
        destinationChainId: destinationChain.chain.id,
        inputToken: originDepositToken.address,
        outputToken: destinationSwapTokenIn as Address,
        isNative: originDepositToken.isNative,
      },
      inputAmount: minExpectedSwapOutputAmount,
      recipient: userAddress,
      crossChainMessage,
    });

    logger.json("Across quote response", quote);

    // Step 5: Get user's nonce for replay protection
    const nonce = await originClient.getTransactionCount({
      address: userAddress,
    });

    // Step 6: Build SwapAndDepositData
    logger.step("Building SwapAndDepositData");

    const depositData: BaseDepositData = {
      inputToken: originDepositToken.address,
      outputToken: addressToBytes32(quote.deposit.outputToken),
      outputAmount: quote.deposit.outputAmount,
      depositor: userAddress,
      recipient: addressToBytes32(quote.deposit.recipient),
      destinationChainId: BigInt(destinationChain.chain.id),
      exclusiveRelayer: addressToBytes32(quote.deposit.exclusiveRelayer),
      quoteTimestamp: quote.deposit.quoteTimestamp,
      fillDeadline: quote.deposit.fillDeadline,
      exclusivityParameter: quote.deposit.exclusivityDeadline,
      message: quote.deposit.message,
    };

    const swapAndDepositData: SwapAndDepositData = {
      submissionFees: {
        amount: 0n,
        recipient: "0x0000000000000000000000000000000000000000",
      },
      depositData,
      swapToken: originSwapTokenIn.address,
      exchange: originExchange as Address,
      transferType: TransferType.Approval,
      swapTokenAmount: originSwapAmount,
      minExpectedInputTokenAmount: minExpectedSwapOutputAmount,
      routerCalldata: originSwapCalldata as `0x${string}`,
      enableProportionalAdjustment: true,
      spokePool: spokePoolAddress,
      nonce: BigInt(nonce),
    };

    logger.json("SwapAndDepositData", swapAndDepositData);

    // Step 7 & 8: Execute swapAndBridge with progress tracking
    logger.step("Executing swap-and-bridge transaction");

    await executeSwapAndBridge({
      walletClient,
      originChain,
      originClient,
      destinationChain: destinationChain.chain,
      destinationClient,
      userAddress,
      swapAndDepositData,
      spokePoolPeripheryAddress,
      destinationSpokePoolAddress,
      isNative: originSwapTokenIn.isNative,
      infiniteApproval: false,
      skipAllowanceCheck: false,
      throwOnError: true,
      onProgress: (progress: SwapAndBridgeProgress) => {
        if (progress.step === "approve" && progress.status === "txPending") {
          logger.step("Approving SpokePoolPeriphery to spend tokens");
          logger.success(
            `Approve TX: ${createTransactionUrl(originChain, progress.txHash)}`
          );
        }

        if (progress.step === "approve" && progress.status === "txSuccess") {
          logger.success("Approval confirmed");
        }

        if (
          progress.step === "swapAndBridge" &&
          progress.status === "txPending"
        ) {
          logger.step("Submitting swapAndBridge transaction");
          logger.success(
            `SwapAndBridge TX: ${createTransactionUrl(
              originChain,
              progress.txHash
            )}`
          );
        }

        if (
          progress.step === "swapAndBridge" &&
          progress.status === "txSuccess"
        ) {
          logger.success(
            `Transaction confirmed in block ${progress.txReceipt.blockNumber}`
          );
          logger.success(`Deposit ID: ${progress.depositId}`);
          logger.json("Transaction receipt", {
            transactionHash: progress.txReceipt.transactionHash,
            blockNumber: progress.txReceipt.blockNumber.toString(),
            status: progress.txReceipt.status,
          });
        }

        if (progress.step === "fill" && progress.status === "pending") {
          logger.step("Waiting for fill on destination chain...");
          logger.json("Deposit details", {
            depositId: progress.meta?.depositId?.toString(),
          });
        }

        if (progress.step === "fill" && progress.status === "txSuccess") {
          logger.success(
            `Fill transaction confirmed on ${destinationChain.name}`
          );
          logger.success(
            `Fill TX: ${createTransactionUrl(destinationChain.chain, progress.txReceipt.transactionHash)}`
          );
          logger.json("Fill transaction details", {
            transactionHash: progress.txReceipt.transactionHash,
            blockNumber: progress.txReceipt.blockNumber.toString(),
            fillTimestamp: progress.fillTxTimestamp.toString(),
            actionSuccess: progress.actionSuccess,
          });
          if (progress.fillLog) {
            logger.json("Fill log details", {
              depositId: progress.fillLog.depositId?.toString(),
              inputAmount: progress.fillLog.inputAmount?.toString(),
              outputAmount: progress.fillLog.outputAmount?.toString(),
              relayer: progress.fillLog.relayer,
            });
          }
        }

        if (progress.status === "error") {
          // logger.error("Transaction failed", progress.error);
        }
      },
    });

    logger.step("Swap-Bridge-Swap flow completed successfully");
  } catch (error) {
    logger.error("Failed to execute swap-bridge-swap", error);
  }
}

executeSwapBridgeSwap();
