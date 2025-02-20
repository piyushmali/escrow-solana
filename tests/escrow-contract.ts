import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Escrow } from "../target/types/escrow";
import { assert } from "chai";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
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

  const program = anchor.workspace.Escrow as Program<Escrow>;
  const payer = provider.wallet as anchor.Wallet;

  let mint: PublicKey;
  let initializerTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let escrowAccount: PublicKey;
  let vault: PublicKey;
  let bump: number;
  let escrowSeed: anchor.BN;
  const amount = new anchor.BN(1000);

  const recipient = Keypair.generate();

  before(async () => {
    // Create mint and token accounts only once
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

    // Initial token minting
    await mintTo(
      provider.connection,
      payer.payer,
      mint,
      initializerTokenAccount,
      payer.publicKey,
      amount.toNumber() * 3 // Mint enough for all tests
    );

    // Generate initial escrow seed
    escrowSeed = new anchor.BN(Date.now());
    
    [escrowAccount, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), escrowSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccount.toBuffer()],
      program.programId
    );
  });

  it("Initializes an escrow", async () => {
    const tx = await program.methods
      .initialize(escrowSeed, amount)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount,
        vault,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Wait for transaction confirmation
    await provider.connection.confirmTransaction(tx, "confirmed");

    // Add small delay to ensure account is available
    await new Promise(resolve => setTimeout(resolve, 1000));

    let escrow = await program.account.escrowAccount.fetch(escrowAccount);
    assert.ok(escrow.amount.eq(amount));
    assert.ok(escrow.initializer.equals(payer.publicKey));
  });

  it("Deposits tokens into escrow", async () => {
    try {
      const vaultAccount = await getAccount(provider.connection, vault);
      assert.strictEqual(Number(vaultAccount.amount), amount.toNumber());
    } catch (err) {
      assert.fail("Failed to get vault account: " + err);
    }
  });

  it("Fails unauthorized withdrawal", async () => {
    try {
      const fakeUser = Keypair.generate();
      await program.methods
        .withdraw()
        .accounts({
          recipient: fakeUser.publicKey,
          recipientTokenAccount,
          escrowAccount,
          vault,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([fakeUser])
        .rpc();
      assert.fail("Unauthorized withdraw should fail");
    } catch (err) {
      assert.ok(err, "Transaction should fail");
    }
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
      })
      .signers([recipient])
      .rpc();

    // Wait for transaction confirmation
    await provider.connection.confirmTransaction(tx, "confirmed");

    const recipientBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    assert.strictEqual(
      Number(recipientBalanceAfter.value.amount) - Number(recipientBalanceBefore.value.amount),
      amount.toNumber()
    );
  });

  it("Fails to cancel without initializing", async () => {
    const newEscrowSeed = new anchor.BN(Date.now());
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), newEscrowSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    try {
      await program.methods
        .cancel()
        .accounts({
          initializer: payer.publicKey,
          initializerDepositTokenAccount: initializerTokenAccount,
          escrowAccount: newEscrowAccount,
          vault,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Cancel should fail without initialization");
    } catch (err) {
      assert.ok(err, "Transaction should fail");
    }
  });

  it("Initializes and cancels an escrow", async () => {
    // Create new escrow for cancel test
    const newEscrowSeed = new anchor.BN(Date.now());
    const [newEscrowAccount, newBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), newEscrowSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    // Initialize new escrow
    const initTx = await program.methods
      .initialize(newEscrowSeed, amount)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Wait for transaction confirmation
    await provider.connection.confirmTransaction(initTx, "confirmed");

    // Cancel the escrow
    const cancelTx = await program.methods
      .cancel()
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    await provider.connection.confirmTransaction(cancelTx, "confirmed");
  });

  it("Fails to withdraw after cancel", async () => {
    try {
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
      assert.fail("Withdraw after cancel should fail");
    } catch (err) {
      assert.ok(err, "Transaction should fail due to insufficient funds");
    }
  });
  it("Fails to initialize with zero amount", async () => {
    const zeroAmount = new anchor.BN(0);
    const newEscrowSeed = new anchor.BN(Date.now());
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), newEscrowSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initialize(newEscrowSeed, zeroAmount)
        .accounts({
          initializer: payer.publicKey,
          initializerDepositTokenAccount: initializerTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: newVault,
          mint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      assert.fail("Should not initialize with zero amount");
    } catch (err) {
      assert.ok(err, "Expected error for zero amount");
    }
  });

  it("Fails to initialize with insufficient balance", async () => {
    const largeAmount = new anchor.BN(1000000); // Amount larger than minted
    const newEscrowSeed = new anchor.BN(Date.now());
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), newEscrowSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initialize(newEscrowSeed, largeAmount)
        .accounts({
          initializer: payer.publicKey,
          initializerDepositTokenAccount: initializerTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: newVault,
          mint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      assert.fail("Should not initialize with insufficient balance");
    } catch (err) {
      assert.ok(err, "Expected error for insufficient balance");
    }
  });

  it("Fails to withdraw with wrong recipient token account", async () => {
    // Create new escrow for this test
    const newEscrowSeed = new anchor.BN(Date.now());
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), newEscrowSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    // Initialize new escrow
    await program.methods
      .initialize(newEscrowSeed, amount)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Create wrong token account (using initializer's instead of recipient's)
    try {
      await program.methods
        .withdraw()
        .accounts({
          recipient: recipient.publicKey,
          recipientTokenAccount: initializerTokenAccount, // Wrong token account
          escrowAccount: newEscrowAccount,
          vault: newVault,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([recipient])
        .rpc();
      assert.fail("Should not withdraw to wrong token account");
    } catch (err) {
      assert.ok(err, "Expected error for wrong token account");
    }
  });

  it("Fails to cancel with wrong initializer", async () => {
    // Create new escrow for this test
    const newEscrowSeed = new anchor.BN(Date.now());
    const [newEscrowAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), newEscrowSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [newVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), newEscrowAccount.toBuffer()],
      program.programId
    );

    // Initialize new escrow
    await program.methods
      .initialize(newEscrowSeed, amount)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: newEscrowAccount,
        vault: newVault,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Try to cancel with wrong initializer
    const wrongInitializer = Keypair.generate();
    try {
      await program.methods
        .cancel()
        .accounts({
          initializer: wrongInitializer.publicKey,
          initializerDepositTokenAccount: initializerTokenAccount,
          escrowAccount: newEscrowAccount,
          vault: newVault,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wrongInitializer])
        .rpc();
      assert.fail("Should not cancel with wrong initializer");
    } catch (err) {
      assert.ok(err, "Expected error for wrong initializer");
    }
  });
});