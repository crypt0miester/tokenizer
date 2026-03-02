use pinocchio::Address;

use super::REGISTRAR_SEED;

/// Voter weight plugin registrar — maps a realm + governing_token_mint to a specific asset.
/// PDA: ["registrar", realm, governing_token_mint]
#[repr(C)]
pub struct Registrar {
    pub account_key: u8,                // AccountKey::Registrar (11)
    pub version: u8,
    pub governance_program_id: [u8; 32],
    pub realm: [u8; 32],
    pub governing_token_mint: [u8; 32],
    pub asset: [u8; 32],               // The specific asset this registrar serves
    pub bump: u8,
}

impl Registrar {
    pub const LEN: usize = core::mem::size_of::<Self>();

    #[inline(always)]
    pub unsafe fn load(data: &[u8]) -> &Self {
        &*(data.as_ptr() as *const Self)
    }

    #[inline(always)]
    pub unsafe fn load_mut(data: &mut [u8]) -> &mut Self {
        &mut *(data.as_mut_ptr() as *mut Self)
    }

    pub fn derive_pda(
        realm: &[u8; 32],
        governing_token_mint: &[u8; 32],
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[REGISTRAR_SEED, realm, governing_token_mint],
            program_id,
        )
    }
}
