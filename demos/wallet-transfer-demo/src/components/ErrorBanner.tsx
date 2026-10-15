import { useState } from "react";
import type { ChainId, Network } from "@asctp/parabola";
import { explorerUrl } from "../lib/explorer.js";

interface Props {
  message: string;
  recoverableBurnTxHash: string | null;
  /** Chain the burn ran on, captured at submit time; used for the wording and explorer link. */
  burnChain: ChainId | null;
  /** Chain the burn is committed to mint on, captured at submit time. */
  destinationChain: ChainId | null;
  network: Network;
  submissionUncertain: boolean;
  destinationWalletConnected: boolean;
  onRecover: () => void;
  recovering: boolean;
  onDismiss: () => void;
}

/**
 * transfer() throwing does not mean nothing happened: the source-chain burn step can
 * succeed and then a later step (attestation polling, the mint call) can still fail.
 * transfer() rethrows those as a TransferError carrying burnTxHash (see src/errors.ts) --
 * recoverableBurnTxHash reflects that, and this banner turns into a recovery panel that
 * finishes the same burn with completeMint() instead of inviting a second burn. Separately,
 * an approve step's own confirmation can time out before the burn is ever attempted
 * (submissionUncertain): there's no burn hash to recover with, but that transaction was
 * still genuinely broadcast, so this banner never claims "nothing happened" for that case
 * either.
 */
export function ErrorBanner({
  message,
  recoverableBurnTxHash,
  burnChain,
  destinationChain,
  network,
  submissionUncertain,
  destinationWalletConnected,
  onRecover,
  recovering,
  onDismiss,
}: Props) {
  const [copied, setCopied] = useState(false);

  async function copyBurnHash() {
    if (!recoverableBurnTxHash) return;
    try {
      await navigator.clipboard.writeText(recoverableBurnTxHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied (insecure context, permissions); the hash stays
      // visible and selectable, so there is nothing else to do.
    }
  }

  return (
    <div className="error-banner" role="alert">
      <p>{message}</p>
      {recoverableBurnTxHash ? (
        <div className="recovery">
          <p>
            <strong>Your funds are safe.</strong> The burn on {burnChain ?? "the source chain"}{" "}
            succeeded, so the USDC has left the source chain, but it has not been minted on{" "}
            {destinationChain ?? "the destination chain"} yet. Do not start the transfer again:
            that would burn a second time. Complete this one instead.
          </p>
          <div className="recovery-hash">
            <span>Burn tx</span>
            <code>{recoverableBurnTxHash}</code>
            <button className="link-button" onClick={copyBurnHash}>
              {copied ? "Copied" : "Copy"}
            </button>
            {burnChain && (
              <a href={explorerUrl(burnChain, recoverableBurnTxHash, network)} target="_blank" rel="noreferrer">
                View on explorer
              </a>
            )}
          </div>
          <p className="hint">
            Keep this hash: it is all completeMint() needs to finish the transfer, even later
            from another tool.
            {!destinationWalletConnected &&
              ` Connect your ${destinationChain ?? "destination"} wallet to complete it here.`}
          </p>
        </div>
      ) : submissionUncertain ? (
        <p>
          A transaction was broadcast (likely the token approval) but its confirmation timed
          out before the burn was attempted, so no funds have left the source chain. It may
          still land on its own; check your address on the source-chain explorer if you want
          to confirm before retrying, though retrying is low-risk here since approvals just
          overwrite the allowance rather than accumulate.
        </p>
      ) : (
        <p>Nothing was submitted on-chain yet, so it's safe to retry.</p>
      )}
      <div className="error-banner-actions">
        {recoverableBurnTxHash && (
          <button onClick={onRecover} disabled={!destinationWalletConnected || recovering}>
            {recovering ? "Completing transfer..." : "Complete transfer"}
          </button>
        )}
        <button className="link-button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
