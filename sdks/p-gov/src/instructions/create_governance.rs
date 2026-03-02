use core::slice::from_raw_parts;

use pinocchio::{
    cpi::{invoke_signed_with_bounds, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, ProgramResult,
};

use crate::{write_bytes, UNINIT_BYTE};

/// Create a governance instance (discriminant 0x04).
///
/// ### Accounts:
///   0. `[]` realm
///   1. `[WRITE]` governance
///   2. `[]` governance_seed
///   3. `[]` token_owner_record
///   4. `[WRITE, SIGNER]` payer
///   5. `[]` system_program
///   6. `[SIGNER]` governance_authority
///   7. `[]` realm_config
///   8. `[OPTIONAL]` voter_weight_record
pub struct CreateGovernance<'a> {
    pub governance_program: &'a AccountView,
    pub realm: &'a AccountView,
    pub governance: &'a AccountView,
    pub governance_seed: &'a AccountView,
    pub token_owner_record: &'a AccountView,
    pub payer: &'a AccountView,
    pub system_program: &'a AccountView,
    pub governance_authority: &'a AccountView,
    pub realm_config: &'a AccountView,
    pub voter_weight_record: Option<&'a AccountView>,
    /// Raw Borsh-encoded GovernanceConfig bytes (pass-through).
    pub governance_config_data: &'a [u8],
}

impl CreateGovernance<'_> {
    #[inline(always)]
    pub fn invoke(&self) -> ProgramResult {
        self.invoke_signed(&[])
    }

    #[inline(always)]
    pub fn invoke_signed(&self, signers: &[Signer]) -> ProgramResult {
        // Build account metas (max 9: 8 required + 1 optional).
        let mut account_metas = [
            InstructionAccount::readonly(self.realm.address()),
            InstructionAccount::writable(self.governance.address()),
            InstructionAccount::readonly(self.governance_seed.address()),
            InstructionAccount::readonly(self.token_owner_record.address()),
            InstructionAccount::writable_signer(self.payer.address()),
            InstructionAccount::readonly(self.system_program.address()),
            InstructionAccount::readonly_signer(self.governance_authority.address()),
            InstructionAccount::readonly(self.realm_config.address()),
            // Slot 8: filled below if optional account is present.
            InstructionAccount::readonly(self.realm.address()),
        ];

        let mut account_views = [
            self.realm,
            self.governance,
            self.governance_seed,
            self.token_owner_record,
            self.payer,
            self.system_program,
            self.governance_authority,
            self.realm_config,
            // Slot 8: filled below if optional account is present.
            self.realm,
        ];

        let mut count = 8;

        if let Some(vwr) = self.voter_weight_record {
            account_metas[count] = InstructionAccount::readonly(vwr.address());
            account_views[count] = vwr;
            count += 1;
        }

        // Build instruction data: [0x04] + governance_config_data.
        let config_len = self.governance_config_data.len();
        let mut ix_data = [UNINIT_BYTE; 64];

        write_bytes(&mut ix_data[0..1], &[0x04]);
        write_bytes(&mut ix_data[1..1 + config_len], self.governance_config_data);

        let total_len = 1 + config_len;

        let instruction = InstructionView {
            program_id: self.governance_program.address(),
            accounts: &account_metas[..count],
            data: unsafe { from_raw_parts(ix_data.as_ptr() as _, total_len) },
        };

        invoke_signed_with_bounds::<9>(
            &instruction,
            &account_views[..count],
            signers,
        )
    }
}
