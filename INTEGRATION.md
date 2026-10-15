# Integrating Parabola

## Who this guide is for

The [README](README.md) covers installation and one-off scripts: import `transfer()`, build a
signer, call it, done. This guide is different: it's for wiring Parabola into a persistent
application, backend service or browser app, where the concerns are different: where do keys
live, what happens when a call fails partway through, and how do you resume a transfer that
didn't finish. If you haven't read the README yet, start there; this guide assumes you have.

## Two integration patterns

### Pattern A: backend-held keys

**When to use:** your service already custodies a hot wallet key server-side for one or both
chains, e.g. an operational treasury wallet, a relayer, anything where the key already lives in
your infrastructure rather than a user's wallet.

**Shape:** build a signer once from an env-stored private key, call `transfer()` from an API
route or background job. This is exactly what [`examples/arc-to-stellar.ts`](examples/arc-to-stellar.ts)
and [`examples/stellar-to-arc.ts`](examples/stellar-to-arc.ts) already show; read those as the
base pattern for this approach.

### Pattern B: non-custodial browser wallet (recommended for user-facing apps)

**When to use:** end users connect their own wallets and your app never touches a private key.

**Shape:**

- `ArcSigner` just wraps a viem `WalletClient`. Build one from an injected wallet with
  `createWalletClient({ account, chain: arcMainnetChain, transport: custom(window.ethereum) })`
  and you have a valid `ArcSigner` (use `arcTestnetChain` for testnet). Nothing Parabola-specific about it.
- `StellarSigner` accepts a `signTransaction` callback instead of a raw `Keypair` for exactly
  this case. Freighter's own `signTransaction(xdr, opts)` resolves to
  `{ signedTxXdr: string; signerAddress: string; error?: FreighterApiError }` (note it's an
  **object**, not a plain string, and it never throws; check `.error` on every call). Your
  callback just needs to unwrap `.signedTxXdr`.

**Reference:** [`demos/wallet-transfer-demo/`](demos/wallet-transfer-demo) is the full working
example of this pattern, specifically
[`src/lib/arcWallet.ts`](demos/wallet-transfer-demo/src/lib/arcWallet.ts) and
[`src/lib/stellarWallet.ts`](demos/wallet-transfer-demo/src/lib/stellarWallet.ts).

## What happens when a call fails partway through

### Transfer lifecycle and where funds sit at each boundary

Every `transfer()` call progresses through five discrete boundaries:

1. **Pre-flight & recipient readiness check** (`checkStellarRecipientReady` for Stellar destinations, address/amount validation). **No funds or allowances have moved.** Any error thrown here means the source wallet's USDC balance is untouched.
2. **USDC allowance approval** (`approveUsdcOnArc` on Arc or `approveUsdcOnStellar` on Stellar). Grants `TokenMessengerV2` / `TokenMessengerMinter` permission to spend `amountRaw`, but **no USDC has been burned yet.**
3. **Source-chain burn** (`depositForBurnWithHook` on Arc or `deposit_for_burn` on Stellar). Once broadcast, a transaction hash (`burnTxHash`) exists; once confirmed, the USDC is locked/burned on the source chain and committed to the destination encoded in the CCTP V2 message. **From this point onward, never re-run `transfer()` to recover a failed call—doing so would burn a second time. Always recover with `completeMint({ from, to, burnTxHash, signer, network })`.**
4. **Circle Iris attestation polling** (`pollForAttestation` / `getAttestation`). Circle observes the confirmed source-chain burn and signs an attestation over the message bytes. While Circle is indexing or waiting for finality, the funds are safely committed to the burn message on-chain.
5. **Destination-chain mint** (`receiveMessage` on Arc or `mint_and_forward` on Stellar's `CctpForwarder`). Submits the attested message and signature to mint USDC to the recipient. Because CCTP enforces nonce uniqueness on the destination chain, `completeMint()` is safe to retry if an attestation wait or mint RPC call fails.

---

### Error classes, what they mean for funds, and what to do next

Every error class exported from `@asctp/parabola` (`src/index.ts`) maps to a specific fund state and recovery action:

| Exported Error Class | When it is thrown | State of funds | Recommended action |
| --- | --- | --- | --- |
| `TransferError` (`err.code === "ATTESTATION_NOT_READY"`) | `transfer()` confirmed the source-chain burn (`err.burnTxHash`), then `pollTimeout` elapsed before Circle finished signing the attestation. | **Funds are safe.** USDC was burned on the source chain and is waiting to be minted on the destination. | **Safe to retry mint:** Persist `err.burnTxHash` and call `completeMint()` after a delay (do **not** call `transfer()` again). |
| `TransferError` (`err.code === undefined`) |Either (a) the burn succeeded and a post-burn step (Iris 5xx or destination mint) failed, **or** (b) the burn transaction itself timed out waiting for confirmation (`err.attestationHash` is `undefined`). | **Funds left or may have left the source chain.** `err.burnTxHash` is always populated. | Persist `err.burnTxHash`. If `err.attestationHash` is present (or once `resolveBurn()` shows the burn is indexed by Iris), recover with `completeMint()`. If the burn tx timed out before confirmation, inspect `err.burnTxHash` on the source chain or via `resolveBurn()` before deciding whether to call `completeMint()` or start a new transfer. |
| `AttestationNotReadyError` | Thrown directly by `getAttestation()`, `resolveBurn()`, or `completeMint()` when Iris has not indexed the burn yet (HTTP `404`) or has not finished signing the attestation within `pollTimeout`. | **Funds are safe** (assuming the burn transaction confirmed on-chain). `err.burnTxHash` holds the burn hash. | **Safe to retry:** Wait and call `completeMint()` or `resolveBurn()` again (typically HTTP `409 Conflict` / retry-after in an API service). |
| `IrisRequestError` | Thrown by `getAttestation()`, `resolveBurn()`, `pollForAttestation()`, or wrapped inside `TransferError` when Circle's Iris API returns persistent HTTP `5xx`/non-OK responses or network transport errors. `err.status` carries the HTTP status code when available. | **Funds are safe** if the burn already confirmed; Circle's off-chain API is experiencing an outage. | **Safe to retry with backoff:** Treat as an upstream infrastructure outage (`502`/`503`). Once Iris recovers, resume with `completeMint()` using the saved `burnTxHash`. |
| `SubmissionTimeoutError` | Thrown by chain submit helpers (`approveUsdcOnArc`, `receiveMessageOnArc`, `approveUsdcOnStellar`, `mintAndForwardOnStellar`, or `completeMint()`) when a transaction was broadcast (`err.hash`) but confirmation did not arrive before the confirmation timeout. *(Note: when the burn step inside `transfer()` hits `SubmissionTimeoutError`, `transfer()` wraps it into `TransferError` with `burnTxHash = err.hash`.)* | **Outcome unknown — inspect first.** The transaction is in the network mempool/ledger pipeline and may still confirm or fail. | **Inspect `err.hash` on-chain before retrying.** For an approve or `completeMint()` call, check whether `err.hash` landed on the chain explorer/RPC before submitting a replacement transaction so you do not pay duplicate gas. |

Branch on the class and `err.code`, never on the message text:

```typescript
import {
  transfer,
  completeMint,
  resolveBurn,
  TransferError,
  AttestationNotReadyError,
  IrisRequestError,
  SubmissionTimeoutError,
} from "@asctp/parabola";

try {
  const result = await transfer(params);
  if (result.status === "pending") {
    await ledger.record({ from, to, burnTxHash: result.burnTxHash, network });
  }
} catch (err) {
  if (err instanceof TransferError) {
    await ledger.record({ from, to, burnTxHash: err.burnTxHash, network });
    if (err.code === "ATTESTATION_NOT_READY") {
      return respond(409, { retryable: true, burnTxHash: err.burnTxHash });
    }
    return respond(502, { retryable: true, burnTxHash: err.burnTxHash });
  }
  if (err instanceof SubmissionTimeoutError) {
    // Pre-burn approve or standalone completeMint() timed out after broadcast; inspect err.hash first
    await ledger.record({ txHash: err.hash, network, uncertain: true });
    return respond(504, { retryable: false, txHash: err.hash });
  }
  if (err instanceof IrisRequestError || err instanceof AttestationNotReadyError) {
    return respond(503, { retryable: true });
  }
  return respond(502, { retryable: false });
}
```

---

### Worked recovery examples: `TransferError` -> wait -> `completeMint`

#### Direction 1: Arc -> Stellar recovery

```typescript
import {
  transfer,
  completeMint,
  TransferError,
  AttestationNotReadyError,
  type ArcSigner,
  type StellarSigner,
} from "@asctp/parabola";

async function transferArcToStellarWithRecovery(
  arcSigner: ArcSigner,
  stellarSigner: StellarSigner,
  recipient: string,
) {
  try {
    return await transfer({
      from: "arc",
      to: "stellar",
      amount: "25.00",
      recipient,
      speed: "fast",
      signer: arcSigner,
      network: "mainnet",
      options: {
        destinationSigner: stellarSigner,
        pollTimeout: 60_000,
      },
    });
  } catch (err) {
    if (!(err instanceof TransferError)) {
      // Pre-burn failure (e.g. recipient missing trustline or approve failed): no USDC burned
      throw err;
    }

    console.warn(`Burn ${err.burnTxHash} succeeded on Arc; recovering mint on Stellar...`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    // Resume from the saved burnTxHash without burning again on Arc
    const recovered = await completeMint({
      from: "arc",
      to: "stellar",
      burnTxHash: err.burnTxHash,
      signer: stellarSigner,
      network: "mainnet",
      options: { pollInterval: 3_000, pollTimeout: 300_000 },
    });

    return {
      status: "success" as const,
      burnTxHash: err.burnTxHash,
      attestationHash: recovered.attestationHash,
      mintTxHash: recovered.mintTxHash,
    };
  }
}
```

#### Direction 2: Stellar -> Arc recovery

```typescript
import {
  transfer,
  completeMint,
  TransferError,
  type ArcSigner,
  type StellarSigner,
} from "@asctp/parabola";

async function transferStellarToArcWithRecovery(
  stellarSigner: StellarSigner,
  arcSigner: ArcSigner,
  recipient: `0x${string}`,
) {
  try {
    return await transfer({
      from: "stellar",
      to: "arc",
      amount: "50.00",
      recipient,
      speed: "standard",
      signer: stellarSigner,
      network: "mainnet",
      options: {
        destinationSigner: arcSigner,
        pollTimeout: 120_000,
      },
    });
  } catch (err) {
    if (!(err instanceof TransferError)) {
      throw err;
    }

    console.warn(`Burn ${err.burnTxHash} succeeded on Stellar; recovering mint on Arc...`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    const recovered = await completeMint({
      from: "stellar",
      to: "arc",
      burnTxHash: err.burnTxHash,
      signer: arcSigner,
      network: "mainnet",
      options: { pollInterval: 3_000, pollTimeout: 300_000 },
    });

    return {
      status: "success" as const,
      burnTxHash: err.burnTxHash,
      attestationHash: recovered.attestationHash,
      mintTxHash: recovered.mintTxHash,
    };
  }
}
```

---

### Choosing `pollTimeout` and `pollInterval`

- **Default values:** `pollInterval` defaults to `3_000` ms (3 seconds) and `pollTimeout` defaults to `300_000` ms (5 minutes).
- **Fast transfers (`speed: "fast"`):** Attestations typically arrive within 10–25 seconds once the source block is observed. For interactive UIs or synchronous HTTP handlers, a shorter `pollTimeout` (e.g. `45_000`–`60_000` ms) lets you surface a retryable `"ATTESTATION_NOT_READY"` state quickly and hand off completion to `completeMint()`.
- **Standard transfers (`speed: "standard"`):** Circle waits for full finality (`FINALITY_THRESHOLD_STANDARD = 2000`), which can take 1–4 minutes depending on network conditions. Keep `pollTimeout` at `300_000` ms (or higher in background workers) so polling does not time out before normal finality is reached.
- **Public testnet / sandbox:** Circle's Iris sandbox (`network: "testnet"`) occasionally experiences indexing delays; use `pollTimeout: 300_000` or recover with `completeMint()` if a poll window expires.

## Completing a burn your service did not create

`completeMint()` does not require the burn to have come from this process, or from Parabola at all. It takes `from`, `to`, `burnTxHash`, `network` and a signer for the destination chain, and it keeps no record of burns, so it neither requires nor checks that your service produced the original `transfer()` call. This is the shape a relayer needs.

Read the burn before you spend anything on it. `resolveBurn` returns what the burn already committed to:

```typescript
import { resolveBurn } from "@asctp/parabola";

const burn = await resolveBurn({ from, burnTxHash, network });
// burn.forwardRecipient is the Stellar account the mint will pay, on an arc -> stellar burn
// burn.amountRaw is in the source chain's USDC subunits, 10^6 on Arc
// burn.attestation is null while Circle is still signing
```

`resolveBurn` returns as soon as Iris has indexed the burn, which is before Circle signs, so a populated `forwardRecipient` alongside a null `attestation` is the normal state for the first seconds after a burn. It throws `AttestationNotReadyError` if Iris has not indexed the burn at all yet.

For a service that must answer its own caller immediately rather than holding the request open, `getAttestation` is a single non-blocking read instead of a poll to a deadline:

```typescript
import { getAttestation, AttestationNotReadyError } from "@asctp/parabola";

try {
  const message = await getAttestation({ sourceDomain: 26, transactionHash: burnTxHash, useSandbox: false });
  if (message.status !== "complete" || !message.attestation) {
    return respond(409, { retryable: true });
  }
  // message.message and message.attestation are ready to submit
} catch (err) {
  if (err instanceof AttestationNotReadyError) return respond(409, { retryable: true });
  throw err;
}
```

The Stellar recipient check `transfer()` performs is built into `completeMint()` as well, and it reads the account out of the burn message's forward hook rather than accepting a recipient argument. A relayer therefore cannot accidentally preflight a different account than the one that gets paid.

### Idempotency is yours to enforce

Nothing in Parabola dedupes, and `completeMint()` will submit again for a burn that was already minted. The chain rejects the re-used CCTP message, so no funds move, but you pay gas to learn that.

Keep a ledger keyed on `(burn hash, network)` and return the recorded mint transaction hash for a repeated request instead of resubmitting. A relayer is precisely the caller that retries, so this is a required component rather than a nicety.

## Network selection in a service

`network` is optional everywhere and defaults to `"mainnet"`. That is convenient for a script and is the wrong failure mode for a long-running process holding a funded key, because an omitted field silently spends real USDC.

Default your own configuration to testnet, make mainnet explicit, and reject any request whose `network` disagrees with the operator's choice. That way a caller cannot push the service onto a network the operator did not select.

## Recovering from a "pending" result: destinationSigner and completeMint

This is a different, sanctioned recovery path from the one above: use it when you deliberately
didn't attach `options.destinationSigner` (for example, your backend only holds the source
chain's key at call time). `transfer()` performs the burn and attestation polling, then returns
`status: "pending"` with a populated `burnTxHash` and an empty `mintTxHash`. `completeMint()`
finishes it later, given that `burnTxHash`.

**Persistence requirement this guide adds:** if your backend could restart between the initial
`transfer()` call and calling `completeMint()`, persist `{ from, to, burnTxHash, network }` to
durable storage before you return from the first call. `CompleteMintParams` requires those as
input, and unlike a failure thrown mid-flight, this is a hash Parabola *does* hand back to you,
so don't let it evaporate in memory. Store `network` alongside it: it decides which Iris
environment and which contract addresses the later call uses, and guessing it wrong on recovery
is silent.

**Reference:**
[`src/components/TransferStatus.tsx`](demos/wallet-transfer-demo/src/components/TransferStatus.tsx)'s
"Complete mint" button is the interactive version of this recovery path.

## Running the demo app locally

```bash
pnpm install
pnpm build      # builds @asctp/parabola: required first, see demos/wallet-transfer-demo/README.md
pnpm dev:wallet-transfer-demo
```

Prerequisites: MetaMask and Freighter browser extensions, and funded Arc + Stellar accounts. On
testnet, fund both via [faucet.circle.com](https://faucet.circle.com). Both integration patterns
above are reachable in the same UI: check or uncheck "Complete the mint automatically" to switch
between them.

## Choosing a pattern for your app

No user-key custody at all, ever -> Pattern B. Already have an operational wallet funded and
ready to sign -> Pattern A is simpler, one fewer moving part. Nothing stops a single application
from using both for different flows (e.g. Pattern A for automated payouts, Pattern B for
user-initiated transfers).
