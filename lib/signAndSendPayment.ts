import type { Connection, Transaction } from "@solana/web3.js";

export async function signAndSendPayment(
  txBase64: string,
  signTransaction: ((tx: Transaction) => Promise<Transaction>) | undefined,
  connection: Connection
): Promise<string> {
  if (!signTransaction) {
    throw new Error("Wallet does not support signing transactions");
  }

  const { Transaction: Web3Transaction } = await import("@solana/web3.js");
  const tx = Web3Transaction.from(Buffer.from(txBase64, "base64"));

  const signedTx = await signTransaction(tx);

  const signature = await connection.sendRawTransaction(
    signedTx.serialize(),
    {
      skipPreflight: false,
      preflightCommitment: "confirmed"
    }
  );

  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature, ...latestBlockhash },
    "confirmed"
  );

  return signature;
}

