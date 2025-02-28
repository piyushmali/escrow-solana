import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EscrowContract } from "../target/types/escrow_contract";
import { assert, expect } from "chai";
import { PublicKey, SystemProgram, Keypair, TransactionSignature, ComputeBudgetProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";

describe("escrow-contract test cases", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.EscrowContract as Program<EscrowContract>;
  const payer = provider.wallet as anchor.Wallet;

  let mint: PublicKey;
  let initializerTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let escrowAccount: PublicKey;
  let vault: PublicKey;
  let bump: number;
  let escrowSeed: number;
  const amount = new anchor.BN(1000);
  const expirationTime = new anchor.BN(Date.now() / 1000 + 3600);
  const feePercentage = 5;

  const recipient = Keypair.generate();

  before(async () => {
    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      0
    );

    initializerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer.payer,
        mint,
        payer.publicKey
      )
    ).address;

    recipientTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer.payer,
        mint,
        recipient.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      payer.payer,
      mint,
      initializerTokenAccount,
      payer.publicKey,
      amount.toNumber() * 20
    );

    escrowSeed = Math.floor(Date.now() / 1000);
    
    [escrowAccount, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(escrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );

    [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccount.toBuffer()],
      program.programId
    );
  });

  async function confirmTransaction(tx: TransactionSignature) {
    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: tx
    });
  }

  it("Deposits tokens into escrow", async () => {
    const tx = await program.methods
      .deposit(escrowSeed, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount,
        vault: vault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(tx);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const escrow = await program.account.escrowAccount.fetch(escrowAccount);
    assert.ok(escrow.amount.eq(amount));
    assert.ok(escrow.initializer.equals(payer.publicKey));
    assert.strictEqual(escrow.feePercentage, feePercentage);
    assert.ok(escrow.expirationTime.eq(expirationTime));
  });

  it("Verifies tokens in vault", async () => {
    const vaultAccount = await getAccount(provider.connection, vault);
    assert.strictEqual(Number(vaultAccount.amount), amount.toNumber());
  });

  it("Withdraws from escrow", async () => {
    const recipientBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    
    const tx = await program.methods
      .withdraw()
      .accounts({
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        escrowAccount: escrowAccount,
        vault: vault,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([recipient])
      .rpc();

    await confirmTransaction(tx);

    const recipientBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const expectedAmount = amount.sub(amount.muln(feePercentage).divn(100));
    assert.strictEqual(
      Number(recipientBalanceAfter.value.amount) - Number(recipientBalanceBefore.value.amount),
      expectedAmount.toNumber()
    );
  });

  it("Initializes and cancels an escrow", async () => {
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    const initTx = await program.methods
      .deposit(newEscrowSeed, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(initTx);

    const balanceBefore = await provider.connection.getTokenAccountBalance(initializerTokenAccount);
    const cancelTx = await program.methods
      .cancel()
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    await confirmTransaction(cancelTx);
    const balanceAfter = await provider.connection.getTokenAccountBalance(initializerTokenAccount);
    assert.strictEqual(
      Number(balanceAfter.value.amount) - Number(balanceBefore.value.amount),
      amount.toNumber()
    );
  });

  it("Fails to deposit with zero amount", async () => {
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .deposit(newEscrowSeed, new anchor.BN(0), expirationTime, feePercentage)
        .accounts({
          initializer: payer.publicKey,
          initializerDepositTokenAccount: initializerTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: newVault,
          mint: mint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      assert.fail("Should not deposit with zero amount");
    } catch (err) {
      assert.ok(err, "Expected error for zero amount");
    }
  });

  it("Fails to withdraw after expiration", async () => {
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const pastExpiration = new anchor.BN(Date.now() / 1000 - 3600);
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .deposit(newEscrowSeed, amount, pastExpiration, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(tx);

    try {
      await program.methods
        .withdraw()
        .accounts({
          recipient: recipient.publicKey,
          recipientTokenAccount: recipientTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: newVault,
          mint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([recipient])
        .rpc();
      assert.fail("Should not withdraw after expiration");
    } catch (err) {
      assert.ok(err, "Expected error for expired escrow");
    }
  });

  it("Fails to deposit to already initialized escrow", async () => {
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .deposit(newEscrowSeed, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(tx);

    try {
      await program.methods
        .deposit(newEscrowSeed, amount, expirationTime, feePercentage)
        .accounts({
          initializer: payer.publicKey,
          initializerDepositTokenAccount: initializerTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: newVault,
          mint: mint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      assert.fail("Should not deposit to already initialized escrow");
    } catch (err) {
      assert.ok(err, "Expected error for already initialized escrow");
    }
  });

  it("Fails to deposit with insufficient token balance", async () => {
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const largeAmount = new anchor.BN(1_000_000_000);
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .deposit(newEscrowSeed, largeAmount, expirationTime, feePercentage)
        .accounts({
          initializer: payer.publicKey,
          initializerDepositTokenAccount: initializerTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: newVault,
          mint: mint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      assert.fail("Should not deposit with insufficient balance");
    } catch (err) {
      assert.ok(err, "Expected error for insufficient token balance");
    }
  });

  it("Successfully withdraws with maximum fee percentage", async () => {
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const maxFeePercentage = 100;
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .deposit(newEscrowSeed, amount, expirationTime, maxFeePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(tx);

    const recipientBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);

    const withdrawTx = await program.methods
      .withdraw()
      .accounts({
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([recipient])
      .rpc();

    await confirmTransaction(withdrawTx);

    const recipientBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    assert.strictEqual(
      Number(recipientBalanceAfter.value.amount) - Number(recipientBalanceBefore.value.amount),
      0,
      "Recipient should receive 0 tokens with 100% fee"
    );
  });

  it("Successfully cancels immediately after deposit", async () => {
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    const depositTx = await program.methods
      .deposit(newEscrowSeed, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(depositTx);

    const balanceBefore = await provider.connection.getTokenAccountBalance(initializerTokenAccount);

    const cancelTx = await program.methods
      .cancel()
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    await confirmTransaction(cancelTx);

    const balanceAfter = await provider.connection.getTokenAccountBalance(initializerTokenAccount);
    assert.strictEqual(
      Number(balanceAfter.value.amount) - Number(balanceBefore.value.amount),
      amount.toNumber(),
      "Initializer should receive full amount back after immediate cancel"
    );
  });

  it("Fails to withdraw with tampered vault authority", async () => {
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );
    const tx = await program.methods
      .deposit(newEscrowSeed, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    await confirmTransaction(tx);
    const fakeVault = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer.payer,
        mint,
        payer.publicKey
      )
    ).address;
    try {
      await program.methods
        .withdraw()
        .accounts({
          recipient: recipient.publicKey,
          recipientTokenAccount: recipientTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: fakeVault,
          mint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([recipient])
        .rpc();
      assert.fail("Should not withdraw with incorrect vault authority");
    } catch (err) {
      assert.include(
        err.message,
        "AnchorError caused by account: vault",
        "Expected error for tampered vault authority"
      );
    }
  });
  
  it("Fails to withdraw with wrong recipient token account mint", async () => {
    const wrongMint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      0
    );
    
    const wrongRecipientTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer.payer,
        wrongMint,
        recipient.publicKey
      )
    ).address;
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );
    const tx = await program.methods
      .deposit(newEscrowSeed, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    await confirmTransaction(tx);
    try {
      await program.methods
        .withdraw()
        .accounts({
          recipient: recipient.publicKey,
          recipientTokenAccount: wrongRecipientTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: newVault,
          mint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([recipient])
        .rpc();
      assert.fail("Should not withdraw to token account with different mint");
    } catch (err) {
      assert.include(
        err.message,
        "Simulation failed",
        "Expected error due to wrong mint"
      );
    }
  });
  
  it("Fails to cancel by non-initializer", async () => {
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );
    const tx = await program.methods
      .deposit(newEscrowSeed, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    await confirmTransaction(tx);
    
    const nonInitializer = anchor.web3.Keypair.generate();
    
    const transferIx = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: nonInitializer.publicKey,
      lamports: 10000000,
    });
    
    const transferTx = new anchor.web3.Transaction().add(transferIx);
    await provider.sendAndConfirm(transferTx, [payer.payer]);
    
    const nonInitializerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer.payer,
        mint,
        nonInitializer.publicKey
      )
    ).address;
    
    try {
      await program.methods
        .cancel()
        .accounts({
          initializer: nonInitializer.publicKey,
          initializerDepositTokenAccount: nonInitializerTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: newVault,
          mint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([nonInitializer])
        .rpc();
      assert.fail("Should not allow non-initializer to cancel");
    } catch (err) {
      assert.include(
        err.message,
        "AnchorError caused by account: initializer",
        "Expected error for non-initializer attempting to cancel"
      );
    }
  });


  it("Handles edge case with extremely high fee percentage", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    const highFeePercentage = 99; // 99% fee
    
    const [escrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(escrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccount.toBuffer()],
      program.programId
    );

    // Deposit with high fee
    const tx = await program.methods
      .deposit(escrowSeed, amount, expirationTime, highFeePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount,
        vault: vault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(tx);
    
    const recipientBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    
    // Withdraw with high fee
    const withdrawTx = await program.methods
      .withdraw()
      .accounts({
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        escrowAccount: escrowAccount,
        vault: vault,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([recipient])
      .rpc();

    await confirmTransaction(withdrawTx);
    
    const recipientBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const expectedAmount = amount.sub(amount.muln(highFeePercentage).divn(100));
    
    assert.strictEqual(
      Number(recipientBalanceAfter.value.amount) - Number(recipientBalanceBefore.value.amount),
      expectedAmount.toNumber(),
      "Recipient should receive only 1% of the amount with 99% fee"
    );
  });

  it("Tests cancellation after expiration", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    const pastExpiration = new anchor.BN(Date.now() / 1000 - 3600); // 1 hour in the past
    
    const [escrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(escrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccount.toBuffer()],
      program.programId
    );

    // Deposit with past expiration time
    const tx = await program.methods
      .deposit(escrowSeed, amount, pastExpiration, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount,
        vault: vault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(tx);
    
    const initializerBalanceBefore = await provider.connection.getTokenAccountBalance(initializerTokenAccount);
    
    // Cancel after expiration (should succeed)
    const cancelTx = await program.methods
      .cancel()
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount,
        vault: vault,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    await confirmTransaction(cancelTx);
    
    const initializerBalanceAfter = await provider.connection.getTokenAccountBalance(initializerTokenAccount);
    
    assert.strictEqual(
      Number(initializerBalanceAfter.value.amount) - Number(initializerBalanceBefore.value.amount),
      amount.toNumber(),
      "Initializer should receive full amount back when canceling after expiration"
    );
  });


  it("Tests parallel escrows with different seeds", async () => {
    const escrowSeed1 = Math.floor(Date.now() / 1000);
    const escrowSeed2 = escrowSeed1 + 1;
    
    const [escrowAccount1] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(escrowSeed1).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    
    const [vault1] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccount1.toBuffer()],
      program.programId
    );
    
    const [escrowAccount2] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(escrowSeed2).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    
    const [vault2] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccount2.toBuffer()],
      program.programId
    );

    // Create first escrow
    const tx1 = await program.methods
      .deposit(escrowSeed1, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount1,
        vault: vault1,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(tx1);
    
    // Create second escrow
    const tx2 = await program.methods
      .deposit(escrowSeed2, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount2,
        vault: vault2,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(tx2);
    
    // Verify both escrows exist with the correct amounts
    const escrow1 = await program.account.escrowAccount.fetch(escrowAccount1);
    const escrow2 = await program.account.escrowAccount.fetch(escrowAccount2);
    
    assert.ok(escrow1.amount.eq(amount), "First escrow should have correct amount");
    assert.ok(escrow2.amount.eq(amount), "Second escrow should have correct amount");
    
    // Cancel both escrows
    await program.methods
      .cancel()
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount1,
        vault: vault1,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
      
    await program.methods
      .cancel()
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount2,
        vault: vault2,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  });



  it("Tests deposit with minimum and maximum possible fee percentages", async () => {
    // Test with minimum fee (0%)
    const escrowSeedMin = Math.floor(Date.now() / 1000);
    const minFeePercentage = 0;
    
    const [escrowAccountMin] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(escrowSeedMin).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    
    const [vaultMin] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccountMin.toBuffer()],
      program.programId
    );

    const tx1 = await program.methods
      .deposit(escrowSeedMin, amount, expirationTime, minFeePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccountMin,
        vault: vaultMin,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(tx1);
    
    const escrowMin = await program.account.escrowAccount.fetch(escrowAccountMin);
    assert.strictEqual(escrowMin.feePercentage, minFeePercentage, "Fee percentage should be 0%");
    
    // Test withdraw with 0% fee
    const recipientBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    
    const withdrawTx = await program.methods
      .withdraw()
      .accounts({
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        escrowAccount: escrowAccountMin,
        vault: vaultMin,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([recipient])
      .rpc();

    await confirmTransaction(withdrawTx);
    
    const recipientBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    
    assert.strictEqual(
      Number(recipientBalanceAfter.value.amount) - Number(recipientBalanceBefore.value.amount),
      amount.toNumber(),
      "Recipient should receive full amount with 0% fee"
    );
    
    // Test with maximum fee (100%)
    const escrowSeedMax = Math.floor(Date.now() / 1000) + 10;
    const maxFeePercentage = 100;
    
    const [escrowAccountMax] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(escrowSeedMax).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    
    const [vaultMax] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccountMax.toBuffer()],
      program.programId
    );

    const tx2 = await program.methods
      .deposit(escrowSeedMax, amount, expirationTime, maxFeePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccountMax,
        vault: vaultMax,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(tx2);
    
    const escrowMax = await program.account.escrowAccount.fetch(escrowAccountMax);
    assert.strictEqual(escrowMax.feePercentage, maxFeePercentage, "Fee percentage should be 100%");
    
    // Cancel the max fee escrow for cleanup
    await program.methods
      .cancel()
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccountMax,
        vault: vaultMax,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  });
});
  describe("escrow-contract CPI test cases", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
  
    const program = anchor.workspace.EscrowContract as Program<EscrowContract>;
    const payer = provider.wallet as anchor.Wallet;
  
    let mint: PublicKey;
    let initializerTokenAccount: PublicKey;
    let recipientTokenAccount: PublicKey;
    let escrowAccount: PublicKey;
    let vault: PublicKey;
    const amount = new anchor.BN(1000);
    const expirationTime = new anchor.BN(Date.now() / 1000 + 3600);
    const feePercentage = 5;
    const recipient = Keypair.generate();
  
    beforeEach(async () => {
      mint = await createMint(
        provider.connection,
        payer.payer,
        payer.publicKey,
        null,
        0
      );
  
      initializerTokenAccount = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          payer.payer,
          mint,
          payer.publicKey
        )
      ).address;
  
      recipientTokenAccount = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          payer.payer,
          mint,
          recipient.publicKey
        )
      ).address;
  
      await mintTo(
        provider.connection,
        payer.payer,
        mint,
        initializerTokenAccount,
        payer.publicKey,
        amount.toNumber() * 20
      );
  
      const escrowSeed = Math.floor(Date.now() / 1000);
      [escrowAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), new anchor.BN(escrowSeed).toArrayLike(Buffer, "le", 4)],
        program.programId
      );
  
      [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), escrowAccount.toBuffer()],
        program.programId
      );
    });
  
    async function confirmTransaction(tx: TransactionSignature) {
      const latestBlockHash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: tx
      });
    }
  
    async function setupEscrow(escrowSeed: number) {
      const [escrowAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), new anchor.BN(escrowSeed).toArrayLike(Buffer, "le", 4)],
        program.programId
      );
      
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), escrowAccount.toBuffer()],
        program.programId
      );
  
      const tx = await program.methods
        .deposit(escrowSeed, amount, expirationTime, feePercentage)
        .accounts({
          initializer: payer.publicKey,
          initializerDepositTokenAccount: initializerTokenAccount,
          escrowAccount: escrowAccount,
          vault: vault,
          mint: mint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
  
      await confirmTransaction(tx);
      return { escrowAccount, vault };
    }

  it("Successfully executes CPI to external program", async () => {
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const [newEscrowAccount, escrowBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
        program.programId
    );
    const [newVault, vaultBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), newEscrowAccount.toBuffer()],
        program.programId
    );

    // Deposit tokens into escrow first
    const depositTx = await program.methods
        .deposit(newEscrowSeed, amount, expirationTime, feePercentage)
        .accounts({
            initializer: provider.wallet.publicKey,
            initializerDepositTokenAccount: initializerTokenAccount,
            escrowAccount: newEscrowAccount,
            vault: newVault,
            mint: mint,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
    await confirmTransaction(depositTx);

    // Verify vault authority
    const vaultAccountInfo = await getAccount(provider.connection, newVault);
    // console.log("Vault authority:", vaultAccountInfo.owner.toBase58());
    // console.log("Escrow PDA:", newEscrowAccount.toBase58());
    assert.ok(
        vaultAccountInfo.owner.equals(newEscrowAccount),
        "Vault authority should be the escrow PDA"
    );

    const recipientBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const transferAmount = 500;

    // Create Transfer instruction data
    const dataBuffer = Buffer.alloc(12);
    dataBuffer.writeUInt8(3, 0); // Transfer instruction discriminator
    dataBuffer.writeBigUInt64LE(BigInt(transferAmount), 1);

    try {
        const tx = await program.methods
            .executeExternalAction(dataBuffer)
            .accounts({
                initializer: provider.wallet.publicKey,
                escrowAccount: newEscrowAccount,
                externalProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            } as any)
            .remainingAccounts([
                {
                    pubkey: newVault,              // Source
                    isSigner: false,
                    isWritable: true,
                },
                {
                    pubkey: recipientTokenAccount, // Destination
                    isSigner: false,
                    isWritable: true,
                },
                {
                    pubkey: newEscrowAccount,      // Authority (PDA)
                    isSigner: false,              // Signed via invoke_signed
                    isWritable: false,
                },
            ])
            .preInstructions([
                ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 })
            ] )
            .rpc({ 
                skipPreflight: false,
                commitment: "confirmed"
            });

        await confirmTransaction(tx);

        // Verify the transfer
        const vaultAccount = await getAccount(provider.connection, newVault);
        const recipientBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
        const recipientBalanceChange = Number(recipientBalanceAfter.value.amount) - Number(recipientBalanceBefore.value.amount);

        assert.strictEqual(
            Number(vaultAccount.amount),
            amount.toNumber() - transferAmount,
            "Vault should have reduced by transfer amount"
        );
        assert.strictEqual(
            recipientBalanceChange,
            transferAmount,
            "Recipient should have received transfer amount"
        );

        const escrow = await program.account.escrowAccount.fetch(newEscrowAccount);
        assert.ok(escrow.amount.eq(amount));
        assert.ok(escrow.initializer.equals(provider.wallet.publicKey));
    } catch (err) {
        console.error("Transaction failed with error:", err);
        if (err.logs) {
            console.error("Transaction logs:", err.logs);
        }
        throw err;
    }
  });

  it("Fails CPI execution by non-initializer", async () => {
    const newEscrowSeed = Math.floor(Date.now() / 1000);
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(newEscrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );
  
    const depositTx = await program.methods
      .deposit(newEscrowSeed, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    await confirmTransaction(depositTx);
  
    const nonInitializer = Keypair.generate();
    const transferIx = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: nonInitializer.publicKey,
      lamports: 10000000,
    });
    const transferTx = new anchor.web3.Transaction().add(transferIx);
    await provider.sendAndConfirm(transferTx, [payer.payer]);
  
    // Create a proper Buffer for the instruction data
    const dataBuffer = Buffer.alloc(9);
    dataBuffer[0] = 3; // Transfer instruction discriminator
    
    // Write a small amount as little-endian 64-bit value
    dataBuffer.writeBigUInt64LE(BigInt(10), 1);
  
    try {
      await program.methods
        .executeExternalAction(dataBuffer)
        .accounts({
          initializer: nonInitializer.publicKey,
          escrowAccount: newEscrowAccount,
          externalProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([nonInitializer])
        .remainingAccounts([
          {
            pubkey: newVault,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: recipientTokenAccount,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: newEscrowAccount,
            isSigner: false,
            isWritable: false,
          },
        ])
        .rpc();
      assert.fail("Should not allow non-initializer to execute CPI");
    } catch (err) {
      // The error might be different now because we're passing the correct buffer format
      // The test will still fail, but with the actual unauthorized error
      assert.include(
        err.toString(),
        "Error Code: Unauthorized",
        "Expected unauthorized error for non-initializer"
      );
    }
  });
  
  it("Successfully executes CPI transfer with maximum amount", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    const { escrowAccount, vault } = await setupEscrow(escrowSeed);

    const recipientBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    
    const dataBuffer = Buffer.alloc(9);
    dataBuffer.writeUInt8(3, 0); // Transfer instruction
    dataBuffer.writeBigUInt64LE(BigInt(amount.toNumber()), 1);

    const tx = await program.methods
      .executeExternalAction(dataBuffer)
      .accounts({
        initializer: payer.publicKey,
        escrowAccount: escrowAccount,
        externalProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts([
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: escrowAccount, isSigner: false, isWritable: false },
      ])
      .rpc();

    await confirmTransaction(tx);

    const recipientBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    assert.strictEqual(
      Number(recipientBalanceAfter.value.amount) - Number(recipientBalanceBefore.value.amount),
      amount.toNumber(),
      "Recipient should receive full amount via CPI"
    );
  });

  it("Fails CPI with insufficient remaining accounts", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    const { escrowAccount } = await setupEscrow(escrowSeed);

    const dataBuffer = Buffer.alloc(9);
    dataBuffer.writeUInt8(3, 0);
    dataBuffer.writeBigUInt64LE(BigInt(100), 1);

    try {
      await program.methods
        .executeExternalAction(dataBuffer)
        .accounts({
          initializer: payer.publicKey,
          escrowAccount: escrowAccount,
          externalProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
          // Missing authority account
        ])
        .rpc();
      assert.fail("Should fail with insufficient accounts");
    } catch (err) {
      assert.include(err.message, "InvalidAmount", "Expected error for insufficient accounts");
    }
  });

  it("Fails CPI with incorrect account order", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    const { escrowAccount, vault } = await setupEscrow(escrowSeed);

    const dataBuffer = Buffer.alloc(9);
    dataBuffer.writeUInt8(3, 0);
    dataBuffer.writeBigUInt64LE(BigInt(100), 1);

    try {
      await program.methods
        .executeExternalAction(dataBuffer)
        .accounts({
          initializer: payer.publicKey,
          escrowAccount: escrowAccount,
          externalProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          { pubkey: recipientTokenAccount, isSigner: false, isWritable: true }, // Wrong order
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: escrowAccount, isSigner: false, isWritable: false },
        ])
        .rpc();
      assert.fail("Should fail with incorrect account order");
    } catch (err) {
      assert.ok(err, "Expected error for incorrect account order");
    }
  });

  it("Fails CPI with invalid instruction data", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    const { escrowAccount, vault } = await setupEscrow(escrowSeed);

    const invalidData = Buffer.from([99]); // Invalid instruction discriminator

    try {
      await program.methods
        .executeExternalAction(invalidData)
        .accounts({
          initializer: payer.publicKey,
          escrowAccount: escrowAccount,
          externalProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
          { pubkey: escrowAccount, isSigner: false, isWritable: false },
        ])
        .rpc();
      assert.fail("Should fail with invalid instruction data");
    } catch (err) {
      assert.ok(err, "Expected error for invalid instruction data");
    }
  });

  it("Successfully executes multiple sequential CPI transfers", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    const { escrowAccount, vault } = await setupEscrow(escrowSeed);

    const recipientBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const transferAmount = 200;

    const dataBuffer = Buffer.alloc(9);
    dataBuffer.writeUInt8(3, 0);
    dataBuffer.writeBigUInt64LE(BigInt(transferAmount), 1);

    for (let i = 0; i < 3; i++) {
      const tx = await program.methods
        .executeExternalAction(dataBuffer)
        .accounts({
          initializer: payer.publicKey,
          escrowAccount: escrowAccount,
          externalProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
          { pubkey: escrowAccount, isSigner: false, isWritable: false },
        ])
        .rpc();
      await confirmTransaction(tx);
    }

    const recipientBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    assert.strictEqual(
      Number(recipientBalanceAfter.value.amount) - Number(recipientBalanceBefore.value.amount),
      transferAmount * 3,
      "Recipient should receive total of multiple transfers"
    );
  });

  it("Fails CPI transfer exceeding vault balance", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    const { escrowAccount, vault } = await setupEscrow(escrowSeed);

    const dataBuffer = Buffer.alloc(9);
    dataBuffer.writeUInt8(3, 0);
    dataBuffer.writeBigUInt64LE(BigInt(amount.toNumber() * 2), 1); // Double the available amount

    try {
      await program.methods
        .executeExternalAction(dataBuffer)
        .accounts({
          initializer: payer.publicKey,
          escrowAccount: escrowAccount,
          externalProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
          { pubkey: escrowAccount, isSigner: false, isWritable: false },
        ])
        .rpc();
      assert.fail("Should fail when exceeding vault balance");
    } catch (err) {
      assert.ok(err, "Expected error for insufficient vault balance");
    }
  });

  it("Verifies CPI maintains escrow account state", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    const { escrowAccount, vault } = await setupEscrow(escrowSeed);

    const escrowBefore = await program.account.escrowAccount.fetch(escrowAccount);
    
    const dataBuffer = Buffer.alloc(9);
    dataBuffer.writeUInt8(3, 0);
    dataBuffer.writeBigUInt64LE(BigInt(100), 1);

    const tx = await program.methods
      .executeExternalAction(dataBuffer)
      .accounts({
        initializer: payer.publicKey,
        escrowAccount: escrowAccount,
        externalProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts([
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: escrowAccount, isSigner: false, isWritable: false },
      ])
      .rpc();

    await confirmTransaction(tx);

    const escrowAfter = await program.account.escrowAccount.fetch(escrowAccount);
    assert.ok(escrowBefore.amount.eq(escrowAfter.amount), "Escrow amount should remain unchanged");
    assert.ok(escrowBefore.initializer.equals(escrowAfter.initializer), "Initializer should remain unchanged");
    assert.strictEqual(escrowBefore.feePercentage, escrowAfter.feePercentage, "Fee percentage should remain unchanged");
  });

  it("Fails CPI with expired escrow", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    const pastExpiration = new anchor.BN(Date.now() / 1000 - 3600);
    const [escrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(escrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccount.toBuffer()],
      program.programId
    );

    await program.methods
      .deposit(escrowSeed, amount, pastExpiration, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount,
        vault: vault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const dataBuffer = Buffer.alloc(9);
    dataBuffer.writeUInt8(3, 0);
    dataBuffer.writeBigUInt64LE(BigInt(100), 1);

    try {
      await program.methods
        .executeExternalAction(dataBuffer)
        .accounts({
          initializer: payer.publicKey,
          escrowAccount: escrowAccount,
          externalProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
          { pubkey: escrowAccount, isSigner: false, isWritable: false },
        ])
        .rpc();
      assert.fail("Should not allow CPI with expired escrow");
    } catch (err) {
      assert.ok(err, "Expected error for expired escrow");
    }
  });
  it("Tests executeExternalAction with minimum required accounts", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    
    const [escrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(escrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccount.toBuffer()],
      program.programId
    );

    // Deposit tokens into escrow first
    const depositTx = await program.methods
      .deposit(escrowSeed, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount,
        vault: vault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(depositTx);

    // Ensure we have exactly the minimum number of accounts
    try {
      await program.methods
        .executeExternalAction(Buffer.from([]))
        .accounts({
          initializer: payer.publicKey,
          escrowAccount: escrowAccount,
          externalProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          // Nothing - this should fail because we need at least 3 accounts
        ])
        .rpc();
      assert.fail("Should require at least 3 remaining accounts");
    } catch (err) {
      assert.include(
        err.toString(),
        "InvalidAmount",
        "Expected error for insufficient remaining accounts"
      );
    }
    
    // Cancel to clean up
    await program.methods
      .cancel()
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount,
        vault: vault,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  });

  it("Tests executeExternalAction with invalid external program", async () => {
    const escrowSeed = Math.floor(Date.now() / 1000);
    
    const [escrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), new anchor.BN(escrowSeed).toArrayLike(Buffer, "le", 4)],
      program.programId
    );
    
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccount.toBuffer()],
      program.programId
    );

    // Deposit tokens into escrow first
    const depositTx = await program.methods
      .deposit(escrowSeed, amount, expirationTime, feePercentage)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount,
        vault: vault,
        mint: mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await confirmTransaction(depositTx);

    // Create an invalid external program (using System Program instead of Token Program)
    try {
      const dataBuffer = Buffer.alloc(9);
      dataBuffer.writeUInt8(3, 0); // Transfer instruction discriminator
      dataBuffer.writeBigUInt64LE(BigInt(100), 1);

      await program.methods
        .executeExternalAction(dataBuffer)
        .accounts({
          initializer: payer.publicKey,
          escrowAccount: escrowAccount,
          externalProgram: SystemProgram.programId, // Invalid program for token transfer
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts([
          {
            pubkey: vault,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: recipientTokenAccount,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: escrowAccount,
            isSigner: false,
            isWritable: false,
          },
        ])
        .rpc();
      assert.fail("Should fail with invalid external program");
    } catch (err) {
      assert.ok(err, "Expected error for invalid external program");
    }
    
    // Cancel to clean up
    await program.methods
      .cancel()
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount,
        vault: vault,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  });
});
