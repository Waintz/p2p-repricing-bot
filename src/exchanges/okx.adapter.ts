import axios from "axios";
import crypto from "crypto";
import { IExchangeAdapter, FetchOrderBookParams } from "./exchange.interface";
import { MarketOrder } from "../engine/math";
import { ENV } from "../config/env";

export interface OkxMyAd {
  adId: string;
  cryptoCurrency: string;
  fiatCurrency: string;
  side: "BUY" | "SELL";
  unitPrice: string;
  status: string;
}

const OKX_PAYMENT_MAP: Record<string, string[]> = {
  MONOBANK_CARD: ["monobank", "mono"],
  MONOBANK_IBAN: ["monobank", "mono"],
  PRIVAT_CARD: ["privatbank", "privat"],
  PRIVAT_IBAN: ["privatbank", "privat"],
  PUMB_CARD: ["pumb"],
  ABANK_CARD: ["a-bank", "abank"],
  BANK_TRANSFER: ["bank transfer", "banktransfer"],
  SENSE_BANK: ["sense"],
  OTP_BANK: ["otp"],
  RAIFFEISEN_BANK: ["raiffeisen", "raif"],
  OSCHAD_BANK: ["oschad"],
};

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function normalizeSide(value: unknown): "BUY" | "SELL" {
  return String(value ?? "").toUpperCase() === "BUY" ? "BUY" : "SELL";
}

export class OkxAdapter implements IExchangeAdapter {
  public readonly name = "OKX";

  private readonly PUBLIC_API_URL = "https://www.okx.com";
  private readonly PUBLIC_MARKETPLACE_PATH =
    "/v3/c2c/tradingOrders/getMarketplaceAdsPrelogin";
  private readonly PUBLIC_PAGE_SIZE = 50;
  private readonly replacementIds = new Map<string, string>();

  private sign(timestamp: string, method: string, requestPath: string, body: string): string {
    return crypto
      .createHmac("sha256", ENV.OKX_API_SECRET)
      .update(timestamp + method.toUpperCase() + requestPath + body)
      .digest("base64");
  }

  private privateHeaders(
    timestamp: string,
    method: string,
    requestPath: string,
    body: string,
  ) {
    return {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": ENV.OKX_API_KEY,
      "OK-ACCESS-SIGN": this.sign(timestamp, method, requestPath, body),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": ENV.OKX_PASSPHRASE,
    };
  }

  private mapMarketAd(item: any): MarketOrder | null {
    const price = Number(item?.unitPrice ?? item?.price);
    const orderId = String(item?.adId ?? item?.id ?? "");
    if (!orderId || !Number.isFinite(price)) return null;

    const rawPayments = asArray(item?.paymentMethods).map((payment) =>
      typeof payment === "string"
        ? payment
        : String(payment?.name ?? payment?.paymentMethodName ?? payment?.id ?? ""),
    ).filter(Boolean);

    return {
      orderId,
      nickName: String(
        item?.creator?.nickName ?? item?.nickName ?? item?.nickname ?? "",
      ),
      price,
      payTime: Number(
        item?.paymentTimeoutMinutes ?? item?.paymentTimeLimit ?? item?.payTime ?? 15,
      ) || 15,
      paymentMethods: rawPayments,
    };
  }

  public async fetchOrderBook(params: FetchOrderBookParams): Promise<MarketOrder[]> {
    const filterByTargets = params.matchAllCompetitors !== true;
    // In this web endpoint `side=buy` is the "Sell USDT" page and returns
    // sellers in data.buy. `side=sell` is the "Buy USDT" page.
    const marketplaceSide = params.side.toLowerCase();
    const targetIds = new Set((params.competitorOrderIds ?? []).map(String));
    const targetNicks = new Set(
      (params.competitorNicks ?? []).map((nick) => nick.trim().toLowerCase()),
    );
    const paymentKeywords = OKX_PAYMENT_MAP[params.paymentMethod ?? ""] ?? [];
    const result: MarketOrder[] = [];
    const seen = new Set<string>();

    try {
      console.log(
        `🔎 [OKX] Запрос стакана: наше объявление ${params.side}, ` +
          `OKX side=${marketplaceSide}, ${params.asset}/${params.fiat}, ` +
          `ники=[${Array.from(targetNicks).join(", ")}], ` +
          `adIds=[${Array.from(targetIds).join(", ")}], ` +
          `банк=${params.paymentMethod || "любой"}, ` +
          `matchAll=${params.matchAllCompetitors === true}`,
      );

      for (let page = 1; page <= 20; page++) {
        const response = await axios.get(
          `${this.PUBLIC_API_URL}${this.PUBLIC_MARKETPLACE_PATH}`,
          {
            params: {
              paymentMethod: "all",
              side: marketplaceSide,
              userType: "all",
              sortType: "price_desc",
              limit: 100,
              cryptoCurrency: params.asset,
              fiatCurrency: params.fiat,
              currentPage: page,
              numberPerPage: this.PUBLIC_PAGE_SIZE,
              t: Date.now(),
            },
            headers: {
              Accept: "application/json",
              "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0.0.0 Safari/537.36",
              platform: "web",
              "X-Locale": "ru_RU",
              Referer: `https://www.okx.com/ru/p2p-markets/${params.fiat.toLowerCase()}/${params.side === "BUY" ? "sell" : "buy"}-${params.asset.toLowerCase()}`,
            },
            timeout: 10000,
          },
        );

        const sideAds = asArray(response.data?.data?.[marketplaceSide]);
        console.log(
          `📥 [OKX] getMarketplaceAdsPrelogin, страница ${page}: ` +
            `${sideAds.length} объявлений (side=${marketplaceSide})`,
        );
        if (sideAds.length === 0) break;

        let rejectedNick = 0;
        let rejectedId = 0;
        let rejectedPayment = 0;
        for (const raw of sideAds) {
          const order = this.mapMarketAd(raw);
          if (!order || seen.has(order.orderId)) continue;
          seen.add(order.orderId);

          const nickMatches =
            !filterByTargets ||
            targetNicks.size === 0 ||
            targetNicks.has(order.nickName.trim().toLowerCase());
          const idMatches =
            !filterByTargets || targetIds.size === 0 || targetIds.has(order.orderId);
          const paymentMatches =
            paymentKeywords.length === 0 ||
            (order.paymentMethods ?? []).some((payment) =>
              paymentKeywords.some((keyword) =>
                payment.toLowerCase().includes(keyword),
              ),
            );
          if (!nickMatches) rejectedNick++;
          if (!idMatches) rejectedId++;
          if (!paymentMatches) rejectedPayment++;
          if (nickMatches && idMatches && paymentMatches) result.push(order);
        }

        console.log(
          `🧾 [OKX] Страница ${page}: совпало ${result.length}, ` +
            `отброшено по нику=${rejectedNick}, ID=${rejectedId}, ` +
            `оплате=${rejectedPayment}. Примеры: ` +
            sideAds
              .slice(0, 5)
              .map((ad) => `${ad.nickName ?? "?"}=${ad.price ?? "?"} (#${ad.id ?? "?"})`)
              .join(" | "),
        );
        if (sideAds.length < this.PUBLIC_PAGE_SIZE) break;
      }
      console.log(
        `✅ [OKX] Итог: найдено ${result.length} объявлений конкурентов` +
          (result.length
            ? `: ${result.map((order) => `${order.nickName}=${order.price} (#${order.orderId})`).join(" | ")}`
            : ""),
      );
      return result;
    } catch (error: any) {
      console.warn(`⚠️ [OKX] Ошибка загрузки стакана: ${error?.message ?? error}`);
      return [];
    }
  }

  public async fetchMyAds(): Promise<OkxMyAd[]> {
    if (!ENV.OKX_API_KEY || !ENV.OKX_API_SECRET || !ENV.OKX_PASSPHRASE) {
      console.warn("⚠️ [OKX] API ключи не заданы в .env");
      return [];
    }

    try {
      const ads: OkxMyAd[] = [];
      for (const side of ["buy", "sell"] as const) {
        const requestPath =
          `/api/v5/p2p/ad/active-list?side=${side}&cryptoCurrency=USDT&fiatCurrency=UAH`;
        const timestamp = new Date().toISOString();
        const response = await axios.get(`${this.PUBLIC_API_URL}${requestPath}`, {
          headers: this.privateHeaders(timestamp, "GET", requestPath, ""),
          timeout: 10000,
        });
        for (const ad of asArray(response.data?.data)) {
          ads.push({
            adId: String(ad.adId ?? ad.id ?? ""),
            cryptoCurrency: String(ad.cryptoCurrency ?? "USDT"),
            fiatCurrency: String(ad.fiatCurrency ?? "UAH"),
            side: normalizeSide(ad.side ?? side),
            unitPrice: String(ad.unitPrice ?? ad.price ?? "0"),
            status: String(ad.status ?? "show"),
          });
        }
      }
      return ads.filter((ad) => ad.adId);
    } catch (error: any) {
      console.warn(`⚠️ [OKX] Ошибка получения своих объявлений: ${error?.message ?? error}`);
      return [];
    }
  }

  public getReplacementAdId(adId: string): string | undefined {
    return this.replacementIds.get(String(adId));
  }

  public async updateAdPrice(adId: string, newPrice: number): Promise<boolean> {
    if (!adId || !Number.isFinite(newPrice)) return false;
    if (!ENV.OKX_API_KEY || !ENV.OKX_API_SECRET || !ENV.OKX_PASSPHRASE) {
      console.log(`🧪 [DRY-RUN | OKX] Симуляция смены цены #${adId} -> ${newPrice.toFixed(2)}`);
      return true;
    }

    const requestPath = "/api/v5/p2p/ad/update";
    const body = JSON.stringify({ adId: String(adId), price: newPrice.toFixed(8) });
    const timestamp = new Date().toISOString();

    try {
      const response = await axios.post(`${this.PUBLIC_API_URL}${requestPath}`, body, {
        headers: this.privateHeaders(timestamp, "POST", requestPath, body),
        timeout: 10000,
      });
      if (response.data?.code !== "0") {
        console.warn(`⚠️ [OKX] Обновление #${adId} отклонено: ${response.data?.msg ?? "unknown error"}`);
        return false;
      }

      const update = asArray(response.data?.data)[0] ?? {};
      const newAdId = String(update.newAdId ?? update.adId ?? "");
      if (newAdId && newAdId !== String(adId)) {
        this.replacementIds.set(String(adId), newAdId);
      }
      return true;
    } catch (error: any) {
      console.warn(`⚠️ [OKX] Ошибка обновления #${adId}: ${error?.message ?? error}`);
      return false;
    }
  }
}
