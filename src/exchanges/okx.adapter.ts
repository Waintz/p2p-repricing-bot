import axios from "axios";
import crypto from "crypto";
import { IExchangeAdapter, FetchOrderBookParams } from "./exchange.interface";
import { MarketOrder } from "../engine/math";
import { ENV } from "../config/env";

export interface OkxMyAd {
  id: string;
  asset: string;
  fiat: string;
  side: "BUY" | "SELL";
  price: number;
}

function normalizeNick(nick: string): string {
  return String(nick ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export class OkxAdapter implements IExchangeAdapter {
  public readonly name = "OKX";

  private readonly PUBLIC_P2P_URL =
    "https://www.okx.com/v3/c2c/tradingOrders/getMarketplaceAdsPrelogin";
  private readonly PRIVATE_API_URL = "https://www.okx.com";

  private readonly MAX_SCAN_PAGES = 5;

  public lastNewAdIds: Map<string, string> = new Map();

  private searchSide(ourSide: "BUY" | "SELL"): "buy" | "sell" {
    return ourSide.toLowerCase() as "buy" | "sell";
  }

  public async fetchOrderBook(
    params: FetchOrderBookParams,
  ): Promise<MarketOrder[]> {
    const okxSide = this.searchSide(params.side);
    const asset = params.asset.toUpperCase();
    const fiat = params.fiat.toUpperCase();

    const extra = params as FetchOrderBookParams & {
      competitorNicks?: string[];
      minPrice?: number;
      maxPrice?: number;
    };

    const targetNicks = extra.competitorNicks?.length
      ? new Set(extra.competitorNicks.map(normalizeNick))
      : undefined;

    const allOrdersMap = new Map<string, MarketOrder>();

    try {
      for (let page = 1; page <= this.MAX_SCAN_PAGES; page++) {
        const url = `${this.PUBLIC_P2P_URL}?paymentMethod=all&side=${okxSide}&userType=all&sortType=price_desc&limit=100&cryptoCurrency=${asset}&fiatCurrency=${fiat}&currentPage=${page}&numberPerPage=50&t=${Date.now()}`;

        const response = await axios.get(url, {
          headers: {
            accept: "application/json",
            "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
            devid: "7da22d37-a593-41a2-8a62-3627e59a2e26",
            platform: "web",
            "x-locale": "ru_RU",
            "x-utc": "2",
            Referer: `https://www.okx.com/ru/p2p-markets/${fiat.toLowerCase()}/${okxSide}-${asset.toLowerCase()}`,
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
          },
          timeout: 8000,
        });

        const rootData = response.data?.data;
        if (!rootData) break;

        const rawList: any[] = rootData[okxSide] || [];
        if (!Array.isArray(rawList) || rawList.length === 0) break;

        for (const item of rawList) {
          const adId = String(item.id || "");
          const rawNick = String(item.nickName || "");
          const nick = normalizeNick(rawNick);
          const price = parseFloat(item.price || "0");

          if (targetNicks && !targetNicks.has(nick)) continue;
          if (!Number.isFinite(price)) continue;
          if (extra.minPrice !== undefined && price < extra.minPrice) continue;
          if (extra.maxPrice !== undefined && price > extra.maxPrice) continue;

          if (!allOrdersMap.has(adId)) {
            allOrdersMap.set(adId, {
              orderId: adId,
              nickName: rawNick.trim(),
              price,
              payTime: parseInt(String(item.paymentTimeoutMinutes || "15"), 10),
              paymentMethods: Array.isArray(item.paymentMethods)
                ? item.paymentMethods
                : [],
            });
          }
        }

        if (rawList.length < 50) break;
      }

      return Array.from(allOrdersMap.values());
    } catch (err: any) {
      console.error(`💥 [OKX] Ошибка сканирования стакана: ${err.message}`);
      return [];
    }
  }

  private sign(
    timestamp: string,
    method: string,
    requestPath: string,
    body: string,
  ): string {
    const message = timestamp + method.toUpperCase() + requestPath + body;
    return crypto
      .createHmac("sha256", ENV.OKX_API_SECRET || "")
      .update(message)
      .digest("base64");
  }

  public async fetchMyAds(): Promise<OkxMyAd[]> {
    if (!ENV.OKX_API_KEY || !ENV.OKX_API_SECRET || !ENV.OKX_PASSPHRASE) {
      return [];
    }

    try {
      const method = "GET";
      const requestPath = "/api/v5/p2p/ad/active-list";
      const timestamp = new Date().toISOString();
      const bodyStr = "";
      const sign = this.sign(timestamp, method, requestPath, bodyStr);

      const response = await axios.get(
        `${this.PRIVATE_API_URL}${requestPath}`,
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

      const items = response.data?.data || [];
      return items.map((ad: any) => ({
        id: String(ad.adId || ad.adid || ad.id),
        asset: String(ad.cryptoCurrency || "USDT").toUpperCase(),
        fiat: String(ad.fiatCurrency || "UAH").toUpperCase(),
        side: String(ad.side).toUpperCase() as "BUY" | "SELL",
        price: parseFloat(ad.unitPrice || ad.price || "0"),
      }));
    } catch (err: any) {
      console.warn(
        `⚠️ [OKX] Ошибка получения личных объявлений: ${err.response?.data?.msg || err.message}`,
      );
      return [];
    }
  }

  public async updateAdPrice(
    adId: string,
    newPrice: number,
  ): Promise<boolean> {
    if (!adId) return false;

    if (!ENV.OKX_API_KEY || !ENV.OKX_API_SECRET || !ENV.OKX_PASSPHRASE) {
      console.log(
        `🧪 [DRY-RUN | OKX] Симуляция смены цены ордера #${adId} -> ${newPrice.toFixed(2)} UAH`,
      );
      return true;
    }

    try {
      const method = "POST";
      const requestPath = "/api/v5/p2p/ad/update";
      const timestamp = new Date().toISOString();

      const bodyStr = JSON.stringify({
        adId,
        unitPrice: newPrice.toFixed(2),
        minOrderLimit: "10000.00",
        maxOrderLimit: "2500000.00",
      });

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

      const codeStr = String(response.data?.code ?? "");

      if (codeStr === "0") {
        const rawData = response.data?.data;
        const newAdId = Array.isArray(rawData)
          ? rawData[0]?.newAdId
          : rawData?.newAdId || adId;

        if (newAdId) {
          this.lastNewAdIds.set(adId, String(newAdId));
        }

        console.log(
          `✅ [OKX API] Ордер #${adId} успешно обновлен на ${newPrice.toFixed(2)} UAH (Новый ID: ${newAdId})`,
        );

        return true;
      }

      console.warn(`❌ [OKX API Error]:`, response.data);
      return false;
    } catch (err: any) {
      console.error(
        `❌ [OKX API Network Error]:`,
        err.response?.data || err.message,
      );
      return false;
    }
  }
}