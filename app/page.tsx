"use client";

import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "../components/WalletContextProvider";
import { signAndSendPayment } from "../lib/signAndSendPayment";
import type { InvoiceParams } from "../lib/invoice";

type InvoiceWithWallet = InvoiceParams & {
  userWallet: string;
};

export default function HomePage() {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();

  const [invoice, setInvoice] = useState<InvoiceWithWallet | null>(null);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>("");
  const [agentAnswer, setAgentAnswer] = useState<string | null>(null);
  const [loadingPayment, setLoadingPayment] = useState(false);
  const [loadingAgent, setLoadingAgent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isWalletConnected = !!publicKey;
  const hasPaid = !!txSignature;

  const handleCreateAndPay = async () => {
    if (!publicKey) return;
    if (!connection) return;

    setError(null);
    setAgentAnswer(null);
    setLoadingPayment(true);

    try {
      const res = await fetch("/api/create-payment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ userWallet: publicKey.toBase58() })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to build payment transaction");
      }

      const data = (await res.json()) as {
        transaction: string;
        invoice: InvoiceWithWallet;
      };

      setInvoice(data.invoice);

      const signature = await signAndSendPayment(
        data.transaction,
        signTransaction,
        connection
      );

      setTxSignature(signature);
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Unexpected error during payment";
      setError(message);
    } finally {
      setLoadingPayment(false);
    }
  };

  const handleAskAgent = async () => {
    if (!invoice) {
      setError("You need to complete a payment first.");
      return;
    }

    if (!prompt.trim()) {
      setError("Enter a question for the agent.");
      return;
    }

    setError(null);
    setLoadingAgent(true);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ...invoice, prompt })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to query agent");
      }

      setAgentAnswer(data.answer ?? "");
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Unexpected error querying agent";
      setError(message);
    } finally {
      setLoadingAgent(false);
    }
  };

  return (
    <main className="card">
      <header className="card-header">
        <div className="pill">Pump Tokenized Agent</div>
        <h1 className="title">
          Solana RNG
          <span style={{ fontSize: "0.9rem", color: "#9ca3af" }}>v1</span>
        </h1>
        <p className="subtitle">
          Pay once with your Solana wallet to unlock a verifiable, backend-gated
          random number between 0 and 1000.
        </p>
      </header>

      <section className="section">
        <div className="section-header">
          <div className="section-title">Wallet</div>
          <div className="badge">
            {isWalletConnected ? "Connected" : "Not connected"}
          </div>
        </div>
        <div className="wallet-row">
          <WalletMultiButton />
          <div className="status">
            Status:{" "}
            <span>
              {isWalletConnected
                ? `${publicKey?.toBase58().slice(0, 4)}…${publicKey
                    ?.toBase58()
                    .slice(-4)}`
                : "Connect a Solana wallet"}
            </span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <div className="section-title">Step 1 · Pay to unlock</div>
          <div className="badge">0.1 SOL</div>
        </div>
        <div className="actions">
          <button
            className="primary-button"
            onClick={handleCreateAndPay}
            disabled={!isWalletConnected || loadingPayment}
          >
            {loadingPayment ? "Processing payment..." : "Pay with wallet"}
          </button>
          <div className="pill-label">
            Invoice:{" "}
            <span>
              {hasPaid
                ? "Paid · ready to generate"
                : "Pending · you will sign a single transaction"}
            </span>
          </div>
        </div>
        {txSignature && (
          <div className="success">
            Payment confirmed on-chain.
            <br />
            Signature:{" "}
            <span style={{ opacity: 0.8 }}>
              {txSignature.slice(0, 6)}…{txSignature.slice(-6)}
            </span>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-header">
          <div className="section-title">Step 2 · Ask your agent</div>
          <div className="badge">Grok</div>
        </div>
        <div className="actions">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask your Pump agent anything..."
            style={{
              width: "100%",
              minHeight: "80px",
              borderRadius: "0.75rem",
              border: "1px solid rgba(55,65,81,0.9)",
              background: "rgba(15,23,42,0.9)",
              color: "#e5e7eb",
              padding: "0.75rem",
              fontSize: "0.9rem",
              resize: "vertical"
            }}
          />
          <button
            className="secondary-button"
            onClick={handleAskAgent}
            disabled={!hasPaid || loadingAgent}
          >
            {loadingAgent ? "Verifying & asking..." : "Ask paid agent"}
          </button>
          <div className="pill-label">
            Backend:{" "}
            <span>
              verifies your payment via PumpAgent, then forwards your question
              to Grok
            </span>
          </div>
        </div>

        {agentAnswer && (
          <div className="result">
            <div className="result-label">Agent answer:</div>
            <div
              style={{
                fontSize: "0.9rem",
                lineHeight: 1.5,
                color: "#e5e7eb",
                whiteSpace: "pre-wrap"
              }}
            >
              {agentAnswer}
            </div>
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <p className="hint">
          <strong>Note:</strong> For a production-grade setup, pin this service
          to your own RPC and add persistence so verified invoices can be reused
          without re-verifying on every request.
        </p>
      </section>
    </main>
  );
}

