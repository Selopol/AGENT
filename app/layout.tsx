import "./globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import type { ReactNode } from "react";
import { WalletContextProvider } from "../components/WalletContextProvider";

export const metadata = {
  title: "Solana RNG — Pump-gated",
  description:
    "Random number generator gated behind a Pump Tokenized Agent payment on Solana."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletContextProvider>
          <div className="app-shell">{children}</div>
        </WalletContextProvider>
      </body>
    </html>
  );
}

