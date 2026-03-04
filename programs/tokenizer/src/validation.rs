use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};
use pinocchio_associated_token_account::instructions::CreateIdempotent;

use crate::error::TokenizerError;
use crate::utils::{read_bytes32, Pk};

/// Close a program-owned account: transfer lamports to recipient, then zero the account.
/// Must have no active borrows on `account` when called.
#[inline(always)]
pub fn close_account(account: &AccountView, recipient: &AccountView) -> ProgramResult {
    recipient.set_lamports(
        recipient.lamports()
            .checked_add(account.lamports())
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?,
    );
    account.close()
}

/// Validates that an account is a valid SPL Token account with the expected mint and owner.
/// SPL Token account layout: [0..32] mint, [32..64] owner.
#[inline(always)]
pub fn require_token_account(
    account: &AccountView,
    expected_mint: &[u8; 32],
    expected_owner: &[u8; 32],
) -> Result<(), ProgramError> {
    require_owner(account, &pinocchio_token::ID, "token_account")?;
    let data = account.try_borrow()?;
    let mint = read_bytes32(&data, 0, "mint")?;
    let owner = read_bytes32(&data, 32, "owner")?;
    if &mint != expected_mint {
        pinocchio_log::log!("token mint: expected {}, got {}", Pk(expected_mint), Pk(&mint));
        return Err(TokenizerError::InvalidMint.into());
    }
    if &owner != expected_owner {
        pinocchio_log::log!("token owner: expected {}, got {}", Pk(expected_owner), Pk(&owner));
        return Err(TokenizerError::InvalidTokenOwner.into());
    }
    Ok(())
}

#[inline(always)]
pub fn require_signer(account: &AccountView, label: &str) -> Result<(), ProgramError> {
    if !account.is_signer() {
        pinocchio_log::log!("{}: not a signer ({})", label, Pk(account.address().as_array()));
        return Err(TokenizerError::MissingRequiredSignature.into());
    }
    Ok(())
}

#[inline(always)]
pub fn require_writable(account: &AccountView, label: &str) -> Result<(), ProgramError> {
    if !account.is_writable() {
        pinocchio_log::log!("{}: not writable ({})", label, Pk(account.address().as_array()));
        return Err(TokenizerError::AccountNotWritable.into());
    }
    Ok(())
}

#[inline(always)]
pub fn require_owner(account: &AccountView, expected: &Address, label: &str) -> Result<(), ProgramError> {
    let account_owner = unsafe { account.owner() };
    if account_owner != expected {
        pinocchio_log::log!("{}: expected owner {}, got {}", label, Pk(expected.as_array()), Pk(account_owner.as_array()));
        return Err(TokenizerError::InvalidAccountOwner.into());
    }
    Ok(())
}

/// Validates that an account matches the expected PDA derivation.
/// Returns the bump seed on success.
#[inline(always)]
pub fn require_pda(
    account: &AccountView,
    seeds: &[&[u8]],
    program_id: &Address,
    label: &str,
) -> Result<u8, ProgramError> {
    let (expected, bump) = Address::find_program_address(seeds, program_id);
    if *account.address() != expected {
        pinocchio_log::log!("{}: expected {}, got {}", label, Pk(expected.as_array()), Pk(account.address().as_array()));
        return Err(TokenizerError::InvalidPDA.into());
    }
    Ok(bump)
}

/// Validates a PDA using a known bump (single hash via `create_program_address`).
/// Seeds must include the bump byte as the last element.
/// Use instead of `require_pda` when the bump is already known from loaded account data.
#[inline(always)]
pub fn require_pda_with_bump(
    account: &AccountView,
    seeds: &[&[u8]],
    program_id: &Address,
    label: &str,
) -> ProgramResult {
    let expected = Address::create_program_address(seeds, program_id)
        .map_err(|_| -> ProgramError {
            pinocchio_log::log!("{}: seed derivation failed", label);
            TokenizerError::InvalidPDA.into()
        })?;
    if *account.address() != expected {
        pinocchio_log::log!("{}: expected {}, got {}", label, Pk(expected.as_array()), Pk(account.address().as_array()));
        return Err(TokenizerError::InvalidPDA.into());
    }
    Ok(())
}

/// Validates that a writable `rent_destination` account matches the stored rent payer.
#[inline(always)]
pub fn require_rent_destination(
    account: &AccountView,
    expected: &[u8; 32],
) -> Result<(), ProgramError> {
    require_writable(account, "rent_destination")?;
    if account.address().as_array() != expected {
        pinocchio_log::log!("rent_destination: expected {}, got {}", Pk(expected), Pk(account.address().as_array()));
        return Err(TokenizerError::RentPayerMismatch.into());
    }
    Ok(())
}

/// Validates that the account is the system program.
#[inline(always)]
pub fn require_system_program(account: &AccountView) -> Result<(), ProgramError> {
    if *account.address() != pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// Validates that the account is the SPL Token program.
#[inline(always)]
pub fn require_token_program(account: &AccountView) -> Result<(), ProgramError> {
    if *account.address() != pinocchio_token::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// Validates that the account is the Associated Token Account program.
#[inline(always)]
pub fn require_ata_program(account: &AccountView) -> Result<(), ProgramError> {
    if *account.address() != pinocchio_associated_token_account::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// Validates that the account is the Metaplex Core program.
#[inline(always)]
pub fn require_mpl_core_program(account: &AccountView) -> Result<(), ProgramError> {
    if *account.address() != p_core::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// Creates an Associated Token Account if it doesn't already exist.
/// Uses CreateIdempotent which is a no-op if the account already exists.
#[inline(always)]
pub fn create_ata_if_needed<'a>(
    payer: &'a AccountView,
    ata: &'a AccountView,
    wallet: &'a AccountView,
    mint: &'a AccountView,
    system_program: &'a AccountView,
    token_program: &'a AccountView,
) -> ProgramResult {
    if ata.data_len() > 0 {
        return Ok(());
    }
    CreateIdempotent {
        funding_account: payer,
        account: ata,
        wallet,
        mint,
        system_program,
        token_program,
    }
    .invoke()
}
