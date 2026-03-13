import { randomInt } from "crypto";

export type InvoiceParams = {
  amount: string;
  memo: string;
  startTime: string;
  endTime: string;
};

export function getPriceAmount(): string {
  const envAmount = process.env.PRICE_AMOUNT;
  const fallback = "100000000"; // 0.1 SOL in lamports
  return envAmount && Number(envAmount) > 0 ? envAmount : fallback;
}

export function generateInvoiceParams(): InvoiceParams {
  const memo = String(
    randomInt(100_000, 900_000_000_000) // unique invoice identifier
  );

  const now = Math.floor(Date.now() / 1000);
  const startTime = String(now);
  const endTime = String(now + 60 * 60 * 24); // valid for 24 hours

  const amount = getPriceAmount();

  return { amount, memo, startTime, endTime };
}

