import { describe, it, expect } from "vitest";
import {
  pythPriceToSharePrice,
  switchboardPriceToSharePrice,
} from "../../src/oracle.js";

describe("pythPriceToSharePrice", () => {
  it("converts gold price with expo=-2, USDC decimals=6, 1000 shares/unit", () => {
    // Gold at $2650.50 → price=265050, expo=-2
    // unitPrice = 265050 * 10^(-2 - (-6)) = 265050 * 10^4 = 2_650_500_000
    // pricePerShare = 2_650_500_000 / 1000 = 2_650_500
    const result = pythPriceToSharePrice(265050n, -2, 6, 1000n);
    expect(result).toBe(2_650_500n);
  });

  it("converts with expo=-8, USDC decimals=6", () => {
    // price=265050000000, expo=-8 → $2650.50
    // expoDiff = -8 - (-6) = -2 → divide by 100
    // unitPrice = 265050000000 / 100 = 2_650_500_000
    // pricePerShare = 2_650_500_000 / 1000 = 2_650_500
    const result = pythPriceToSharePrice(265050000000n, -8, 6, 1000n);
    expect(result).toBe(2_650_500n);
  });

  it("converts silver price ($30.50) with 100 shares/unit", () => {
    // price=3050, expo=-2, USDC 6 decimals, 100 shares/unit
    // unitPrice = 3050 * 10^4 = 30_500_000
    // pricePerShare = 30_500_000 / 100 = 305_000
    const result = pythPriceToSharePrice(3050n, -2, 6, 100n);
    expect(result).toBe(305_000n);
  });

  it("returns null for zero/negative price", () => {
    expect(pythPriceToSharePrice(0n, -2, 6, 1000n)).toBeNull();
    expect(pythPriceToSharePrice(-100n, -2, 6, 1000n)).toBeNull();
  });

  it("returns null for zero sharesPerUnit", () => {
    expect(pythPriceToSharePrice(265050n, -2, 6, 0n)).toBeNull();
  });
});

describe("switchboardPriceToSharePrice", () => {
  it("converts gold price (10^18 scaled), USDC decimals=6, 1000 shares/unit", () => {
    // Gold at $2650.50 → value = 2_650_500_000_000_000_000_000 (2650.5 * 10^18)
    // unitPrice = value / 10^(18-6) = value / 10^12 = 2_650_500_000
    // pricePerShare = 2_650_500_000 / 1000 = 2_650_500
    const value = 2_650_500_000_000_000_000_000n;
    const result = switchboardPriceToSharePrice(value, 6, 1000n);
    expect(result).toBe(2_650_500n);
  });

  it("converts silver price ($30.50) with 100 shares/unit", () => {
    const value = 30_500_000_000_000_000_000n; // $30.50 * 10^18
    const result = switchboardPriceToSharePrice(value, 6, 100n);
    expect(result).toBe(305_000n);
  });

  it("returns null for zero/negative value", () => {
    expect(switchboardPriceToSharePrice(0n, 6, 1000n)).toBeNull();
    expect(switchboardPriceToSharePrice(-100n, 6, 1000n)).toBeNull();
  });

  it("returns null for zero sharesPerUnit", () => {
    const value = 2_650_500_000_000_000_000_000n;
    expect(switchboardPriceToSharePrice(value, 6, 0n)).toBeNull();
  });
});
