#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("F9zSjL7BveRqKDwLcrpU9cdzzVjSAZhE4swHNzfNeDf7");

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
        escrow_account.bump = ctx.bumps.escrow_account; // Changed from get() to direct access
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
        space = 8 + std::mem::size_of::<EscrowAccount>()
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