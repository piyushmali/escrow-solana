import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Escrow } from "../target/types/escrow";
import { assert } from "chai";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

describe("escrow-contract", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.EscrowContract as Program<Escrow>;
  const payer = provider.wallet as anchor.Wallet;

  let mint: PublicKey;
  let initializerTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let escrowAccount: PublicKey; // PDA instead of Keypair
  let vault: PublicKey;
  let bump: number;
  let escrowSeed = new anchor.BN(Date.now()); // Unique escrow seed
  const amount = new anchor.BN(1000);

  before(async () => {
    // Create Mint
    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      0
    );

    // Create Token Accounts
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
        payer.publicKey
      )
    ).address;

    // Mint tokens to initializer
    await mintTo(
      provider.connection,
      payer.payer,
      mint,
      initializerTokenAccount,
      payer.publicKey,
      amount.toNumber()
    );

    // Compute Escrow Account PDA
    [escrowAccount, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), escrowSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Compute Vault PDA
    [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowAccount.toBuffer()],
      program.programId
    );
  });

  it("Initializes an escrow", async () => {
    await program.methods
      .initialize(escrowSeed, amount)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount, // Now correctly set as a PDA
        vault,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    let escrow = await program.account.escrowAccount.fetch(escrowAccount);
    assert.ok(escrow.amount.eq(amount));
    assert.ok(escrow.initializer.equals(payer.publicKey));
  });

  it("Withdraws from escrow", async () => {
    await program.methods
      .withdraw()
      .accounts({
        recipient: payer.publicKey,
        recipientTokenAccount,
        escrowAccount,
        vault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    let recipientBalance = (
      await provider.connection.getTokenAccountBalance(recipientTokenAccount)
    ).value.amount;
    assert.strictEqual(Number(recipientBalance), amount.toNumber());
  });

  it("Cancels the escrow", async () => {
    await program.methods
      .cancel()
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount,
        vault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    let initializerBalance = (
      await provider.connection.getTokenAccountBalance(initializerTokenAccount)
    ).value.amount;
    assert.strictEqual(Number(initializerBalance), amount.toNumber());
  });
});
