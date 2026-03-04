#![no_std]

pub mod error;
pub mod processor;
pub mod state;
pub mod utils;
pub mod validation;

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use pinocchio::{
        program_entrypoint, nostd_panic_handler, no_allocator,
        error::ProgramError,
        AccountView,
        Address,
        ProgramResult,
    };

    use crate::processor;

    program_entrypoint!(process_instruction);
    nostd_panic_handler!();
    no_allocator!();

    pub fn process_instruction(
        program_id: &Address,
        accounts: &[AccountView],
        data: &[u8],
    ) -> ProgramResult {
        if data.len() < 2 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let discriminant = u16::from_le_bytes([data[0], data[1]]);
        let instruction_data = &data[2..];

        match discriminant {
            // Protocol
            0 => { pinocchio_log::log!("ixn: initialize protocol"); processor::protocol::initialize::process(program_id, accounts, instruction_data) },
            1 => { pinocchio_log::log!("ixn: update config"); processor::protocol::update_config::process(program_id, accounts, instruction_data) },
            2 => { pinocchio_log::log!("ixn: pause"); processor::protocol::pause::process(program_id, accounts, instruction_data) },
            3 => { pinocchio_log::log!("ixn: unpause"); processor::protocol::unpause::process(program_id, accounts, instruction_data) },

            // Organization 
            10 => { pinocchio_log::log!("ixn: register org"); processor::organization::register::process(program_id, accounts, instruction_data) },
            11 => { pinocchio_log::log!("ixn: deregister org"); processor::organization::deregister::process(program_id, accounts, instruction_data) },
            12 => { pinocchio_log::log!("ixn: update org"); processor::organization::update_organization::process(program_id, accounts, instruction_data) },

            // Asset
            20 => { pinocchio_log::log!("ixn: initialize asset"); processor::asset::initialize::process(program_id, accounts, instruction_data) },
            21 => { pinocchio_log::log!("ixn: mint token"); processor::asset::mint_token::process(program_id, accounts, instruction_data) },
            22 => { pinocchio_log::log!("ixn: update collection metadata"); processor::asset::update_metadata::process(program_id, accounts, instruction_data) },

            // Fundraising
            30 => { pinocchio_log::log!("ixn: create round"); processor::fundraising::create_round::process(program_id, accounts, instruction_data) },
            31 => { pinocchio_log::log!("ixn: invest"); processor::fundraising::invest::process(program_id, accounts, instruction_data) },
            32 => { pinocchio_log::log!("ixn: finalize round"); processor::fundraising::finalize_round::process(program_id, accounts, instruction_data) },
            33 => { pinocchio_log::log!("ixn: mint round tokens"); processor::fundraising::mint_round_tokens::process(program_id, accounts, instruction_data) },
            34 => { pinocchio_log::log!("ixn: refund investment"); processor::fundraising::refund_investment::process(program_id, accounts, instruction_data) },
            35 => { pinocchio_log::log!("ixn: cancel round"); processor::fundraising::cancel_round::process(program_id, accounts, instruction_data) },

            // Secondary Market
            40 => { pinocchio_log::log!("ixn: list for sale"); processor::market::list_for_sale::process(program_id, accounts, instruction_data) },
            41 => { pinocchio_log::log!("ixn: delist"); processor::market::delist::process(program_id, accounts, instruction_data) },
            42 => { pinocchio_log::log!("ixn: buy listed token"); processor::market::buy_listed_token::process(program_id, accounts, instruction_data) },
            43 => { pinocchio_log::log!("ixn: make offer"); processor::market::make_offer::process(program_id, accounts, instruction_data) },
            44 => { pinocchio_log::log!("ixn: accept offer"); processor::market::accept_offer::process(program_id, accounts, instruction_data) },
            45 => { pinocchio_log::log!("ixn: reject offer"); processor::market::reject_offer::process(program_id, accounts, instruction_data) },
            46 => { pinocchio_log::log!("ixn: cancel offer"); processor::market::cancel_offer::process(program_id, accounts, instruction_data) },
            47 => { pinocchio_log::log!("ixn: consolidate tokens"); processor::market::consolidate_tokens::process(program_id, accounts, instruction_data) },
            48 => { pinocchio_log::log!("ixn: transfer token"); processor::market::transfer_token::process(program_id, accounts, instruction_data) },

            // Distribution
            50 => { pinocchio_log::log!("ixn: create distribution"); processor::distribution::create_distribution::process(program_id, accounts, instruction_data) },
            51 => { pinocchio_log::log!("ixn: claim distribution"); processor::distribution::claim_distribution::process(program_id, accounts, instruction_data) },
            52 => { pinocchio_log::log!("ixn: close distribution"); processor::distribution::close_distribution::process(program_id, accounts, instruction_data) },

            // Emergency Recovery
            60 => { pinocchio_log::log!("ixn: burn and remint"); processor::emergency::burn_and_remint::process(program_id, accounts, instruction_data) },
            61 => { pinocchio_log::log!("ixn: split and remint"); processor::emergency::split_and_remint::process(program_id, accounts, instruction_data) },

            // Governance
            70 => { pinocchio_log::log!("ixn: create registrar"); processor::governance::create_registrar::process(program_id, accounts, instruction_data) },
            71 => { pinocchio_log::log!("ixn: create voter weight record"); processor::governance::create_voter_weight_record::process(program_id, accounts, instruction_data) },
            72 => { pinocchio_log::log!("ixn: create max voter weight record"); processor::governance::create_max_voter_weight_record::process(program_id, accounts, instruction_data) },
            73 => { pinocchio_log::log!("ixn: update voter weight record"); processor::governance::update_voter_weight_record::process(program_id, accounts, instruction_data) },
            74 => { pinocchio_log::log!("ixn: relinquish voter weight"); processor::governance::relinquish_voter_weight::process(program_id, accounts, instruction_data) },
            75 => { pinocchio_log::log!("ixn: create protocol realm"); processor::governance::create_protocol_realm::process(program_id, accounts, instruction_data) },
            76 => { pinocchio_log::log!("ixn: create org realm"); processor::governance::create_org_realm::process(program_id, accounts, instruction_data) },
            77 => { pinocchio_log::log!("ixn: create asset governance"); processor::governance::create_asset_governance::process(program_id, accounts, instruction_data) },

            // Buyout
            85 => { pinocchio_log::log!("ixn: create buyout offer"); processor::buyout::create_buyout_offer::process(program_id, accounts, instruction_data) },
            86 => { pinocchio_log::log!("ixn: fund buyout offer"); processor::buyout::fund_buyout_offer::process(program_id, accounts, instruction_data) },
            87 => { pinocchio_log::log!("ixn: approve buyout"); processor::buyout::approve_buyout::process(program_id, accounts, instruction_data) },
            88 => { pinocchio_log::log!("ixn: settle buyout"); processor::buyout::settle_buyout::process(program_id, accounts, instruction_data) },
            89 => { pinocchio_log::log!("ixn: complete buyout"); processor::buyout::complete_buyout::process(program_id, accounts, instruction_data) },
            90 => { pinocchio_log::log!("ixn: cancel buyout"); processor::buyout::cancel_buyout::process(program_id, accounts, instruction_data) },

            _ => { pinocchio_log::log!("ixn: unknown discriminant"); Err(ProgramError::InvalidInstructionData) },
        }
    }
}
