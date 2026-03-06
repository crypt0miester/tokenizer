/**
 * Off-chain oracle price → price_per_share conversion.
 *
 * Mirrors the on-chain math in refresh_oracle_price (ix 23) so integrators
 * can preview the result before deciding to crank.
 */

/**
 * Convert a Pyth oracle price to price_per_share.
 *
 * @param price     - Pyth price value (i64, e.g. 265050)
 * @param expo      - Pyth exponent (i32, e.g. -2 means price is 265050 * 10^-2 = $2650.50)
 * @param mintDecimals - Decimals of the accepted mint (e.g. 6 for USDC)
 * @param sharesPerUnit - How many shares represent 1 unit of underlying (e.g. 1000)
 * @returns price_per_share in smallest mint units, or null on overflow/invalid
 */
export function pythPriceToSharePrice(
  price: bigint,
  expo: number,
  mintDecimals: number,
  sharesPerUnit: bigint,
): bigint | null {
  if (price <= 0n || sharesPerUnit <= 0n) return null;

  // target_expo = -mintDecimals (e.g. -6 for USDC)
  // expo_diff = expo - target_expo
  const expoDiff = expo - (-mintDecimals);

  let unitPrice: bigint;
  if (expoDiff >= 0) {
    const multiplier = 10n ** BigInt(expoDiff);
    unitPrice = price * multiplier;
  } else {
    const divisor = 10n ** BigInt(-expoDiff);
    unitPrice = price / divisor;
  }

  if (unitPrice <= 0n) return null;

  const result = unitPrice / sharesPerUnit;
  return result > 0n ? result : null;
}

/**
 * Convert a Switchboard oracle value to price_per_share.
 *
 * @param value     - Switchboard result value (i128 scaled by 10^18)
 * @param mintDecimals - Decimals of the accepted mint (e.g. 6 for USDC)
 * @param sharesPerUnit - How many shares represent 1 unit of underlying (e.g. 1000)
 * @returns price_per_share in smallest mint units, or null on overflow/invalid
 */
export function switchboardPriceToSharePrice(
  value: bigint,
  mintDecimals: number,
  sharesPerUnit: bigint,
): bigint | null {
  if (value <= 0n || sharesPerUnit <= 0n) return null;

  const PRECISION = 18;

  let unitPrice: bigint;
  if (mintDecimals >= PRECISION) {
    const multiplier = 10n ** BigInt(mintDecimals - PRECISION);
    unitPrice = value * multiplier;
  } else {
    const divisor = 10n ** BigInt(PRECISION - mintDecimals);
    unitPrice = value / divisor;
  }

  if (unitPrice <= 0n) return null;

  const result = unitPrice / sharesPerUnit;
  return result > 0n ? result : null;
}
