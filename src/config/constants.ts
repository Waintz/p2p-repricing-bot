export const EXCHANGES = ["BINANCE", "BYBIT"] as const;
export type ExchangeType = (typeof EXCHANGES)[number];

export const ASSETS = ["USDT", "USDC"] as const;
export type AssetType = (typeof ASSETS)[number];

export const PAYMENT_METHODS: Record<string, string> = {
  MONOBANK_CARD: "Monobank Карта",
  MONOBANK_IBAN: "Monobank IBAN",
  PRIVAT_CARD: "PrivatBank Карта",
  PRIVAT_IBAN: "PrivatBank IBAN",
  ABANK_CARD: "А-Банк",
  PUMB_CARD: "ПУМБ",
  BANK_TRANSFER: "Bank Transfer",
  SENSE_BANK: "Sense SuperApp",
  OTP_BANK: "ОТП Банк",
  RAIFFEISEN_BANK: "Райффайзен",
  OSCHAD_BANK: "Ощадбанк",
};

export const PAY_TIMES = [15, 30, 45, 60] as const;