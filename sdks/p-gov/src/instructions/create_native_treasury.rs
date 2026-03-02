use pinocchio::{
    cpi::{invoke_signed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, ProgramResult,
};

/// Create a native SOL treasury for a governance (discriminant 0x19).
///
/// ### Accounts:
///   0. `[]` governance
///   1. `[WRITE]` native_treasury
///   2. `[WRITE, SIGNER]` payer
///   3. `[]` system_program
pub struct CreateNativeTreasury<'a> {
    pub governance_program: &'a AccountView,
    pub governance: &'a AccountView,
    pub native_treasury: &'a AccountView,
    pub payer: &'a AccountView,
    pub system_program: &'a AccountView,
}

impl CreateNativeTreasury<'_> {
    #[inline(always)]
    pub fn invoke(&self) -> ProgramResult {
        self.invoke_signed(&[])
    }

    #[inline(always)]
    pub fn invoke_signed(&self, signers: &[Signer]) -> ProgramResult {
        let account_metas = [
            InstructionAccount::readonly(self.governance.address()),
            InstructionAccount::writable(self.native_treasury.address()),
            InstructionAccount::writable_signer(self.payer.address()),
            InstructionAccount::readonly(self.system_program.address()),
        ];

        let ix_data = [0x19u8];

        let instruction = InstructionView {
            program_id: self.governance_program.address(),
            accounts: &account_metas,
            data: &ix_data,
        };

        invoke_signed(
            &instruction,
            &[
                self.governance,
                self.native_treasury,
                self.payer,
                self.system_program,
            ],
            signers,
        )
    }
}
