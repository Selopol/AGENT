import { NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram
} from "@solana/web3.js";
import { PumpAgent } from "@pump-fun/agent-payments-sdk";
import { generateInvoiceParams } from "../../../lib/invoice";

type RequestBody = {
  userWallet?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RequestBody;
    const userWallet = body.userWallet;

    if (!userWallet) {
      return NextResponse.json(
        { error: "Missing userWallet" },
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

    const { amount, memo, startTime, endTime } = generateInvoiceParams();

    if (Number(amount) <= 0) {
      return NextResponse.json(
        { error: "Amount must be greater than zero" },
        { status: 500 }
      );
    }

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

    return NextResponse.json({
      transaction: serializedTx,
      invoice: {
        userWallet,
        amount,
        memo,
        startTime,
        endTime
      }
    });
  } catch (error) {
    console.error("Error in /api/create-payment:", error);
    return NextResponse.json(
      { error: "Failed to build payment transaction" },
      { status: 500 }
    );
  }
}

