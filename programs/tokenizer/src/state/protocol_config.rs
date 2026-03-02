use pinocchio::{error::ProgramError, AccountView, Address};

use crate::error::TokenizerError;
use crate::utils::Pk;

use super::PROTOCOL_CONFIG_SEED;

pub const MAX_ACCEPTED_MINTS: usize = 4;

/// Global protocol configuration singleton.
/// PDA: ["protocol_config"]
#[repr(C)]
pub struct ProtocolConfig {
    // Discriminator
    pub account_key: u8,          // AccountKey::ProtocolConfig
    pub version: u8,

    // Authority
    pub operator: [u8; 32],
    pub realm: [u8; 32],
    pub governance: [u8; 32],

    // Fees
    pub fee_bps: u16,
    pub fee_treasury: [u8; 32],

    // State
    pub paused: u8,               // 0 = active, 1 = paused

    // Accepted stablecoin mints
    pub accepted_mint_count: u8,
    pub accepted_mints: [[u8; 32]; MAX_ACCEPTED_MINTS],

    // Counters
    pub total_organizations: u32,

    // PDA
    pub bump: u8,

    // Governance guardrails
    // _pad: u8 (implicit repr(C) alignment padding)
    /// Minimum community weight to create a proposal, expressed as basis points
    /// of the asset's total_shares. 0 = no enforcement (backwards compatible).
    /// E.g. 500 = 5% of total_shares.
    pub min_proposal_weight_bps: u16,
}

impl ProtocolConfig {
    pub const LEN: usize = core::mem::size_of::<Self>();

    #[inline(always)]
    pub unsafe fn load(data: &[u8]) -> &Self {
        &*(data.as_ptr() as *const Self)
    }

    #[inline(always)]
    pub unsafe fn load_mut(data: &mut [u8]) -> &mut Self {
        &mut *(data.as_mut_ptr() as *mut Self)
    }

    pub fn derive_pda(program_id: &Address) -> (Address, u8) {
        Address::find_program_address(&[PROTOCOL_CONFIG_SEED], program_id)
    }

    #[inline(always)]
    pub fn is_paused(&self) -> bool {
        self.paused != 0
    }

    #[inline(always)]
    pub fn require_operator(&self, signer: &AccountView) -> Result<(), ProgramError> {
        if signer.address().as_array() != &self.operator {
            pinocchio_log::log!("operator: expected {}, got {}", Pk(&self.operator), Pk(signer.address().as_array()));
            return Err(TokenizerError::InvalidOperator.into());
        }
        if !signer.is_signer() {
            pinocchio_log::log!("operator: not a signer ({})", Pk(signer.address().as_array()));
            return Err(TokenizerError::MissingRequiredSignature.into());
        }
        Ok(())
    }

    #[inline(always)]
    pub fn require_not_paused(&self) -> Result<(), ProgramError> {
        if self.is_paused() {
            pinocchio_log::log!("protocol is paused");
            return Err(TokenizerError::ProtocolPaused.into());
        }
        Ok(())
    }

    pub fn is_mint_accepted(&self, mint: &[u8; 32]) -> bool {
        let count = self.accepted_mint_count as usize;
        for i in 0..count {
            if &self.accepted_mints[i] == mint {
                return true;
            }
        }
        false
    }
}
