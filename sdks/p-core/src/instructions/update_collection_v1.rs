use core::slice::from_raw_parts;

use pinocchio::{
    cpi::{invoke_signed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, ProgramResult,
};

use crate::{write_bytes, UNINIT_BYTE};

/// Update an MPL Core Collection V1 metadata (name and/or URI).
///
/// Uses discriminator 16 (UpdateCollectionV1).
/// Unlike asset UpdateV1, collection updates do NOT include new_update_authority
/// in the instruction data.
///
/// ### Accounts:
///   0. `[WRITE]` The collection to update
///   1. `[WRITE, SIGNER]` The payer
///   2. `[SIGNER, OPTIONAL]` The update authority
///   3. `[OPTIONAL]` The new update authority (program ID sentinel = None)
///   4. `[]` The system program
///   5. `[OPTIONAL]` The SPL Noop Program
pub struct UpdateCollectionV1<'a> {
    pub collection: &'a AccountView,
    pub payer: &'a AccountView,
    pub authority: &'a AccountView,
    pub system_program: &'a AccountView,
    pub log_wrapper: &'a AccountView,
    pub new_name: &'a [u8],
    pub new_uri: &'a [u8],
}

impl UpdateCollectionV1<'_> {
    #[inline(always)]
    pub fn invoke(&self) -> ProgramResult {
        self.invoke_signed(&[])
    }

    #[inline(always)]
    pub fn invoke_signed(&self, signers: &[Signer]) -> ProgramResult {
        let account_metas = [
            InstructionAccount::writable(self.collection.address()),
            InstructionAccount::writable_signer(self.payer.address()),
            InstructionAccount::readonly_signer(self.authority.address()),
            InstructionAccount::readonly(&crate::ID), // newUpdateAuthority = None (program ID sentinel)
            InstructionAccount::readonly(self.system_program.address()),
            InstructionAccount::readonly(self.log_wrapper.address()),
        ];

        let mut instruction_data = [UNINIT_BYTE; 256];
        let mut offset = 0;

        // Discriminator (16 for UpdateCollectionV1)
        write_bytes(&mut instruction_data[offset..offset+1], &[16]);
        offset += 1;

        // new_name: Option<String>
        if !self.new_name.is_empty() {
            let name_len = self.new_name.len().min(32);
            write_bytes(&mut instruction_data[offset..offset+1], &[1]); // Some
            offset += 1;
            write_bytes(&mut instruction_data[offset..offset+4], &(name_len as u32).to_le_bytes());
            offset += 4;
            write_bytes(&mut instruction_data[offset..offset+name_len], &self.new_name[..name_len]);
            offset += name_len;
        } else {
            write_bytes(&mut instruction_data[offset..offset+1], &[0]); // None
            offset += 1;
        }

        // new_uri: Option<String>
        if !self.new_uri.is_empty() {
            let uri_len = self.new_uri.len().min(200);
            write_bytes(&mut instruction_data[offset..offset+1], &[1]); // Some
            offset += 1;
            write_bytes(&mut instruction_data[offset..offset+4], &(uri_len as u32).to_le_bytes());
            offset += 4;
            write_bytes(&mut instruction_data[offset..offset+uri_len], &self.new_uri[..uri_len]);
            offset += uri_len;
        } else {
            write_bytes(&mut instruction_data[offset..offset+1], &[0]); // None
            offset += 1;
        }

        let instruction = InstructionView {
            program_id: &crate::ID,
            accounts: &account_metas,
            data: unsafe { from_raw_parts(instruction_data.as_ptr() as _, offset) },
        };

        invoke_signed(
            &instruction,
            &[self.collection, self.payer, self.authority, self.log_wrapper, self.system_program, self.log_wrapper],
            signers,
        )
    }
}
