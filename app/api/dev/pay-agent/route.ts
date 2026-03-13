import { NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram
} from "@solana/web3.js";
import { PumpAgent } from "@pump-fun/agent-payments-sdk";
import bs58 from "bs58";
import { notifyTelegram } from "../../../../lib/telegram";

function parseSecretKey(raw: string): Uint8Array | null {
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const arr = JSON.parse(trimmed) as number[];
      return new Uint8Array(arr);
    }
    return bs58.decode(trimmed);
  } catch {
    return null;
  }
}

type RequestBody = {
  userWallet?: string;
  amount?: string; // smallest unit (lamports for SOL)
  agentMint?: string;
  currencyMint?: string;
  /** If set, API signs and sends the tx and returns { signature }. */
  devWalletPrivateKey?: string; // base58 or JSON array
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RequestBody;
    const { userWallet, amount, agentMint, currencyMint, devWalletPrivateKey } =
      body;

    if (!userWallet || !amount || !agentMint || !currencyMint) {
      return NextResponse.json(
        { error: "Missing userWallet, amount, agentMint, or currencyMint" },
        { status: 400 }
      );
    }

    let userPublicKey: PublicKey;
    try {
      userPublicKey = new PublicKey(userWallet);
    } catch {
      return NextResponse.json(
        { error: "Invalid userWallet public key" },
        { status: 400 }
      );
    }

    const parsedAmount = BigInt(amount);
    if (parsedAmount <= 0n) {
      return NextResponse.json(
        { error: "Amount must be greater than zero" },
        { status: 400 }
      );
    }

    const rpcUrl =
      process.env.SOLANA_RPC_URL || "https://rpc.solanatracker.io/public";
    const connection = new Connection(rpcUrl);

    let agentMintPk: PublicKey;
    let currencyMintPk: PublicKey;
    try {
      agentMintPk = new PublicKey(agentMint);
      currencyMintPk = new PublicKey(currencyMint);
    } catch {
      return NextResponse.json(
        { error: "Invalid agentMint or currencyMint" },
        { status: 400 }
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const memo = String(
      Math.floor(Math.random() * 900_000_000_000) + 100_000 // unique-ish
    );
    const startTime = String(now);
    const endTime = String(now + 60 * 60 * 24); // 24h window

    const agent = new PumpAgent(agentMintPk, "mainnet", connection);

    const instructions = await agent.buildAcceptPaymentInstructions({
      user: userPublicKey,
      currencyMint: currencyMintPk,
      amount,
      memo,
      startTime,
      endTime
    });

    const { blockhash } = await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = userPublicKey;
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ...instructions
    );

    const signAndSend = !!devWalletPrivateKey;
    if (signAndSend) {
      const secret = parseSecretKey(devWalletPrivateKey);
      if (!secret) {
        return NextResponse.json(
          { error: "Invalid devWalletPrivateKey" },
          { status: 400 }
        );
      }
      const keypair = Keypair.fromSecretKey(secret);
      if (!keypair.publicKey.equals(userPublicKey)) {
        return NextResponse.json(
          { error: "devWalletPrivateKey does not match userWallet" },
          { status: 400 }
        );
      }
      tx.sign(keypair);
      const raw = tx.serialize();
      const signature = await connection.sendRawTransaction(raw, {
        skipPreflight: false
      });
      // Return immediately; do not block on confirm (avoids 30–60s hang for the bot)

      void notifyTelegram(
        [
          "✅ *Dev payment sent*",
          "",
          `*User*: \`${userWallet}\``,
          `*Amount*: \`${amount}\` (smallest unit)`,
          `*Tx*: \`${signature}\``
        ].join("\n")
      );

      return NextResponse.json({ signature });
    }

    const serializedTx = tx
      .serialize({ requireAllSignatures: false })
      .toString("base64");

    void notifyTelegram(
      [
        "💸 *Dev payment prepared*",
        "",
        `*User*: \`${userWallet}\``,
        `*Amount*: \`${amount}\` (smallest unit)`,
        `*Memo*: \`${memo}\``,
        `*Window*: \`${startTime} – ${endTime}\``
      ].join("\n")
    );

    return NextResponse.json({
      transaction: serializedTx
    });
  } catch (error) {
    console.error("Error in /api/dev/pay-agent:", error);
    return NextResponse.json(
      { error: "Failed to build dev payment transaction" },
      { status: 500 }
    );
  }
}

