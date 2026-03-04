use core::mem::MaybeUninit;

use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView, ProgramResult,
};
use pinocchio_log::logger::{Argument, Log};
use pinocchio_token::instructions::{CloseAccount, SyncNative, Transfer};

use crate::error::TokenizerError;

// Base58 pubkey logging

/// Format a public key as base58 for diagnostic logging.
pub(crate) struct Pk<'a>(pub &'a [u8; 32]);

// Safety: five8::encode_32 writes valid ASCII bytes; returned length is exact.
unsafe impl Log for Pk<'_> {
    fn write_with_args(&self, buffer: &mut [MaybeUninit<u8>], _args: &[Argument]) -> usize {
        let mut tmp = [0u8; 44];
        let mut len = 0u8;
        five8::encode_32(self.0, Some(&mut len), &mut tmp);
        let len = len as usize;
        let to_write = if len < buffer.len() { len } else { buffer.len() };
        for i in 0..to_write {
            buffer[i] = MaybeUninit::new(tmp[i]);
        }
        to_write
    }
}

// Safe byte-reading helpers

/// Byte offset of the `amount` field in an SPL Token account.
pub const SPL_TOKEN_AMOUNT_OFFSET: usize = 64;

/// Cold error path shared by all read helpers — keeps inlined hot paths small.
#[cold]
#[inline(never)]
fn data_too_short(label: &str, offset: usize, need: usize, have: usize) -> ProgramError {
    pinocchio_log::log!("{}: data too short at offset {} (need {}, have {})", label, offset, need, have);
    TokenizerError::InstructionDataTooShort.into()
}

#[inline(always)]
pub fn read_u8(data: &[u8], offset: usize, label: &str) -> Result<u8, ProgramError> {
    data.get(offset).copied().ok_or_else(|| data_too_short(label, offset, 1, data.len()))
}

#[inline(always)]
pub fn read_u16(data: &[u8], offset: usize, label: &str) -> Result<u16, ProgramError> {
    match data.get(offset..offset + 2) {
        Some(s) => Ok(u16::from_le_bytes(s.try_into().unwrap())),
        None => Err(data_too_short(label, offset, 2, data.len())),
    }
}

#[inline(always)]
pub fn read_u32(data: &[u8], offset: usize, label: &str) -> Result<u32, ProgramError> {
    match data.get(offset..offset + 4) {
        Some(s) => Ok(u32::from_le_bytes(s.try_into().unwrap())),
        None => Err(data_too_short(label, offset, 4, data.len())),
    }
}

#[inline(always)]
pub fn read_u64(data: &[u8], offset: usize, label: &str) -> Result<u64, ProgramError> {
    match data.get(offset..offset + 8) {
        Some(s) => Ok(u64::from_le_bytes(s.try_into().unwrap())),
        None => Err(data_too_short(label, offset, 8, data.len())),
    }
}

#[inline(always)]
pub fn read_i64(data: &[u8], offset: usize, label: &str) -> Result<i64, ProgramError> {
    match data.get(offset..offset + 8) {
        Some(s) => Ok(i64::from_le_bytes(s.try_into().unwrap())),
        None => Err(data_too_short(label, offset, 8, data.len())),
    }
}

#[inline(always)]
pub fn read_bytes32(data: &[u8], offset: usize, label: &str) -> Result<[u8; 32], ProgramError> {
    match data.get(offset..offset + 32) {
        Some(s) => Ok(s.try_into().unwrap()),
        None => Err(data_too_short(label, offset, 32, data.len())),
    }
}

/// Read a 1-byte-length-prefixed string from `data` at `offset`.
/// Returns the string bytes and the new offset (past the string).
#[inline(always)]
pub fn read_len_prefixed<'a>(
    data: &'a [u8],
    offset: usize,
    label: &str,
) -> Result<(&'a [u8], usize), ProgramError> {
    let len = read_u8(data, offset, label)? as usize;
    let start = offset + 1;
    let end = start + len;
    if data.len() < end {
        return Err(data_too_short(label, start, len, data.len()));
    }
    Ok((&data[start..end], end))
}

/// Read SPL Token balance (amount at byte 64).
#[inline(always)]
pub fn read_token_balance(data: &[u8]) -> Result<u64, ProgramError> {
    match data.get(SPL_TOKEN_AMOUNT_OFFSET..SPL_TOKEN_AMOUNT_OFFSET + 8) {
        Some(s) => Ok(u64::from_le_bytes(s.try_into().unwrap())),
        None => {
            pinocchio_log::log!("token_balance: data too short (need 72, have {})", data.len());
            Err(TokenizerError::TokenAccountDataTooShort.into())
        }
    }
}

/// Native SOL wrapped-mint address.
pub const NATIVE_MINT: [u8; 32] =
    five8_const::decode_32_const("So11111111111111111111111111111111111111112");

/// Returns `true` when `mint` is native SOL (wrapped SOL).
#[inline(always)]
pub fn is_native_mint(mint: &[u8; 32]) -> bool {
    mint == &NATIVE_MINT
}

// SPL Token transfer helpers

/// Transfer SPL tokens (user-signed authority).
/// For native mint destinations, syncs the native balance afterward.
#[inline(always)]
pub fn spl_transfer<'a>(
    from: &'a AccountView,
    to: &'a AccountView,
    authority: &'a AccountView,
    amount: u64,
    mint: &[u8; 32],
) -> ProgramResult {
    Transfer { from, to, authority, amount }.invoke()?;
    if is_native_mint(mint) {
        SyncNative { native_token: to }.invoke()?;
    }
    Ok(())
}

/// Transfer SPL tokens (PDA-signed authority).
/// For native mint destinations, syncs the native balance afterward.
#[inline(always)]
pub fn spl_transfer_signed<'a>(
    from: &'a AccountView,
    to: &'a AccountView,
    authority: &'a AccountView,
    amount: u64,
    mint: &[u8; 32],
    seeds: &[Seed],
) -> ProgramResult {
    let signer = Signer::from(seeds);
    Transfer { from, to, authority, amount }.invoke_signed(&[signer])?;
    if is_native_mint(mint) {
        SyncNative { native_token: to }.invoke()?;
    }
    Ok(())
}

// Token account lifecycle

/// Close a PDA-owned token account, sending remaining lamports to `beneficiary`.
/// For native mint this unwraps any remaining SOL.
/// For all mints this recovers rent-exempt lamports.
#[inline(always)]
pub fn close_token_account_signed<'a>(
    account: &'a AccountView,
    beneficiary: &'a AccountView,
    authority: &'a AccountView,
    seeds: &[Seed],
) -> ProgramResult {
    let signer = Signer::from(seeds);
    CloseAccount {
        account,
        destination: beneficiary,
        authority,
    }
    .invoke_signed(&[signer])
}

// Metaplex Core NFT helpers

/// Mint a Metaplex Core NFT with the standard plugin set
/// (FreezeDelegate frozen, TransferDelegate, BurnDelegate, Attributes).
/// All plugins are included in the CreateV1 instruction data so that the
/// creating authority can set owner-managed plugins atomically.
pub fn mint_nft_with_plugins<'a>(
    nft: &'a AccountView,
    collection: &'a AccountView,
    collection_authority: &'a AccountView,
    payer: &'a AccountView,
    owner: &'a AccountView,
    system_program: &'a AccountView,
    mpl_core_program: &'a AccountView,
    name: &[u8],
    uri: &[u8],
    shares_str: &[u8],
    asset_id_str: &[u8],
    ca_bump_bytes: &[u8; 1],
) -> ProgramResult {
    use p_core::instructions::{CreateV1, DataState};

    use crate::state::COLLECTION_AUTHORITY_SEED;

    // Build pre-serialized plugins: Vec<PluginAuthorityPair>
    // Layout: 4-byte LE count + [plugin_borsh + Option<Authority>] × N
    let mut pbuf = [0u8; 256];
    let mut p = 0;

    // Vec length = 4 plugins
    pbuf[p..p+4].copy_from_slice(&4u32.to_le_bytes());
    p += 4;

    // Plugin 1: PermanentFreezeDelegate { frozen: true }, authority: Some(UpdateAuthority)
    pbuf[p] = 5; p += 1; // variant 5 = PermanentFreezeDelegate
    pbuf[p] = 1; p += 1; // frozen = true
    pbuf[p] = 1; p += 1; // Some(authority)
    pbuf[p] = 2; p += 1; // UpdateAuthority

    // Plugin 2: BurnDelegate, authority: Some(UpdateAuthority)
    pbuf[p] = 2; p += 1; // variant 2 = BurnDelegate
    pbuf[p] = 1; p += 1; // Some(authority)
    pbuf[p] = 2; p += 1; // UpdateAuthority

    // Plugin 3: TransferDelegate, authority: Some(UpdateAuthority)
    pbuf[p] = 3; p += 1; // variant 3 = TransferDelegate
    pbuf[p] = 1; p += 1; // Some(authority)
    pbuf[p] = 2; p += 1; // UpdateAuthority

    // Plugin 4: Attributes { attribute_list }, authority: Some(UpdateAuthority)
    pbuf[p] = 6; p += 1; // variant 6 = Attributes

    // attribute_list: Vec<Attribute> — 3 attributes
    pbuf[p..p+4].copy_from_slice(&3u32.to_le_bytes());
    p += 4;

    // Attribute { key: "shares", value: shares_str }
    p = write_borsh_str(&mut pbuf, p, b"shares");
    p = write_borsh_str(&mut pbuf, p, shares_str);

    // Attribute { key: "asset_id", value: asset_id_str }
    p = write_borsh_str(&mut pbuf, p, b"asset_id");
    p = write_borsh_str(&mut pbuf, p, asset_id_str);

    // Attribute { key: "status", value: "active" }
    p = write_borsh_str(&mut pbuf, p, b"status");
    p = write_borsh_str(&mut pbuf, p, b"active");

    pbuf[p] = 1; p += 1; // Some(authority)
    pbuf[p] = 2; p += 1; // UpdateAuthority

    // Single CreateV1 CPI with all plugins inline
    let ca_seeds = [
        Seed::from(COLLECTION_AUTHORITY_SEED),
        Seed::from(collection.address().as_ref()),
        Seed::from(ca_bump_bytes.as_ref()),
    ];
    let ca_signer = Signer::from(&ca_seeds);

    CreateV1 {
        asset: nft,
        collection,
        authority: collection_authority,
        payer,
        owner,
        update_authority: mpl_core_program,
        system_program,
        log_wrapper: mpl_core_program,
        data_state: DataState::AccountState,
        name,
        uri,
        plugins: &pbuf[..p],
    }
    .invoke_signed(&[ca_signer])
}

/// Write a Borsh string (4-byte LE length prefix + bytes) into a buffer.
#[inline(always)]
fn write_borsh_str(buf: &mut [u8], offset: usize, s: &[u8]) -> usize {
    let len = s.len();
    buf[offset..offset+4].copy_from_slice(&(len as u32).to_le_bytes());
    buf[offset+4..offset+4+len].copy_from_slice(s);
    offset + 4 + len
}

// Number formatting

/// Convert a u64 to its ASCII decimal representation.
/// Returns a fixed buffer; use `u64_str_len` to get the actual length.
pub fn u64_to_bytes(mut n: u64) -> [u8; 20] {
    let mut buf = [0u8; 20];
    if n == 0 {
        buf[0] = b'0';
        return buf;
    }
    let mut i = 20;
    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    let len = 20 - i;
    let mut result = [0u8; 20];
    result[..len].copy_from_slice(&buf[i..]);
    result
}

/// Length of the ASCII decimal representation of a u64.
pub fn u64_str_len(mut n: u64) -> usize {
    if n == 0 {
        return 1;
    }
    let mut len = 0;
    while n > 0 {
        len += 1;
        n /= 10;
    }
    len
}

/// Convert a u32 to its ASCII decimal representation.
pub fn u32_to_bytes(n: u32) -> [u8; 10] {
    let mut buf = [0u8; 10];
    let full = u64_to_bytes(n as u64);
    let len = u64_str_len(n as u64);
    buf[..len].copy_from_slice(&full[..len]);
    buf
}

/// Length of the ASCII decimal representation of a u32.
pub fn u32_str_len(n: u32) -> usize {
    u64_str_len(n as u64)
}
