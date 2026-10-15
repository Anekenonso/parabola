import {
  Contract,
  TransactionBuilder,
  BASE_FEE,
  Address,
  nativeToScVal,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import { stellarConfig, STELLAR_TX_TIMEOUT_SECONDS, STELLAR_CONFIRMATION_TIMEOUT_MS, STELLAR_INCLUSION_FEE } from "../constants.js";
import type { StellarSigner, Network } from "../types.js";
import { SubmissionTimeoutError } from "../errors.js";

export interface StellarRetryOptions {
  attempts?: number;
  delayMs?: number;
}

function getServer(network: Network, rpcUrl?: string): rpc.Server {
  return new rpc.Server(rpcUrl ?? stellarConfig(network).sorobanRpcUrl);
}

async function signTransaction(
  xdr: string,
  signer: StellarSigner,
  network: Network,
): Promise<string> {
  const passphrase = stellarConfig(network).networkPassphrase;
  if (signer.signTransaction) {
    return signer.signTransaction(xdr, passphrase);
  }
  if (signer.keypair) {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase);
    tx.sign(signer.keypair);
    return tx.toXDR();
  }
  throw new Error("StellarSigner must provide either a keypair or a signTransaction function");
}

/**
 * Simulates, prepares, signs, and submits a Soroban contract invocation, then
 * polls the RPC server until the transaction is confirmed. Returns the tx hash.
 */
async function invokeContract(
  contractId: string,
  method: string,
  args: ReturnType<typeof nativeToScVal>[],
  signer: StellarSigner,
  network: Network,
  rpcUrl?: string,
): Promise<string> {
  const server = getServer(network, rpcUrl);
  const account = await server.getAccount(signer.publicKey);
  const contract = new Contract(contractId);

  const builtTx = new TransactionBuilder(account, {
    fee: STELLAR_INCLUSION_FEE,
    networkPassphrase: stellarConfig(network).networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(STELLAR_TX_TIMEOUT_SECONDS)
    .build();

  const prepared = await server.prepareTransaction(builtTx);
  const signedXdr = await signTransaction(prepared.toXDR(), signer, network);
  const signedTx = TransactionBuilder.fromXDR(signedXdr, stellarConfig(network).networkPassphrase);

  const sendResult = await server.sendTransaction(signedTx);
  if (sendResult.status === "ERROR") {
    throw new Error(`Stellar transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  return pollTransactionStatus(server, sendResult.hash);
}

async function pollTransactionStatus(server: rpc.Server, hash: string): Promise<string> {
  const deadline = Date.now() + STELLAR_CONFIRMATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await server.getTransaction(hash);
    if (result.status === "SUCCESS") return hash;
    if (result.status === "FAILED") {
      throw new Error(`Stellar transaction ${hash} failed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  // The transaction was broadcast (this hash came from a successful sendTransaction);
  // confirmation did not arrive within the timeout. This differs from never having been
  // submitted, so the hash is surfaced for callers to act on instead of being discarded
  // in a bare error.
  throw new SubmissionTimeoutError(`Timed out waiting for Stellar transaction ${hash} to confirm`, hash);
}

/**
 * Approves Stellar's TokenMessengerMinter to pull USDC from the signer via the
 * SEP-41 token's transfer_from, mirroring the ERC20 approve step CCTP needs on
 * EVM chains. Required before deposit_for_burn, which otherwise fails with
 * "not enough allowance to spend".
 */
export async function approveUsdcOnStellar(
  amountRaw: bigint,
  signer: StellarSigner,
  network: Network,
  rpcUrl?: string,
  retryOptions?: StellarRetryOptions,
): Promise<string> {
  const stellar = stellarConfig(network);
  const server = getServer(network, rpcUrl);
  const latestLedger = await server.getLatestLedger();
  const expirationLedger = latestLedger.sequence + 100_000;

  const args = [
    Address.fromString(signer.publicKey).toScVal(),
    Address.fromString(stellar.tokenMessengerMinter).toScVal(),
    nativeToScVal(amountRaw, { type: "i128" }),
    nativeToScVal(expirationLedger, { type: "u32" }),
  ];

  const approveTxHash = await invokeContract(stellar.usdc, "approve", args, signer, network, rpcUrl);

  // The approve tx above is confirmed (SUCCESS) by this point, but a subsequent
  // deposit_for_burn simulation can still read a stale allowance of 0 immediately
  // afterward. This is RPC read-after-write lag between the ledger closing and it
  // becoming queryable for simulation. Poll the on-chain allowance until it reflects
  // the approval (or fail with a clear error) before returning, so the two calls do not
  // proceed on disagreeing views of state.
  await waitForAllowance(
    signer.publicKey,
    stellar.tokenMessengerMinter,
    amountRaw,
    network,
    rpcUrl,
    retryOptions,
  );

  return approveTxHash;
}

export interface StellarRecipientStatus {
  /** Whether the account exists on-ledger (has been funded with at least the minimum XLM reserve). */
  exists: boolean;
  /** Whether the account holds a trustline for the USDC asset. Only meaningful when `exists` is true. */
  hasTrustline: boolean;
  /** True only when both `exists` and `hasTrustline` are true; a mint sent here would actually land. */
  ready: boolean;
}

const MISSING_TRUSTLINE_MESSAGE = "trustline entry is missing for account";

/**
 * Checks whether a Stellar account can receive USDC: it must exist on-ledger (accounts do
 * not exist until minimally funded with XLM) and hold a trustline for the USDC asset. An
 * unfunded account causes server.getAccount() to throw "Account not found"; a funded
 * account without a USDC trustline causes the balance() simulation to fail with
 * Error(Contract, #13) / "trustline entry is missing for account" rather than returning a
 * zero balance.
 */
export async function checkStellarRecipientReady(
  recipient: string,
  network: Network = "mainnet",
  rpcUrl?: string,
): Promise<StellarRecipientStatus> {
  const stellar = stellarConfig(network);
  const server = getServer(network, rpcUrl);

  let account;
  try {
    account = await server.getAccount(recipient);
  } catch {
    return { exists: false, hasTrustline: false, ready: false };
  }

  const contract = new Contract(stellar.usdc);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: stellar.networkPassphrase,
  })
    .addOperation(contract.call("balance", Address.fromString(recipient).toScVal()))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    if (sim.error.includes(MISSING_TRUSTLINE_MESSAGE)) {
      return { exists: true, hasTrustline: false, ready: false };
    }
    throw new Error(`Failed to check Stellar recipient's USDC trustline: ${sim.error}`);
  }

  return { exists: true, hasTrustline: true, ready: true };
}

async function getUsdcAllowance(
  owner: string,
  spender: string,
  network: Network,
  rpcUrl?: string,
): Promise<bigint> {
  const stellar = stellarConfig(network);
  const server = getServer(network, rpcUrl);
  const account = await server.getAccount(owner);
  const contract = new Contract(stellar.usdc);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: stellar.networkPassphrase,
  })
    .addOperation(
      contract.call("allowance", Address.fromString(owner).toScVal(), Address.fromString(spender).toScVal()),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Failed to read Stellar USDC allowance: ${sim.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    return 0n;
  }
  return BigInt(scValToNative(sim.result.retval));
}

async function waitForAllowance(
  owner: string,
  spender: string,
  minimum: bigint,
  network: Network,
  rpcUrl?: string,
  retryOptions?: StellarRetryOptions,
): Promise<void> {
  const attempts = retryOptions?.attempts ?? 6;
  const delayMs = retryOptions?.delayMs ?? 1500;
  for (let i = 0; i < attempts; i++) {
    const allowance = await getUsdcAllowance(owner, spender, network, rpcUrl);
    if (allowance >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(
    `Approved USDC allowance for ${spender} did not reach ${minimum} after ${(attempts * delayMs) / 1000}s of polling; the approval transaction confirmed but the network hasn't reflected it yet`,
  );
}

/**
 * Calls deposit_for_burn on Stellar's TokenMessengerMinter, burning USDC to be
 * minted on the destination CCTP domain.
 */
export async function burnUsdcOnStellar(params: {
  amountRaw: bigint;
  destinationDomain: number;
  mintRecipientBytes32: `0x${string}`;
  maxFeeRaw: bigint;
  minFinalityThreshold: number;
  signer: StellarSigner;
  network: Network;
  rpcUrl?: string;
  retryOptions?: StellarRetryOptions;
}): Promise<string> {
  const stellar = stellarConfig(params.network);
  const recipientBytes = Buffer.from(params.mintRecipientBytes32.slice(2), "hex");

  // Argument order per the deployed contract's interface (stellar contract info
  // interface): caller comes first, not last, as in deposit_for_burn(caller,
  // amount, destination_domain, mint_recipient, burn_token, destination_caller,
  // max_fee, min_finality_threshold). Do not reorder from memory; re-verify
  // against the contract if this signature ever needs to change.
  const args = [
    Address.fromString(params.signer.publicKey).toScVal(),
    nativeToScVal(params.amountRaw, { type: "i128" }),
    nativeToScVal(params.destinationDomain, { type: "u32" }),
    nativeToScVal(recipientBytes, { type: "bytes" }),
    Address.fromString(stellar.usdc).toScVal(),
    nativeToScVal(Buffer.alloc(32), { type: "bytes" }), // destinationCaller: unrestricted
    nativeToScVal(params.maxFeeRaw, { type: "i128" }),
    nativeToScVal(params.minFinalityThreshold, { type: "u32" }),
  ];

  // waitForAllowance() in approveUsdcOnStellar confirms on-chain state is caught up before
  // this runs, but that confirmation and this call's own getAccount()/simulation can land
  // on different RPC nodes that have not converged yet. Two symptoms share this cause: a
  // stale allowance read ("not enough allowance"), and a stale account sequence number
  // (txBadSeq) when the node serving this call's getAccount() has not seen the approve's
  // sequence bump. Both are handled by retrying: invokeContract() re-fetches the account on
  // every call, so a retry can reach a caught-up node.
  return retryOnTransientRpcLag(() =>
    invokeContract(stellar.tokenMessengerMinter, "deposit_for_burn", args, params.signer, params.network, params.rpcUrl),
    params.retryOptions,
  );
}

function isTransientRpcLagError(message: string): boolean {
  return message.includes("not enough allowance") || message.includes("txBadSeq");
}

async function retryOnTransientRpcLag(
  call: () => Promise<string>,
  retryOptions?: StellarRetryOptions,
): Promise<string> {
  const attempts = retryOptions?.attempts ?? 3;
  const delayMs = retryOptions?.delayMs ?? 2000;
  for (let i = 0; i < attempts; i++) {
    try {
      return await call();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isLastAttempt = i === attempts - 1;
      if (!isTransientRpcLagError(message) || isLastAttempt) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("unreachable");
}

/**
 * Calls mint_and_forward on Stellar's CctpForwarder contract. This is the only
 * supported way to land an inbound CCTP transfer on Stellar: it verifies the
 * message and attestation, mints USDC to the forwarder, then forwards it to
 * the recipient strkey encoded in the burn message's hook data.
 */
export async function mintAndForwardOnStellar(params: {
  message: `0x${string}`;
  attestation: `0x${string}`;
  signer: StellarSigner;
  network: Network;
  rpcUrl?: string;
}): Promise<string> {
  const stellar = stellarConfig(params.network);
  const args = [
    nativeToScVal(Buffer.from(params.message.slice(2), "hex"), { type: "bytes" }),
    nativeToScVal(Buffer.from(params.attestation.slice(2), "hex"), { type: "bytes" }),
  ];

  return invokeContract(stellar.cctpForwarder, "mint_and_forward", args, params.signer, params.network, params.rpcUrl);
}
