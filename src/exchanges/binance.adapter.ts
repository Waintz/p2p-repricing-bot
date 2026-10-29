import axios from "axios";
import crypto from "crypto";
import { IExchangeAdapter, FetchOrderBookParams } from "./exchange.interface";
import { MarketOrder } from "../engine/math";
import { ENV } from "../config/env";
import { bot } from "../bot/bot";

export interface BinanceMyAd {
  advNo: string;
  asset: string;
  fiat: string;
  fiatUnit: string;
  tradeType: "BUY" | "SELL";
  price: number;
  advStatus: number;
}

function normalizeNick(nick: string): string {
  return String(nick ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export class BinanceAdapter implements IExchangeAdapter {
  public readonly name = "BINANCE";

  private readonly PUBLIC_SEARCH_URL =
    "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
  private readonly PRIVATE_API_URL = "https://api.binance.com";

  private readonly MAX_SCAN_PAGES = 5;

  private blockedUntil = 0;
  private readonly BASE_BACKOFF_MS = 280_000; // ~4.6 минуты (перекрывает 270с бана)
  private backoffMs = 280_000;
  private readonly MAX_BACKOFF_MS: number = 20 * 60_000;
  private isCurrentlyBlocked = false;

  private pageCache = new Map<string, { ts: number; items: any[] }>();
  private readonly PAGE_CACHE_TTL_MS = 10_000;

  /**
   * В публичном поиске Binance tradeType — это сторона ПОЛЬЗОВАТЕЛЯ:
   *  - tradeType "BUY"  -> показывает мерчантов, которые ПРОДАЮТ крипту (конкуренты наших SELL-объявлений)
   *  - tradeType "SELL" -> показывает мерчантов, которые ПОКУПАЮТ крипту (конкуренты наших BUY-объявлений)
   * Поэтому для конкурентов нужна ПРОТИВОПОЛОЖНАЯ сторона относительно нашего объявления.
   */
  private searchSide(ourSide: "BUY" | "SELL"): "BUY" | "SELL" {
    return ourSide === "SELL" ? "BUY" : "SELL";
  }

  private async notifyAdmin(message: string) {
    if (!ENV.ADMIN_TG_ID) return;
    try {
      await bot.api.sendMessage(ENV.ADMIN_TG_ID, message, {
        parse_mode: "HTML",
      });
    } catch (err: any) {
      console.error("⚠️ [Telegram Notification Error]:", err?.message);
    }
  }

  /**
   * Одна страница стакана. Возвращает null при ошибке или лимите запросов.
   */
  private async fetchPageStrict(
    asset: string,
    fiat: string,
    tradeType: "BUY" | "SELL",
    page: number
  ): Promise<any[] | null> {
    const cacheKey = [asset, fiat, tradeType, page].join("|");
    const cached = this.pageCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.PAGE_CACHE_TTL_MS) {
      return cached.items;
    }

    if (Date.now() < this.blockedUntil) return null;

    if (this.isCurrentlyBlocked && Date.now() >= this.blockedUntil) {
      this.isCurrentlyBlocked = false;
      const unbanMsg = `✅ <b>[Binance API] Доступ восстановлен!</b>\nПауза завершена, слежение за ордерами возобновлено.`;
      console.log(`✅ [Binance] Кулдаун истек, доступ восстановлен.`);
      void this.notifyAdmin(unbanMsg);
    }

    try {
      const response = await axios.post(
        this.PUBLIC_SEARCH_URL,
        {
          asset,
          fiat,
          merchantCheck: false,
          page,
          payTypes: [], // Без фильтрации по банкам на стороне API
          publisherType: null,
          rows: 60,
          tradeType,
          classifies: ["mass", "profession", "fiat_trade"],
        },
        {
          headers: {
            "Content-Type": "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
          timeout: 8000,
        }
      );

      this.backoffMs = this.BASE_BACKOFF_MS;
      const items: any[] = Array.isArray(response.data?.data)
        ? response.data.data
        : [];

      if (this.pageCache.size > 500) {
        const now = Date.now();
        for (const [k, v] of Array.from(this.pageCache.entries())) {
          if (now - v.ts >= this.PAGE_CACHE_TTL_MS) this.pageCache.delete(k);
        }
      }
      this.pageCache.set(cacheKey, { ts: Date.now(), items });
      return items;
    } catch (err: any) {
      const status = err.response?.status;
      const errCode = err.code;
      if (
        status === 429 ||
        status === 418 ||
        errCode === "ECONNRESET" ||
        !status
      ) {
        if (Date.now() >= this.blockedUntil) {
          this.blockedUntil = Date.now() + this.backoffMs;
          this.isCurrentlyBlocked = true;

          const pauseSeconds = Math.round(this.backoffMs / 1000);
          const pauseMinutes = (pauseSeconds / 60).toFixed(1);

          const alertMsg =
            `🛑 <b>[Binance API] Лимит запросов (HTTP 429)!</b>\n\n` +
            `Биржа временно подбанила IP. Слежение за объявлениями Binance <b>приостановлено на ${pauseMinutes} мин</b> (${pauseSeconds} сек).\n` +
            `<i>Бот автоматически возобновит работу после истечения кулдауна.</i>`;

          console.error(
            `🛑 [Binance БАН] Пауза на ${pauseSeconds}с (${pauseMinutes} мин).`
          );
          void this.notifyAdmin(alertMsg);

          this.backoffMs = Math.min(this.backoffMs * 2, this.MAX_BACKOFF_MS);
        }
      } else {
        console.warn(
          `⚠️ [Binance] Ошибка загрузки страницы ${page} (${tradeType}): ${err.message}`
        );
      }
      return null;
    }
  }

  /**
   * Загружает страницы стакана до конца доступных данных или лимита MAX_SCAN_PAGES.
   */
  private async fetchPages(
    asset: string,
    fiat: string,
    tradeType: "BUY" | "SELL"
  ): Promise<any[] | null> {
    const collected: any[] = [];
    const seenAdvNos = new Set<string>();

    for (let page = 1; page <= this.MAX_SCAN_PAGES; page++) {
      const items = await this.fetchPageStrict(asset, fiat, tradeType, page);

      if (items === null) return null;
      if (items.length === 0) break;

      for (const item of items) {
        const advNo = String(item?.adv?.advNo || "");
        if (advNo && !seenAdvNos.has(advNo)) {
          seenAdvNos.add(advNo);
          collected.push(item);
        }
      }

      if (items.length < 60) break;

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    return collected;
  }

  public async fetchOrderBook(
    params: FetchOrderBookParams
  ): Promise<MarketOrder[]> {
    try {
      const tradeType = this.searchSide(params.side);

      if (Date.now() < this.blockedUntil) return [];

      const extra = params as FetchOrderBookParams & {
        competitorNicks?: string[];
        minPrice?: number;
        maxPrice?: number;
      };

      const assetUpper = params.asset.toUpperCase();
      const fiatUpper = params.fiat.toUpperCase();

      const allDataRaw = await this.fetchPages(
        assetUpper,
        fiatUpper,
        tradeType
      );
      if (allDataRaw === null) return [];

      let allData = allDataRaw;

      const targetNicks = extra.competitorNicks?.length
        ? new Set(extra.competitorNicks.map(normalizeNick))
        : undefined;

      const targetOrderIds = params.competitorOrderIds?.length
        ? new Set(params.competitorOrderIds.map(String))
        : undefined;

      const matchAllCompetitors = extra.matchAllCompetitors === true;

      allData = allData.filter((item) => {
        const nick = normalizeNick(item?.advertiser?.nickName);
        const advNo = String(item?.adv?.advNo || "");
        const price = parseFloat(item?.adv?.price || "0");

        // Фильтр по никам (если не включен режим перебивания всех)
        if (!matchAllCompetitors && targetNicks && !targetNicks.has(nick)) {
          return false;
        }

        // Фильтр по конкретным выбранным ID объявлений (если заданы)
        if (targetOrderIds && !targetOrderIds.has(advNo)) {
          return false;
        }

        if (!Number.isFinite(price)) return false;
        if (extra.minPrice !== undefined && price < extra.minPrice)
          return false;
        if (extra.maxPrice !== undefined && price > extra.maxPrice)
          return false;

        return true;
      });

      const uniqueOrders = new Map<string, MarketOrder>();

      for (const item of allData) {
        const adv = item.adv || {};
        const advertiser = item.advertiser || {};
        const advNo = String(adv.advNo || "");
        if (!advNo) continue;

        const nickName = String(advertiser.nickName || "").trim();
        const price = parseFloat(adv.price || "0");
        const payTime = parseInt(
          String(adv.payTimeLimit ?? adv.payTime ?? "15"),
          10
        );

        uniqueOrders.set(advNo, {
          orderId: advNo,
          nickName,
          price,
          payTime,
          paymentMethods: [],
        });
      }

      const orders = Array.from(uniqueOrders.values());
      console.log(
        `📚 [Binance] Стакан ${assetUpper}/${fiatUpper} (наша сторона: ${params.side}): ${orders.length} объявлений`
      );
      return orders;
    } catch (err: any) {
      console.warn(`⚠️ [Binance] Ошибка парсинга стакана: ${err.message}`);
      return [];
    }
  }

  private signQueryString(queryString: string): string {
    return crypto
      .createHmac("sha256", ENV.BINANCE_API_SECRET)
      .update(queryString)
      .digest("hex");
  }

  public async fetchMyAds(): Promise<BinanceMyAd[]> {
    if (!ENV.BINANCE_API_KEY || !ENV.BINANCE_API_SECRET) {
      return [];
    }

    try {
      const timestamp = Date.now() - 1000;
      const queryString = `timestamp=${timestamp}&recvWindow=60000`;
      const signature = this.signQueryString(queryString);

      const allItems: any[] = [];
      const rows = 20;

      for (let page = 1; page <= 50; page++) {
        const response = await axios.post(
          `${this.PRIVATE_API_URL}/sapi/v1/c2c/ads/listWithPagination?${queryString}&signature=${signature}`,
          { page, rows },
          {
            headers: {
              "X-MBX-APIKEY": ENV.BINANCE_API_KEY,
              "Content-Type": "application/json",
              clientType: "WEB",
            },
            timeout: 6000,
          }
        );

        const items = Array.isArray(response.data?.data)
          ? response.data.data
          : [];
        allItems.push(...items);

        if (items.length < rows) {
          break;
        }
      }

      return allItems.map((ad: any) => ({
        advNo: String(ad.advNo),
        asset: String(ad.asset || "USDT").toUpperCase(),
        fiat: String(ad.fiatUnit || "UAH").toUpperCase(),
        fiatUnit: String(ad.fiatUnit || "UAH").toUpperCase(),
        tradeType:
          ad.tradeType === "0" || ad.tradeType === "BUY" ? "BUY" : "SELL",
        price: parseFloat(ad.price || "0"),
        advStatus: Number(ad.advStatus || 0),
      }));
    } catch (err: any) {
      console.warn(
        `⚠️ [Binance] Ошибка получения объявлений: ${
          err.response?.data?.msg || err.message
        }`
      );
      return [];
    }
  }

  private adCooldown = new Map<string, number>();
  private readonly CONFLICT_COOLDOWN_MS = 60_000;

  public isAdCoolingDown(adId: string): boolean {
    const until = this.adCooldown.get(String(adId));
    if (!until) return false;
    if (Date.now() >= until) {
      this.adCooldown.delete(String(adId));
      return false;
    }
    return true;
  }

  private handleRangeConflict(adId: string, data: any): boolean {
    if (Number(data?.code) !== 187055) return false;
    this.adCooldown.set(String(adId), Date.now() + this.CONFLICT_COOLDOWN_MS);
    console.error(
      `⏸️ [Binance] Объявление #${adId}: диапазон цены пересекается с другим вашим объявлением на этой стороне. ` +
        `Пауза ${this.CONFLICT_COOLDOWN_MS / 60000} мин. Если повторяется: разведите коридоры правил минимум на 1% или проверьте объявления, которыми бот не управляет. ` +
        `Ответ Binance: ${data?.msg ?? ""}`
    );
    void this.logMyAds(adId);
    return true;
  }

  private async logMyAds(conflictAdId: string) {
    try {
      const ads = await this.fetchMyAds();
      if (ads.length === 0) return;
      const lines = ads
        .slice(0, 12)
        .map(
          (a) =>
            `#${a.advNo}${a.advNo === String(conflictAdId) ? " (это объявление)" : ""} | ${a.tradeType} | ${a.asset}/${a.fiat} | ${a.price} UAH | статус ${a.advStatus}`
        );
      console.log(
        `📋 [Binance] Ваши объявления на аккаунте:\n   ${lines.join("\n   ")}`
      );
    } catch {
      // диагностика не должна ломать работу
    }
  }

  public async updateAdPrice(adId: string, newPrice: number): Promise<boolean> {
    if (!adId) {
      console.warn("⚠️ [Binance] Не указан ID объявления (advNo).");
      return false;
    }

    if (!ENV.BINANCE_API_KEY || !ENV.BINANCE_API_SECRET) {
      console.log(
        `🧪 [DRY-RUN | Binance] Симуляция смены цены для ордера #${adId} -> ${newPrice.toFixed(2)} UAH`
      );
      return true;
    }

    try {
      const timestamp = Date.now() - 1000;
      const queryString = `timestamp=${timestamp}&recvWindow=60000`;
      const signature = this.signQueryString(queryString);

      const payload = {
        advNo: String(adId),
        price: Number(newPrice.toFixed(2)),
        updateMode: "quickedit",
      };

      const response = await axios.post(
        `${this.PRIVATE_API_URL}/sapi/v1/c2c/ads/update?${queryString}&signature=${signature}`,
        payload,
        {
          headers: {
            "X-MBX-APIKEY": ENV.BINANCE_API_KEY,
            "Content-Type": "application/json",
            clientType: "WEB",
          },
          timeout: 6000,
        }
      );

      if (response.data?.success || response.data?.data === true) {
        console.log(
          `✅ [Binance API] Цена ордера #${adId} успешно обновлена на ${newPrice.toFixed(2)} UAH`
        );
        return true;
      }

      if (this.handleRangeConflict(adId, response.data)) return false;

      console.error(
        `❌ [Binance API] Ошибка обновления ордера #${adId}:`,
        response.data
      );
      return false;
    } catch (error: any) {
      if (this.handleRangeConflict(adId, error.response?.data)) return false;

      console.error(
        `❌ [Binance API] Ошибка запроса к SAPI:`,
        error.response?.data || error.message
      );
      return false;
    }
  }
}