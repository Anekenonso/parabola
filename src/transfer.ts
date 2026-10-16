import type {
  TransferParams,
  TransferResult,
  TransferMode,
  ArcSigner,
  StellarSigner,
  ChainId,
  Signer,
  Network,
  CompleteMintParams,
  CompleteMintResult,
  ResolveBurnParams,
  ResolvedBurn,
} from "./types.js";
import {
  ARC_DOMAIN,
  STELLAR_DOMAIN,
  stellarConfig,
  FINALITY_THRESHOLD_STANDARD,
  FINALITY_THRESHOLD_FAST,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
} from "./constants.js";
import { fetchFastTransferFeeBps, pollForAttestation, getAttestation } from "./iris/poll.js";
import { resolveFastFallback } from "./estimate.js";
import { TransferError, SubmissionTimeoutError, AttestationNotReadyError } from "./errors.js";
import { toRawAmount, fromRawAmount, decimalsForChain } from "./utils/amount.js";
import { parseUsdcAmount, stellarAddressToBytes32, evmAddressToBytes32, encodeStellarForwardHook } from "./utils/encoding.js";
import { decodeCctpMessage } from "./utils/message.js";
import { approveUsdcOnArc, burnUsdcOnArcWithStellarForward, receiveMessageOnArc } from "./chains/arc.js";
import {
  approveUsdcOnStellar,
  burnUsdcOnStellar,
  mintAndForwardOnStellar,
  checkStellarRecipientReady,
} from "./chains/stellar.js";

function domainFor(chain: "arc" | "stellar"): number {
  return chain === "arc" ? ARC_DOMAIN : STELLAR_DOMAIN;
}

export async function transfer(params: TransferParams): Promise<TransferResult> {
  const start = Date.now();
  const options = params.options ?? {};
  const network: Network = params.network ?? "mainnet";
  const useSandbox = network === "testnet";
  const stellarRpcUrl = options.stellarRpcUrl;
  const arcRpcUrl = options.arcRpcUrl;
  const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeout = options.pollTimeout ?? DEFAULT_POLL_TIMEOUT_MS;

  const precheck = resolveFastFallback({
    speed: params.speed,
    maxWait: options.maxWait,
    sourceChain: params.from,
  });
  let transferMode: TransferMode = precheck.transferMode;
  let feeRaw = 0n;

  if (transferMode === "fast") {
    const feeBps = await fetchFastTransferFeeBps(domainFor(params.from), domainFor(params.to), useSandbox);
    const amountRawSource = toRawAmount(params.amount, params.from);
    const quotedFeeRaw = (amountRawSource * BigInt(feeBps)) / 10_000n;
    const resolved = resolveFastFallback({
      speed: params.speed,
      maxWait: options.maxWait,
      feeRaw: quotedFeeRaw,
      maxFee: options.maxFee,
      sourceChain: params.from,
    });
    transferMode = resolved.transferMode;
    feeRaw = resolved.feeRaw;
  }

  const minFinalityThreshold =
    transferMode === "fast" ? FINALITY_THRESHOLD_FAST : FINALITY_THRESHOLD_STANDARD;
  const amountRaw = toRawAmount(params.amount, params.from);
  const maxFeeRaw =
    transferMode === "fast" && options.maxFee !== undefined
      ? parseUsdcAmount(options.maxFee, decimalsForChain(params.from))
      : feeRaw;

  const burnTxHash = await burn({
    params,
    network,
    stellarRpcUrl,
    arcRpcUrl,
    amountRaw,
    maxFeeRaw,
    minFinalityThreshold,
  });

  // Everything past this point runs after the source-chain burn has already happened.
  // Any failure here (attestation timeout, a mint-step error) must not lose burnTxHash;
  // the caller still needs it to recover via completeMint(), so it's rethrown attached to
  // a TransferError rather than left to vanish with a bare Error.
  let attestationHash: string | undefined;
  try {
    const attestation = await pollForAttestation({
      sourceDomain: domainFor(params.from),
      transactionHash: burnTxHash,
      useSandbox,
      pollInterval,
      pollTimeout,
    });
    attestationHash = attestation.attestation ?? undefined;

    let mintTxHash = "";
    let status: TransferResult["status"] = "pending";

    if (options.destinationSigner && attestation.message && attestation.attestation) {
      mintTxHash = await mint({
        to: params.to,
        message: attestation.message as `0x${string}`,
        attestation: attestation.attestation as `0x${string}`,
        signer: options.destinationSigner,
        network,
        stellarRpcUrl,
        arcRpcUrl,
      });
      status = "success";
    }

    return {
      status,
      transferMode,
      burnTxHash,
      attestationHash: attestation.attestation ?? "",
      mintTxHash,
      fee: transferMode === "fast" ? fromRawAmount(feeRaw, params.from) : "0",
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // burnTxHash has to survive this wrap, but so does the distinction between "Circle has
    // not attested it yet" and a real failure, since a caller retries one and gives up on
    // the other. That distinction rides along as a code rather than only in the message.
    const code = err instanceof AttestationNotReadyError ? "ATTESTATION_NOT_READY" : undefined;
    throw new TransferError(message, burnTxHash, attestationHash, code);
  }
}

async function burn(args: {
  params: TransferParams;
  network: Network;
  stellarRpcUrl?: string;
  arcRpcUrl?: string;
  amountRaw: bigint;
  maxFeeRaw: bigint;
  minFinalityThreshold: number;
}): Promise<string> {
  const { params, network, stellarRpcUrl, arcRpcUrl, amountRaw, maxFeeRaw, minFinalityThreshold } =
    args;

  if (params.from === "arc") {
    const signer = params.signer;

    // Arc is only ever the source of a Stellar-bound transfer here, so the recipient
    // check and the hook encoding are unconditional rather than gated on params.to.
    await assertStellarRecipientReady(params.recipient, network, stellarRpcUrl);

    // TokenMessengerV2 pulls USDC via transferFrom under the hood; it must be
    // approved to spend at least amountRaw before depositForBurnWithHook will
    // succeed. Approving the exact amount per call avoids leaving a standing
    // allowance beyond what this transfer needs.
    await approveUsdcOnArc(signer, amountRaw, network, arcRpcUrl);
    return runBurn(() => {
      const hookData = encodeStellarForwardHook(params.recipient);
      const mintRecipientBytes32 = stellarAddressToBytes32(stellarConfig(network).cctpForwarder);
      return burnUsdcOnArcWithStellarForward({
        amountRaw,
        destinationDomain: STELLAR_DOMAIN,
        mintRecipientBytes32,
        maxFeeRaw,
        minFinalityThreshold,
        hookData,
        signer,
        network,
        rpcUrl: arcRpcUrl,
      });
    });
  }

  const signer = params.signer;
  const mintRecipientBytes32 = evmAddressToBytes32(params.recipient);
  // Stellar's SEP-41 USDC token requires the same approve-before-transfer_from
  // pattern as ERC20 on Arc.
  await approveUsdcOnStellar(amountRaw, signer, network, stellarRpcUrl);
  return runBurn(() =>
    burnUsdcOnStellar({
      amountRaw,
      destinationDomain: ARC_DOMAIN,
      mintRecipientBytes32,
      maxFeeRaw,
      minFinalityThreshold,
      signer,
      network,
      rpcUrl: stellarRpcUrl,
    }),
  );
}

/**
 * Verifies a Stellar recipient can actually receive USDC before anything is burned on
 * Arc toward it. Without this, an unfunded or trustline-less recipient only surfaces as
 * a failed mint_and_forward call after the burn has already gone through, leaving USDC
 * stuck at the CctpForwarder with no way back to the sender.
 */
async function assertStellarRecipientReady(
  recipient: string,
  network: Network,
  rpcUrl?: string,
): Promise<void> {
  const status = await checkStellarRecipientReady(recipient, network, rpcUrl);
  if (!status.exists) {
    throw new Error(
      `Stellar recipient ${recipient} does not exist yet. It must be funded with at least the minimum XLM reserve before it can receive USDC.`,
    );
  }
  if (!status.hasTrustline) {
    throw new Error(
      `Stellar recipient ${recipient} exists but has no USDC trustline. It must add a trustline for the USDC asset before it can receive USDC.`,
    );
  }
}

/**
 * Runs the actual burn call (as opposed to the approve step before it). If confirmation
 * times out here, funds may have left the source chain. Unlike an approve
 * timeout, this is the one point in burn() where losing the hash would mean losing the
 * only way to recover via completeMint(), so it's converted to a TransferError instead
 * of propagating as a bare SubmissionTimeoutError.
 */
async function runBurn(call: () => Promise<string>): Promise<string> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof SubmissionTimeoutError) {
      throw new TransferError(err.message, err.hash);
    }
    throw err;
  }
}

async function mint(args: {
  to: ChainId;
  message: `0x${string}`;
  attestation: `0x${string}`;
  signer: Signer;
  network: Network;
  stellarRpcUrl?: string;
  arcRpcUrl?: string;
}): Promise<string> {
  const { to, message, attestation, signer, network, stellarRpcUrl, arcRpcUrl } = args;

  if (to === "arc") {
    return receiveMessageOnArc({
      message,
      attestation,
      signer: signer as ArcSigner,
      network,
      rpcUrl: arcRpcUrl,
    });
  }
  return mintAndForwardOnStellar({
    message,
    attestation,
    signer: signer as StellarSigner,
    network,
    rpcUrl: stellarRpcUrl,
  });
}

/**
 * Reads back what a burn has already committed to: the destination domain, the amount, and
 * for a Stellar-bound burn the account the mint will actually pay.
 *
 * This matters most for a service completing someone else's transfer. The burn message is
 * the only authoritative statement of where the minted USDC goes, and the forward hook
 * inside it is the only place a Stellar recipient is recorded, so a caller that has not
 * produced the burn itself has no other way to learn the destination.
 *
 * Resolves as soon as Iris has indexed the burn, which is before Circle signs it, so the
 * message can be read while the attestation is still pending. `attestation` in the result
 * is null in that case.
 */
export async function resolveBurn(params: ResolveBurnParams): Promise<ResolvedBurn> {
  const network: Network = params.network ?? "mainnet";
  const attestation = await getAttestation({
    sourceDomain: domainFor(params.from),
    transactionHash: params.burnTxHash,
    useSandbox: network === "testnet",
  });

  if (!attestation.message) {
    throw new AttestationNotReadyError(
      `Iris has indexed burn ${params.burnTxHash} but returned no message for it`,
      params.burnTxHash,
    );
  }

  return {
    ...decodeCctpMessage(attestation.message),
    attestation: attestation.attestation,
  };
}

/**
 * Completes a transfer that was left "pending" because transfer() was called
 * without options.destinationSigner, or one whose burn was produced by another system
 * entirely. Re-polls Iris for the burn's attestation (in case it wasn't available yet)
 * and submits the destination-chain mint: receiveMessage on Arc, or mint_and_forward on
 * Stellar's CctpForwarder.
 *
 * For a Stellar destination the mint pays whichever account the burn message's forward
 * hook names, so that account is read out of the message and checked before anything is
 * submitted. transfer() performs the same check up front; doing it here too means the
 * guarantee holds for a caller that never ran transfer() at all.
 */
export async function completeMint(params: CompleteMintParams): Promise<CompleteMintResult> {
  const network: Network = params.network ?? "mainnet";
  const useSandbox = network === "testnet";
  const options = params.options ?? {};
  // The top-level knobs predate CompleteMintOptions. They still resolve, but options wins
  // so a caller that passes both gets the documented precedence rather than an error.
  const pollInterval = options.pollInterval ?? params.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeout = options.pollTimeout ?? params.pollTimeout ?? DEFAULT_POLL_TIMEOUT_MS;
  const stellarRpcUrl = options.stellarRpcUrl ?? params.stellarRpcUrl;
  const arcRpcUrl = options.arcRpcUrl ?? params.arcRpcUrl;

  const attestation = await pollForAttestation({
    sourceDomain: domainFor(params.from),
    transactionHash: params.burnTxHash,
    useSandbox,
    pollInterval,
    pollTimeout,
  });

  if (!attestation.message || !attestation.attestation) {
    throw new AttestationNotReadyError(
      `Iris returned no attestation for burn ${params.burnTxHash}`,
      params.burnTxHash,
    );
  }

  if (params.to === "stellar") {
    const { forwardRecipient } = decodeCctpMessage(attestation.message);
    if (!forwardRecipient) {
      throw new Error(
        `Burn ${params.burnTxHash} carries no readable Stellar forward recipient, so the account this mint would pay cannot be determined. Refusing to submit a mint to an unknown destination.`,
      );
    }
    await assertStellarRecipientReady(forwardRecipient, network, stellarRpcUrl);
  }

  const mintTxHash = await mint({
    to: params.to,
    message: attestation.message as `0x${string}`,
    attestation: attestation.attestation as `0x${string}`,
    signer: params.signer,
    network,
    stellarRpcUrl,
    arcRpcUrl,
  });

  return { mintTxHash, attestationHash: attestation.attestation };
}
