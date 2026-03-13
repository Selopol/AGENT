import { NextResponse } from "next/server";
import { PumpAgent } from "@pump-fun/agent-payments-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { notifyTelegram } from "../../../lib/telegram";

type RequestBody = {
  userWallet?: string;
  amount?: string;
  memo?: string;
  startTime?: string;
  endTime?: string;
  prompt?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RequestBody;
    const { userWallet, amount, memo, startTime, endTime, prompt } = body;

    if (!userWallet || !amount || !memo || !startTime || !endTime || !prompt) {
      return NextResponse.json(
        { error: "Missing invoice parameters or prompt" },
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

    void notifyTelegram(
      [
        "✅ *Invoice paid*",
        "",
        `*User*: \`${userWallet}\``,
        `*Amount*: \`${amount}\` (smallest unit)`,
        `*Memo*: \`${memo}\``,
        `*Window*: \`${startTime} – ${endTime}\``
      ].join("\n")
    );

    const apiKey = process.env.GROK_API_KEY;
    const baseUrl = process.env.GROK_API_BASE_URL || "https://api.x.ai/v1";
    const model = process.env.GROK_MODEL || "grok-2-latest";

    if (!apiKey) {
      return NextResponse.json(
        { error: "Grok API key is not configured on the server" },
        { status: 500 }
      );
    }

    const grokRes = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a tokenized AI agent for a Pump.fun coin. Be concise, helpful, and avoid financial advice."
          },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!grokRes.ok) {
      const text = await grokRes.text();
      console.error("Grok API error:", text);
      return NextResponse.json(
        { error: "Failed to get a response from Grok" },
        { status: 502 }
      );
    }

    const grokJson = (await grokRes.json()) as {
      choices?: { message?: { content?: string } }[];
    };

    const answer =
      grokJson.choices?.[0]?.message?.content ??
      "No response from Grok model.";

    return NextResponse.json({ answer });
  } catch (error) {
    console.error("Error in /api/agent:", error);
    return NextResponse.json(
      { error: "Failed to verify payment or query Grok" },
      { status: 500 }
    );
  }
}

