// Shamir degree-one shares over the Mersenne prime 2^127-1.
import { randomBytes } from "node:crypto";
export const PRIME = (1n << 127n) - 1n;
export const mod = (n: bigint) => ((n % PRIME) + PRIME) % PRIME;
export function randomField() {
  let value: bigint;
  do { value = BigInt("0x" + randomBytes(16).toString("hex")) & PRIME; } while (value >= PRIME);
  return value;
}
export function polynomialShares(secret: bigint, slope: bigint): bigint[] { return [1n, 2n, 3n].map(x => mod(secret + slope * x)); }
export function shares(secret: bigint): bigint[] { return polynomialShares(secret, randomField()); }
export function reconstruct(values: readonly bigint[]): bigint {
  if (values.length !== 3) throw new Error("Three approved aggregate shares required");
  // Lagrange coefficients at x=0 for x=1,2,3: 3,-3,1.
  return mod(3n * values[0] - 3n * values[1] + values[2]);
}
export function parseField(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9]{1,39}$/.test(value)) throw new Error("Invalid field element");
  const n = BigInt(value); if (n >= PRIME) throw new Error("Field element out of range"); return n;
}
