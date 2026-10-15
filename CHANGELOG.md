# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `stellarRetryAttempts` and `stellarRetryDelayMs` transfer options, which tune the two Stellar recovery loops (the post-approve allowance wait and the transient-lag retry around `deposit_for_burn`). Omitted fields keep the current defaults of 6 x 1500ms and 3 x 2000ms. `StellarRetryOptions` is exported.

## [0.4.0] - 2026-10-07

### Added

- `resolveBurn()`, which reads back what a burn has already committed to: the source and destination domains, the raw amount, and for a Stellar-bound burn the account the mint will actually pay. It resolves as soon as Circle's Iris service has indexed the burn, which is before Circle has signed, so a service can learn a burn's destination while the attestation is still pending.
- `getAttestation()`, a single non-blocking Iris read for callers that need to answer immediately and finish later, instead of polling to a deadline the way `completeMint()` does.
- `decodeCctpMessage()` and `decodeStellarForwardHook()`, decoders for the CCTP V2 message layout and the Stellar forward-recipient hook. `tests/message.test.ts` pins the byte offsets against a live testnet attestation rather than against the specification alone.
- `AttestationNotReadyError` and `IrisRequestError`, so "Circle has not attested this yet" and "Circle's API is failing" are distinguishable by class instead of by matching message text. `TransferError` also carries a `code`, set to `"ATTESTATION_NOT_READY"` for the retryable case.
- `options.arcRpcUrl`, the Arc counterpart to `options.stellarRpcUrl`, applied to the receipt reads Parabola performs.
- `CompleteMintParams.options`, accepting the same `pollInterval`, `pollTimeout`, `stellarRpcUrl`, and `arcRpcUrl` as `TransferOptions`. The top-level equivalents still resolve, and `options` wins when both are present.
- `decimalsForChain()` and a re-export of `Keypair` from the package root, so a consumer building a `StellarSigner` does not need a second copy of `@stellar/stellar-sdk` in its own manifest.

### Changed

- **Breaking:** `TransferParams` and `CompleteMintParams` are discriminated unions over the transfer direction. `transfer()` requires a signer native to `from` and `completeMint()` one native to `to`, so a mismatched signer that previously compiled now fails to typecheck. Arc-to-Arc and Stellar-to-Stellar are no longer representable, since neither is a CCTP transfer. `transfer()` applies the same rule to `options.destinationSigner` through the new `ArcDestinationOptions` and `StellarDestinationOptions` types, so the destination signer is checked against `to` rather than accepted as a signer for either chain.
- **Breaking:** `StellarSigner` requires at least one signing route. `{ publicKey }` with neither `keypair` nor `signTransaction` no longer compiles. Supplying both remains valid and prefers `signTransaction`.
- **Breaking:** `completeMint()` reads the Stellar recipient out of the burn message's forward hook and checks it before submitting, and refuses to submit when the hook carries no readable recipient. It previously performed no recipient check at all, leaving the less-guarded entry point as the one a relayer uses. A burn whose forward hook cannot be decoded is now rejected rather than minted into an unknown destination.
- Attestation polling distinguishes a `404` from Iris, which means the burn is not indexed yet and is an ordinary early state, from a `5xx`, which is an upstream failure. Five consecutive failures now stop polling with an `IrisRequestError` rather than running the clock to its deadline.
- `decimalsForChain()` reads the USDC scale as a property of the asset rather than of the deployment. No behavior change: Arc USDC is 6 decimals and Stellar USDC is 7 on both networks, and the previous code read the testnet constants for mainnet calls because the values are identical.

### Fixed

- A broken Circle Iris looked identical to a slow one. Non-OK responses were discarded and the polling loop ran to its deadline, so an outage surfaced as a timeout and neither the caller nor the operator's logs could tell the two apart.
- A not-yet-attested burn threw a plain `Error`, leaving a service to match prose to decide between a retryable `409` and a terminal `502`. It is now `AttestationNotReadyError`, or a `TransferError` whose `code` is `"ATTESTATION_NOT_READY"`.

### Documentation

- `README.md` documents the relayer pattern for completing a burn Parabola did not produce, the error taxonomy a service branches on, and the two scales Arc reports USDC at. Arc's native gas asset and its ERC-20 USDC are one balance at 18 and 6 decimals respectively, so a balance floor expressed in the wrong scale is wrong by a factor of 10^12.
- `INTEGRATION.md` replaces the "burnTxHash is lost if attestation polling times out" section, which 0.2.0 had already made obsolete, with the behavior a service now gets: `TransferError` carries the hash, and the retryable state is signalled by type.

## [0.3.1] - 2026-09-30

### Fixed

- Soroban transactions were built with `BASE_FEE` (100 stroops) as the inclusion fee, leaving no headroom for the resource fee to rise between simulation and submission. A mainnet `mint_and_forward` was rejected with `txInsufficientFee`. The inclusion fee is now `STELLAR_INCLUSION_FEE` (1000000 stroops), a per-transaction ceiling the network does not fully charge (it still takes only the resource fee plus the prevailing inclusion fee).

## [0.3.0] - 2026-09-23

### Added

- Mainnet support for both Arc and Stellar. `transfer()`, `estimateFee()`, `completeMint()`, and `checkStellarRecipientReady()` accept an optional `network` parameter (`"mainnet"` or `"testnet"`) that selects contract addresses, RPC endpoints, and the Circle Iris environment.
- `arcMainnetChain`, `ARC_MAINNET`, `STELLAR_MAINNET`, and the `Network` type are exported from the package root alongside the existing testnet values.
- `options.stellarRpcUrl` to override the Soroban RPC per call. Defaults to `https://mainnet.sorobanrpc.com` on mainnet and `https://soroban-testnet.stellar.org` on testnet.
- `scripts/verify-contract-addresses.mjs` now verifies mainnet addresses in addition to testnet.

### Changed

- **Breaking:** `network` defaults to `"mainnet"`. A 0.2.0 caller that upgrades and does not pass `network` will transact on Arc and Stellar mainnet, moving real USDC and spending real Arc gas. Pass `network: "testnet"` to keep the previous testnet behavior.
- **Breaking:** removed `useSandbox` from `TransferOptions` and `CompleteMintParams`. The Iris environment is now derived from `network` (`testnet` uses the Iris sandbox), so `useSandbox` is no longer needed. Callers that set it should pass `network: "testnet"` instead.
- `pnpm smoke` still defaults to testnet for safety; set `NETWORK=mainnet` to smoke against mainnet.

## [0.2.0] - 2026-08-14

### Changed

- **Breaking:** package renamed from `@drydocs/parabola` to `@asctp/parabola`, following the project's move to its own dedicated GitHub organization (`ASCTP`). `@drydocs/parabola` is deprecated; install `@asctp/parabola` going forward.

### Added

- Initial `transfer()` and `estimateFee()` exports for moving USDC between Arc testnet and Stellar testnet via CCTP V2.
- `completeMint()` for finishing a transfer left `"pending"` when no `destinationSigner` was provided.
- Stellar address encoding, `CctpForwarder` routing, and 6/7-decimal precision conversion utilities.
- `TransferError`, carrying `burnTxHash` (and `attestationHash` when available), for any failure that happens after the source-chain burn has already succeeded.
- `SubmissionTimeoutError`, carrying a transaction hash, for a broadcast transaction whose confirmation timed out before its outcome was known. Both are exported from the package root.
- `tests/amount.test.ts`, covering the Arc/Stellar decimal-precision wiring in `src/utils/amount.ts` directly; previously only the lower-level parsing primitives it wraps were tested.
- `checkStellarRecipientReady()`, exported from the package root, to check whether a Stellar address exists on-ledger and holds a USDC trustline before a transfer is attempted. `transfer()` now calls it automatically before any Arc-side approval or burn on an Arc-to-Stellar transfer, throwing a clear pre-burn error instead of letting the burn go through and only failing later at `mint_and_forward` with the USDC stuck at the CctpForwarder.

### Fixed

Found by running the wallet-connected demo app against live testnet in both directions, repeatedly, across many real transfers; none of these were catchable by mocked unit tests either:

- `transfer()` only ever returned `burnTxHash` on success. Any failure after the burn (an attestation-polling timeout, a mint-step error, a burn confirmation that timed out without a definite outcome) threw a bare `Error` and the hash was gone for good, with no way to recover via `completeMint()`. Now rethrown as `TransferError`/`SubmissionTimeoutError` carrying the hash.
- Iris's fees endpoint (`burn/USDC/fees/{source}/{destination}`) returns a bare array, not `{ data: [...] }` as the code assumed. Every fast-transfer fee lookup threw `TypeError: can't access property 'find', body.data is undefined`.
- `approveUsdcOnStellar` confirming (`SUCCESS` status) didn't guarantee a subsequent `deposit_for_burn` call would see that approval: an RPC read-after-write race between the two calls could produce a stale allowance read (`not enough allowance to spend`) or a stale account sequence number (`txBadSeq`), even though the approval had genuinely landed. `approveUsdcOnStellar` now actively polls the real on-chain allowance before returning, and `burnUsdcOnStellar` retries once more on either of those two specific transient errors.
- Stellar's transaction validity window (`.setTimeout(60)`) and confirmation-wait timeout were both tuned for machine-speed signing. Once a human is in the loop approving a wallet popup (Freighter), 60 seconds was routinely too short, failing with `txTooLate` or a confirmation timeout on transactions that had nothing wrong with them. Bumped to 180s and 120s respectively.
- **(security)** `evmAddressToBytes32` and `encodeStellarForwardHook` never validated the recipient address they were given. A truncated, malformed, or otherwise garbage `recipient` string was silently encoded into a syntactically valid but wrong bytes32 value, and `transfer()` would proceed to burn real funds on the source chain toward it, funds effectively unrecoverable. Both now throw before the burn is ever submitted if the recipient isn't a real address for its chain. Found in a dedicated security review, not live testing.

### Changed

- **Breaking:** minimum supported Node.js bumped `>=18` -> `>=20`. The `@stellar/stellar-sdk@16.2.0` upgrade pulled in a `@noble/ed25519` version that requires `globalThis.crypto`, which Node 18 doesn't expose by default (this surfaced as CI failures on the Node 18 matrix job, not a theoretical concern). Node 18 has also been EOL since April 2025.
- Removed `convertAmountBetweenChains`, a thin wrapper around already-exported functions that had no callers anywhere in the SDK, the demo app, or the tests.
