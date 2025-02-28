#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_lang::solana_program;

declare_id!("C5C2TF7sVJCqFN1vsQygtGLDSEFBLgbVxJs7o55VCg2N");

#[program]
pub mod escrow_contract {
    use super::*;

    pub fn deposit(
        ctx: Context<Deposit>,
        escrow_seed: u32,
        amount: u64,
        expiration_time: i64,
        fee_percentage: u8,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        
        let escrow_account = &mut ctx.accounts.escrow_account;
        require!(!escrow_account.is_initialized, EscrowError::AlreadyInitialized);
        
        let initializer = &ctx.accounts.initializer;
        let clock = Clock::get()?;

        escrow_account.initializer = initializer.key();
        escrow_account.initializer_deposit_token_account = ctx.accounts.initializer_deposit_token_account.key();
        escrow_account.amount = amount;
        escrow_account.escrow_seed = escrow_seed;
        escrow_account.bump = ctx.bumps.escrow_account;
        escrow_account.is_initialized = true;
        escrow_account.expiration_time = expiration_time;
        escrow_account.fee_percentage = fee_percentage;
        
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.initializer_deposit_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: initializer.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(DepositEvent {
            initializer: initializer.key(),
            amount,
            escrow_seed,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
    ) -> Result<()> {
        let escrow_account = &mut ctx.accounts.escrow_account;
        let clock = Clock::get()?;
        
        require!(
            clock.unix_timestamp <= escrow_account.expiration_time,
            EscrowError::EscrowExpired
        );

        let seeds = &[
            b"escrow".as_ref(),
            &escrow_account.escrow_seed.to_le_bytes(),
            &[escrow_account.bump],
        ];
        let signer = &[&seeds[..]];

        let fee_amount = (escrow_account.amount * escrow_account.fee_percentage as u64) / 100;
        let transfer_amount = escrow_account.amount.checked_sub(fee_amount)
            .ok_or(EscrowError::InsufficientFunds)?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.escrow_account.to_account_info(),
                },
                signer,
            ),
            transfer_amount,
        )?;

        emit!(WithdrawEvent {
            recipient: ctx.accounts.recipient.key(),
            amount: transfer_amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn cancel(
        ctx: Context<Cancel>,
    ) -> Result<()> {
        let escrow_account = &ctx.accounts.escrow_account;
        let seeds = &[
            b"escrow".as_ref(),
            &escrow_account.escrow_seed.to_le_bytes(),
            &[escrow_account.bump],
        ];
        let signer = &[&seeds[..]];
        let clock = Clock::get()?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.initializer_deposit_token_account.to_account_info(),
                    authority: ctx.accounts.escrow_account.to_account_info(),
                },
                signer,
            ),
            escrow_account.amount,
        )?;

        emit!(CancelEvent {
            initializer: ctx.accounts.initializer.key(),
            amount: escrow_account.amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    // New function that performs a CPI to another program
    pub fn execute_external_action(
        ctx: Context<ExternalAction>,
        data: Vec<u8>,
    ) -> Result<()> {
        let escrow_account = &ctx.accounts.escrow_account;
        
        // Verify that only the initializer can call this function
        require!(
            ctx.accounts.initializer.key() == escrow_account.initializer,
            EscrowError::Unauthorized
        );
        
        // Create the seeds for PDA signing
        let seeds = &[
            b"escrow".as_ref(),
            &escrow_account.escrow_seed.to_le_bytes(),
            &[escrow_account.bump],
        ];
        let signer = &[&seeds[..]];
    
        // Create the instruction to call the external program
        let instruction = solana_program::instruction::Instruction {
            program_id: ctx.accounts.external_program.key(),
            accounts: ctx.remaining_accounts.iter().map(|acc| {
                solana_program::instruction::AccountMeta {
                    pubkey: acc.key(),
                    is_signer: acc.is_signer,
                    is_writable: acc.is_writable,
                }
            }).collect(),
            data,
        };
    
        // Execute the CPI
        solana_program::program::invoke_signed(
            &instruction,
            &ctx.remaining_accounts,
            signer,
        )?;
    
        emit!(ExternalActionEvent {
            initializer: ctx.accounts.initializer.key(),
            external_program: ctx.accounts.external_program.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
    
        Ok(())
    }
}

#[account]
#[derive(Default)]
pub struct EscrowAccount {
    pub initializer: Pubkey,
    pub initializer_deposit_token_account: Pubkey,
    pub amount: u64,
    pub escrow_seed: u32,
    pub bump: u8,
    pub is_initialized: bool,
    pub expiration_time: i64,
    pub fee_percentage: u8,
}

// Define a constant for the account size
const ESCROW_ACCOUNT_SPACE: usize = 256;
    // 32 +  // initializer: Pubkey
    // 32 +  // initializer_deposit_token_account: Pubkey
    // 8 +   // amount: u64
    // 4 +   // escrow_seed: u32
    // 1 +   // bump: u8
    // 1 +   // is_initialized: bool
    // 8 +   // expiration_time: i64
    // 1;    // fee_percentage: u8
    // // Total: 95 bytes, but we'll use 128 for safety

#[derive(Accounts)]
#[instruction(escrow_seed: u32, amount: u64, expiration_time: i64, fee_percentage: u8)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,
    
    #[account(mut, constraint = initializer_deposit_token_account.owner == initializer.key())]
    pub initializer_deposit_token_account: Account<'info, TokenAccount>,
    
    #[account(
        init_if_needed,
        seeds = [b"escrow", escrow_seed.to_le_bytes().as_ref()],
        bump,
        payer = initializer,
        space = ESCROW_ACCOUNT_SPACE // Updated constant
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    
    #[account(
        init_if_needed,
        payer = initializer,
        seeds = [b"vault", escrow_account.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow_account,
    )]
    pub vault: Account<'info, TokenAccount>,
    
    pub mint: Account<'info, token::Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub recipient: Signer<'info>,
    #[account(mut, constraint = recipient_token_account.owner == recipient.key())]
    pub recipient_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"escrow", escrow_account.escrow_seed.to_le_bytes().as_ref()], bump = escrow_account.bump)]
    pub escrow_account: Account<'info, EscrowAccount>,
    #[account(mut, seeds = [b"vault", escrow_account.key().as_ref()], bump, token::mint = mint, token::authority = escrow_account)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, token::Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut, constraint = initializer.key() == escrow_account.initializer)]
    pub initializer: Signer<'info>,
    #[account(mut, constraint = initializer_deposit_token_account.key() == escrow_account.initializer_deposit_token_account && initializer_deposit_token_account.owner == initializer.key())]
    pub initializer_deposit_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"escrow", escrow_account.escrow_seed.to_le_bytes().as_ref()], bump = escrow_account.bump)]
    pub escrow_account: Account<'info, EscrowAccount>,
    #[account(mut, seeds = [b"vault", escrow_account.key().as_ref()], bump, token::mint = mint, token::authority = escrow_account)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, token::Mint>,
    pub token_program: Program<'info, Token>,
}

// New account struct for CPI to external program
#[derive(Accounts)]
pub struct ExternalAction<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,
    #[account(mut, seeds = [b"escrow", escrow_account.escrow_seed.to_le_bytes().as_ref()], bump = escrow_account.bump)]
    pub escrow_account: Account<'info, EscrowAccount>,
    /// CHECK: This is the external program we'll call via CPI
    pub external_program: UncheckedAccount<'info>,
    /// System program may be needed for some operations
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Escrow account already initialized")]
    AlreadyInitialized,
    #[msg("Escrow has expired")]
    EscrowExpired,
    #[msg("Insufficient funds after fee calculation")]
    InsufficientFunds,
    #[msg("Unauthorized operation")]
    Unauthorized,
}

#[event]
pub struct DepositEvent {
    pub initializer: Pubkey,
    pub amount: u64,
    pub escrow_seed: u32,
    pub timestamp: i64,
}

#[event]
pub struct WithdrawEvent {
    pub recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct CancelEvent {
    pub initializer: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

// New event for the external program action
#[event]
pub struct ExternalActionEvent {
    pub initializer: Pubkey,
    pub external_program: Pubkey,
    pub timestamp: i64,
}