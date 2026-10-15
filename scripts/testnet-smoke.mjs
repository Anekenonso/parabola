#!/usr/bin/env node
// End-to-end smoke test against live Arc and Stellar testnets. Unlike the
// mocked unit tests in tests/, this exercises the real depositForBurn /
// receiveMessage / mint_and_forward calls and waits on real Iris attestations.
//
// Requires funded testnet keys (see .env.example, fund via
// https://faucet.circle.com) and a built package (`pnpm build` first), since
// this imports from dist/, not src/, so it also catches bundling regressions
// that unit tests against src/ can't see.
//
// Not run in the default CI workflow: it needs funded secrets and takes
// 20s-5min per transfer depending on speed. Run manually, or wire into a
// workflow_dispatch job once ARC_PRIVATE_KEY / STELLAR_SECRET_KEY exist as
// repo secrets.

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import {
  transfer,
  completeMint,
  resolveBurn,
  checkStellarRecipientReady,
  arcMainnetChain,
  arcTestnetChain,
  TransferError,
  AttestationNotReadyError,
  IrisRequestError,
  SubmissionTimeoutError,
} from "../dist/index.js";

const ARC_PRIVATE_KEY = process.env.ARC_PRIVATE_KEY;
const STELLAR_SECRET_KEY = process.env.STELLAR_SECRET_KEY;

// Defaults to testnet. Set NETWORK=mainnet to smoke against mainnet, which
// moves real USDC and spends real Arc gas on every case below.
const NETWORK = process.env.NETWORK === "mainnet" ? "mainnet" : "testnet";
const STELLAR_RPC_URL = process.env.STELLAR_RPC_URL;

// Amount burned per case, in USDC. Override with SMOKE_AMOUNT to test with less
// on mainnet (for example SMOKE_AMOUNT=0.10).
const SMOKE_AMOUNT = process.env.SMOKE_AMOUNT ?? "1.00";

// Which leg(s) to run, named by source chain. Set FROM=arc to run only arc -> stellar
// or FROM=stellar to run only stellar -> arc (useful for a first mainnet run that
// validates the full burn, attest, and mint path with one transfer before committing
// the second). Anything else runs both.
const FROM = process.env.FROM ?? "both";

const STEP_MAX_ATTEMPTS = Number(process.env.SMOKE_MAX_ATTEMPTS ?? "3");
const STEP_BASE_DELAY_MS = Number(process.env.SMOKE_BASE_DELAY_MS ?? "2500");

if (!ARC_PRIVATE_KEY || !STELLAR_SECRET_KEY) {
  console.error(
    "Missing ARC_PRIVATE_KEY and/or STELLAR_SECRET_KEY.\n" +
      "Fund testnet accounts at https://faucet.circle.com, copy .env.example to .env, " +
      "fill in both keys, then export them in your shell (or, on Node 20.6+, run with " +
      "`node --env-file=.env scripts/testnet-smoke.mjs`) before re-running `pnpm smoke`.",
  );
  process.exit(1);
}

const arcChain = NETWORK === "mainnet" ? arcMainnetChain : arcTestnetChain;
const arcAccount = privateKeyToAccount(ARC_PRIVATE_KEY);
const arcSigner = {
  walletClient: createWalletClient({ account: arcAccount, chain: arcChain, transport: http() }),
};

const stellarKeypair = Keypair.fromSecret(STELLAR_SECRET_KEY);
const stellarSigner = { publicKey: stellarKeypair.publicKey(), keypair: stellarKeypair };

/** @type {Array<{ caseName: string; step: string; status: "PASS" | "FAIL" | "SKIP"; durationMs: number; attempts: number; detail?: string }>} */
const stepSummary = [];
let failures = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Distinguishes transient infrastructure / finality-window errors from deterministic
 * validation or balance failures that should fail immediately without retry.
 */
function isTransientError(error) {
  if (
    error instanceof AttestationNotReadyError ||
    error instanceof IrisRequestError ||
    error instanceof SubmissionTimeoutError
  ) {
    return true;
  }
  if (error instanceof TransferError && error.code === "ATTESTATION_NOT_READY") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const deterministicPatterns = [
    /Invalid Stellar address/i,
    /Invalid EVM address/i,
    /Invalid USDC amount/i,
    /more precision/i,
    /does not exist yet/i,
    /no USDC trustline/i,
    /insufficient funds/i,
    /exceeds balance/i,
    /underfunded/i,
  ];
  if (deterministicPatterns.some((re) => re.test(message))) {
    return false;
  }
  const transientPatterns = [
    /5\d\d/,
    /429/,
    /rate limit/i,
    /timeout/i,
    /timed out/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
    /fetch failed/i,
    /network/i,
    /txBadSeq/i,
    /not enough allowance/i,
  ];
  return transientPatterns.some((re) => re.test(message));
}

/**
 * Runs a single named step with exponential backoff for transient infrastructure errors.
 * Note: the approve+burn step sets `allowRetryIfTransferError: false` so a post-burn
 * TransferError is never retried via a second `transfer()` call (which would double-burn);
 * instead, the burnTxHash is handed directly to the attestation/mint steps.
 */
async function runStep(caseName, stepName, fn, { maxAttempts = STEP_MAX_ATTEMPTS } = {}) {
  const start = Date.now();
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const value = await fn();
      const durationMs = Date.now() - start;
      stepSummary.push({ caseName, step: stepName, status: "PASS", durationMs, attempts });
      console.log(`  [PASS] ${stepName} (${durationMs}ms, attempt ${attempts}/${maxAttempts})`);
      return value;
    } catch (error) {
      // If transfer() threw a TransferError during approve+burn, the burn itself succeeded!
      // Do NOT retry transfer() (which would burn again); return the TransferError so the
      // caller can proceed to the attestation wait and mint recovery steps.
      if (stepName === "approve+burn" && error instanceof TransferError && error.burnTxHash) {
        const durationMs = Date.now() - start;
        stepSummary.push({
          caseName,
          step: stepName,
          status: "PASS",
          durationMs,
          attempts,
          detail: `burnTxHash=${error.burnTxHash}`,
        });
        console.log(
          `  [PASS] ${stepName} (${durationMs}ms, burn confirmed: ${error.burnTxHash})`,
        );
        return {
          status: "pending",
          burnTxHash: error.burnTxHash,
          attestationHash: error.attestationHash ?? "",
          mintTxHash: "",
        };
      }

      const canRetry = attempts < maxAttempts && isTransientError(error);
      const msg = error instanceof Error ? error.message : String(error);
      if (!canRetry) {
        const durationMs = Date.now() - start;
        stepSummary.push({
          caseName,
          step: stepName,
          status: "FAIL",
          durationMs,
          attempts,
          detail: msg,
        });
        console.error(`  [FAIL] ${stepName} (${durationMs}ms, attempt ${attempts}): ${msg}`);
        throw error;
      }

      const delayMs = STEP_BASE_DELAY_MS * 2 ** (attempts - 1);
      console.warn(
        `  [WARN] ${stepName} transient error on attempt ${attempts}/${maxAttempts}: ${msg} — retrying in ${delayMs}ms...`,
      );
      await sleep(delayMs);
    }
  }
}

function printRecoveryInstructions(params, destinationChainName, burnTxHash, attestationHash) {
  console.error(`  burnTxHash: ${burnTxHash}`);
  if (attestationHash) {
    console.error(`  attestationHash: ${attestationHash}`);
  }
  console.error(
    "  Recover with completeMint(" +
      JSON.stringify(
        {
          from: params.from,
          to: params.to,
          network: params.network,
          burnTxHash,
          signer: `<${destinationChainName} signer>`,
        },
        null,
        2,
      ) +
      ")",
  );
}

async function runCase(name, params, destinationSigner) {
  console.log(`\n--- ${name} ---`);
  const caseStart = Date.now();
  /** @type {string | undefined} */
  let burnTxHash;
  /** @type {string | undefined} */
  let attestationHash;

  try {
    // Step 1: fund/check
    await runStep(name, "fund/check", async () => {
      if (params.to === "stellar") {
        const status = await checkStellarRecipientReady(
          params.recipient,
          params.network,
          STELLAR_RPC_URL,
        );
        if (!status.exists) {
          throw new Error(
            `Stellar recipient ${params.recipient} does not exist yet. Fund it with XLM first.`,
          );
        }
        if (!status.hasTrustline) {
          throw new Error(
            `Stellar recipient ${params.recipient} has no USDC trustline.`,
          );
        }
      }
    });

    // Step 2: approve+burn (run transfer without destinationSigner so burn, attestation, and
    // mint are observed and retried as distinct steps without ever double-burning).
    const burnOutcome = await runStep(name, "approve+burn", async () => {
      return await transfer({
        ...params,
        options: {
          ...params.options,
          destinationSigner: undefined,
        },
      });
    });

    burnTxHash = burnOutcome.burnTxHash;
    attestationHash = burnOutcome.attestationHash || undefined;

    // Step 3: attestation wait (verifies Iris has indexed and signed the burn)
    await runStep(name, "attestation wait", async () => {
      const resolved = await resolveBurn({
        from: params.from,
        burnTxHash,
        network: params.network,
      });
      if (!resolved.attestation) {
        throw new AttestationNotReadyError(
          `Iris has indexed burn ${burnTxHash} but attestation signature is still pending`,
          burnTxHash,
        );
      }
      attestationHash = resolved.attestation;
      return resolved;
    });

    // Step 4: mint (completes the transfer on the destination chain via completeMint)
    const mintResult = await runStep(name, "mint", async () => {
      const completed = await completeMint({
        from: params.from,
        to: params.to,
        burnTxHash,
        signer: destinationSigner,
        network: params.network,
        options: {
          stellarRpcUrl: STELLAR_RPC_URL,
        },
      });
      if (!completed.mintTxHash) {
        throw new Error("expected a non-empty mintTxHash from completeMint");
      }
      return completed;
    });

    attestationHash = mintResult.attestationHash;
    console.log(
      JSON.stringify(
        {
          status: "success",
          from: params.from,
          to: params.to,
          burnTxHash,
          attestationHash,
          mintTxHash: mintResult.mintTxHash,
          durationMs: Date.now() - caseStart,
        },
        null,
        2,
      ),
    );
    console.log(`PASS ${name} (${Date.now() - caseStart}ms)`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}:`, error instanceof Error ? error.message : error);

    if (error instanceof TransferError && error.burnTxHash) {
      burnTxHash = error.burnTxHash;
      attestationHash = error.attestationHash ?? attestationHash;
    }

    if (burnTxHash) {
      printRecoveryInstructions(params, params.to, burnTxHash, attestationHash);
    }
  }
}

function printStepSummary() {
  console.log("\n=== Smoke Step Summary ===");
  for (const row of stepSummary) {
    const detail = row.detail ? ` — ${row.detail}` : "";
    console.log(
      `[${row.status}] ${row.caseName} :: ${row.step} (${row.durationMs}ms, attempts=${row.attempts})${detail}`,
    );
  }
}

console.log(`Running smoke cases against ${NETWORK}.`);
if (NETWORK === "mainnet") {
  console.log("WARNING: mainnet moves real USDC and spends real Arc gas.");
}

if (FROM === "arc" || FROM === "both") {
  await runCase(
    "arc -> stellar (standard)",
    {
      from: "arc",
      to: "stellar",
      amount: SMOKE_AMOUNT,
      recipient: stellarKeypair.publicKey(),
      speed: "standard",
      signer: arcSigner,
      network: NETWORK,
      options: { stellarRpcUrl: STELLAR_RPC_URL },
    },
    stellarSigner,
  );
}

if (FROM === "stellar" || FROM === "both") {
  await runCase(
    "stellar -> arc (standard)",
    {
      from: "stellar",
      to: "arc",
      amount: SMOKE_AMOUNT,
      recipient: arcAccount.address,
      speed: "standard",
      signer: stellarSigner,
      network: NETWORK,
      options: { stellarRpcUrl: STELLAR_RPC_URL },
    },
    arcSigner,
  );
}

printStepSummary();

if (failures > 0) {
  console.error(`\n${failures} smoke test case(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke test cases passed.");
