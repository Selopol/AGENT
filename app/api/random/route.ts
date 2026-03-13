import { NextResponse } from "next/server";
import { PumpAgent } from "@pump-fun/agent-payments-sdk";
import { Connection, PublicKey } from "@solana/web3.js";

type RequestBody = {
  userWallet?: string;
  amount?: string;
  memo?: string;
  startTime?: string;
  endTime?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RequestBody;
    const { userWallet, amount, memo, startTime, endTime } = body;

    if (!userWallet || !amount || !memo || !startTime || !endTime) {
      return NextResponse.json(
        { error: "Missing invoice parameters" },
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

    const parsedAmount = Number(amount);
    const parsedMemo = Number(memo);
    const parsedStartTime = Number(startTime);
    const parsedEndTime = Number(endTime);

    if (
      !Number.isFinite(parsedAmount) ||
      !Number.isFinite(parsedMemo) ||
      !Number.isFinite(parsedStartTime) ||
      !Number.isFinite(parsedEndTime)
    ) {
      return NextResponse.json(
        { error: "Invoice parameters must be numeric" },
        { status: 400 }
      );
    }

    if (parsedAmount <= 0) {
      return NextResponse.json(
        { error: "Amount must be greater than zero" },
        { status: 400 }
      );
    }

    if (parsedEndTime <= parsedStartTime) {
      return NextResponse.json(
        { error: "Invoice endTime must be after startTime" },
        { status: 400 }
      );
    }

    const currencyMintEnv = process.env.CURRENCY_MINT;
    const agentMintEnv = process.env.AGENT_TOKEN_MINT_ADDRESS;

    if (!currencyMintEnv || !agentMintEnv) {
      return NextResponse.json(
        {
          error:
            "AGENT_TOKEN_MINT_ADDRESS and CURRENCY_MINT must be configured on the server"
        },
        { status: 500 }
      );
    }

    const rpcUrl =
      process.env.SOLANA_RPC_URL || "https://rpc.solanatracker.io/public";

    const connection = new Connection(rpcUrl);
    const agentMint = new PublicKey(agentMintEnv);
    const currencyMint = new PublicKey(currencyMintEnv);

    const agent = new PumpAgent(agentMint, "mainnet", connection);

    const paid = await agent.validateInvoicePayment({
      user: userPublicKey,
      currencyMint,
      amount: parsedAmount,
      memo: parsedMemo,
      startTime: parsedStartTime,
      endTime: parsedEndTime
    });

    if (!paid) {
      return NextResponse.json(
        { error: "Payment not found for this invoice" },
        { status: 402 }
      );
    }

    const random = Math.floor(Math.random() * 1001);

    return NextResponse.json({ random });
  } catch (error) {
    console.error("Error in /api/random:", error);
    return NextResponse.json(
      { error: "Failed to verify payment or generate random number" },
      { status: 500 }
    );
  }
}

