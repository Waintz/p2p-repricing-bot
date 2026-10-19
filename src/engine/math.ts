export interface MarketOrder {
  orderId: string;
  nickName: string;
  price: number;
  payTime: number;
  paymentMethods?: string[];
}

export interface RuleConfig {
  side: "BUY" | "SELL";
  paymentMethod?: string;
  step: number;
  minPrice: number;
  maxPrice: number;
  currentPrice?: number | null;
  allowedPayTimes: number[];
  matchAllCompetitors?: boolean;
  competitors: {
    nickname: string;
    orderIds?: string[];
    isEnabled: boolean;
    step?: number | null;
  }[];
}

export interface CalculationResult {
  targetPrice: number;
  reason: string;
  matchedCompetitor?: {
    nickName: string;
    price: number;
    payTime: number;
    stepUsed: number;
  };
}

function roundPrice(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeNick(nick: string): string {
  return String(nick ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function calculateNewPrice(
  orderBook: MarketOrder[],
  rule: RuleConfig,
): CalculationResult {
  const activeCompetitorsMap = new Map<
    string,
    { nickname: string; orderIds?: string[]; step?: number | null }
  >();

  for (const competitor of rule.competitors) {
    if (competitor.isEnabled) {
      activeCompetitorsMap.set(normalizeNick(competitor.nickname), competitor);
    }
  }

  const matchAllCompetitors = rule.matchAllCompetitors === true;
  const registeredComps = Array.from(activeCompetitorsMap.keys()).join(", ");

  if (activeCompetitorsMap.size === 0 && !matchAllCompetitors) {
    const fallbackPrice = rule.side === "SELL" ? rule.maxPrice : rule.minPrice;
    return {
      targetPrice: roundPrice(fallbackPrice),
      reason: "Нет активных конкурентов в правиле",
    };
  }

  const validCompetitorOrders: {
    order: MarketOrder;
    calculatedPrice: number;
    stepUsed: number;
  }[] = [];

  let matchedByNick = 0;

  for (const order of orderBook) {
    const orderNick = normalizeNick(order.nickName);
    const competitorConfig = activeCompetitorsMap.get(orderNick);

    if (!matchAllCompetitors && !competitorConfig) {
      continue;
    }

    if (
      competitorConfig?.orderIds &&
      competitorConfig.orderIds.length > 0 &&
      !competitorConfig.orderIds.includes(order.orderId)
    ) {
      continue;
    }

    matchedByNick++;

    // Проверяем фильтр по времени оплаты
    if (
      rule.allowedPayTimes.length > 0 &&
      !rule.allowedPayTimes.includes(order.payTime)
    ) {
      continue;
    }

    // Если ордер выходит за рамки коридора — просто пропускаем ЭТО конкретное объявление
    // (не блокируя остальные объявления этого же конкурента!)
    if (rule.side === "BUY" && order.price > rule.maxPrice) {
      continue;
    }
    if (rule.side === "SELL" && order.price < rule.minPrice) {
      continue;
    }

    const stepUsed =
      competitorConfig?.step !== null && competitorConfig?.step !== undefined
        ? competitorConfig.step
        : rule.step;

    let target =
      rule.side === "BUY" ? order.price + stepUsed : order.price - stepUsed;

    target = roundPrice(target);

    if (rule.side === "BUY") {
      if (target > rule.maxPrice) {
        target = rule.minPrice;
      } else if (target < rule.minPrice) {
        target = rule.minPrice;
      }
    } else {
      if (target < rule.minPrice) {
        target = rule.maxPrice;
      } else if (target > rule.maxPrice) {
        target = rule.maxPrice;
      }
    }

    validCompetitorOrders.push({
      order,
      calculatedPrice: roundPrice(target),
      stepUsed,
    });
  }

  if (validCompetitorOrders.length === 0) {
    const hasCurrentPrice =
      rule.currentPrice !== null &&
      rule.currentPrice !== undefined &&
      Number.isFinite(rule.currentPrice);

    const shouldHoldPrice = matchedByNick > 0 && hasCurrentPrice;

    const fallbackPrice = shouldHoldPrice
      ? Math.min(rule.maxPrice, Math.max(rule.minPrice, rule.currentPrice!))
      : rule.side === "SELL"
        ? rule.maxPrice
        : rule.minPrice;

    const reason =
      matchedByNick === 0
        ? `конкуренты не найдены в активном стакане`
        : `конкуренты найдены (${matchedByNick}), но вне лимитов времени/коридора [${rule.minPrice}..${rule.maxPrice}]`;

    return {
      targetPrice: roundPrice(fallbackPrice),
      reason: shouldHoldPrice
        ? `[${registeredComps}] ${reason} -> удерживаем текущую цену`
        : `[${registeredComps}] ${reason}`,
    };
  }

  if (rule.side === "BUY") {
    validCompetitorOrders.sort((a, b) => b.calculatedPrice - a.calculatedPrice);
  } else {
    validCompetitorOrders.sort((a, b) => a.calculatedPrice - b.calculatedPrice);
  }

  const best = validCompetitorOrders[0];

  return {
    targetPrice: best.calculatedPrice,
    reason: `Перебиваем [${best.order.nickName}] (цена: ${best.order.price}, шаг: ${
      rule.side === "BUY" ? "+" : "-"
    }${best.stepUsed})`,
    matchedCompetitor: {
      nickName: best.order.nickName,
      price: best.order.price,
      payTime: best.order.payTime,
      stepUsed: best.stepUsed,
    },
  };
}
