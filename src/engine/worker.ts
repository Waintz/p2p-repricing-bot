import { prisma } from "../database/prisma";
import { calculateNewPrice, RuleConfig, MarketOrder } from "./math";
import { BybitAdapter } from "../exchanges/bybit.adapter";
import { BinanceAdapter } from "../exchanges/binance.adapter";
import { OkxAdapter } from "../exchanges/okx.adapter";
import { IExchangeAdapter } from "../exchanges/exchange.interface";

type Coolable = IExchangeAdapter & {
  isAdCoolingDown?: (adId: string) => boolean;
};

export class RepricingWorker {
  private isRunning = false;
  private intervalId?: NodeJS.Timeout;
  private warnedSafetyConflicts = new Set<string>();

  private adapters: Record<string, IExchangeAdapter> = {
    BYBIT: new BybitAdapter(),
    BINANCE: new BinanceAdapter(),
    OKX: new OkxAdapter(),
  };

  public start(intervalMs = 15000) {
    if (this.intervalId) return;
    console.log(`⚙️ Авторепрайсинг запущен (интервал: ${intervalMs / 1000}с)`);
    this.intervalId = setInterval(() => void this.tick(), intervalMs);
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private async tick() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const activeRules = await prisma.adRule.findMany({
        where: { isActive: true },
        include: { competitors: true },
      });

      if (activeRules.length === 0) return;

      const groups = new Map<string, any[]>();
      for (const rule of activeRules) {
        if (!this.adapters[rule.exchange]) continue;
        const key = [rule.exchange, rule.asset, rule.fiat, rule.side].join("|");
        const list = groups.get(key) ?? [];
        list.push(rule);
        groups.set(key, list);
      }

      for (const rules of Array.from(groups.values())) {
        await this.processGroup(rules);
      }
    } catch (error: any) {
      console.error("❌ Ошибка цикла репрайсинга:", error?.message ?? error);
    } finally {
      this.isRunning = false;
    }
  }

  private bookKeyOf(rule: any): string {
    const nicks = rule.competitors
      .filter((c: any) => c.isEnabled)
      .map((c: any) => String(c.nickname).trim().toLowerCase())
      .sort();

    return [
      rule.asset,
      rule.fiat,
      rule.side,
      rule.paymentMethod,
      rule.matchAllCompetitors ? "ALL" : "NICKS",
      ...nicks,
      ...rule.competitors
        .filter((c: any) => c.isEnabled)
        .flatMap((c: any) => JSON.parse(c.orderIds || "[]"))
        .sort(),
    ].join("|");
  }

  private async processGroup(rules: any[]) {
    const adapter = this.adapters[rules[0].exchange] as Coolable;
    const books = new Map<string, MarketOrder[]>();

    for (const rule of rules) {
      if (!rule.adId) {
        console.warn(`⚠️ [${rule.exchange}] Правило "${rule.name}" включено, но не привязан ID ордера (adId пустой)`);
        continue;
      }
      if (adapter.isAdCoolingDown?.(String(rule.adId))) {
        console.log(`⏳ [${rule.exchange}] Ордер #${rule.adId} на кулдауне, пропуск.`);
        continue;
      }

      try {
        const bookKey = this.bookKeyOf(rule);
        let orderBook = books.get(bookKey);

        if (!orderBook) {
          const sharing = rules.filter((c) => this.bookKeyOf(c) === bookKey);
          orderBook = await adapter.fetchOrderBook({
            asset: rule.asset as "USDT" | "USDC",
            fiat: rule.fiat,
            side: rule.side as "BUY" | "SELL",
            paymentMethod: rule.paymentMethod,
            competitorNicks: rule.competitors
              .filter((c: any) => c.isEnabled)
              .map((c: any) => c.nickname),
            competitorOrderIds: rule.competitors
              .filter((c: any) => c.isEnabled)
              .flatMap((c: any) => JSON.parse(c.orderIds || "[]")),
            matchAllCompetitors: rule.matchAllCompetitors === true,
            minPrice: Math.min(...sharing.map((c) => c.minPrice)),
            maxPrice: Math.max(...sharing.map((c) => c.maxPrice)),
          });
          books.set(bookKey, orderBook);
        }

        if (!orderBook || orderBook.length === 0) {
          console.warn(`⚠️ [${rule.exchange}] Стакан для "${rule.name}" пуст или не загружен`);
          continue;
        }

        const allowedPayTimes: number[] = JSON.parse(
          rule.allowedPayTimes || "[15,30,45,60]"
        );

        const mathConfig: RuleConfig = {
          side: rule.side as "BUY" | "SELL",
          paymentMethod: rule.paymentMethod,
          step: rule.step,
          minPrice: rule.minPrice,
          maxPrice: rule.maxPrice,
          currentPrice: rule.currentPrice,
          allowedPayTimes,
          matchAllCompetitors: rule.matchAllCompetitors === true,
          competitors: rule.competitors.map((c: any) => ({
            nickname: c.nickname,
            orderIds: JSON.parse(c.orderIds || "[]"),
            isEnabled: c.isEnabled,
            step: c.step,
          })),
        };

        const result = calculateNewPrice(orderBook, mathConfig);
        const currentPrice = rule.currentPrice ? Number(rule.currentPrice) : null;
        const safeTargetPrice = this.applyBinanceSafetyLimit(rules, rule, result.targetPrice);

        if (safeTargetPrice === null) continue;

        if (
          currentPrice !== null &&
          Number.isFinite(currentPrice) &&
          Math.round(currentPrice * 100) === Math.round(safeTargetPrice * 100)
        ) {
          console.log(
            `⏸️ [${rule.exchange} | ${rule.name}] Цена актуальна: ${currentPrice.toFixed(2)} UAH (${result.reason})`
          );
          continue;
        }

        console.log(
          `🔄 [${rule.exchange} | ${rule.name}] ${currentPrice ? currentPrice.toFixed(2) : "—"} -> ${safeTargetPrice.toFixed(2)} UAH (${result.reason})`
        );

        const updated = await adapter.updateAdPrice(String(rule.adId), safeTargetPrice);

        if (updated) {
          const replacementAdId = adapter.getReplacementAdId?.(String(rule.adId));
          await prisma.adRule.update({
            where: { id: rule.id },
            data: {
              currentPrice: safeTargetPrice,
              ...(replacementAdId ? { adId: replacementAdId } : {}),
            },
          });
        }
      } catch (error: any) {
        console.error(`❌ [${rule.exchange}] Ошибка ордера ${rule.name}:`, error?.message ?? error);
      }
    }
  }

  private applyBinanceSafetyLimit(rules: any[], rule: any, targetPrice: number): number | null {
    if (rule.exchange !== "BINANCE" || rule.asset !== "USDT" || !Number.isFinite(targetPrice)) {
      return targetPrice;
    }

    const related = rules.filter(
      (c) =>
        c.id !== rule.id &&
        c.exchange === "BINANCE" &&
        c.asset === rule.asset &&
        c.fiat === rule.fiat &&
        c.side === rule.side &&
        c.paymentMethod === rule.paymentMethod &&
        c.currentPrice
    );

    const violating = related.find((c) => Math.abs(targetPrice / Number(c.currentPrice) - 1) > 0.005);
    if (!violating) return targetPrice;

    const conflictKey = `${rule.id}|${targetPrice.toFixed(2)}|${violating.id}`;
    if (!this.warnedSafetyConflicts.has(conflictKey)) {
      this.warnedSafetyConflicts.add(conflictKey);
      console.warn(`🛑 [BINANCE] Ордер "${rule.name}" (${targetPrice.toFixed(2)}) конфликтует с "${violating.name}" (>0.5%).`);
    }
    return null;
  }
}