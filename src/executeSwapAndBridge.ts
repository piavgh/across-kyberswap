import { type ConfiguredPublicClient, type ConfiguredWalletClient, parseDepositLogs, parseFillLogs, waitForDepositTx, waitForFillTx } from "@across-protocol/app-sdk";
import type { Chain } from "viem";
import {
  type Address,
  encodeFunctionData,
  type Hash,
  maxUint256,
  parseAbi,
  type TransactionReceipt
} from "viem";
import {
  spokePoolPeripheryAbi,
  type SwapAndDepositData,
} from "./utils/peripheryAbi.js";

// Progress tracking types
type ProgressMeta = ApproveMeta | SwapAndBridgeMeta | FillMeta | undefined;

type ApproveMeta = {
  approvalAmount: bigint;
  spender: Address;
};

type SwapAndBridgeMeta = {
  swapAndDepositData: SwapAndDepositData;
};

type FillMeta = {
  depositId: bigint;
};

export type SwapAndBridgeProgress =
  | {
    step: "approve";
    status: "idle";
  }
  | {
    step: "approve";
    status: "txPending";
    txHash: Hash;
    meta: ApproveMeta;
  }
  | {
    step: "approve";
    status: "txSuccess";
    txReceipt: TransactionReceipt;
    meta: ApproveMeta;
  }
  | {
    step: "swapAndBridge";
    status: "txPending";
    txHash: Hash;
    meta: SwapAndBridgeMeta;
  }
  | {
    step: "swapAndBridge";
    status: "txSuccess";
    txReceipt: TransactionReceipt;
    depositId: bigint;
    depositLog: ReturnType<typeof parseDepositLogs>;
    meta: SwapAndBridgeMeta;
  }
  | {
    step: "fill";
    status: "pending";
    meta: FillMeta;
  }
  | {
    step: "fill";
    status: "txSuccess";
    txReceipt: TransactionReceipt;
    fillTxTimestamp: bigint;
    actionSuccess: boolean | undefined;
    meta: FillMeta;
    fillLog: ReturnType<typeof parseFillLogs>;
  }
  | {
    step: "approve" | "swapAndBridge" | "fill";
    status: "error";
    error: Error;
    meta: ProgressMeta;
  };

export type ExecuteSwapAndBridgeParams = {
  // Wallet and clients
  walletClient: ConfiguredWalletClient;
  originClient: ConfiguredPublicClient;
  destinationClient: ConfiguredPublicClient;
  originChain: Chain;
  destinationChain: Chain;

  // User address
  userAddress: Address;

  // Swap and bridge data
  swapAndDepositData: SwapAndDepositData;

  // Contract addresses
  spokePoolPeripheryAddress: Address;
  destinationSpokePoolAddress: Address;

  // Options
  isNative?: boolean;
  infiniteApproval?: boolean;
  skipAllowanceCheck?: boolean;
  throwOnError?: boolean;

  // Progress handler
  onProgress?: (progress: SwapAndBridgeProgress) => void;
};

export type ExecuteSwapAndBridgeResponse = {
  depositId?: bigint;
  swapAndBridgeTxReceipt?: TransactionReceipt;
  fillTxReceipt?: TransactionReceipt;
  error?: Error;
};

/**
 * Executes a swap-and-bridge transaction by:
 * 1. Approving the SpokePoolPeriphery contract if necessary
 * 2. Executing the swapAndBridge transaction
 * 3. Parsing the deposit ID from transaction logs
 * @param params - See {@link ExecuteSwapAndBridgeParams}
 * @returns The deposit ID and transaction receipt. See {@link ExecuteSwapAndBridgeResponse}
 */
export async function executeSwapAndBridge(
  params: ExecuteSwapAndBridgeParams
): Promise<ExecuteSwapAndBridgeResponse> {
  const {
    walletClient,
    originChain,
    originClient,
    destinationChain,
    destinationClient,
    userAddress,
    swapAndDepositData,
    spokePoolPeripheryAddress,
    destinationSpokePoolAddress,
    isNative = false,
    infiniteApproval = false,
    skipAllowanceCheck = false,
    throwOnError = true,
    onProgress,
  } = params;

  const onProgressHandler =
    onProgress ||
    ((progress: SwapAndBridgeProgress) => console.log("Progress:", progress));

  let currentProgress: SwapAndBridgeProgress = {
    status: "idle",
    step: "approve",
  };
  let currentProgressMeta: ProgressMeta;

  try {
    // Step 1: Check and handle approval if necessary (skip for native ETH)
    if (!skipAllowanceCheck && !isNative) {
      const allowance = await originClient.readContract({
        address: swapAndDepositData.swapToken,
        abi: parseAbi([
          "function allowance(address owner, address spender) public view returns (uint256)",
        ]),
        functionName: "allowance",
        args: [userAddress, spokePoolPeripheryAddress],
      });

      if (swapAndDepositData.swapTokenAmount > allowance) {
        const approvalAmount = infiniteApproval ? maxUint256 : swapAndDepositData.swapTokenAmount;

        currentProgressMeta = {
          approvalAmount,
          spender: spokePoolPeripheryAddress,
        };

        // Execute approval
        const approveCalldata = encodeFunctionData({
          abi: parseAbi(["function approve(address spender, uint256 value)"]),
          args: [spokePoolPeripheryAddress, approvalAmount],
        });

        const approveTxHash = await walletClient.sendTransaction({
          account: walletClient.account!,
          chain: originChain,
          to: swapAndDepositData.swapToken,
          data: approveCalldata,
        });

        currentProgress = {
          step: "approve",
          status: "txPending",
          txHash: approveTxHash,
          meta: currentProgressMeta,
        };
        onProgressHandler(currentProgress);

        // Wait for approval confirmation
        const approveTxReceipt =
          await originClient.waitForTransactionReceipt({
            hash: approveTxHash,
          });

        currentProgress = {
          step: "approve",
          status: "txSuccess",
          txReceipt: approveTxReceipt,
          meta: currentProgressMeta,
        };
        onProgressHandler(currentProgress);
      }
    }

    // Step 2: Execute swapAndBridge
    currentProgressMeta = {
      swapAndDepositData,
    };

    // Encode the swapAndBridge call
    const swapAndBridgeCalldata = encodeFunctionData({
      abi: spokePoolPeripheryAbi,
      functionName: "swapAndBridge",
      args: [
        {
          submissionFees: swapAndDepositData.submissionFees,
          depositData: swapAndDepositData.depositData,
          swapToken: swapAndDepositData.swapToken,
          exchange: swapAndDepositData.exchange,
          transferType: swapAndDepositData.transferType,
          swapTokenAmount: swapAndDepositData.swapTokenAmount,
          minExpectedInputTokenAmount:
            swapAndDepositData.minExpectedInputTokenAmount,
          routerCalldata: swapAndDepositData.routerCalldata,
          enableProportionalAdjustment:
            swapAndDepositData.enableProportionalAdjustment,
          spokePool: swapAndDepositData.spokePool,
          nonce: swapAndDepositData.nonce,
        },
      ],
    });

    console.log("\n=== SWAP AND BRIDGE TRANSACTION DATA ===");
    console.log("To:", spokePoolPeripheryAddress);
    console.log("Value:", isNative ? swapAndDepositData.swapTokenAmount.toString() : "0");
    console.log("Calldata:", swapAndBridgeCalldata);
    console.log("swapTokenAmount:", swapAndDepositData.swapTokenAmount.toString());
    console.log("==========================================\n");

    // First simulate the transaction to catch revert errors with proper decoding
    try {
      await originClient.simulateContract({
        address: spokePoolPeripheryAddress,
        abi: spokePoolPeripheryAbi,
        functionName: "swapAndBridge",
        args: [swapAndDepositData] as any,
        account: userAddress,
        value: isNative ? swapAndDepositData.swapTokenAmount : undefined,
      });
    } catch (simulateError) {
      throw simulateError;
    }

    console.log("==========================================\n");
    console.log("Executing swap and bridge transaction...");
    console.log("==========================================\n");

    const swapAndBridgeTxHash = await walletClient.sendTransaction({
      account: walletClient.account!,
      chain: originChain,
      to: spokePoolPeripheryAddress,
      data: swapAndBridgeCalldata,
      value: isNative ? swapAndDepositData.swapTokenAmount : undefined,
    });

    currentProgress = {
      step: "swapAndBridge",
      status: "txPending",
      txHash: swapAndBridgeTxHash,
      meta: currentProgressMeta,
    };
    onProgressHandler(currentProgress);

    // Wait for deposit transaction and parse logs using SDK
    const { depositId, depositTxReceipt } = await waitForDepositTx({
      originChainId: originChain.id,
      transactionHash: swapAndBridgeTxHash,
      publicClient: originClient,
    });
    const depositLog = parseDepositLogs(depositTxReceipt.logs);

    currentProgress = {
      step: "swapAndBridge",
      status: "txSuccess",
      txReceipt: depositTxReceipt,
      depositId,
      depositLog,
      meta: currentProgressMeta,
    };
    onProgressHandler(currentProgress);

    // Step 3: Wait for fill on destination chain if requested
    currentProgressMeta = {
      depositId,
    };
    currentProgress = {
      step: "fill",
      status: "pending",
      meta: currentProgressMeta,
    };
    onProgressHandler(currentProgress);

    const destinationBlock = await destinationClient.getBlockNumber();

    const { fillTxReceipt, fillTxTimestamp, actionSuccess } = await waitForFillTx({
      deposit: {
        originChainId: originChain.id,
        destinationChainId: destinationChain.id,
        destinationSpokePoolAddress,
        message: swapAndDepositData.depositData.message,
      },
      depositId,
      depositTxHash: depositTxReceipt.transactionHash,
      destinationChainClient: destinationClient,
      fromBlock: destinationBlock - 100n,
    });

    const fillLog = parseFillLogs(fillTxReceipt.logs);

    currentProgress = {
      step: "fill",
      status: "txSuccess",
      txReceipt: fillTxReceipt,
      fillTxTimestamp,
      actionSuccess,
      fillLog,
      meta: currentProgressMeta,
    };
    onProgressHandler(currentProgress);

    return {
      depositId,
      swapAndBridgeTxReceipt: depositTxReceipt,
      fillTxReceipt,
    };
  } catch (error) {
    currentProgress = {
      ...currentProgress,
      status: "error",
      error: error as Error,
      meta: currentProgressMeta,
    };
    onProgressHandler(currentProgress);

    if (!throwOnError) {
      return { error: error as Error };
    }

    throw error;
  }
}
