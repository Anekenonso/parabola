import { useCallback, useState } from "react";
import {
  transfer,
  estimateFee,
  completeMint,
  TransferError,
  SubmissionTimeoutError,
  type TransferParams,
  type TransferResult,
  type EstimateFeeParams,
  type FeeEstimate,
  type CompleteMintParams,
  type ChainId,
  type Network,
} from "@asctp/parabola";

export type TransferUiStatus = "idle" | "submitting" | "success" | "pending" | "error";

/**
 * What the burn was committed to, captured when transfer() is called. Completing a mint
 * later must use these values, not whatever the form or network selector holds by then:
 * flipping the direction after a post-burn failure would otherwise send completeMint() to
 * the wrong chain.
 */
export interface TransferContext {
  from: ChainId;
  to: ChainId;
  network: Network;
  recipient: string;
}

export function useTransfer() {
  const [status, setStatus] = useState<TransferUiStatus>("idle");
  const [result, setResult] = useState<TransferResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set whenever transfer() throws a TransferError: burnTxHash is still recoverable via
  // completeMint() even though the promise rejected, so the UI can offer that instead of
  // just telling the user to go find the hash themselves on an explorer.
  const [recoverableBurnTxHash, setRecoverableBurnTxHash] = useState<string | null>(null);
  // Set for a SubmissionTimeoutError that isn't a TransferError, i.e. an approve step's
  // confirmation timed out, not the burn itself. There's no burn hash to recover with here
  // (the burn was never reached), but it's still wrong to claim nothing was submitted: this
  // specific transaction was broadcast, its outcome is just unconfirmed.
  const [submissionUncertain, setSubmissionUncertain] = useState(false);
  const [context, setContext] = useState<TransferContext | null>(null);

  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);

  const submit = useCallback(async (params: TransferParams): Promise<TransferResult | null> => {
    setStatus("submitting");
    setError(null);
    setRecoverableBurnTxHash(null);
    setSubmissionUncertain(false);
    setContext({
      from: params.from,
      to: params.to,
      network: params.network ?? "mainnet",
      recipient: params.recipient,
    });
    try {
      const transferResult = await transfer(params);
      setResult(transferResult);
      setStatus(transferResult.status === "success" ? "success" : "pending");
      return transferResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      // Only a TransferError with a real hash means the burn landed. Anything else failed
      // before the burn, so there is nothing to recover and retrying is the right move.
      if (err instanceof TransferError && err.burnTxHash) {
        setRecoverableBurnTxHash(err.burnTxHash);
      } else if (err instanceof SubmissionTimeoutError) {
        setSubmissionUncertain(true);
      }
      setStatus("error");
      return null;
    }
  }, []);

  const finishPending = useCallback(async (params: CompleteMintParams) => {
    setStatus("submitting");
    setError(null);
    try {
      const completeResult = await completeMint(params);
      setResult((previous) =>
        previous
          ? { ...previous, status: "success", mintTxHash: completeResult.mintTxHash, attestationHash: completeResult.attestationHash }
          : { status: "success", transferMode: "standard", burnTxHash: params.burnTxHash, mintTxHash: completeResult.mintTxHash, attestationHash: completeResult.attestationHash, fee: "0", durationMs: 0 },
      );
      setRecoverableBurnTxHash(null);
      setStatus("success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      // Only a TransferError with a real hash means the burn landed. Anything else failed
      // before the burn, so there is nothing to recover and retrying is the right move.
      if (err instanceof TransferError && err.burnTxHash) {
        setRecoverableBurnTxHash(err.burnTxHash);
      } else if (err instanceof SubmissionTimeoutError) {
        setSubmissionUncertain(true);
      }
      setStatus("error");
    }
  }, []);

  // Marks the pending transfer complete from a mint produced outside this hook, i.e. by the
  // Onderhaus sponsor rather than by completeMint() with a local wallet. The burn and
  // attestation already happened, so only the final hashes and status change.
  const markCompleted = useCallback((mintTxHash: string, attestationHash: string) => {
    setResult((previous) =>
      previous
        ? { ...previous, status: "success", mintTxHash, attestationHash: attestationHash || previous.attestationHash }
        : previous,
    );
    setStatus("success");
  }, []);

  const estimate = useCallback(async (params: EstimateFeeParams) => {
    setEstimating(true);
    try {
      setFeeEstimate(await estimateFee(params));
    } catch {
      setFeeEstimate(null);
    } finally {
      setEstimating(false);
    }
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setResult(null);
    setError(null);
    setRecoverableBurnTxHash(null);
    setSubmissionUncertain(false);
    setContext(null);
  }, []);

  return {
    status,
    result,
    error,
    recoverableBurnTxHash,
    submissionUncertain,
    context,
    submit,
    finishPending,
    markCompleted,
    feeEstimate,
    estimating,
    estimate,
    reset,
  };
}
