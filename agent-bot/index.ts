import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import bs58 from "bs58";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID =
  Number(process.env.TELEGRAM_CHAT_ID) || 8423354370;
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  "https://mainnet.helius-rpc.com/?api-key=ba94ceff-57d2-4471-81b6-c5815242a33c";
const DEFAULT_AGENT_MINT = process.env.AGENT_TOKEN_MINT_ADDRESS;
// Default currency mint is wSOL; can be overridden per-chat via commands later.
const DEFAULT_CURRENCY_MINT =
  process.env.CURRENCY_MINT ||
  "So11111111111111111111111111111111111111112";

if (!BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set");
}

const connection = new Connection(RPC_URL, "confirmed");
const onlinePumpSdk = new OnlinePumpSdk(connection);
const defaultAgentMintPk = DEFAULT_AGENT_MINT
  ? new PublicKey(DEFAULT_AGENT_MINT)
  : null;
const defaultCurrencyMintPk = new PublicKey(DEFAULT_CURRENCY_MINT);

// Use PORT (Railway etc.) so bot and Next can run in one process
const INTERNAL_API_BASE_URL =
  process.env.INTERNAL_API_BASE_URL ||
  `http://127.0.0.1:${process.env.PORT || "3000"}`;

// PDA helper for the Tokenized Agent payments account (program vault).
const PUMP_AGENT_PAYMENTS_PROGRAM_ID = new PublicKey(
  "AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7"
);
const TOKEN_AGENT_PAYMENTS_SEED = Buffer.from("token-agent-payments");

function getTokenAgentPaymentsPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [TOKEN_AGENT_PAYMENTS_SEED, mint.toBuffer()],
    PUMP_AGENT_PAYMENTS_PROGRAM_ID
  );
  return pda;
}

type ChatConfig = {
  wallet?: Keypair;
  agentMint?: PublicKey;
  currencyMint?: PublicKey;
};

// In-memory config per chat. Do NOT log or persist private keys.
const chatConfigs = new Map<number, ChatConfig>();

const claimLoops = new Map<number, NodeJS.Timeout | null>();

function getChatConfig(chatId: number): ChatConfig {
  let cfg = chatConfigs.get(chatId);
  if (!cfg) {
    cfg = {};
    chatConfigs.set(chatId, cfg);
  }
  return cfg;
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function isAllowed(chatId: number): boolean {
  return chatId === ALLOWED_CHAT_ID;
}

bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  bot.sendMessage(
    msg.chat.id,
    [
      "🤖 Pump Agent Wallet Bot",
      "",
      "Configure this bot for any Pump agent token.",
      "",
      "Commands:",
      "/setkey <secret> – set dev wallet private key (base58 or JSON array).",
      "/setca <mint> – set the agent token CA (mint address).",
      "/address – show current dev wallet, CA, and currency.",
      "/claim – claim creator rewards from Pump into the agent wallet.",
      "/payagent <lamports> – send an AgentAcceptPayment from the agent wallet."
    ].join("\n")
  );
});

function parseSecretKey(raw: string): Uint8Array | null {
  const trimmed = raw.trim();

  try {
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const arr = JSON.parse(trimmed) as number[];
      return new Uint8Array(arr);
    }
  } catch {
    // ignore
  }

  try {
    return bs58.decode(trimmed);
  } catch {
    return null;
  }
}

bot.onText(/\/setkey (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;
  const raw = match?.[1];
  if (!raw) {
    bot.sendMessage(chatId, "Please provide a private key after the command.");
    return;
  }

  const secret = parseSecretKey(raw);
  if (!secret) {
    bot.sendMessage(chatId, "Failed to parse private key.");
    return;
  }

  try {
    const kp = Keypair.fromSecretKey(secret);
    const cfg = getChatConfig(chatId);
    cfg.wallet = kp;
    bot.sendMessage(
      chatId,
      `Agent wallet set.\nPublic address: \`${kp.publicKey.toBase58()}\``,
      { parse_mode: "Markdown" }
    );
  } catch {
    bot.sendMessage(chatId, "Invalid private key.");
  }
});

bot.onText(/\/setca (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;
  const raw = match?.[1];
  if (!raw) {
    bot.sendMessage(chatId, "Please provide a mint address after the command.");
    return;
  }

  try {
    const mint = new PublicKey(raw.trim());
    const cfg = getChatConfig(chatId);
    cfg.agentMint = mint;
    const paymentsPda = getTokenAgentPaymentsPDA(mint);
    bot.sendMessage(
      chatId,
      [
        "Agent token CA set.",
        "",
        `Mint (CA): \`${mint.toBase58()}\``,
        "Agent payments PDA (program vault):",
        `\`${paymentsPda.toBase58()}\``
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch {
    bot.sendMessage(chatId, "Invalid mint address. Please send a valid Solana mint.");
  }
});

bot.onText(/\/address/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;
  const cfg = getChatConfig(chatId);

  const wallet = cfg.wallet;
  const mint = cfg.agentMint ?? defaultAgentMintPk;
  const currencyMint = cfg.currencyMint ?? defaultCurrencyMintPk;

  if (!wallet && !mint) {
    bot.sendMessage(
      chatId,
      "No configuration yet. Use /setkey <secret> and /setca <mint>."
    );
    return;
  }

  const lines: string[] = [];
  if (wallet) {
    lines.push(`Dev wallet: \`${wallet.publicKey.toBase58()}\``);
  } else {
    lines.push("Dev wallet: not set (use /setkey).");
  }

  if (mint) {
    lines.push(`Agent token CA (mint): \`${mint.toBase58()}\``);
  } else {
    lines.push("Agent token CA (mint): not set (use /setca).");
  }

  if (currencyMint) {
    lines.push(`Payment currency mint: \`${currencyMint.toBase58()}\``);
  }

  bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
});

bot.onText(/\/claim/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;

  if (claimLoops.get(chatId)) {
    bot.sendMessage(chatId, "Auto claim + pay loop is already running.");
    return;
  }

  const cfg = getChatConfig(chatId);
  if (!cfg.wallet) {
    bot.sendMessage(chatId, "Set agent wallet first with /setkey <secret>.");
    return;
  }

  bot.sendMessage(
    chatId,
    "Starting auto claim + pay loop (every 60 seconds). Use /stop to halt."
  );

  const handle = setInterval(() => {
    void claimAndPayOnce(chatId);
  }, 60_000);

  claimLoops.set(chatId, handle);
});

bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;

  const handle = claimLoops.get(chatId);
  if (!handle) {
    bot.sendMessage(chatId, "No running auto claim + pay loop.");
    return;
  }

  clearInterval(handle);
  claimLoops.set(chatId, null);
  bot.sendMessage(chatId, "Stopped auto claim + pay loop.");
});

// One-shot manual claim test: only claims creator rewards once, without paying agent.
bot.onText(/\/claimtest/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;

  const cfg = getChatConfig(chatId);
  if (!cfg.wallet) {
    bot.sendMessage(chatId, "Set dev wallet first with /setkey <secret>.");
    return;
  }

  await claimCreatorRewardsForChat(chatId, true);
});

async function claimAndPayOnce(chatId: number): Promise<void> {
  const cfg = getChatConfig(chatId);
  const wallet = cfg.wallet;

  if (!wallet) {
    return;
  }

  const mint = cfg.agentMint ?? defaultAgentMintPk;
  if (!mint) {
    // Mint not configured, cannot pay agent.
    return;
  }

  const currencyMint = cfg.currencyMint ?? defaultCurrencyMintPk;
  if (!currencyMint) {
    // Should not happen, we always have a default.
    return;
  }

  try {
    const balanceBefore = await connection.getBalance(
      wallet.publicKey,
      "confirmed"
    );

    await claimCreatorRewardsForChat(chatId, false);

    const balanceAfter = await connection.getBalance(
      wallet.publicKey,
      "confirmed"
    );

    const claimed = BigInt(balanceAfter - balanceBefore);
    // Keep some lamports for transaction fees.
    const feeReserve = 100_000n; // 0.0001 SOL
    const payable = claimed > feeReserve ? claimed - feeReserve : 0n;

    if (payable <= 0n) {
      return;
    }

    bot.sendMessage(
      chatId,
      `Sending \`${payable.toString()}\` lamports to agent...`,
      { parse_mode: "Markdown" }
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(
      `${INTERNAL_API_BASE_URL}/api/dev/pay-agent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          userWallet: wallet.publicKey.toBase58(),
          amount: payable.toString(),
          agentMint: mint.toBase58(),
          currencyMint: currencyMint.toBase58()
        }),
        signal: controller.signal
      }
    );
    clearTimeout(timeoutId);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const errMsg = (data as { error?: string }).error ?? res.statusText ?? "unknown";
      console.error("pay-agent API error:", data);
      bot.sendMessage(
        chatId,
        `Payment to agent failed (API ${res.status}): \`${errMsg}\`.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const data = (await res.json()) as { transaction: string };
    if (!data.transaction) {
      bot.sendMessage(chatId, "Payment failed: API returned no transaction.", {
        parse_mode: "Markdown"
      });
      return;
    }

    const tx = Transaction.from(Buffer.from(data.transaction, "base64"));
    tx.sign(wallet);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false
    });
    await connection.confirmTransaction(sig, "confirmed");
    bot.sendMessage(
      chatId,
      `✅ Auto claim + pay executed.\nPaid to agent: \`${payable.toString()}\` lamports.\nTx: \`${sig}\``,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("claimAndPayOnce error:", err);
    const e = err as Error & { name?: string };
    const msg =
      e.name === "AbortError"
        ? "Payment request timed out (60s). API may be slow or unreachable."
        : e.message?.toLowerCase().includes("fetch")
          ? `Auto pay error: ${e.message}. Check INTERNAL_API_BASE_URL (now \`${INTERNAL_API_BASE_URL}\`).`
          : `Auto pay error: ${e.message}`;
    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
  }
}

async function claimCreatorRewardsForChat(
  chatId: number,
  notifyIfNone: boolean
): Promise<void> {
  const cfg = getChatConfig(chatId);
  const mint = cfg.agentMint ?? defaultAgentMintPk;
  const wallet = cfg.wallet;
  if (!wallet) {
    if (notifyIfNone) {
      bot.sendMessage(chatId, "Set agent wallet first with /setkey <secret>.");
    }
    return;
  }

  if (!mint) {
    if (notifyIfNone) {
      bot.sendMessage(
        chatId,
        "Set agent token CA (mint) first with /setca <mint> before claiming."
      );
    }
    return;
  }

  try {
    // 1) Check that we have enough SOL on the dev wallet to pay fees.
    const minFeeLamports = 100_000; // ~0.0001 SOL
    const balanceLamportsBefore =
      await connection.getBalance(wallet.publicKey, "confirmed");
    if (balanceLamportsBefore < minFeeLamports) {
      if (notifyIfNone) {
        const sol = balanceLamportsBefore / 1e9;
        bot.sendMessage(
          chatId,
          `Not enough SOL on dev wallet to pay claim fee. Balance: \`${sol.toFixed(
            6
          )}\` SOL`,
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    if (notifyIfNone) {
      bot.sendMessage(
        chatId,
        "Building claim transaction for creator rewards..."
      );
    }

    const { instructions } =
      await onlinePumpSdk.buildDistributeCreatorFeesInstructions(mint);

    if (instructions.length === 0) {
      if (notifyIfNone) {
        bot.sendMessage(chatId, "No creator fees available to distribute.");
      }
      return;
    }

    // Low priority fee (real claim ~0.000007 SOL total; avoid PumpPortal-style 0.001)
    const priorityFeeIx = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 })
    ];
    const allInstructions = [...priorityFeeIx, ...instructions];

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: allInstructions
    }).compileToV0Message();
    const vx = new VersionedTransaction(msg);
    vx.sign([wallet]);

    const sig = await connection.sendRawTransaction(vx.serialize(), {
      skipPreflight: false
    });

    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    // 4) Wait a bit for balance to update, then measure claimed amount.
    await new Promise((r) => setTimeout(r, 1000));

    const balanceLamportsAfter =
      await connection.getBalance(wallet.publicKey, "confirmed");
    const claimedLamports = BigInt(
      balanceLamportsAfter - balanceLamportsBefore
    );

    if (claimedLamports <= 0n) {
      if (notifyIfNone) {
        bot.sendMessage(
          chatId,
          "No creator fees were claimed (balance did not increase)."
        );
      }
      return;
    }

    const claimedSol = Number(claimedLamports) / 1e9;

    bot.sendMessage(
      chatId,
      `Creator rewards claim sent.\nClaimed: \`${claimedSol.toFixed(
        6
      )}\` SOL\nTx: \`${sig}\``,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    if (notifyIfNone) {
      bot.sendMessage(
        chatId,
        `Error while claiming creator rewards: ${(err as Error).message}`
      );
    }
  }
}

bot.onText(/\/payagent (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;
  const cfg = getChatConfig(chatId);
  const wallet = cfg.wallet;

  if (!wallet) {
    bot.sendMessage(chatId, "Set agent wallet first with /setkey <secret>.");
    return;
  }

  const mint = cfg.agentMint ?? defaultAgentMintPk;
  if (!mint) {
    bot.sendMessage(
      chatId,
      "Set agent token CA (mint) first with /setca <mint>."
    );
    return;
  }

  const currencyMint = cfg.currencyMint ?? defaultCurrencyMintPk;

  const lamportsRaw = match?.[1];
  if (!lamportsRaw) {
    bot.sendMessage(chatId, "Specify amount in lamports: /payagent <lamports>");
    return;
  }

  const lamports = BigInt(lamportsRaw);
  if (lamports <= 0n) {
    bot.sendMessage(chatId, "Amount must be greater than zero.");
    return;
  }

  try {
    bot.sendMessage(chatId, "Building payment transaction...");

    const res = await fetch(
      `${INTERNAL_API_BASE_URL}/api/dev/pay-agent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          userWallet: wallet.publicKey.toBase58(),
          amount: lamports.toString(),
          agentMint: mint.toBase58(),
          currencyMint: currencyMint.toBase58()
        })
      }
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      bot.sendMessage(
        chatId,
        `Error from pay-agent API: \`${(data as { error?: string }).error ?? "unknown error"}\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const data = (await res.json()) as { transaction: string };
    if (!data.transaction) {
      bot.sendMessage(chatId, "API returned no transaction.", {
        parse_mode: "Markdown"
      });
      return;
    }

    const tx = Transaction.from(Buffer.from(data.transaction, "base64"));
    tx.sign(wallet);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false
    });
    await connection.confirmTransaction(sig, "confirmed");
    bot.sendMessage(
      chatId,
      `Payment to Tokenized Agent sent.\nTx: \`${sig}\``,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    bot.sendMessage(
      chatId,
      `Error sending payment via agent contract: ${(err as Error).message}`
    );
  }
});

bot.on("polling_error", (err) => {
  // Do not log secrets
  console.error("Telegram polling error:", err.message);
});

