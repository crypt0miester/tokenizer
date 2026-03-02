/**
 * Shared codec instances for decoding #[repr(C)] account data.
 */
import {
  fixDecoderSize,
  getAddressDecoder,
  getArrayDecoder,
  getBooleanDecoder,
  getBytesDecoder,
  getI64Decoder,
  getU8Decoder,
  getU16Decoder,
  getU32Decoder,
  getU64Decoder,
} from "gill";

export const u8d = getU8Decoder();
export const u16d = getU16Decoder();
export const u32d = getU32Decoder();
export const u64d = getU64Decoder();
export const i64d = getI64Decoder();
export const addr = getAddressDecoder();
export const bool = getBooleanDecoder();

/** Skip `n` bytes of #[repr(C)] alignment padding. */
export const pad = (n: number) => fixDecoderSize(getBytesDecoder(), n);

/** Fixed-size array of N addresses (N × 32 bytes). */
export const addrArray = (n: number) => getArrayDecoder(addr, { size: n });

/** Fixed-size raw byte buffer. */
export const rawBytes = (n: number) => fixDecoderSize(getBytesDecoder(), n);

/** 32-byte raw buffer (e.g. terms_hash). */
export const bytes32 = fixDecoderSize(getBytesDecoder(), 32);
