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

interface BybitStopCondition {
  ourSide: "BUY" | "SELL";
  nicks?: Set<string>;
  minPrice?: number;
  maxPrice?: number;
}

function normalizeNick(nick: string): string {
  return String(nick ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export class BybitAdapter implements IExchangeAdapter {
  public readonly name = "BYBIT";

  private readonly PRIMARY_P2P_URL =
    "https://api2.bybit.com/fiat/otc/item/online";
  private readonly BACKUP_P2P_URL =
    "https://api.bybit.com/fiat/otc/item/online";
  private readonly PRIVATE_API_URL = "https://api.bybit.com";

  private readonly MAX_SCAN_PAGES = 10;

  private timeOffset: number = 0;
  private lastTimeSync: number = 0;
  private updateHistory: Map<string, number[]> = new Map();
  private readonly priceCeilings: Map<string, number> = new Map();
  private readonly statusCooldownMs = 5 * 60 * 1000;
  private readonly statusCooldownUntil: Map<string, number> = new Map();

  public isAdCoolingDown(adId: string): boolean {
    const cooldownUntil = this.statusCooldownUntil.get(adId) || 0;
    if (cooldownUntil <= Date.now()) {
      this.statusCooldownUntil.delete(adId);
      return false;
    }

    const waitSec = Math.ceil((cooldownUntil - Date.now()) / 1000);
    console.log(
      `⏳ [Bybit] Ордер #${adId} пропущен: объявление временно нельзя менять. Осталось ${waitSec}с.`,
    );
    return true;
  }

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
          10,
        );
        this.timeOffset = serverTime - now;
        this.lastTimeSync = now;
      } catch {}
    }
    return (Date.now() + this.timeOffset).toString();
  }

  private async fetchPageStrict(
    asset: string,
    fiat: string,
    bybitSide: string,
    page: number,
  ): Promise<any[] | null> {
    const payload = {
      tokenId: asset,
      currencyId: fiat,
      side: bybitSide,
      size: "300",
      page: String(page),
    };

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };

    try {
      const response = await axios.post(this.PRIMARY_P2P_URL, payload, {
        headers,
        timeout: 9000,
      });
      return response.data?.result?.items || [];
    } catch {
      try {
        const responseBackup = await axios.post(this.BACKUP_P2P_URL, payload, {
          headers,
          timeout: 9000,
        });
        return responseBackup.data?.result?.items || [];
      } catch (err: any) {
        console.warn(
          `⚠️ [Bybit] Ошибка стакана (стр. ${page}): ${err.message}`,
        );
        return null;
      }
    }
  }

  public async fetchOrderBook(
    params: FetchOrderBookParams,
  ): Promise<MarketOrder[]> {
    const extra = params as FetchOrderBookParams & {
      competitorNicks?: string[];
      minPrice?: number;
      maxPrice?: number;
    };

    const bybitSide = params.side === "SELL" ? "1" : "0";

    const targetNicks = extra.competitorNicks?.length
      ? new Set(extra.competitorNicks.map(normalizeNick))
      : undefined;
    const targetOrderIds = (params.competitorOrderIds || []).length
      ? new Set(params.competitorOrderIds)
      : undefined;

    const stop: BybitStopCondition = {
      ourSide: params.side,
      nicks: targetNicks,
      minPrice: extra.minPrice,
      maxPrice: extra.maxPrice,
    };

    const isTargetCompetitorInCorridor = (item: any): boolean => {
      const nick = normalizeNick(item?.nickName);
      const orderId = String(item?.id || "");
      const price = parseFloat(item?.price || "0");

      if (stop.nicks && !stop.nicks.has(nick)) return false;
      if (targetOrderIds && !targetOrderIds.has(orderId)) return false;
      if (!Number.isFinite(price)) return false;
      if (stop.minPrice !== undefined && price < stop.minPrice) return false;
      if (stop.maxPrice !== undefined && price > stop.maxPrice) return false;
      return true;
    };

    let allRawItems: any[] = [];
    const seenOrderIds = new Set<string>();

    for (let page = 1; page <= this.MAX_SCAN_PAGES; page++) {
      const items = await this.fetchPageStrict(
        params.asset,
        params.fiat,
        bybitSide,
        page,
      );

      if (items === null || items.length === 0) break;

      for (const item of items) {
        const idStr = String(item.id);
        if (!seenOrderIds.has(idStr)) {
          seenOrderIds.add(idStr);
          allRawItems.push(item);
        }
      }

      if (items.length < 300) break;
    }

    const matchingItems = allRawItems.filter(isTargetCompetitorInCorridor);
    const hightCompetitor = matchingItems.reduce<any | null>(
      (highest, item) => {
        const price = parseFloat(item.price);
        return highest === null || price > parseFloat(highest.price)
          ? item
          : highest;
      },
      null,
    );

    const mappedOrders: MarketOrder[] = allRawItems.map((item: any) => {
      return {
        orderId: String(item.id),
        nickName: String(item.nickName || ""),
        price: parseFloat(item.price),
        payTime: parseInt(
          String(item.paymentPeriod ?? item.payTime ?? "15"),
          10,
        ),
        paymentMethods: [],
      };
    });

    console.log(
      `📚 [Bybit] Стакан ${params.asset}/${params.fiat} (${params.side} -> side ${bybitSide}, получено ${mappedOrders.length} ордеров, лучший конкурент: ${hightCompetitor?.nickName ?? "не найден"} ${hightCompetitor?.price ?? ""})`,
    );

    return mappedOrders;
  }

  private signRequest(
    timestamp: string,
    recvWindow: string,
    bodyString: string,
  ): string {
    const prehash = `${timestamp}${ENV.BYBIT_API_KEY}${recvWindow}${bodyString}`;
    return crypto
      .createHmac("sha256", ENV.BYBIT_API_SECRET)
      .update(prehash)
      .digest("hex");
  }

  public async fetchMyAds(): Promise<BybitMyAd[]> {
    if (!ENV.BYBIT_API_KEY || !ENV.BYBIT_API_SECRET) {
      console.warn("⚠️ [Bybit] API ключи не заданы в .env");
      return [];
    }

    try {
      const timestamp = await this.getSyncedTimestamp();
      const recvWindow = "10000";
      const bodyStr = JSON.stringify({});
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
        },
      );

      const rawItems = response.data?.result?.items || [];
      const activeAds = rawItems
        .filter((ad: any) => Number(ad.status) === 10)
        .map((ad: any) => ({
          id: String(ad.id),
          tokenId: String(ad.tokenId || ad.tokenName || "USDT")
            .trim()
            .toUpperCase(),
          currencyId: String(ad.currencyId || "UAH")
            .trim()
            .toUpperCase(),
          side: Number(ad.side) === 1 ? "SELL" : "BUY",
          price: String(ad.price || "0"),
          status: 10,
        }));

      console.log(
        `📋 [Bybit] Загружено личных активных объявлений (Online): ${activeAds.length} из ${rawItems.length}`,
      );
      return activeAds;
    } catch (err: any) {
      console.warn(`⚠️ [Bybit] Ошибка получения объявлений: ${err.message}`);
      return [];
    }
  }

  private async getRawAd(adId: string): Promise<any | null> {
    try {
      const timestamp = await this.getSyncedTimestamp();
      const recvWindow = "10000";
      const bodyStr = JSON.stringify({ itemId: String(adId) });
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
        },
      );

      const items = response.data?.result?.items || [];
      if (items.length > 0) {
        return items[0];
      }

      const fallbackRes = await axios.post(
        `${this.PRIVATE_API_URL}/v5/p2p/item/personal/list`,
        JSON.stringify({ size: 30 }),
        {
          headers: {
            "Content-Type": "application/json",
            "X-BAPI-API-KEY": ENV.BYBIT_API_KEY,
            "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": recvWindow,
            "X-BAPI-SIGN": signature,
          },
          timeout: 6000,
        },
      );

      const fallbackItems = fallbackRes.data?.result?.items || [];
      return (
        fallbackItems.find(
          (item: any) => String(item.id).trim() === String(adId).trim(),
        ) || null
      );
    } catch (err: any) {
      console.warn(`⚠️ [Bybit] getRawAd ошибка для #${adId}: ${err.message}`);
      return null;
    }
  }

  public async updateAdPrice(adId: string, newPrice: number): Promise<boolean> {
    if (!adId) return false;

    if (!ENV.BYBIT_API_KEY || !ENV.BYBIT_API_SECRET) {
      console.log(
        `🧪 [DRY-RUN | Bybit] Симуляция смены цены для ордера #${adId} -> ${newPrice.toFixed(2)} UAH`,
      );
      return true;
    }

    const now = Date.now();
    const windowMs = 5 * 60 * 1000;

    const timestamps = (this.updateHistory.get(adId) || []).filter(
      (t) => now - t < windowMs,
    );

    if (timestamps.length >= 8) {
      const waitSec = Math.ceil((timestamps[0] + windowMs - now) / 1000);
      console.warn(
        `⏳ [Bybit Rate-Limit] Пауза для ордера #${adId}. Ждем ${waitSec}с до сброса лимита.`,
      );
      return false;
    }

    const lastAttempt = timestamps[timestamps.length - 1] || 0;
    if (now - lastAttempt < 25000) {
      console.log(
        `⏱️ [Bybit] Пропуск тика для #${adId} (интервал между обновлениями одного ордера < 25с)`,
      );
      return false;
    }

    const knownCeiling = this.priceCeilings.get(adId);
    if (knownCeiling !== undefined && newPrice > knownCeiling) {
      console.warn(
        `🛑 [Bybit] Ордер #${adId}: ${newPrice.toFixed(2)} выше известного потолка ${knownCeiling.toFixed(2)} UAH. Обновление пропущено, чтобы не снять объявление.`,
      );
      return false;
    }

    try {
      const currentAd = await this.getRawAd(adId);
      if (!currentAd) {
        console.warn(
          `⚠️ [Bybit] Ордер #${adId} не найден на бирже через getRawAd`,
        );
        return false;
      }

      const exchangePrice = Number(currentAd.price);
      if (
        Number.isFinite(exchangePrice) &&
        Math.round(exchangePrice * 100) === Math.round(newPrice * 100)
      ) {
        console.log(
          `⏸️ [Bybit] Ордер #${adId} уже выставлен на ${exchangePrice.toFixed(2)} UAH, запрос изменения не отправляем.`,
        );
        return true;
      }

      const rawTermsIds = (currentAd.paymentTerms || [])
        .map((p: any) => String(p.id))
        .filter((id: string) => id && id !== "0" && id !== "-1");

      const paymentIds: string[] =
        rawTermsIds.length > 0
          ? rawTermsIds
          : (currentAd.payments || [])
              .map(String)
              .filter((id: string) => id && id !== "-1");

      const timestamp = await this.getSyncedTimestamp();
      const recvWindow = "10000";

      const rawPrefs = currentAd.tradingPreferenceSet || {};
      const cleanTradingPrefs: Record<string, string> = {};

      const allowedPrefKeys = [
        "hasUnPostAd",
        "isKyc",
        "isEmail",
        "isMobile",
        "hasRegisterTime",
        "registerTimeThreshold",
        "orderFinishNumberDay30",
        "completeRateDay30",
        "nationalLimit",
        "hasOrderFinishNumberDay30",
        "hasCompleteRateDay30",
        "hasNationalLimit",
      ];

      for (const key of allowedPrefKeys) {
        if (rawPrefs[key] !== undefined && rawPrefs[key] !== null) {
          cleanTradingPrefs[key] = String(rawPrefs[key]);
        }
      }

      const updatePayload: Record<string, any> = {
        id: String(currentAd.id),
        actionType: "MODIFY",
        priceType: String(currentAd.priceType ?? "0"),
        premium:
          String(currentAd.priceType) === "1"
            ? String(currentAd.premium ?? "100")
            : "",
        price: newPrice.toFixed(2),
        quantity: String("100000"),
        minAmount: String(currentAd.minAmount ?? "500"),
        maxAmount: String(currentAd.maxAmount ?? "50000"),
        paymentPeriod: String(currentAd.paymentPeriod ?? "15"),
        remark: String(currentAd.remark || ""),
        paymentIds: paymentIds.length > 0 ? paymentIds.slice(0, 5) : ["-1"],
        tradingPreferenceSet: cleanTradingPrefs,
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
        },
      );

      const isSuccess =
        response.data?.ret_code === 0 || response.data?.retCode === 0;

      if (!isSuccess) {
        const retCode = String(
          response.data?.ret_code ?? response.data?.retCode ?? "",
        );
        const errMsg = response.data?.ret_msg || "";
        console.warn(
          `⚠️ [Bybit API Error]: Код ${retCode} — ${errMsg}`,
          JSON.stringify(response.data),
        );
        console.warn(`📦 Отправленный payload:`, bodyStr);

        if (
          retCode === "912300121" ||
          retCode === "912120050" ||
          /ads cannot be modified in the current status/i.test(String(errMsg))
        ) {
          this.statusCooldownUntil.set(
            adId,
            Date.now() + this.statusCooldownMs,
          );
          timestamps.pop();
          console.warn(
            retCode === "912120050"
              ? `⏸️ [Bybit] Ордер #${adId}: достигнут лимит 10 обновлений за 5 минут. Повторная попытка через 5 минут.`
              : `⏸️ [Bybit] Ордер #${adId}: объявление нельзя менять в текущем статусе. Повторная попытка через 5 минут.`,
          );
          return false;
        }

        const ceilingMatch = errMsg.match(/higher than ([\d.]+)/);
        if (ceilingMatch && ceilingMatch[1]) {
          const maxAllowed = parseFloat(ceilingMatch[1]);
          this.priceCeilings.set(adId, maxAllowed);
          console.log(
            `🎯 [Bybit] Коррекция под потолок биржи: ставим ${maxAllowed.toFixed(2)} UAH`,
          );
          timestamps.pop();
          return this.updateAdPrice(adId, maxAllowed);
        }

        return false;
      }

      console.log(
        `✅ [Bybit API] Ордер #${adId} успешно выставлен на ${newPrice.toFixed(2)} UAH (лимит: ${timestamps.length}/8)`,
      );
      return true;
    } catch (err: any) {
      console.error(
        `❌ [Bybit API Network Error]:`,
        err.response?.data || err.message,
      );
      return false;
    }
  }

  public async test(
    params: FetchOrderBookParams,
  ): Promise<{ nickName: string; price: number } | null> {
    const extra = params as FetchOrderBookParams & {
      competitorNicks?: string[];
      minPrice?: number;
      maxPrice?: number;
    };

    const bybitSide = params.side === "SELL" ? "1" : "0";

    const targetNicks = extra.competitorNicks?.length
      ? new Set(extra.competitorNicks.map(normalizeNick))
      : undefined;

    let hightCompetitor: { nickName: string; price: number } | null = null;

    const stop: BybitStopCondition = {
      ourSide: params.side,
      nicks: targetNicks,
      minPrice: extra.minPrice,
      maxPrice: extra.maxPrice,
    };

    const isTargetCompetitorInCorridor = (item: any): boolean => {
      const nick = normalizeNick(item?.nickName);
      const price = parseFloat(item?.price || "0");

      if (stop.nicks && !stop.nicks.has(nick)) return false;
      if (!Number.isFinite(price)) return false;
      if (stop.minPrice !== undefined && price < stop.minPrice) return false;
      if (stop.maxPrice !== undefined && price > stop.maxPrice) return false;
      return true;
    };

    const seenOrderIds = new Set<string>();

    for (let page = 1; page <= this.MAX_SCAN_PAGES; page++) {
      const items = await this.fetchPageStrict(
        params.asset,
        params.fiat,
        bybitSide,
        page,
      );

      if (items === null || items.length === 0) break;

      for (const item of items) {
        const idStr = String(item.id);
        if (seenOrderIds.has(idStr)) continue;
        seenOrderIds.add(idStr);

        if (!isTargetCompetitorInCorridor(item)) continue;

        const price = parseFloat(item.price);
        if (hightCompetitor === null || price > hightCompetitor.price) {
          hightCompetitor = {
            nickName: String(item.nickName || ""),
            price,
          };
        }
      }

      if (items.length < 300) break;
    }

    console.log(
      `📚 [Bybit] Лучший конкурент ${params.asset}/${params.fiat} (${params.side} -> side ${bybitSide}):`,
      hightCompetitor,
    );

    return hightCompetitor;
  }
}