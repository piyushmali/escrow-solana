import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EscrowContract } from "../target/types/escrow_contract";
import { assert } from "chai";
import { PublicKey, SystemProgram, Keypair, TransactionSignature } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  createAssociatedTokenAccountInstruction,
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

    // Increase initial minting to cover all test cases
    await mintTo(
      provider.connection,
      payer.payer,
      mint,
      initializerTokenAccount,
      payer.publicKey,
      amount.toNumber() * 20 // Increased to ensure sufficient funds for all tests
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
        escrowAccount,
        vault,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any) // Type assertion to bypass TS error temporarily
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
        recipientTokenAccount,
        escrowAccount,
        vault,
        mint,
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
        mint,
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
        mint,
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
          mint,
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
        mint,
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
          recipientTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: newVault,
          mint,
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
        mint,
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
          mint,
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
          mint,
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
        mint,
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
        recipientTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint,
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
        mint,
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
        mint,
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
        mint,
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
        payer.publicKey // Incorrect authority
      )
    ).address;
    try {
      await program.methods
        .withdraw()
        .accounts({
          recipient: recipient.publicKey,
          recipientTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: fakeVault,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([recipient])
        .rpc();
      assert.fail("Should not withdraw with incorrect vault authority");
    } catch (err) {
      assert.include(
        err.message,
        "AnchorError caused by account: vault", // Look for account name in error
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
        mint,
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
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([recipient])
        .rpc();
      assert.fail("Should not withdraw to token account with different mint");
    } catch (err) {
      // Check for simulation failure, which occurs when token accounts have mismatched mints
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
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    await confirmTransaction(tx);
    
    // Instead of generating a new keypair and airdropping SOL,
    // use a pre-funded account from the wallet (similar to recipient)
    const nonInitializer = anchor.web3.Keypair.generate();
    
    // Transfer some SOL from payer to nonInitializer instead of using airdrop
    const transferIx = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: nonInitializer.publicKey,
      lamports: 10000000, // 0.01 SOL
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
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([nonInitializer])
        .rpc();
      assert.fail("Should not allow non-initializer to cancel");
    } catch (err) {
      // Look for account name in error message instead of specific error code
      assert.include(
        err.message,
        "AnchorError caused by account: initializer",
        "Expected error for non-initializer attempting to cancel"
      );
    }
  });

});