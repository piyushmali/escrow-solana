import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { EscrowContract } from '../target/types/escrow_contract';
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { assert } from 'chai';

describe('escrow-contract', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.EscrowContract as Program<EscrowContract>;
  const payer = anchor.web3.Keypair.generate();
  const initializer = anchor.web3.Keypair.generate();
  const recipient = anchor.web3.Keypair.generate();
  
  let mint: PublicKey;
  let initializerTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let escrowAccount: PublicKey;
  let vault: PublicKey;
  let escrowSeed = new anchor.BN(Math.floor(Math.random() * 100000));
  let depositAmount = new anchor.BN(100000000);
  
  before(async () => {
    // Airdrop SOL to payer
    const airdropSig = await provider.connection.requestAirdrop(
      payer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);
    
    // Transfer some SOL to initializer
    const tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: initializer.publicKey,
        lamports: anchor.web3.LAMPORTS_PER_SOL / 2,
      }),
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: anchor.web3.LAMPORTS_PER_SOL / 2,
      })
    );
    await provider.sendAndConfirm(tx, [payer]);
    
    // Create mint and token accounts
    mint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );
    
    initializerTokenAccount = await createAccount(
      provider.connection,
      initializer,
      mint,
      initializer.publicKey
    );
    
    recipientTokenAccount = await createAccount(
      provider.connection,
      recipient,
      mint,
      recipient.publicKey
    );
    
    // Mint tokens to initializer
    await mintTo(
      provider.connection,
      payer,
      mint,
      initializerTokenAccount,
      payer.publicKey,
      depositAmount.toNumber()
    );
    
    // Derive PDA addresses
    [escrowAccount] = await PublicKey.findProgramAddress(
      [Buffer.from("escrow"), escrowSeed.toArrayLike(Buffer, 'le', 8)],
      program.programId
    );
    
    [vault] = await PublicKey.findProgramAddress(
      [Buffer.from("vault"), escrowAccount.toBuffer()],
      program.programId
    );
  });

  it('Initialize escrow', async () => {
    await program.methods
      .initialize(escrowSeed, depositAmount)
      .accounts({
        initializer: initializer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount,
        vault,
        mint,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([initializer])
      .rpc();
      
    // Verify escrow state
    const escrowState = await program.account.escrowAccount.fetch(escrowAccount);
    assert.equal(escrowState.initializer.toString(), initializer.publicKey.toString());
    assert.equal(escrowState.amount.toString(), depositAmount.toString());
    
    // Verify tokens transferred
    const vaultAccount = await getAccount(provider.connection, vault);
    assert.equal(vaultAccount.amount.toString(), depositAmount.toString());
  });
  
  it('Withdraw from escrow', async () => {
    await program.methods
      .withdraw()
      .accounts({
        recipient: recipient.publicKey,
        recipientTokenAccount,
        escrowAccount,
        vault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([recipient])
      .rpc();
      
    // Verify tokens transferred
    const recipientAccount = await getAccount(provider.connection, recipientTokenAccount);
    assert.equal(recipientAccount.amount.toString(), depositAmount.toString());
  });
});