import { MarketOrder } from "../engine/math";

export interface FetchOrderBookParams {
  asset: "USDT" | "USDC";
  fiat: string;
  side: "BUY" | "SELL";
  paymentMethod: string;
  competitorNicks?: string[];
  minPrice?: number;
  maxPrice?: number;
  matchAllCompetitors?: boolean;
}

export interface IExchangeAdapter {
  readonly name: string;

  /**
   * Получение публичного стакана ордеров (без использования приватных ключей)
   */
  fetchOrderBook(params: FetchOrderBookParams): Promise<MarketOrder[]>;

  /**
   * Обновление цены нашего объявления через приватное API биржи
   * Возвращает true, если цена успешно изменена
   */
  updateAdPrice(adId: string, newPrice: number): Promise<boolean>;
}
