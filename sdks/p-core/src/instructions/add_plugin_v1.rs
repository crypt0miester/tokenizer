use core::slice::from_raw_parts;

use pinocchio::{
    cpi::{invoke_signed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, ProgramResult,
};

use crate::{write_bytes, UNINIT_BYTE, plugins::PluginAuthority};

/// Plugin data for adding to an asset.
pub enum PluginData<'a> {
    Attributes {
        authority: PluginAuthority,
        attributes: &'a [(&'a [u8], &'a [u8])],
    },
    FreezeDelegate {
        authority: PluginAuthority,
        frozen: bool,
    },
    BurnDelegate {
        authority: PluginAuthority,
    },
    TransferDelegate {
        authority: PluginAuthority,
    },
    PermanentFreezeDelegate {
        authority: PluginAuthority,
        frozen: bool,
    },
}

/// Add a plugin to an MPL Core Asset V1.
///
/// ### Accounts:
///   0. `[WRITE]` The asset
///   1. `[WRITE, OPTIONAL]` The collection
///   2. `[WRITE, SIGNER]` The payer
///   3. `[SIGNER, OPTIONAL]` The authority
///   4. `[]` The system program
///   5. `[OPTIONAL]` The SPL Noop Program
pub struct AddPluginV1<'a> {
    pub asset: &'a AccountView,
    pub collection: &'a AccountView,
    pub payer: &'a AccountView,
    pub authority: &'a AccountView,
    pub system_program: &'a AccountView,
    pub log_wrapper: &'a AccountView,
    pub plugin: PluginData<'a>,
}

impl AddPluginV1<'_> {
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

        // Discriminator (2 for AddPluginV1)
        write_bytes(&mut instruction_data[offset..offset+1], &[2]);
        offset += 1;

        match &self.plugin {
            PluginData::Attributes { authority, attributes } => {
                // Plugin::Attributes variant 6
                write_bytes(&mut instruction_data[offset..offset+1], &[6]);
                offset += 1;

                // Vec<Attribute>
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

                // init_authority: Option<Authority> — Some(authority)
                write_bytes(&mut instruction_data[offset..offset+1], &[1]);
                offset += 1;
                offset = Self::write_authority(&mut instruction_data, offset, authority);
            },
            PluginData::FreezeDelegate { authority, frozen } => {
                // Plugin::FreezeDelegate variant 1
                write_bytes(&mut instruction_data[offset..offset+1], &[1]);
                offset += 1;
                write_bytes(&mut instruction_data[offset..offset+1], &[*frozen as u8]);
                offset += 1;
                offset = Self::write_option_authority(&mut instruction_data, offset, authority);
            },
            PluginData::BurnDelegate { authority } => {
                // Plugin::BurnDelegate variant 2
                write_bytes(&mut instruction_data[offset..offset+1], &[2]);
                offset += 1;
                offset = Self::write_option_authority(&mut instruction_data, offset, authority);
            },
            PluginData::TransferDelegate { authority } => {
                // Plugin::TransferDelegate variant 3
                write_bytes(&mut instruction_data[offset..offset+1], &[3]);
                offset += 1;
                offset = Self::write_option_authority(&mut instruction_data, offset, authority);
            },
            PluginData::PermanentFreezeDelegate { authority, frozen } => {
                // Plugin::PermanentFreezeDelegate variant 5
                write_bytes(&mut instruction_data[offset..offset+1], &[5]);
                offset += 1;
                write_bytes(&mut instruction_data[offset..offset+1], &[*frozen as u8]);
                offset += 1;
                offset = Self::write_option_authority(&mut instruction_data, offset, authority);
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

    fn write_option_authority(buf: &mut [core::mem::MaybeUninit<u8>], mut offset: usize, authority: &PluginAuthority) -> usize {
        write_bytes(&mut buf[offset..offset+1], &[1]); // Some
        offset += 1;
        Self::write_authority(buf, offset, authority)
    }

    fn write_authority(buf: &mut [core::mem::MaybeUninit<u8>], mut offset: usize, authority: &PluginAuthority) -> usize {
        match authority {
            PluginAuthority::None => {
                write_bytes(&mut buf[offset..offset+1], &[0]);
                offset += 1;
            }
            PluginAuthority::Owner => {
                write_bytes(&mut buf[offset..offset+1], &[1]);
                offset += 1;
            }
            PluginAuthority::UpdateAuthority => {
                write_bytes(&mut buf[offset..offset+1], &[2]);
                offset += 1;
            }
            PluginAuthority::Address(pubkey) => {
                write_bytes(&mut buf[offset..offset+1], &[3]);
                offset += 1;
                write_bytes(&mut buf[offset..offset+32], pubkey);
                offset += 32;
            }
        }
        offset
    }
}
