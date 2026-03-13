import { NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram
} from "@solana/web3.js";
import { PumpAgent } from "@pump-fun/agent-payments-sdk";
import { notifyTelegram } from "../../../../lib/telegram";

type RequestBody = {
  userWallet?: string;
  amount?: string; // smallest unit (lamports for SOL)
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RequestBody;
    const { userWallet, amount } = body;

    if (!userWallet || !amount) {
      return NextResponse.json(
        { error: "Missing userWallet or amount" },
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

    const agentMintEnv = process.env.AGENT_TOKEN_MINT_ADDRESS;
    const currencyMintEnv = process.env.CURRENCY_MINT;

    if (!agentMintEnv || !currencyMintEnv) {
      return NextResponse.json(
        {
          error:
            "AGENT_TOKEN_MINT_ADDRESS and CURRENCY_MINT must be configured on the server"
        },
        { status: 500 }
      );
    }

    const agentMint = new PublicKey(agentMintEnv);
    const currencyMint = new PublicKey(currencyMintEnv);

    const now = Math.floor(Date.now() / 1000);
    const memo = String(
      Math.floor(Math.random() * 900_000_000_000) + 100_000 // unique-ish
    );
    const startTime = String(now);
    const endTime = String(now + 60 * 60 * 24); // 24h window

    const agent = new PumpAgent(agentMint, "mainnet", connection);

    const instructions = await agent.buildAcceptPaymentInstructions({
      user: userPublicKey,
      currencyMint,
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

