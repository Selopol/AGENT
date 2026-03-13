import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { PumpSdk } from "@pump-fun/pump-sdk";
import { PumpAgent } from "@pump-fun/agent-payments-sdk";
import bs58 from "bs58";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  "https://mainnet.helius-rpc.com/?api-key=ba94ceff-57d2-4471-81b6-c5815242a33c";
const AGENT_MINT = process.env.AGENT_TOKEN_MINT_ADDRESS;
const CURRENCY_MINT = process.env.CURRENCY_MINT;

if (!BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set");
}

if (!AGENT_MINT || !CURRENCY_MINT) {
  throw new Error(
    "AGENT_TOKEN_MINT_ADDRESS and CURRENCY_MINT must be set for the agent bot"
  );
}

const connection = new Connection(RPC_URL, "confirmed");
const pumpSdk = new PumpSdk();
const agentMintPk = new PublicKey(AGENT_MINT);
const currencyMintPk = new PublicKey(CURRENCY_MINT);

// In-memory private key per chat. Do NOT log or persist.
const agentWallets = new Map<number, Keypair>();

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    [
      "🤖 Agent wallet bot.",
      "",
      "Команды:",
      "/setkey <secret> — задать приватный ключ кошелька агента (base58 или JSON массива).",
      "/address — показать публичный адрес кошелька агента.",
      "/claim — забрать creator rewards с Pump на кошелёк агента.",
      "/payagent <lamports> — отправить оплату в Tokenized Agent контракт от имени кошелька агента."
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
  const raw = match?.[1];
  if (!raw) {
    bot.sendMessage(chatId, "Передай приватный ключ после команды.");
    return;
  }

  const secret = parseSecretKey(raw);
  if (!secret) {
    bot.sendMessage(chatId, "Не удалось распарсить приватный ключ.");
    return;
  }

  try {
    const kp = Keypair.fromSecretKey(secret);
    agentWallets.set(chatId, kp);
    bot.sendMessage(
      chatId,
      `Кошелёк агента задан.\nПубличный адрес: \`${kp.publicKey.toBase58()}\``,
      { parse_mode: "Markdown" }
    );
  } catch {
    bot.sendMessage(chatId, "Неверный приватный ключ.");
  }
});

bot.onText(/\/address/, (msg) => {
  const chatId = msg.chat.id;
  const kp = agentWallets.get(chatId);
  if (!kp) {
    bot.sendMessage(chatId, "Сначала задай ключ через /setkey <secret>.");
    return;
  }
  bot.sendMessage(chatId, `Адрес кошелька агента: \`${kp.publicKey.toBase58()}\``, {
    parse_mode: "Markdown"
  });
});

bot.onText(/\/claim/, async (msg) => {
  const chatId = msg.chat.id;
  const kp = agentWallets.get(chatId);
  if (!kp) {
    bot.sendMessage(chatId, "Сначала задай ключ через /setkey <secret>.");
    return;
  }

  try {
    bot.sendMessage(chatId, "Собираю инструкции для claim creator rewards...");

    const instructions = await pumpSdk.collectCoinCreatorFeeInstructions(
      kp.publicKey
    );

    if (!instructions.length) {
      bot.sendMessage(chatId, "Нет доступных creator rewards для claim.");
      return;
    }

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(
      ...instructions
    );

    tx.sign(kp);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false
    });

    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight }, "confirmed");

    bot.sendMessage(
      chatId,
      `Claim creator rewards отправлен.\nTx: \`${sig}\``,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    bot.sendMessage(
      chatId,
      `Ошибка при claim creator rewards: ${(err as Error).message}`
    );
  }
});

bot.onText(/\/payagent (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const kp = agentWallets.get(chatId);
  if (!kp) {
    bot.sendMessage(chatId, "Сначала задай ключ через /setkey <secret>.");
    return;
  }

  const lamportsRaw = match?.[1];
  if (!lamportsRaw) {
    bot.sendMessage(chatId, "Укажи сумму в лампортах: /payagent <lamports>");
    return;
  }

  const lamports = BigInt(lamportsRaw);
  if (lamports <= 0n) {
    bot.sendMessage(chatId, "Сумма должна быть больше нуля.");
    return;
  }

  try {
    bot.sendMessage(chatId, "Строю AgentAcceptPayment транзакцию...");

    const agent = new PumpAgent(agentMintPk, "mainnet", connection);

    const now = Math.floor(Date.now() / 1000);
    const amount = lamports.toString();
    const memo = String(Math.floor(Math.random() * 900000000000) + 100000);
    const startTime = String(now);
    const endTime = String(now + 60 * 60 * 24);

    const instructions = await agent.buildAcceptPaymentInstructions({
      user: kp.publicKey,
      currencyMint: currencyMintPk,
      amount,
      memo,
      startTime,
      endTime
    });

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction({
      feePayer: kp.publicKey,
      recentBlockhash: blockhash
    }).add(...instructions);

    tx.sign(kp);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false
    });

    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );

    bot.sendMessage(
      chatId,
      `Оплата в Tokenized Agent отправлена.\nTx: \`${sig}\``,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    bot.sendMessage(
      chatId,
      `Ошибка при оплате через агентский контракт: ${(err as Error).message}`
    );
  }
});

bot.on("polling_error", (err) => {
  // Do not log secrets
  console.error("Telegram polling error:", err.message);
});

