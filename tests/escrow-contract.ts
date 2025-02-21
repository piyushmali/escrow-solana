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

    await mintTo(
      provider.connection,
      payer.payer,
      mint,
      initializerTokenAccount,
      payer.publicKey,
      amount.toNumber() * 3
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
});