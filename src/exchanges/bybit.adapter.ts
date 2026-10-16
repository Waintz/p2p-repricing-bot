import axios from "axios";
import crypto from "crypto";
import { IExchangeAdapter, FetchOrderBookParams } from "./exchange.interface";
import { MarketOrder } from "../engine/math";
import { ENV } from "../config/env";

export interface BybitMyAd {
  id: string;
  tokenId: string;
  currencyId: string;
  side: "BUY" | "SELL";
  price: string;
  status: number;
}

export const BYBIT_PAYMENT_MAP: Record<string, string[]> = {
  MONOBANK_CARD: ["43"],
  MONOBANK_IBAN: ["659"],
  PRIVAT_CARD: ["60"],
  PRIVAT_IBAN: ["60"],
  ABANK_CARD: ["1"],
  PUMB_CARD: ["61"],
  BANK_TRANSFER: ["14"],
  SENSE_BANK: ["477"],
  OTP_BANK: ["395"],
  RAIFFEISEN_BANK: ["44"],
  OSCHAD_BANK: ["45"],
};

export class BybitAdapter implements IExchangeAdapter {
  public readonly name = "BYBIT";

  private readonly PRIMARY_P2P_URL =
    "https://api2.bybit.com/fiat/otc/item/online";
  private readonly BACKUP_P2P_URL =
    "https://api.bybit.com/fiat/otc/item/online";
  private readonly PRIVATE_API_URL = "https://api.bybit.com";

  private timeOffset: number = 0;
  private lastTimeSync: number = 0;

  // Хранилище истории запросов для соблюдения рейт-лимитов Bybit
  private updateHistory: Map<string, number[]> = new Map();

  private async getSyncedTimestamp(): Promise<string> {
    const now = Date.now();
    if (now - this.lastTimeSync > 300000) {
      try {
        const res = await axios.get(`${this.PRIVATE_API_URL}/v5/market/time`, {
          timeout: 4000,
        });
        const serverTime = parseInt(
          res.data?.timeNano?.slice(0, 13) ||
            res.data?.result?.timeSecond * 1000 ||
            now,
          10
        );
        this.timeOffset = serverTime - now;
        this.lastTimeSync = now;
      } catch {
      }
    }
    return (Date.now() + this.timeOffset).toString();
  }

  public async fetchOrderBook(
    params: FetchOrderBookParams
  ): Promise<MarketOrder[]> {
    const paymentIds = BYBIT_PAYMENT_MAP[params.paymentMethod] || [];
    const bybitSide = params.side === "SELL" ? "1" : "0";

    const payload = {
      userId: "",
      tokenId: params.asset,
      currencyId: params.fiat,
      payment: paymentIds.length > 0 ? paymentIds : [],
      side: bybitSide,
      size: "50",
      page: "1",
      amount: "",
      authMaker: false,
      canTrade: false,
    };

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };

    let items: any[] = [];

    try {
      const response = await axios.post(this.PRIMARY_P2P_URL, payload, {
        headers,
        timeout: 12000,
      });
      items = response.data?.result?.items || [];
    } catch {
      try {
        const responseBackup = await axios.post(this.BACKUP_P2P_URL, payload, {
          headers,
          timeout: 12000,
        });
        items = responseBackup.data?.result?.items || [];
      } catch (err: any) {
        console.warn(
          `⚠️ [Bybit] Задержка сети при запросе стакана: ${err.message}`
        );
        return [];
      }
    }

    return items.map((item: any) => {
      const rawPayments: string[] = (item.payments || []).map(String);
      const mappedMethods: string[] = [...rawPayments];

      const matchesPayment =
        paymentIds.length === 0 ||
        paymentIds.some((pid) => rawPayments.includes(pid));

      if (matchesPayment) {
        mappedMethods.push(params.paymentMethod);
      }

      return {
        orderId: String(item.id),
        nickName: String(item.nickName || ""),
        price: parseFloat(item.price),
        payTime: parseInt(
          String(item.paymentPeriod ?? item.payTime ?? "15"),
          10
        ),
        paymentMethods: mappedMethods,
      };
    });
  }

  private signRequest(
    timestamp: string,
    recvWindow: string,
    bodyString: string
  ): string {
    const prehash = `${timestamp}${ENV.BYBIT_API_KEY}${recvWindow}${bodyString}`;
    return crypto
      .createHmac("sha256", ENV.BYBIT_API_SECRET)
      .update(prehash)
      .digest("hex");
  }

  public async fetchMyAds(): Promise<BybitMyAd[]> {
    if (!ENV.BYBIT_API_KEY || !ENV.BYBIT_API_SECRET) {
      return [];
    }

    try {
      const timestamp = await this.getSyncedTimestamp();
      const recvWindow = "10000";
      const bodyStr = JSON.stringify({ page: "1", size: "50" });
      const signature = this.signRequest(timestamp, recvWindow, bodyStr);

      const response = await axios.post(
        `${this.PRIVATE_API_URL}/v5/p2p/item/personal/list`,
        bodyStr,
        {
          headers: {
            "Content-Type": "application/json",
            "X-BAPI-API-KEY": ENV.BYBIT_API_KEY,
            "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": recvWindow,
            "X-BAPI-SIGN": signature,
          },
          timeout: 6000,
        }
      );

      const rawItems = response.data?.result?.items || [];
      return rawItems.map((ad: any) => ({
        id: String(ad.id),
        tokenId: String(ad.tokenId || "USDT"),
        currencyId: String(ad.currencyId || "UAH"),
        side: ad.side === 1 ? "SELL" : "BUY",
        price: String(ad.price || "0"),
        status: Number(ad.status || 0),
      }));
    } catch (err: any) {
      console.warn(`⚠️ [Bybit] Ошибка получения объявлений: ${err.message}`);
      return [];
    }
  }

  private async getRawAd(adId: string): Promise<any | null> {
    try {
      const timestamp = await this.getSyncedTimestamp();
      const recvWindow = "10000";
      const bodyStr = JSON.stringify({ page: "1", size: "50" });
      const signature = this.signRequest(timestamp, recvWindow, bodyStr);

      const response = await axios.post(
        `${this.PRIVATE_API_URL}/v5/p2p/item/personal/list`,
        bodyStr,
        {
          headers: {
            "Content-Type": "application/json",
            "X-BAPI-API-KEY": ENV.BYBIT_API_KEY,
            "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": recvWindow,
            "X-BAPI-SIGN": signature,
          },
          timeout: 6000,
        }
      );

      const items = response.data?.result?.items || [];
      return (
        items.find((item: any) => String(item.id).trim() === String(adId).trim()) || null
      );
    } catch {
      return null;
    }
  }

  public async updateAdPrice(adId: string, newPrice: number): Promise<boolean> {
    if (!adId) return false;

    if (!ENV.BYBIT_API_KEY || !ENV.BYBIT_API_SECRET) {
      console.log(
        `🧪 [DRY-RUN | Bybit] Симуляция смены цены для ордера #${adId} -> ${newPrice.toFixed(2)} UAH`
      );
      return true;
    }

    const now = Date.now();
    const windowMs = 5 * 60 * 1000;

    const timestamps = (this.updateHistory.get(adId) || []).filter(
      (t) => now - t < windowMs
    );

    if (timestamps.length >= 8) {
      const waitSec = Math.ceil((timestamps[0] + windowMs - now) / 1000);
      console.warn(
        `⏳ [Bybit Rate-Limit] Пауза для ордера #${adId}. Ждем ${waitSec}с до сброса лимита.`
      );
      return false;
    }

    // Не чаще 1 раза в 25 секунд на одно объявление
    const lastAttempt = timestamps[timestamps.length - 1] || 0;
    if (now - lastAttempt < 25000) {
      return false;
    }

    try {
      const currentAd = await this.getRawAd(adId);
      if (!currentAd) {
        console.warn(`⚠️ [Bybit] Ордер #${adId} не найден в списке пользователя`);
        return false;
      }

      const rawTermsIds = (currentAd.paymentTerms || [])
        .map((p: any) => String(p.id))
        .filter((id: string) => id && id !== "0" && id !== "-1");

      const paymentIds: string[] =
        rawTermsIds.length > 0
          ? rawTermsIds
          : (currentAd.payments || []).map(String);

      const timestamp = await this.getSyncedTimestamp();
      const recvWindow = "10000";

      const rawPrefs = currentAd.tradingPreferenceSet || {};
      const formattedTradingPrefs: Record<string, string> = {};
      for (const [key, val] of Object.entries(rawPrefs)) {
        if (val !== undefined && val !== null && val !== "") {
          formattedTradingPrefs[key] = String(val);
        }
      }

      const updatePayload: Record<string, any> = {
        id: String(currentAd.id),
        actionType: "MODIFY",
        priceType: String(currentAd.priceType ?? "0"),
        premium: String(currentAd.premium ?? ""),
        price: newPrice.toFixed(2),
        quantity: String(currentAd.lastQuantity ?? currentAd.quantity ?? "100"),
        minAmount: String(currentAd.minAmount ?? "500"),
        maxAmount: String(currentAd.maxAmount ?? "50000"),
        paymentPeriod: String(currentAd.paymentPeriod ?? "15"),
        remark: String(currentAd.remark || ""),
        paymentIds: paymentIds.slice(0, 5),
        tradingPreferenceSet: formattedTradingPrefs,
      };

      const bodyStr = JSON.stringify(updatePayload);
      const signature = this.signRequest(timestamp, recvWindow, bodyStr);

      timestamps.push(now);
      this.updateHistory.set(adId, timestamps);

      const response = await axios.post(
        `${this.PRIVATE_API_URL}/v5/p2p/item/update`,
        bodyStr,
        {
          headers: {
            "Content-Type": "application/json",
            "X-BAPI-API-KEY": ENV.BYBIT_API_KEY,
            "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": recvWindow,
            "X-BAPI-SIGN": signature,
          },
          timeout: 6000,
        }
      );

      const isSuccess =
        response.data?.ret_code === 0 || response.data?.retCode === 0;

      if (!isSuccess) {
        const errMsg = response.data?.ret_msg || "";
        console.warn(`⚠️ [Bybit API Error]: ${JSON.stringify(response.data)}`);

        const ceilingMatch = errMsg.match(/higher than ([\d.]+)/);
        if (ceilingMatch && ceilingMatch[1]) {
          const maxAllowed = parseFloat(ceilingMatch[1]);
          console.log(
            `🎯 [Bybit] Коррекция под потолок биржи: ставим ${maxAllowed.toFixed(2)} UAH`
          );
          timestamps.pop();
          return this.updateAdPrice(adId, maxAllowed);
        }

        return false;
      }

      console.log(
        `✅ [Bybit API] Ордер #${adId} успешно выставлен на ${newPrice.toFixed(2)} UAH (использовано ${timestamps.length}/8 лимита)`
      );
      return true;
    } catch (err: any) {
      console.error(
        `❌ [Bybit API Network Error]:`,
        err.response?.data || err.message
      );
      return false;
    }
  }
}