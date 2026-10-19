import axios from "axios";
import crypto from "crypto";
import { IExchangeAdapter, FetchOrderBookParams } from "./exchange.interface";
import { MarketOrder } from "../engine/math";
import { ENV } from "../config/env";

const OKX_PAYMENT_MAP: Record<string, string[]> = {
  MONOBANK_CARD: ["Monobank", "Monobank (Card)", "mono"],
  MONOBANK_IBAN: ["Monobank", "Monobank (Card)", "mono"],
  PRIVAT_CARD: ["PrivatBank", "PrivatBank (Card)", "privat"],
  PRIVAT_IBAN: ["PrivatBank", "PrivatBank (Card)", "privat"],
  PUMB_CARD: ["PUMB", "PUMB (CARD)"],
  ABANK_CARD: ["A-Bank", "A-Bank (Card)"],
};

export class OkxAdapter implements IExchangeAdapter {
  public readonly name = "OKX";

  private readonly OKX_P2P_URL =
    "https://www.okx.com/v3/c2c/tradingOrders/getMarketplaceAdsPrelogin";
  private readonly PRIVATE_API_URL = "https://www.okx.com";

  /**
   * 1. Публичный парсер стакана OKX P2P через официальный веб-эндпоинт
   */
  public async fetchOrderBook(
    params: FetchOrderBookParams,
  ): Promise<MarketOrder[]> {
    try {
      const sideParam = params.side === "SELL" ? "sell" : "buy";

      const response = await axios.get(this.OKX_P2P_URL, {
        params: {
          paymentMethod: "all",
          side: sideParam,
          userType: "all",
          sortType: "price_asc",
          limit: "100",
          cryptoCurrency: params.asset,
          fiatCurrency: params.fiat,
          currentPage: "1",
          numberPerPage: "50",
          t: Date.now(),
        },
        headers: {
          Accept: "application/json",
          "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
          Referer: "https://www.okx.com/ru/p2p-markets/uah/buy-usdt",
        },
        timeout: 10000,
      });

      const rootData = response.data?.data;
      if (!rootData) return [];

      // В OKX данные лежат строго внутри sell или buy
      const rawList: any[] =
        sideParam === "sell"
          ? rootData.sell || rootData.buy || []
          : rootData.buy || rootData.sell || [];

      if (!Array.isArray(rawList) || rawList.length === 0) {
        return [];
      }

      const paymentMethod = params.paymentMethod || "";
      const mappedPaymentKeywords = OKX_PAYMENT_MAP[paymentMethod] || [];

      return rawList.map((item: any) => {
        const itemPayments: string[] = Array.isArray(item.paymentMethods)
          ? item.paymentMethods
          : [];

        // Проверяем совпадение способа оплаты
        const isPaymentMatched =
          mappedPaymentKeywords.length === 0 ||
          itemPayments.some((p) =>
            mappedPaymentKeywords.some((kw) =>
              p.toLowerCase().includes(kw.toLowerCase()),
            ),
          );

        const paymentMethods = [...itemPayments];
        if (isPaymentMatched) {
          if (paymentMethod) {
            paymentMethods.push(paymentMethod);
          }
        }

        return {
          orderId: String(item.id || item.publicUserId || ""),
          nickName: String(item.nickName || ""),
          price: parseFloat(item.price || "0"),
          payTime: parseInt(String(item.paymentTimeoutMinutes || "15"), 10),
          paymentMethods,
        };
      });
    } catch (err: any) {
      console.warn(`⚠️ [OKX Adapter] Ошибка парсинга стакана: ${err.message}`);
      return [];
    }
  }

  /**
   * Генерация подписи OKX V5 REST API
   */
  private sign(
    timestamp: string,
    method: string,
    requestPath: string,
    body: string,
  ): string {
    const message = timestamp + method.toUpperCase() + requestPath + body;
    return crypto
      .createHmac("sha256", ENV.OKX_API_SECRET)
      .update(message)
      .digest("base64");
  }

  /**
   * 2. Обновление цены через приватное API OKX P2P
   */
  public async updateAdPrice(adId: string, newPrice: number): Promise<boolean> {
    if (!adId) return false;

    if (!ENV.OKX_API_KEY || !ENV.OKX_API_SECRET || !ENV.OKX_PASSPHRASE) {
      console.log(
        `🧪 [DRY-RUN | OKX] Симуляция смены цены ордера #${adId} -> ${newPrice.toFixed(2)} UAH`,
      );
      return true;
    }

    try {
      const method = "POST";
      const requestPath = "/api/v5/p2p/update-ad";
      const timestamp = new Date().toISOString();
      const bodyStr = JSON.stringify({ adId, price: newPrice.toFixed(2) });
      const sign = this.sign(timestamp, method, requestPath, bodyStr);

      const response = await axios.post(
        `${this.PRIVATE_API_URL}${requestPath}`,
        bodyStr,
        {
          headers: {
            "Content-Type": "application/json",
            "OK-ACCESS-KEY": ENV.OKX_API_KEY,
            "OK-ACCESS-SIGN": sign,
            "OK-ACCESS-TIMESTAMP": timestamp,
            "OK-ACCESS-PASSPHRASE": ENV.OKX_PASSPHRASE,
          },
          timeout: 6000,
        },
      );

      return response.data?.code === "0";
    } catch {
      return false;
    }
  }
}
