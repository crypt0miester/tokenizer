use core::slice::from_raw_parts;

use pinocchio::{
    cpi::{invoke_signed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, ProgramResult,
};

use crate::{write_bytes, UNINIT_BYTE};

/// Data state for asset creation
#[repr(u8)]
#[derive(Copy, Clone, Debug)]
pub enum DataState {
    AccountState = 0,
    LedgerState = 1,
}

/// Create a new MPL Core Asset V1.
///
/// ### Accounts:
///   0. `[WRITE, SIGNER]` The address of the new asset
///   1. `[WRITE, OPTIONAL]` The collection
///   2. `[SIGNER, OPTIONAL]` The authority signing for creation
///   3. `[WRITE, SIGNER]` The payer
///   4. `[OPTIONAL]` The owner of the new asset
///   5. `[OPTIONAL]` The update authority on the new asset
///   6. `[]` The system program
///   7. `[OPTIONAL]` The SPL Noop Program
///
/// To indicate "no update authority" (e.g. when creating within a collection),
/// pass the MPL Core program account as `update_authority`. When its address
/// equals `crate::ID`, the on-chain Shank resolver treats it as `None`.
///
/// `plugins` is pre-serialized Borsh for `Vec<PluginAuthorityPair>`.
/// Pass an empty slice for no plugins.
pub struct CreateV1<'a> {
    pub asset: &'a AccountView,
    pub collection: &'a AccountView,
    pub authority: &'a AccountView,
    pub payer: &'a AccountView,
    pub owner: &'a AccountView,
    pub update_authority: &'a AccountView,
    pub system_program: &'a AccountView,
    pub log_wrapper: &'a AccountView,
    pub data_state: DataState,
    pub name: &'a [u8],
    pub uri: &'a [u8],
    /// Pre-serialized Borsh bytes for `Vec<PluginAuthorityPair>`.
    /// Empty slice = `None` (no plugins).
    pub plugins: &'a [u8],
}

impl CreateV1<'_> {
    #[inline(always)]
    pub fn invoke(&self) -> ProgramResult {
        self.invoke_signed(&[])
    }

    #[inline(always)]
    pub fn invoke_signed(&self, signers: &[Signer]) -> ProgramResult {
        let account_metas = [
            InstructionAccount::writable_signer(self.asset.address()),
            InstructionAccount::writable(self.collection.address()),
            InstructionAccount::readonly_signer(self.authority.address()),
            InstructionAccount::writable_signer(self.payer.address()),
            InstructionAccount::readonly(self.owner.address()),
            InstructionAccount::readonly(self.update_authority.address()),
            InstructionAccount::readonly(self.system_program.address()),
            InstructionAccount::readonly(self.log_wrapper.address()),
        ];

        let name_len = self.name.len().min(32);
        let uri_len = self.uri.len().min(200);

        let mut instruction_data = [UNINIT_BYTE; 512];
        let mut offset = 0;

        // Discriminator (0 for CreateV1)
        write_bytes(&mut instruction_data[offset..offset+1], &[0]);
        offset += 1;

        // Data state
        write_bytes(&mut instruction_data[offset..offset+1], &[self.data_state as u8]);
        offset += 1;

        // Name (Borsh string)
        write_bytes(&mut instruction_data[offset..offset+4], &(name_len as u32).to_le_bytes());
        offset += 4;
        write_bytes(&mut instruction_data[offset..offset+name_len], &self.name[..name_len]);
        offset += name_len;

        // URI (Borsh string)
        write_bytes(&mut instruction_data[offset..offset+4], &(uri_len as u32).to_le_bytes());
        offset += 4;
        write_bytes(&mut instruction_data[offset..offset+uri_len], &self.uri[..uri_len]);
        offset += uri_len;

        // Plugins: Option<Vec<PluginAuthorityPair>>
        if self.plugins.is_empty() {
            write_bytes(&mut instruction_data[offset..offset+1], &[0]); // None
            offset += 1;
        } else {
            write_bytes(&mut instruction_data[offset..offset+1], &[1]); // Some
            offset += 1;
            let plen = self.plugins.len();
            write_bytes(&mut instruction_data[offset..offset+plen], self.plugins);
            offset += plen;
        }

        let instruction = InstructionView {
            program_id: &crate::ID,
            accounts: &account_metas,
            data: unsafe { from_raw_parts(instruction_data.as_ptr() as _, offset) },
        };

        invoke_signed(
            &instruction,
            &[self.asset, self.collection, self.authority, self.payer, self.owner, self.update_authority, self.system_program, self.log_wrapper],
            signers,
        )
    }
}
