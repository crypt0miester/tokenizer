use core::slice::from_raw_parts;

use pinocchio::{
    cpi::{invoke_signed_with_bounds, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, ProgramResult,
};

use crate::{write_bytes, UNINIT_BYTE};

/// Deposit governing tokens into a realm (discriminant 0x01).
///
/// ### Accounts:
///   0. `[]` realm
///   1. `[WRITE]` governing_token_holding
///   2. `[WRITE]` governing_token_source
///   3. `[SIGNER]` governing_token_owner
///   4. `[SIGNER]` governing_token_transfer_authority
///   5. `[WRITE]` token_owner_record
///   6. `[WRITE, SIGNER]` payer
///   7. `[]` system_program
///   8. `[]` spl_token_program
///   9. `[]` realm_config
pub struct DepositGoverningTokens<'a> {
    pub governance_program: &'a AccountView,
    pub realm: &'a AccountView,
    pub governing_token_holding: &'a AccountView,
    pub governing_token_source: &'a AccountView,
    pub governing_token_owner: &'a AccountView,
    pub governing_token_transfer_authority: &'a AccountView,
    pub token_owner_record: &'a AccountView,
    pub payer: &'a AccountView,
    pub system_program: &'a AccountView,
    pub spl_token_program: &'a AccountView,
    pub realm_config: &'a AccountView,
    pub amount: u64,
}

impl DepositGoverningTokens<'_> {
    #[inline(always)]
    pub fn invoke(&self) -> ProgramResult {
        self.invoke_signed(&[])
    }

    #[inline(always)]
    pub fn invoke_signed(&self, signers: &[Signer]) -> ProgramResult {
        let account_metas = [
            InstructionAccount::readonly(self.realm.address()),
            InstructionAccount::writable(self.governing_token_holding.address()),
            InstructionAccount::writable(self.governing_token_source.address()),
            InstructionAccount::readonly_signer(self.governing_token_owner.address()),
            InstructionAccount::readonly_signer(self.governing_token_transfer_authority.address()),
            InstructionAccount::writable(self.token_owner_record.address()),
            InstructionAccount::writable_signer(self.payer.address()),
            InstructionAccount::readonly(self.system_program.address()),
            InstructionAccount::readonly(self.spl_token_program.address()),
            InstructionAccount::readonly(self.realm_config.address()),
        ];

        let account_views = [
            self.realm,
            self.governing_token_holding,
            self.governing_token_source,
            self.governing_token_owner,
            self.governing_token_transfer_authority,
            self.token_owner_record,
            self.payer,
            self.system_program,
            self.spl_token_program,
            self.realm_config,
        ];

        // Data: [0x01] + amount (u64 LE) = 9 bytes.
        let mut ix_data = [UNINIT_BYTE; 9];
        write_bytes(&mut ix_data[0..1], &[0x01]);
        write_bytes(&mut ix_data[1..9], &self.amount.to_le_bytes());

        let instruction = InstructionView {
            program_id: self.governance_program.address(),
            accounts: &account_metas,
            data: unsafe { from_raw_parts(ix_data.as_ptr() as _, 9) },
        };

        invoke_signed_with_bounds::<10>(
            &instruction,
            &account_views,
            signers,
        )
    }
}
