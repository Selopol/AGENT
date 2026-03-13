import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { PumpSdk } from "@pump-fun/pump-sdk";
import { PumpAgent } from "@pump-fun/agent-payments-sdk";
import bs58 from "bs58";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID =
  Number(process.env.TELEGRAM_CHAT_ID) || 8423354370;
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  "https://mainnet.helius-rpc.com/?api-key=ba94ceff-57d2-4471-81b6-c5815242a33c";
const DEFAULT_AGENT_MINT = process.env.AGENT_TOKEN_MINT_ADDRESS;
const CURRENCY_MINT = process.env.CURRENCY_MINT;

if (!BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set");
}

if (!CURRENCY_MINT) {
  throw new Error("CURRENCY_MINT must be set for the agent bot");
}

const connection = new Connection(RPC_URL, "confirmed");
const pumpSdk = new PumpSdk();
const defaultAgentMintPk = DEFAULT_AGENT_MINT
  ? new PublicKey(DEFAULT_AGENT_MINT)
  : null;
const currencyMintPk = new PublicKey(CURRENCY_MINT);

type ChatConfig = {
  wallet?: Keypair;
  agentMint?: PublicKey;
};

// In-memory config per chat. Do NOT log or persist private keys.
const chatConfigs = new Map<number, ChatConfig>();

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
      "/setkey <secret> – set agent wallet private key (base58 or JSON array).",
      "/setca <mint> – set the agent token CA (mint address).",
      "/address – show current agent wallet and CA.",
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
    bot.sendMessage(
      chatId,
      `Agent token CA (mint) set:\n\`${mint.toBase58()}\``,
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

  if (!wallet && !mint) {
    bot.sendMessage(
      chatId,
      "No configuration yet. Use /setkey <secret> and /setca <mint>."
    );
    return;
  }

  const lines: string[] = [];
  if (wallet) {
    lines.push(`Agent wallet: \`${wallet.publicKey.toBase58()}\``);
  } else {
    lines.push("Agent wallet: not set (use /setkey).");
  }

  if (mint) {
    lines.push(`Agent token CA (mint): \`${mint.toBase58()}\``);
  } else {
    lines.push("Agent token CA (mint): not set (use /setca).");
  }

  bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
});

bot.onText(/\/claim/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) return;
  await claimCreatorRewardsForChat(chatId, true);
});

async function claimCreatorRewardsForChat(
  chatId: number,
  notifyIfNone: boolean
): Promise<void> {
  const cfg = getChatConfig(chatId);
  const wallet = cfg.wallet;
  if (!wallet) {
    if (notifyIfNone) {
      bot.sendMessage(chatId, "Set agent wallet first with /setkey <secret>.");
    }
    return;
  }

  try {
    if (notifyIfNone) {
      bot.sendMessage(
        chatId,
        "Building claim instructions for creator rewards..."
      );
    }

    const instructions = await pumpSdk.collectCoinCreatorFeeInstructions(
      wallet.publicKey
    );

    if (!instructions.length) {
      if (notifyIfNone) {
        bot.sendMessage(chatId, "No creator rewards available to claim.");
      }
      return;
    }

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction({
      feePayer: wallet.publicKey,
      recentBlockhash: blockhash
    }).add(...instructions);

    tx.sign(wallet);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false
    });

    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    bot.sendMessage(
      chatId,
      `Creator rewards claim sent.\nTx: \`${sig}\``,
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

// Auto-claim loop: every minute, try to claim rewards for all configured chats.
setInterval(() => {
  for (const [chatId, cfg] of chatConfigs.entries()) {
    if (!cfg.wallet) continue;
    // Fire-and-forget; no notifications when there is nothing to claim.
    void claimCreatorRewardsForChat(chatId, false);
  }
}, 60_000);

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
    bot.sendMessage(chatId, "Building AgentAcceptPayment transaction...");

    const agent = new PumpAgent(mint, "mainnet", connection);

    const now = Math.floor(Date.now() / 1000);
    const amount = lamports.toString();
    const memo = String(Math.floor(Math.random() * 900000000000) + 100000);
    const startTime = String(now);
    const endTime = String(now + 60 * 60 * 24);

    const instructions = await agent.buildAcceptPaymentInstructions({
      user: wallet.publicKey,
      currencyMint: currencyMintPk,
      amount,
      memo,
      startTime,
      endTime
    });

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction({
      feePayer: wallet.publicKey,
      recentBlockhash: blockhash
    }).add(...instructions);

    tx.sign(wallet);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false
    });

    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );

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

