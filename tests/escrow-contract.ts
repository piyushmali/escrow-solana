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

  const program = anchor.workspace.Escrow as Program<Escrow>;
  const payer = provider.wallet as anchor.Wallet;

  let mint: PublicKey;
  let initializerTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let escrowAccount: PublicKey;
  let vault: PublicKey;
  let bump: number;
  let escrowSeed = new anchor.BN(Date.now());
  const amount = new anchor.BN(1000);

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
        payer.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      payer.payer,
      mint,
      initializerTokenAccount,
      payer.publicKey,
      amount.toNumber()
    );

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
    await program.methods
      .initialize(escrowSeed, amount)
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount,
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

  it("Fails to withdraw without initializing", async () => {
    try {
      await program.methods.withdraw().rpc();
      assert.fail("Withdraw should fail without initialization");
    } catch (err) {
      assert.ok(err, "Transaction should fail");
    }
  });

  it("Fails to cancel without initializing", async () => {
    try {
      await program.methods.cancel().rpc();
      assert.fail("Cancel should fail without initialization");
    } catch (err) {
      assert.ok(err, "Transaction should fail");
    }
  });

  it("Withdraws from escrow", async () => {
    await program.methods
      .withdraw()
      .accounts({
        recipient: payer.publicKey,
        recipientTokenAccount: recipientTokenAccount,
        escrowAccount: escrowAccount,
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

  it("Fails unauthorized withdrawal", async () => {
    try {
      const fakeUser = anchor.web3.Keypair.generate();
      await program.methods
        .withdraw()
        .signers([fakeUser])
        .rpc();
      assert.fail("Unauthorized withdraw should fail");
    } catch (err) {
      assert.ok(err, "Transaction should fail");
    }
  });

  it("Cancels the escrow", async () => {
    await program.methods
      .cancel()
      .accounts({
        initializer: payer.publicKey,
        initializerDepositTokenAccount: initializerTokenAccount,
        escrowAccount: escrowAccount,
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

  it("Fails unauthorized cancel", async () => {
    try {
      const fakeUser = anchor.web3.Keypair.generate();
      await program.methods
        .cancel()
        .signers([fakeUser])
        .rpc();
      assert.fail("Unauthorized cancel should fail");
    } catch (err) {
      assert.ok(err, "Transaction should fail");
    }
  });
});
