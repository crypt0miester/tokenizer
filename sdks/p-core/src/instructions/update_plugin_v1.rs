use core::slice::from_raw_parts;

use pinocchio::{
    cpi::{invoke_signed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, ProgramResult,
};

use crate::{write_bytes, UNINIT_BYTE};

/// Plugin update data.
pub enum PluginUpdateData<'a> {
    AttributesSet {
        attributes: &'a [(&'a [u8], &'a [u8])],
    },
    FreezeDelegateState {
        frozen: bool,
    },
    PermanentFreezeDelegateState {
        frozen: bool,
    },
}

/// Update a plugin on an MPL Core Asset V1.
///
/// ### Accounts:
///   0. `[WRITE]` The asset
///   1. `[WRITE, OPTIONAL]` The collection
///   2. `[WRITE, SIGNER]` The payer
///   3. `[SIGNER, OPTIONAL]` The authority
///   4. `[]` The system program
///   5. `[OPTIONAL]` The SPL Noop Program
pub struct UpdatePluginV1<'a> {
    pub asset: &'a AccountView,
    pub collection: &'a AccountView,
    pub payer: &'a AccountView,
    pub authority: &'a AccountView,
    pub system_program: &'a AccountView,
    pub log_wrapper: &'a AccountView,
    pub update: PluginUpdateData<'a>,
}

impl UpdatePluginV1<'_> {
    #[inline(always)]
    pub fn invoke(&self) -> ProgramResult {
        self.invoke_signed(&[])
    }

    #[inline(always)]
    pub fn invoke_signed(&self, signers: &[Signer]) -> ProgramResult {
        let account_metas = [
            InstructionAccount::writable(self.asset.address()),
            InstructionAccount::writable(self.collection.address()),
            InstructionAccount::writable_signer(self.payer.address()),
            InstructionAccount::readonly_signer(self.authority.address()),
            InstructionAccount::readonly(self.system_program.address()),
            InstructionAccount::readonly(self.log_wrapper.address()),
        ];

        let mut instruction_data = [UNINIT_BYTE; 1024];
        let mut offset = 0;

        // Discriminator (6 for UpdatePluginV1)
        write_bytes(&mut instruction_data[offset..offset+1], &[6]);
        offset += 1;

        match &self.update {
            PluginUpdateData::AttributesSet { attributes } => {
                // Plugin::Attributes variant 6
                write_bytes(&mut instruction_data[offset..offset+1], &[6]);
                offset += 1;

                let attr_count = attributes.len().min(10) as u32;
                write_bytes(&mut instruction_data[offset..offset+4], &attr_count.to_le_bytes());
                offset += 4;

                for (key, value) in attributes.iter().take(10) {
                    let key_len = key.len() as u32;
                    write_bytes(&mut instruction_data[offset..offset+4], &key_len.to_le_bytes());
                    offset += 4;
                    write_bytes(&mut instruction_data[offset..offset+(key_len as usize)], key);
                    offset += key_len as usize;

                    let val_len = value.len() as u32;
                    write_bytes(&mut instruction_data[offset..offset+4], &val_len.to_le_bytes());
                    offset += 4;
                    write_bytes(&mut instruction_data[offset..offset+(val_len as usize)], value);
                    offset += val_len as usize;
                }
            },
            PluginUpdateData::FreezeDelegateState { frozen } => {
                // Plugin::FreezeDelegate variant 1
                write_bytes(&mut instruction_data[offset..offset+1], &[1]);
                offset += 1;
                write_bytes(&mut instruction_data[offset..offset+1], &[*frozen as u8]);
                offset += 1;
            },
            PluginUpdateData::PermanentFreezeDelegateState { frozen } => {
                // Plugin::PermanentFreezeDelegate variant 5
                write_bytes(&mut instruction_data[offset..offset+1], &[5]);
                offset += 1;
                write_bytes(&mut instruction_data[offset..offset+1], &[*frozen as u8]);
                offset += 1;
            },
        }

        let instruction = InstructionView {
            program_id: &crate::ID,
            accounts: &account_metas,
            data: unsafe { from_raw_parts(instruction_data.as_ptr() as _, offset) },
        };

        invoke_signed(
            &instruction,
            &[self.asset, self.collection, self.payer, self.authority, self.system_program, self.log_wrapper],
            signers,
        )
    }
}
