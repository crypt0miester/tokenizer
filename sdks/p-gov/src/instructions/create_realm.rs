use core::slice::from_raw_parts;

use pinocchio::{
    cpi::{invoke_signed_with_bounds, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, ProgramResult,
};

use crate::{write_bytes, UNINIT_BYTE};

/// Community/council token type for SPL Governance realm configuration.
#[repr(u8)]
#[derive(Copy, Clone, Debug)]
pub enum GovTokenType {
    Liquid = 0,
    Membership = 1,
    Dormant = 2,
}

/// Token configuration for a governance realm token (community or council).
#[derive(Copy, Clone, Debug)]
pub struct GovTokenConfig {
    pub use_voter_weight_addin: bool,
    pub use_max_voter_weight_addin: bool,
    pub token_type: GovTokenType,
}

/// Vote threshold for governance proposals.
#[derive(Copy, Clone, Debug)]
pub enum VoteThreshold {
    /// Supply fraction threshold (variant 0).
    SupplyFraction(u64),
    /// Voting disabled (variant 1).
    Disabled,
}

/// Configuration arguments for creating a governance realm.
#[derive(Copy, Clone, Debug)]
pub struct RealmConfigArgs {
    pub use_council_mint: bool,
    pub min_community_weight_to_create_governance: u64,
    pub community_vote_threshold: VoteThreshold,
    pub community_token_config: GovTokenConfig,
    pub council_token_config: GovTokenConfig,
}

/// Create a new SPL Governance Realm (discriminant 0x00).
///
/// ### Accounts:
///   0.  `[WRITE]` realm
///   1.  `[]` realm_authority
///   2.  `[]` community_mint
///   3.  `[WRITE, SIGNER]` payer
///   4.  `[]` system_program
///   5.  `[]` spl_token_program
///   6.  `[]` rent_sysvar
///   7.  `[]` council_mint
///   8.  `[WRITE]` community_token_holding
///   9.  `[WRITE]` council_token_holding
///   10. `[WRITE]` realm_config
///   11. `[OPTIONAL]` voter_weight_addin
///   12. `[OPTIONAL]` max_voter_weight_addin
pub struct CreateRealm<'a> {
    pub governance_program: &'a AccountView,
    pub realm: &'a AccountView,
    pub realm_authority: &'a AccountView,
    pub community_mint: &'a AccountView,
    pub payer: &'a AccountView,
    pub system_program: &'a AccountView,
    pub spl_token_program: &'a AccountView,
    pub rent_sysvar: &'a AccountView,
    pub council_mint: &'a AccountView,
    pub community_token_holding: &'a AccountView,
    pub council_token_holding: &'a AccountView,
    pub realm_config: &'a AccountView,
    pub voter_weight_addin: Option<&'a AccountView>,
    pub max_voter_weight_addin: Option<&'a AccountView>,
    pub name: &'a [u8],
    pub config_args: RealmConfigArgs,
}

impl CreateRealm<'_> {
    #[inline(always)]
    pub fn invoke(&self) -> ProgramResult {
        self.invoke_signed(&[])
    }

    #[inline(always)]
    pub fn invoke_signed(&self, signers: &[Signer]) -> ProgramResult {
        // Build account metas (max 13: 11 required + 2 optional).
        let mut account_metas = [
            InstructionAccount::writable(self.realm.address()),
            InstructionAccount::readonly(self.realm_authority.address()),
            InstructionAccount::readonly(self.community_mint.address()),
            InstructionAccount::writable(self.community_token_holding.address()),
            InstructionAccount::writable_signer(self.payer.address()),
            InstructionAccount::readonly(self.system_program.address()),
            InstructionAccount::readonly(self.spl_token_program.address()),
            InstructionAccount::readonly(self.rent_sysvar.address()),
            InstructionAccount::readonly(self.council_mint.address()),
            InstructionAccount::writable(self.council_token_holding.address()),
            InstructionAccount::writable(self.realm_config.address()),
            // Slots 11-12: filled below if optional accounts are present.
            InstructionAccount::readonly(self.realm.address()),
            InstructionAccount::readonly(self.realm.address()),
        ];

        let mut account_views = [
            self.realm,
            self.realm_authority,
            self.community_mint,
            self.community_token_holding,
            self.payer,
            self.system_program,
            self.spl_token_program,
            self.rent_sysvar,
            self.council_mint,
            self.council_token_holding,
            self.realm_config,
            // Slots 11-12: filled below if optional accounts are present.
            self.realm,
            self.realm,
        ];

        let mut count = 11;

        if let Some(vw) = self.voter_weight_addin {
            account_metas[count] = InstructionAccount::readonly(vw.address());
            account_views[count] = vw;
            count += 1;
        }

        if let Some(mw) = self.max_voter_weight_addin {
            account_metas[count] = InstructionAccount::readonly(mw.address());
            account_views[count] = mw;
            count += 1;
        }

        // Build instruction data: [0x00] + Borsh string (name) + RealmConfigArgs.
        let name_len = self.name.len();

        let mut ix_data = [UNINIT_BYTE; 160];
        let mut offset = 0;

        // Discriminant.
        write_bytes(&mut ix_data[offset..offset + 1], &[0x00]);
        offset += 1;

        // Name (Borsh string: u32 LE length + bytes).
        write_bytes(
            &mut ix_data[offset..offset + 4],
            &(name_len as u32).to_le_bytes(),
        );
        offset += 4;
        write_bytes(&mut ix_data[offset..offset + name_len], self.name);
        offset += name_len;

        // RealmConfigArgs.
        let cfg = &self.config_args;

        // use_council_mint (bool).
        write_bytes(
            &mut ix_data[offset..offset + 1],
            &[cfg.use_council_mint as u8],
        );
        offset += 1;

        // min_community_weight_to_create_governance (u64 LE).
        write_bytes(
            &mut ix_data[offset..offset + 8],
            &cfg.min_community_weight_to_create_governance.to_le_bytes(),
        );
        offset += 8;

        // community_vote_threshold (Borsh enum).
        match cfg.community_vote_threshold {
            VoteThreshold::SupplyFraction(val) => {
                write_bytes(&mut ix_data[offset..offset + 1], &[0]);
                offset += 1;
                write_bytes(&mut ix_data[offset..offset + 8], &val.to_le_bytes());
                offset += 8;
            }
            VoteThreshold::Disabled => {
                write_bytes(&mut ix_data[offset..offset + 1], &[1]);
                offset += 1;
            }
        }

        // community_token_config.
        write_bytes(
            &mut ix_data[offset..offset + 1],
            &[cfg.community_token_config.use_voter_weight_addin as u8],
        );
        offset += 1;
        write_bytes(
            &mut ix_data[offset..offset + 1],
            &[cfg.community_token_config.use_max_voter_weight_addin as u8],
        );
        offset += 1;
        write_bytes(
            &mut ix_data[offset..offset + 1],
            &[cfg.community_token_config.token_type as u8],
        );
        offset += 1;

        // council_token_config.
        write_bytes(
            &mut ix_data[offset..offset + 1],
            &[cfg.council_token_config.use_voter_weight_addin as u8],
        );
        offset += 1;
        write_bytes(
            &mut ix_data[offset..offset + 1],
            &[cfg.council_token_config.use_max_voter_weight_addin as u8],
        );
        offset += 1;
        write_bytes(
            &mut ix_data[offset..offset + 1],
            &[cfg.council_token_config.token_type as u8],
        );
        offset += 1;

        let instruction = InstructionView {
            program_id: self.governance_program.address(),
            accounts: &account_metas[..count],
            data: unsafe { from_raw_parts(ix_data.as_ptr() as _, offset) },
        };

        invoke_signed_with_bounds::<13>(
            &instruction,
            &account_views[..count],
            signers,
        )
    }
}
