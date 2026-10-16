import axios from "axios";
import crypto from "crypto";
import { IExchangeAdapter, FetchOrderBookParams } from "./exchange.interface";
import { MarketOrder } from "../engine/math";
import { ENV } from "../config/env";

export interface BinanceMyAd {
  advNo: string;
  asset: string;
  fiat: string;
  fiatUnit: string;
  tradeType: "BUY" | "SELL";
  price: number;
  advStatus: number;
}

interface StopCondition {
  ourSide: "BUY" | "SELL";
  nicks?: Set<string>;
  minPrice?: number;
  maxPrice?: number;
  accept?: (item: any) => boolean;
}

function normalizeNick(nick: string): string {
  return String(nick ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Банки (коды из config/constants.ts) -> идентификатор Binance для серверного
 * фильтра payTypes. Эти значения относятся только к Binance API.
 */
const BINANCE_PAY_TYPE_MAP: Record<string, string> = {
  MONOBANK_CARD: "Monobank",
  MONOBANK_IBAN: "Monobankiban",
  PRIVAT_CARD: "PrivatBank",
  PRIVAT_IBAN: "PrivatBankIBAN",
  PUMB_CARD: "PUMBBank",
  PUMB_IBAN: "PUMBIBAN",
  ABANK_CARD: "ABank",
  ABANK_IBAN: "AbankIBAN",
  RAIFFEISEN_BANK: "RaiffeisenBankAval",
  OSCHAD_BANK: "Oschadbank",
  SENSE_BANK: "SenseSuperApp",
};

/**
 * Локальный отбор объявлений по банку: в тексте способов оплаты объявления
 * (идентификатор + название) должны встретиться ВСЕ слова хотя бы из одного набора.
 */
const BANK_TOKENS: Record<string, string[][]> = {
  MONOBANK_CARD: [["monobank", "card"]],
  MONOBANK_IBAN: [["monobank", "iban"]],
  PRIVAT_CARD: [["privat", "card"], ["privat", "univer"]],
  PRIVAT_IBAN: [["privat", "iban"]],
  ABANK_CARD: [["abank"], ["a-bank"], ["a bank"]],
  ABANK_IBAN: [["abankiban"], ["a-bankiban"], ["a bank iban"]],
  PUMB_CARD: [["pumbbank"]],
  PUMB_IBAN: [["pumbiban"]],
  SENSE_BANK: [["sensesuperapp"]],
  OTP_BANK: [["otp"]],
  RAIFFEISEN_BANK: [["raiffeisen"], ["raif"]],
  OSCHAD_BANK: [["oschadbank"]],
  BANK_TRANSFER: [["bank transfer"], ["banktransfer"]],
};

function matchesBank(item: any, tokenSets: string[][]): boolean {
  const methods: any[] = item?.adv?.tradeMethods || [];
  return methods.some((m) => {
    const text = `${m?.identifier ?? ""} ${m?.tradeMethodName ?? ""} ${
      m?.payType ?? ""
    }`.toLowerCase();
    return tokenSets.some((tokens) => tokens.every((t) => text.includes(t)));
  });
}

function priceOf(item: any): number {
  return parseFloat(item?.adv?.price || "0");
}

function lastPriceOf(items: any[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const v = priceOf(items[i]);
    if (v > 0) return v;
  }
  return 0;
}

export class BinanceAdapter implements IExchangeAdapter {
  public readonly name = "BINANCE";

  private readonly PUBLIC_SEARCH_URL =
    "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
  private readonly PRIVATE_API_URL = "https://api.binance.com";

  private readonly MAX_PROBE_PAGE = 60;
  private readonly MAX_SCAN_PAGES = 10;

  private blockedUntil = 0;
  private backoffMs = 120_000;

  private pageCache = new Map<string, { ts: number; items: any[] }>();
  private readonly PAGE_CACHE_TTL_MS = 10_000;

  private pageHints = new Map<string, number>();

  private discoveredBanks = new Set<string>();

  /**
   * В публичном поиске Binance tradeType — это сторона ПОЛЬЗОВАТЕЛЯ:
   *  - tradeType "BUY"  -> показывает мерчантов, которые ПРОДАЮТ крипту (конкуренты наших SELL-объявлений)
   *  - tradeType "SELL" -> показывает мерчантов, которые ПОКУПАЮТ крипту (конкуренты наших BUY-объявлений)
   * Поэтому для конкурентов нужна ПРОТИВОПОЛОЖНАЯ сторона относительно нашего объявления.
   */
  private searchSide(ourSide: "BUY" | "SELL"): "BUY" | "SELL" {
    return ourSide === "SELL" ? "BUY" : "SELL";
  }

  /**
   * Одна страница стакана. Возвращает null при ошибке или лимите запросов
   * (чтобы отличать сбой от конца стакана, где страница просто пустая).
   */
  private async fetchPageStrict(
    asset: string,
    fiat: string,
    tradeType: "BUY" | "SELL",
    page: number,
    payType?: string
  ): Promise<any[] | null> {
    const cacheKey = [asset, fiat, tradeType, payType ?? "*", page].join("|");
    const cached = this.pageCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.PAGE_CACHE_TTL_MS) {
      return cached.items;
    }

    if (Date.now() < this.blockedUntil) return null;

    try {
      const response = await axios.post(
        this.PUBLIC_SEARCH_URL,
        {
          asset,
          fiat,
          merchantCheck: false,
          page,
          payTypes: payType ? [payType] : [],
          publisherType: null,
          rows: 20,
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

      this.backoffMs = 120_000;
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
      if (status === 429 || status === 418) {
        this.blockedUntil = Date.now() + this.backoffMs;
        console.error(
          `🛑 [Binance] Лимит запросов (HTTP ${status}). Пауза ${Math.round(this.backoffMs / 60000)} мин, запросов к Binance не будет.`
        );
        this.backoffMs = Math.min(this.backoffMs * 2, 30 * 60_000);
      } else {
        console.warn(
          `⚠️ [Binance] Ошибка загрузки страницы ${page} (${tradeType}): ${err.message}`
        );
      }
      return null;
    }
  }

  /**
   * Стакан отсортирован по цене. Вместо чтения всех страниц подряд находим бинарным поиском
   * страницу, где начинается коридор цены правила, и читаем только страницы внутри него.
   * Возвращает null, если поиск не удалось завершить (сбой, лимит, коридор слишком глубоко):
   * в этом случае цену менять нельзя, иначе бот решит, что конкурента нет.
   */
  private async fetchCorridor(
    asset: string,
    fiat: string,
    tradeType: "BUY" | "SELL",
    payType: string | undefined,
    stop: StopCondition
  ): Promise<any[] | null> {
    const side = stop.ourSide;
    const boundary = side === "BUY" ? stop.maxPrice : stop.minPrice;

    const isBefore = (items: any[]): boolean => {
      if (boundary === undefined) return false;
      const lp = lastPriceOf(items);
      if (!lp) return false;
      return side === "BUY" ? lp > boundary : lp < boundary;
    };

    const get = async (p: number): Promise<any[]> => {
      const items = await this.fetchPageStrict(asset, fiat, tradeType, p, payType);
      if (items === null) throw new Error("PAGE_FAIL");
      return items;
    };

    const notBefore = async (p: number): Promise<boolean> => {
      const items = await get(p);
      return items.length === 0 || !isBefore(items);
    };

    const isFound = (item: any): boolean => {
      const nick = normalizeNick(item?.advertiser?.nickName);
      const price = priceOf(item);
      if (stop.nicks && !stop.nicks.has(nick)) return false;
      if (stop.accept && !stop.accept(item)) return false;
      if (stop.minPrice !== undefined && price < stop.minPrice) return false;
      if (stop.maxPrice !== undefined && price > stop.maxPrice) return false;
      return true;
    };

    const hintKey = [asset, fiat, tradeType, payType ?? "*", side, boundary].join("|");

    try {
      const hint = Math.max(1, this.pageHints.get(hintKey) ?? 1);
      let lo = 0;
      let hi = -1;

      if (await notBefore(hint)) {
        hi = hint;
        let step = 2;
        while (hi > 1) {
          const q = Math.max(1, hi - step);
          if (await notBefore(q)) {
            hi = q;
            step *= 2;
          } else {
            lo = q;
            break;
          }
        }
      } else {
        lo = hint;
        let step = 4;
        while (hi === -1) {
          const q = lo + step;
          if (q > this.MAX_PROBE_PAGE) {
            if (lo < this.MAX_PROBE_PAGE && (await notBefore(this.MAX_PROBE_PAGE))) {
              hi = this.MAX_PROBE_PAGE;
              break;
            }
            console.warn(
              `⚠️ [Binance] Коридор цены лежит глубже ${this.MAX_PROBE_PAGE} страниц стакана — цену не меняю`
            );
            return null;
          }
          if (await notBefore(q)) {
            hi = q;
          } else {
            lo = q;
            step *= 2;
          }
        }
      }

      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (await notBefore(mid)) hi = mid;
        else lo = mid;
      }

      const startPage = hi;
      this.pageHints.set(hintKey, startPage);

      const from = Math.max(1, startPage - 1);
      const collected: any[] = [];

      for (let p = from; p < from + this.MAX_SCAN_PAGES; p++) {
        const items = await get(p);
        collected.push(...items);

        if (items.length < 20) break;

        if (items.some(isFound)) {
          console.log(
            `⏹️ [Binance] Конкурент найден (страницы ${from}..${p}), загружено ${collected.length} объявлений`
          );
          break;
        }

        const lp = lastPriceOf(items);
        if (lp > 0) {
          if (side === "BUY" && stop.minPrice !== undefined && lp < stop.minPrice) break;
          if (side === "SELL" && stop.maxPrice !== undefined && lp > stop.maxPrice) break;
        }
      }

      return collected;
    } catch (err: any) {
      if (err?.message === "PAGE_FAIL") return null;
      console.warn(`⚠️ [Binance] Ошибка поиска по стакану: ${err?.message}`);
      return null;
    }
  }

  private logDiscoveredBanks(code: string, items: any[]) {
    if (this.discoveredBanks.has(code)) return;
    this.discoveredBanks.add(code);

    const seen = new Set<string>();
    for (const item of items) {
      for (const m of item?.adv?.tradeMethods || []) {
        seen.add(`${m?.identifier}=${m?.tradeMethodName}`);
      }
    }
    console.log(
      `🔬 [Binance] Способы оплаты в стакане (для настройки BINANCE_PAY_TYPE_MAP, правило "${code}"): ${Array.from(seen)
        .slice(0, 40)
        .join(" | ")}`
    );
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

      const code = String(params.paymentMethod || "").toUpperCase();
      const serverPayType = BINANCE_PAY_TYPE_MAP[code];
      const tokenSets = BANK_TOKENS[code];
      const localAccept = tokenSets
        ? (item: any) => matchesBank(item, tokenSets)
        : undefined;

      const makeStop = (
        accept?: (item: any) => boolean
      ): StopCondition | undefined =>
        (extra.competitorNicks?.length || extra.matchAllCompetitors)
          ? {
              ourSide: params.side,
              nicks: extra.competitorNicks?.length
                ? new Set(extra.competitorNicks.map(normalizeNick))
                : undefined,
              minPrice: extra.minPrice,
              maxPrice: extra.maxPrice,
              accept,
            }
          : undefined;

      const load = async (
        payType: string | undefined,
        accept?: (item: any) => boolean
      ): Promise<any[] | null> => {
        const stop = makeStop(accept);
        if (!stop) {
          return this.fetchPageStrict(params.asset, params.fiat, tradeType, 1, payType);
        }
        return this.fetchCorridor(params.asset, params.fiat, tradeType, payType, stop);
      };

      let allData: any[] = [];
      let usedServerFilter = false;

      if (serverPayType) {
        const probe = await this.fetchPageStrict(
          params.asset,
          params.fiat,
          tradeType,
          1,
          serverPayType
        );
        if (probe === null) return [];

        if (probe.length > 0) {
          const loaded = await load(serverPayType);
          if (loaded === null) return [];
          allData = loaded;
          usedServerFilter = true;
        } else {
          console.warn(
            `⚠️ [Binance] По способу оплаты "${code}" (${serverPayType}) пусто, пробую без серверного фильтра`
          );
        }
      }

      if (!usedServerFilter) {
        const raw = await load(undefined, localAccept);
        if (raw === null) return [];
        allData = raw;

        if (localAccept) {
          this.logDiscoveredBanks(code, allData);
          allData = allData.filter(localAccept);
        } else if (code) {
          console.warn(
            `⚠️ [Binance] Для банка "${code}" нет правила отбора в BANK_TOKENS: стакан показан без фильтра по банку`
          );
        }
      }

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
        const tradeMethods = (adv.tradeMethods || []).map(
          (m: any) => m.identifier || m.payType
        );

        uniqueOrders.set(advNo, {
          orderId: advNo,
          nickName,
          price,
          payTime,
          paymentMethods: [params.paymentMethod, ...tradeMethods],
        });
      }

      const orders = Array.from(uniqueOrders.values());
      console.log(
        `📚 [Binance] Стакан ${params.asset}/${params.fiat} (наша сторона: ${params.side}, банк: ${code || "любой"}): ${orders.length} объявлений`
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
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
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
          asset: String(ad.asset || "USDT"),
          fiat: String(ad.fiatUnit || "UAH"),
          fiatUnit: String(ad.fiatUnit || "UAH"),
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

  // Пауза для объявлений, которые Binance отклонил из-за пересечения ценовых диапазонов (код 187055)
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

  // Возвращает true, если ошибка была конфликтом диапазонов и объявление поставлено на паузу
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

  // При конфликте показываем реальные объявления аккаунта, чтобы найти то, что мешает
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
      console.log(`📋 [Binance] Ваши объявления на аккаунте:\n   ${lines.join("\n   ")}`);
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
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
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