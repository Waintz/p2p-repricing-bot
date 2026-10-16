import dotenv from "dotenv";
dotenv.config();

export const ENV = {
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  ADMIN_TG_ID: Number(process.env.ADMIN_TG_ID || 0),
  BYBIT_API_KEY: process.env.BYBIT_API_KEY || "",
  BYBIT_API_SECRET: process.env.BYBIT_API_SECRET || "",
  BINANCE_API_KEY: process.env.BINANCE_API_KEY || "",
  BINANCE_API_SECRET: process.env.BINANCE_API_SECRET || "",
  OKX_API_KEY: process.env.OKX_API_KEY || "",
  OKX_API_SECRET: process.env.OKX_API_SECRET || "",
  OKX_PASSPHRASE: process.env.OKX_PASSPHRASE || "",
};

if (!ENV.BOT_TOKEN || ENV.BOT_TOKEN === "YOUR_TELEGRAM_BOT_TOKEN") {
  console.warn("⚠️ ВНИМАНИЕ: Укажи реальный BOT_TOKEN в файле .env!");
}
