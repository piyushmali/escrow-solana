use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("F9zSjL7BveRqKDwLcrpU9cdzzVjSAZhE4swHNzfNeDf7");

#[program]
pub mod escrow {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        escrow_seed: u64,
        amount: u64,
    ) -> Result<()> {
        let escrow_account = &mut ctx.accounts.escrow_account;
        let initializer = &ctx.accounts.initializer;

        escrow_account.initializer = initializer.key();
        escrow_account.initializer_deposit_token_account = ctx.accounts.initializer_deposit_token_account.key();
        escrow_account.amount = amount;
        escrow_account.escrow_seed = escrow_seed;
        escrow_account.bump = ctx.bumps.escrow_account;
        
        // Transfer tokens to the PDA
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

        Ok(())
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
    ) -> Result<()> {
        let escrow_account = &ctx.accounts.escrow_account;
        let seeds = &[
            b"escrow".as_ref(),
            &escrow_account.escrow_seed.to_le_bytes(),
            &[escrow_account.bump],
        ];
        let signer = &[&seeds[..]];

        // Transfer tokens from vault to recipient
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
            escrow_account.amount,
        )?;

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

        // Return tokens to initializer
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

        Ok(())
    }
}

#[account]
pub struct EscrowAccount {
    pub initializer: Pubkey,
    pub initializer_deposit_token_account: Pubkey,
    pub amount: u64,
    pub escrow_seed: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(escrow_seed: u64, amount: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,
    
    #[account(
        mut,
        constraint = initializer_deposit_token_account.owner == initializer.key()
    )]
    pub initializer_deposit_token_account: Account<'info, TokenAccount>,
    
    #[account(
        init,
        seeds = [b"escrow", escrow_seed.to_le_bytes().as_ref()],
        bump,
        payer = initializer,
        space = 8 + std::mem::size_of::<EscrowAccount>()
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    
    #[account(
        init,
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
    
    #[account(
        mut,
        constraint = recipient_token_account.owner == recipient.key()
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        seeds = [b"escrow", escrow_account.escrow_seed.to_le_bytes().as_ref()],
        bump = escrow_account.bump,
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    
    #[account(
        mut,
        seeds = [b"vault", escrow_account.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow_account,
    )]
    pub vault: Account<'info, TokenAccount>,
    
    pub mint: Account<'info, token::Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(
        mut,
        constraint = initializer.key() == escrow_account.initializer
    )]
    pub initializer: Signer<'info>,
    
    #[account(
        mut,
        constraint = initializer_deposit_token_account.key() == escrow_account.initializer_deposit_token_account,
        constraint = initializer_deposit_token_account.owner == initializer.key()
    )]
    pub initializer_deposit_token_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        seeds = [b"escrow", escrow_account.escrow_seed.to_le_bytes().as_ref()],
        bump = escrow_account.bump,
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    
    #[account(
        mut,
        seeds = [b"vault", escrow_account.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow_account,
    )]
    pub vault: Account<'info, TokenAccount>,
    
    pub mint: Account<'info, token::Mint>,
    pub token_program: Program<'info, Token>,
}