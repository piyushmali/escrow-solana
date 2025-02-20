use anchor_lang::prelude::*;

declare_id!("5FDbsL1XiZRc1MMkQxJFyDBaKM3oNw2HtKTTtEQ49KPk");

#[program]
pub mod escrow_contract {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
