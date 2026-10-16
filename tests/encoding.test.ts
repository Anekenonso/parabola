import { describe, it, expect } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  stellarAddressToBytes32,
  bytes32ToStellarAddress,
  encodeStellarForwardHook,
  evmAddressToBytes32,
  parseUsdcAmount,
  formatUsdcAmount,
  convertPrecision,
} from "../src/utils/encoding.js";

describe("stellarAddressToBytes32 / bytes32ToStellarAddress", () => {
  it("round-trips a Stellar ed25519 public key through bytes32", () => {
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const bytes32 = stellarAddressToBytes32(address);
    expect(bytes32).toMatch(/^0x[0-9a-f]{64}$/);

    const roundTripped = bytes32ToStellarAddress(bytes32);
    expect(roundTripped).toBe(address);
  });

  it("encodes a Stellar contract (CctpForwarder) strkey without throwing", () => {
    const raw = Buffer.alloc(32, 7);
    const contractAddress = StrKey.encodeContract(raw);

    const bytes32 = stellarAddressToBytes32(contractAddress);
    expect(bytes32).toBe(`0x${raw.toString("hex")}`);
  });

  it("throws on an invalid Stellar address", () => {
    expect(() => stellarAddressToBytes32("not-a-stellar-address")).toThrow(
      /Invalid Stellar address/,
    );
  });

  describe("bytes32ToStellarAddress validation & error taxonomy", () => {
    it("round-trips multiple valid sample G-addresses consistently", () => {
      for (let i = 0; i < 10; i++) {
        const kp = Keypair.random();
        const g = kp.publicKey();
        const b32 = stellarAddressToBytes32(g);
        expect(bytes32ToStellarAddress(b32)).toBe(g);
      }
    });

    it("throws a clear error when missing 0x prefix", () => {
      const validWithoutPrefix = "a".repeat(64);
      expect(() => bytes32ToStellarAddress(validWithoutPrefix as any)).toThrow(
        /missing 0x prefix/,
      );
      expect(() => bytes32ToStellarAddress("1234" as any)).toThrow(
        /missing 0x prefix/,
      );
    });

    it("throws a clear error on odd-length hex strings", () => {
      expect(() => bytes32ToStellarAddress("0xabc" as any)).toThrow(
        /odd length \(3 hex chars\)/,
      );
      expect(() => bytes32ToStellarAddress(("0x" + "f".repeat(63)) as any)).toThrow(
        /odd length \(63 hex chars\)/,
      );
    });

    it("throws a clear error on wrong byte lengths", () => {
      // 0 bytes (empty 0x)
      expect(() => bytes32ToStellarAddress("0x" as any)).toThrow(
        /expected 64 hex characters \(32 bytes\), got 0/,
      );
      // 20 bytes (40 hex chars, e.g. unpadded EVM address)
      expect(() => bytes32ToStellarAddress(("0x" + "0".repeat(40)) as any)).toThrow(
        /expected 64 hex characters \(32 bytes\), got 40/,
      );
      // 31 bytes (62 hex chars)
      expect(() => bytes32ToStellarAddress(("0x" + "0".repeat(62)) as any)).toThrow(
        /expected 64 hex characters \(32 bytes\), got 62/,
      );
      // 33 bytes (66 hex chars)
      expect(() => bytes32ToStellarAddress(("0x" + "0".repeat(66)) as any)).toThrow(
        /expected 64 hex characters \(32 bytes\), got 66/,
      );
    });

    it("throws a clear error on non-hexadecimal characters", () => {
      const nonHex = "0x" + "0".repeat(62) + "zz";
      expect(() => bytes32ToStellarAddress(nonHex as any)).toThrow(
        /contains non-hexadecimal characters/,
      );
      expect(() => bytes32ToStellarAddress(("0x" + "g".repeat(64)) as any)).toThrow(
        /contains non-hexadecimal characters/,
      );
      expect(() => bytes32ToStellarAddress(("0x" + " ".repeat(64)) as any)).toThrow(
        /contains non-hexadecimal characters/,
      );
    });

    it("documents Contract (C...) strkey behavior explicitly", () => {
      // Contract addresses (C...) encode into raw 32 bytes via stellarAddressToBytes32.
      // bytes32ToStellarAddress decodes raw 32 bytes strictly into ed25519 public keys (G...).
      // To recover the C... strkey, callers should use StrKey.encodeContract.
      const rawContractBytes = Buffer.alloc(32, 42);
      const contractStrkey = StrKey.encodeContract(rawContractBytes);
      const bytes32 = stellarAddressToBytes32(contractStrkey);

      const asGAddress = bytes32ToStellarAddress(bytes32);
      expect(StrKey.isValidEd25519PublicKey(asGAddress)).toBe(true);
      expect(StrKey.encodeContract(Buffer.from(bytes32.slice(2), "hex"))).toBe(contractStrkey);
    });
  });
});

describe("encodeStellarForwardHook", () => {
  it("encodes a G... recipient into the CctpForwarder hook payload format", () => {
    const keypair = Keypair.random();
    const recipient = keypair.publicKey();

    const hook = encodeStellarForwardHook(recipient);
    const bytes = Buffer.from(hook.slice(2), "hex");

    // 32-byte header (version at 24-27, strkey length at 28-31) + strkey utf8 bytes
    expect(bytes.length).toBe(32 + recipient.length);
    expect(bytes.readUInt32BE(24)).toBe(0); // version
    expect(bytes.readUInt32BE(28)).toBe(recipient.length);
    expect(bytes.subarray(32).toString("utf8")).toBe(recipient);
  });

  // A malformed recipient here has nowhere else to fail loudly: mint_and_forward
  // would eventually reject it on-chain, but only after the source-chain burn has
  // already spent real funds. This must throw before that burn is ever submitted.
  it("throws on a malformed recipient instead of silently encoding garbage", () => {
    expect(() => encodeStellarForwardHook("not-a-stellar-address")).toThrow(
      /Invalid Stellar address/,
    );
    expect(() => encodeStellarForwardHook("GTRUNCATED")).toThrow(/Invalid Stellar address/);
  });
});

describe("evmAddressToBytes32", () => {
  it("pads a valid 20-byte EVM address to 32 bytes", () => {
    const address = `0x${"1".repeat(39)}C`; // 40 hex chars, verified by construction
    expect(evmAddressToBytes32(address)).toBe(`0x000000000000000000000000${address.slice(2)}`);
  });

  // Before this validation existed, viem's pad() would silently accept a truncated
  // or non-hex string and produce a syntactically valid but wrong bytes32 -- the
  // burn would then succeed toward an address nobody controls, funds unrecoverable.
  it("throws on a truncated address instead of silently padding it into a wrong one", () => {
    expect(() => evmAddressToBytes32("0x1234")).toThrow(/Invalid EVM address/);
  });

  it("throws on a non-hex string instead of silently encoding it", () => {
    expect(() => evmAddressToBytes32("not-a-hex-address")).toThrow(/Invalid EVM address/);
  });

  it("throws on an address missing the 0x prefix", () => {
    expect(() => evmAddressToBytes32("70997970C51812dc3A010C7d01b50e0d17dc79C")).toThrow(
      /Invalid EVM address/,
    );
  });
});

describe("parseUsdcAmount / formatUsdcAmount", () => {
  it("parses whole amounts", () => {
    expect(parseUsdcAmount("10", 6)).toBe(10_000_000n);
  });

  it("parses fractional amounts at Arc's 6 decimals", () => {
    expect(parseUsdcAmount("10.50", 6)).toBe(10_500_000n);
  });

  it("parses fractional amounts at Stellar's 7 decimals", () => {
    expect(parseUsdcAmount("10.5000001", 7)).toBe(105_000_001n);
  });

  it("rejects excess precision", () => {
    expect(() => parseUsdcAmount("10.1234567", 6)).toThrow(/more precision/);
  });

  it("rejects malformed amounts", () => {
    expect(() => parseUsdcAmount("abc", 6)).toThrow(/Invalid USDC amount/);
    expect(() => parseUsdcAmount("-1", 6)).toThrow(/Invalid USDC amount/);
  });

  it("formats raw subunits back into human-readable amounts", () => {
    expect(formatUsdcAmount(10_500_000n, 6)).toBe("10.5");
    expect(formatUsdcAmount(10_000_000n, 6)).toBe("10");
    expect(formatUsdcAmount(105_000_001n, 7)).toBe("10.5000001");
  });

  it("round-trips parse -> format", () => {
    const amounts = ["0.000001", "1234.56", "1", "999999.999999"];
    for (const amount of amounts) {
      expect(formatUsdcAmount(parseUsdcAmount(amount, 6), 6)).toBe(amount);
    }
  });
});

describe("convertPrecision", () => {
  it("converts Stellar's 7-decimal USDC down to Arc's 6-decimal USDC, truncating excess precision", () => {
    // 10.5000001 on Stellar (7 decimals) -> 10.500000 on Arc (6 decimals), truncated
    expect(convertPrecision(105_000_001n, 7, 6)).toBe(10_500_000n);
  });

  it("converts Arc's 6-decimal USDC up to Stellar's 7-decimal USDC", () => {
    expect(convertPrecision(10_500_000n, 6, 7)).toBe(105_000_000n);
  });

  it("is a no-op when decimals match", () => {
    expect(convertPrecision(123n, 6, 6)).toBe(123n);
  });
});
