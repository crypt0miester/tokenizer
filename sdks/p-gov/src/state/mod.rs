pub mod governance;
pub mod proposal;
pub mod realm;
pub mod token_owner_record;

/// GovernanceAccountType discriminator values (byte 0 of every spl-gov account).
pub mod account_type {
    pub const REALM_V1: u8 = 1;
    pub const REALM_V2: u8 = 16;
    pub const TOKEN_OWNER_RECORD_V1: u8 = 2;
    pub const TOKEN_OWNER_RECORD_V2: u8 = 17;
    pub const GOVERNANCE_V1: u8 = 3;
    pub const GOVERNANCE_V2: u8 = 18;
    pub const PROPOSAL_V1: u8 = 5;
    pub const PROPOSAL_V2: u8 = 14;
}

/// Proposal lifecycle states.
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ProposalState {
    Draft = 0,
    SigningOff = 1,
    Voting = 2,
    Succeeded = 3,
    Executing = 4,
    Completed = 5,
    Cancelled = 6,
    Defeated = 7,
    ExecutingWithErrors = 8,
    Vetoed = 9,
}

impl ProposalState {
    pub fn from_u8(val: u8) -> Option<Self> {
        match val {
            0 => Some(Self::Draft),
            1 => Some(Self::SigningOff),
            2 => Some(Self::Voting),
            3 => Some(Self::Succeeded),
            4 => Some(Self::Executing),
            5 => Some(Self::Completed),
            6 => Some(Self::Cancelled),
            7 => Some(Self::Defeated),
            8 => Some(Self::ExecutingWithErrors),
            9 => Some(Self::Vetoed),
            _ => None,
        }
    }

    /// Returns true if the proposal is in a final state (cannot transition further).
    /// Matches spl-gov's `assert_is_final_state()` — Completed, Cancelled, Defeated, Vetoed.
    /// Note: ExecutingWithErrors is NOT final (can still transition to Completed).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Cancelled | Self::Defeated | Self::Vetoed
        )
    }
}
