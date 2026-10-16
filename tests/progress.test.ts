import { describe, it, expect, vi, beforeEach } from "vitest";

const approveUsdcOnArc = vi.fn();
const burnUsdcOnArcWithStellarForward = vi.fn();
const receiveMessageOnArc = vi.fn();
const approveUsdcOnStellar = vi.fn();
const burnUsdcOnStellar = vi.fn();
const mintAndForwardOnStellar = vi.fn();
const checkStellarRecipientReady = vi.fn();
const fetchFastTransferFeeBps = vi.fn();
const pollForAttestation = vi.fn();

vi.mock("../src/chains/arc.js", () => ({
  approveUsdcOnArc: (...args: unknown[]) => approveUsdcOnArc(...args),
  burnUsdcOnArcWithStellarForward: (...args: unknown[]) => burnUsdcOnArcWithStellarForward(...args),
  receiveMessageOnArc: (...args: unknown[]) => receiveMessageOnArc(...args),
}));

vi.mock("../src/chains/stellar.js", () => ({
  approveUsdcOnStellar: (...args: unknown[]) => approveUsdcOnStellar(...args),
  burnUsdcOnStellar: (...args: unknown[]) => burnUsdcOnStellar(...args),
  mintAndForwardOnStellar: (...args: unknown[]) => mintAndForwardOnStellar(...args),
  checkStellarRecipientReady: (...args: unknown[]) => checkStellarRecipientReady(...args),
}));

vi.mock("../src/iris/poll.js", () => ({
  fetchFastTransferFeeBps: (...args: unknown[]) => fetchFastTransferFeeBps(...args),
  pollForAttestation: (...args: unknown[]) => pollForAttestation(...args),
}));

const { transfer } = await import("../src/transfer.js");
import type { TransferProgressEvent } from "../src/index.js";

const STELLAR_RECIPIENT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const FAKE_ARC_SIGNER = {
  account: { address: "0x1111111111111111111111111111111111111111" as `0x${string}` },
  chain: { id: 50 },
} as any;

describe("transfer() progress callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkStellarRecipientReady.mockResolvedValue({ exists: true, hasTrustline: true });
    approveUsdcOnArc.mockResolvedValue("0xapprove");
    burnUsdcOnArcWithStellarForward.mockResolvedValue("0xburnhash");
    pollForAttestation.mockResolvedValue({
      status: "complete",
      attestation: "0xattest",
      message: "0xmsg",
    });
    mintAndForwardOnStellar.mockResolvedValue("0xminthash");
  });

  it("emits the expected sequence of stage events in order with payloads", async () => {
    const events: TransferProgressEvent[] = [];
    const onProgress = vi.fn((ev: TransferProgressEvent) => {
      events.push(ev);
    });

    const result = await transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      speed: "standard",
      recipient: STELLAR_RECIPIENT,
      signer: FAKE_ARC_SIGNER,
      options: {
        destinationSigner: { publicKey: STELLAR_RECIPIENT, signTransaction: vi.fn() },
        onProgress,
      },
    });

    expect(result.status).toBe("success");
    expect(result.burnTxHash).toBe("0xburnhash");
    expect(result.mintTxHash).toBe("0xminthash");

    expect(onProgress).toHaveBeenCalled();
    const stages = events.map((e) => e.stage);
    expect(stages).toEqual([
      "recipient-check",
      "approve",
      "burn-submitted",
      "burn-confirmed",
      "attestation",
      "mint-submitted",
      "mint-confirmed",
    ]);

    // Check payload data
    const burnConfirmed = events.find((e) => e.stage === "burn-confirmed");
    expect(burnConfirmed).toBeDefined();
    if (burnConfirmed && "burnTxHash" in burnConfirmed) {
      expect(burnConfirmed.burnTxHash).toBe("0xburnhash");
    }

    const mintConfirmed = events.find((e) => e.stage === "mint-confirmed");
    expect(mintConfirmed).toBeDefined();
    if (mintConfirmed && "mintTxHash" in mintConfirmed) {
      expect(mintConfirmed.burnTxHash).toBe("0xburnhash");
      expect(mintConfirmed.mintTxHash).toBe("0xminthash");
    }
  });

  it("swallows exceptions thrown by onProgress without breaking the transfer", async () => {
    const explodingCallback = vi.fn(() => {
      throw new Error("Consumer listener exploded!");
    });

    const result = await transfer({
      from: "arc",
      to: "stellar",
      amount: "10",
      speed: "standard",
      recipient: STELLAR_RECIPIENT,
      signer: FAKE_ARC_SIGNER,
      options: {
        onProgress: explodingCallback,
      },
    });

    expect(result.status).toBe("pending");
    expect(result.burnTxHash).toBe("0xburnhash");
    expect(explodingCallback).toHaveBeenCalled();
  });
});
