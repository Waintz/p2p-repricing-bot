import { Bot, Context, InlineKeyboard, session, SessionFlavor } from "grammy";
import { ENV } from "../config/env";
import { prisma } from "../database/prisma";
import { EXCHANGES, PAYMENT_METHODS, PAY_TIMES } from "../config/constants";
import { BybitAdapter } from "../exchanges/bybit.adapter";
import { BinanceAdapter } from "../exchanges/binance.adapter";

const bybitAdapter = new BybitAdapter();
const binanceAdapter = new BinanceAdapter();

interface SessionData {
  awaitingInput?: {
    type:
      | "STEP"
      | "MIN_PRICE"
      | "MAX_PRICE"
      | "ADD_COMPETITOR"
      | "AD_NAME"
      | "AD_ID"
      | "COMP_STEP";
    ruleId: number;
    compId?: number;
  };
}

export type BotContext = Context & SessionFlavor<SessionData>;

export const bot = new Bot<BotContext>(ENV.BOT_TOKEN);

bot.use(
  session({
    initial: (): SessionData => ({}),
  }),
);

bot.use(async (ctx, next) => {
  if (ENV.ADMIN_TG_ID && ctx.from?.id !== ENV.ADMIN_TG_ID) {
    await ctx.reply(`⛔ Доступ запрещен. Ваш Telegram ID: ${ctx.from?.id}`);
    return;
  }
  await next();
});

async function showMainMenu(ctx: BotContext, isEdit = false) {
  ctx.session.awaitingInput = undefined;
  const text =
    "🤖 <b>Панель управления P2P-репрайсингом</b>\n\nВыберите биржу для настройки объявлений:";

  const kb = new InlineKeyboard();
  for (const ex of EXCHANGES) {
    const count = await prisma.adRule.count({ where: { exchange: ex } });
    const activeCount = await prisma.adRule.count({
      where: { exchange: ex, isActive: true },
    });
    kb.text(`${ex} (Всего: ${count} | 🟢 ${activeCount})`, `ex:${ex}`).row();
  }

  if (isEdit && ctx.callbackQuery) {
    await ctx
      .editMessageText(text, { parse_mode: "HTML", reply_markup: kb })
      .catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

async function showExchangeAds(ctx: BotContext, exchange: string) {
  ctx.session.awaitingInput = undefined;
  const rules = await prisma.adRule.findMany({
    where: { exchange },
    orderBy: { id: "asc" },
  });

  let text = `🏦 <b>Биржа: ${exchange}</b>\n\n`;
  text += rules.length
    ? "Выберите объявление для настройки или создайте новое:"
    : "У вас пока нет добавленных объявлений для этой биржи.";

  const kb = new InlineKeyboard();
  for (const r of rules) {
    const statusIcon = r.isActive ? "🟢" : "🔴";
    const sideText = r.side === "SELL" ? "Продажа" : "Покупка";
    kb.text(
      `${statusIcon} ${r.name} [${r.asset}/${r.fiat} • ${sideText}]`,
      `rule:${r.id}`,
    ).row();
  }

  kb.text("➕ Добавить объявление", `add_rule:${exchange}`).row();
  kb.text("⬅️ Назад к биржам", "main_menu");

  await ctx
    .editMessageText(text, { parse_mode: "HTML", reply_markup: kb })
    .catch(() => {});
}

export async function showRuleCard(
  ctx: BotContext,
  ruleId: number,
  isEdit = true,
) {
  ctx.session.awaitingInput = undefined;
  const rule = await prisma.adRule.findUnique({
    where: { id: ruleId },
    include: { competitors: true },
  });

  if (!rule) {
    await ctx.reply("❌ Объявление не найдено.");
    return;
  }

  const activeComps = rule.competitors.filter((c) => c.isEnabled).length;
  const payTimes: number[] = JSON.parse(rule.allowedPayTimes || "[]");
  const payMethodLabel =
    PAYMENT_METHODS[rule.paymentMethod] || rule.paymentMethod;
  const sideLabel = rule.side === "SELL" ? "Продажа (SELL)" : "Покупка (BUY)";

  const text =
    `⚙️ <b>Настройка объявления: ${rule.name}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏦 <b>Биржа:</b> ${rule.exchange}\n` +
    `🆔 <b>ID ордера на бирже:</b> <code>${rule.adId || "Не указан"}</code>\n` +
    `🪙 <b>Валютная пара:</b> ${rule.asset} / ${rule.fiat}\n` +
    `🔄 <b>Тип:</b> ${sideLabel}\n` +
    `💳 <b>Способ оплаты:</b> ${payMethodLabel}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📏 <b>Общий шаг перебивания:</b> ${rule.step.toFixed(2)} грн\n` +
    `📉 <b>Мин. / Базовая цена:</b> ${rule.minPrice.toFixed(2)} грн\n` +
    `📈 <b>Макс. цена (потолок):</b> ${rule.maxPrice.toFixed(2)} грн\n` +
    `⏱ <b>Лимит времени оплаты:</b> ${payTimes.length ? payTimes.join(", ") + " мин" : "Не выбрано"}\n` +
    `🎯 <b>Режим конкурентов:</b> ${rule.matchAllCompetitors ? "все объявления банка" : "только выбранные ники"}\n` +
    `👥 <b>Конкуренты:</b> активных ${activeComps} из ${rule.competitors.length}\n` +
    `💰 <b>Текущая выставленная цена:</b> ${rule.currentPrice ? rule.currentPrice.toFixed(2) + " грн" : "—"}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Статус: ${rule.isActive ? "🟢 <b>РАБОТАЕТ (Слежение включено)</b>" : "🔴 <b>ОСТАНОВЛЕНО</b>"}`;

  const kb = new InlineKeyboard()
    .text(
      rule.isActive ? "🔴 Выключить слежение" : "🟢 Включить слежение",
      `toggle_active:${rule.id}`,
    )
    .row()
    .text(`🪙 Валюта: ${rule.asset}`, `toggle_asset:${rule.id}`)
    .text(`🔄 Тип: ${rule.side}`, `toggle_side:${rule.id}`)
    .row()
    .text(`💳 Банк: ${payMethodLabel}`, `menu_bank:${rule.id}`)
    .row()
    .text(
      rule.matchAllCompetitors
        ? "🎯 Все объявления банка: ВКЛ"
        : "🎯 Все объявления банка: ВЫКЛ",
      `toggle_all_comp:${rule.id}`,
    )
    .row()
    .text(
      `👥 Конкуренты (${activeComps}/${rule.competitors.length})`,
      `menu_comp:${rule.id}`,
    )
    .text(`⏱ Время оплаты`, `menu_time:${rule.id}`)
    .row()
    .text(`📏 Шаг: ${rule.step}`, `ask_input:STEP:${rule.id}`)
    .text(`📉 Мин: ${rule.minPrice}`, `ask_input:MIN_PRICE:${rule.id}`)
    .text(`📈 Макс: ${rule.maxPrice}`, `ask_input:MAX_PRICE:${rule.id}`)
    .row();

  if (rule.exchange === "BYBIT") {
    kb.text(`📋 Выбрать ордер из Bybit`, `fetch_bybit_ads:${rule.id}`).row();
  } else if (rule.exchange === "BINANCE") {
    kb.text(
      `📋 Выбрать ордер из Binance`,
      `fetch_binance_ads:${rule.id}`,
    ).row();
  }

  kb.text(`🆔 Ввести ID вручную`, `ask_input:AD_ID:${rule.id}`)
    .text(`✏️ Название`, `ask_input:AD_NAME:${rule.id}`)
    .row()
    .text(`🗑 Удалить объявление`, `del_rule:${rule.id}`)
    .row()
    .text(`⬅️ Назад к списку (${rule.exchange})`, `ex:${rule.exchange}`);

  if (isEdit && ctx.callbackQuery) {
    await ctx
      .editMessageText(text, { parse_mode: "HTML", reply_markup: kb })
      .catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

bot.callbackQuery(/^fetch_bybit_ads:(\d+)$/, async (ctx) => {
  const ruleId = Number(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: "Загружаю объявления из Bybit..." });

  const ads = await bybitAdapter.fetchMyAds();

  if (ads.length === 0) {
    await ctx.reply(
      "⚠️ Объявления не найдены или не указаны валидные API-ключи Bybit в .env (нужен доступ P2P/OTC).",
    );
    return;
  }

  const kb = new InlineKeyboard();
  for (const ad of ads) {
    const sideText = ad.side === "SELL" ? "ПРОДАЖА" : "ПОКУПКА";
    kb.text(
      `#${ad.id.slice(-6)} | ${sideText} | ${ad.tokenId} | ${ad.price} UAH`,
      `set_ad_id:${ruleId}:${ad.id}`,
    ).row();
  }
  kb.text("⬅️ Назад к карточке", `rule:${ruleId}`);

  await ctx.editMessageText(
    "📋 <b>Выберите объявление из вашего аккаунта Bybit:</b>\n\nНажмите на нужный ордер, чтобы привязать его:",
    { parse_mode: "HTML", reply_markup: kb },
  );
});

bot.callbackQuery(/^fetch_binance_ads:(\d+)$/, async (ctx) => {
  const ruleId = Number(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: "Загружаю объявления из Binance..." });

  const ads = await binanceAdapter.fetchMyAds();

  if (ads.length === 0) {
    await ctx.reply(
      "⚠️ Объявления не найдены или нет прав у API-ключа Binance. Можно ввести ID ордера вручную.",
    );
    return;
  }

  const kb = new InlineKeyboard();
  for (const ad of ads) {
    const sideText = ad.tradeType === "SELL" ? "ПРОДАЖА" : "ПОКУПКА";
    kb.text(
      `#${ad.advNo.slice(-6)} | ${sideText} | ${ad.asset} | ${ad.price} UAH`,
      `set_ad_id:${ruleId}:${ad.advNo}`,
    ).row();
  }
  kb.text("⬅️ Назад к карточке", `rule:${ruleId}`);

  await ctx.editMessageText(
    "📋 <b>Выберите объявление из Binance:</b>\n\nНажмите на нужный ордер для привязки:",
    { parse_mode: "HTML", reply_markup: kb },
  );
});

bot.callbackQuery(/^set_ad_id:(\d+):(\d+)$/, async (ctx) => {
  const ruleId = Number(ctx.match[1]);
  const adId = ctx.match[2];

  await prisma.adRule.update({
    where: { id: ruleId },
    data: { adId },
  });

  await ctx.answerCallbackQuery(`✅ Привязано объявление #${adId}`);
  await showRuleCard(ctx, ruleId, true);
});

bot.command("start", async (ctx) => {
  await showMainMenu(ctx, false);
});

bot.callbackQuery("main_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showMainMenu(ctx, true);
});

bot.callbackQuery(/^ex:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const exchange = ctx.match[1];
  await showExchangeAds(ctx, exchange);
});

bot.callbackQuery(/^add_rule:(.+)$/, async (ctx) => {
  const exchange = ctx.match[1];
  const count = await prisma.adRule.count({ where: { exchange } });
  const newRule = await prisma.adRule.create({
    data: {
      exchange,
      adId: "",
      name: `Объявление #${count + 1}`,
      asset: "USDT",
      fiat: "UAH",
      side: "BUY",
      paymentMethod: "MONOBANK_CARD",
      step: 0.01,
      minPrice: 45.5,
      maxPrice: 55.0,
      allowedPayTimes: "[15,30]",
      isActive: false,
    },
  });
  await ctx.answerCallbackQuery("✅ Объявление создано");
  await showRuleCard(ctx, newRule.id, true);
});

bot.callbackQuery(/^rule:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ruleId = Number(ctx.match[1]);
  await showRuleCard(ctx, ruleId, true);
});

bot.callbackQuery(/^toggle_active:(\d+)$/, async (ctx) => {
  const ruleId = Number(ctx.match[1]);
  const rule = await prisma.adRule.findUnique({ where: { id: ruleId } });
  if (!rule) return;

  const updated = await prisma.adRule.update({
    where: { id: ruleId },
    data: { isActive: !rule.isActive },
  });

  await ctx.answerCallbackQuery(
    updated.isActive ? "🟢 Слежение запущено!" : "🔴 Слежение остановлено!",
  );
  await showRuleCard(ctx, ruleId, true);
});

bot.callbackQuery(/^toggle_asset:(\d+)$/, async (ctx) => {
  const ruleId = Number(ctx.match[1]);
  const rule = await prisma.adRule.findUnique({ where: { id: ruleId } });
  if (!rule) return;

  const nextAsset = rule.asset === "USDT" ? "USDC" : "USDT";
  await prisma.adRule.update({
    where: { id: ruleId },
    data: { asset: nextAsset },
  });

  await ctx.answerCallbackQuery(`Валюта изменена на ${nextAsset}/UAH`);
  await showRuleCard(ctx, ruleId, true);
});

bot.callbackQuery(/^toggle_side:(\d+)$/, async (ctx) => {
  const ruleId = Number(ctx.match[1]);
  const rule = await prisma.adRule.findUnique({ where: { id: ruleId } });
  if (!rule) return;

  const nextSide = rule.side === "SELL" ? "BUY" : "SELL";
  await prisma.adRule.update({
    where: { id: ruleId },
    data: { side: nextSide },
  });

  await ctx.answerCallbackQuery(`Тип изменен на ${nextSide}`);
  await showRuleCard(ctx, ruleId, true);
});

bot.callbackQuery(/^menu_bank:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ruleId = Number(ctx.match[1]);
  const rule = await prisma.adRule.findUnique({ where: { id: ruleId } });
  if (!rule) return;

  const kb = new InlineKeyboard();
  for (const [code, label] of Object.entries(PAYMENT_METHODS)) {
    const mark = rule.paymentMethod === code ? "✅ " : "";
    kb.text(`${mark}${label}`, `set_bank:${ruleId}:${code}`).row();
  }
  kb.text("⬅️ Назад к объявлению", `rule:${ruleId}`);

  await ctx.editMessageText("💳 <b>Выберите способ оплаты (банк / IBAN):</b>", {
    parse_mode: "HTML",
    reply_markup: kb,
  });
});

bot.callbackQuery(/^set_bank:(\d+):(.+)$/, async (ctx) => {
  const ruleId = Number(ctx.match[1]);
  const bankCode = ctx.match[2];
  await prisma.adRule.update({
    where: { id: ruleId },
    data: { paymentMethod: bankCode },
  });
  await ctx.answerCallbackQuery("✅ Способ оплаты обновлен");
  await showRuleCard(ctx, ruleId, true);
});

bot.callbackQuery(/^toggle_all_comp:(\d+)$/, async (ctx) => {
  const ruleId = Number(ctx.match[1]);
  const rule = await prisma.adRule.findUnique({ where: { id: ruleId } });
  if (!rule) return;

  await prisma.adRule.update({
    where: { id: ruleId },
    data: { matchAllCompetitors: !rule.matchAllCompetitors },
  });
  await ctx.answerCallbackQuery(
    !rule.matchAllCompetitors
      ? "✅ Теперь перебиваются все объявления выбранного банка"
      : "✅ Снова учитываются только выбранные ники",
  );
  await showRuleCard(ctx, ruleId, true);
});

async function renderTimeMenu(ctx: BotContext, ruleId: number) {
  const rule = await prisma.adRule.findUnique({ where: { id: ruleId } });
  if (!rule) return;

  const currentTimes: number[] = JSON.parse(rule.allowedPayTimes || "[]");
  const kb = new InlineKeyboard();

  for (const t of PAY_TIMES) {
    const isChecked = currentTimes.includes(t);
    kb.text(
      `${isChecked ? "✅" : "❌"} ${t} минут`,
      `toggle_time:${ruleId}:${t}`,
    ).row();
  }
  kb.text("⬅️ Готово (Назад)", `rule:${ruleId}`);

  await ctx
    .editMessageText(
      "⏱ <b>Лимит времени оплаты конкурентов</b>\n\nОтметьте значения, которые бот должен учитывать:",
      { parse_mode: "HTML", reply_markup: kb },
    )
    .catch(() => {});
}

bot.callbackQuery(/^menu_time:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderTimeMenu(ctx, Number(ctx.match[1]));
});

bot.callbackQuery(/^toggle_time:(\d+):(\d+)$/, async (ctx) => {
  const ruleId = Number(ctx.match[1]);
  const timeVal = Number(ctx.match[2]);
  const rule = await prisma.adRule.findUnique({ where: { id: ruleId } });
  if (!rule) return;

  let currentTimes: number[] = JSON.parse(rule.allowedPayTimes || "[]");
  if (currentTimes.includes(timeVal)) {
    currentTimes = currentTimes.filter((t) => t !== timeVal);
  } else {
    currentTimes.push(timeVal);
    currentTimes.sort((a, b) => a - b);
  }

  await prisma.adRule.update({
    where: { id: ruleId },
    data: { allowedPayTimes: JSON.stringify(currentTimes) },
  });

  await ctx.answerCallbackQuery();
  await renderTimeMenu(ctx, ruleId);
});

async function renderCompetitorsMenu(ctx: BotContext, ruleId: number) {
  const rule = await prisma.adRule.findUnique({
    where: { id: ruleId },
    include: { competitors: { orderBy: { id: "asc" } } },
  });
  if (!rule) return;

  let text = `👥 <b>Конкуренты для "${rule.name}"</b>\n\n`;
  text +=
    "• Нажмите <b>ник</b>, чтобы включить/выключить\n" +
    "• Нажмите <b>кнопку с шагом</b>, чтобы задать персональный шаг\n" +
    "• Нажмите 🗑 для удаления:";

  const kb = new InlineKeyboard();
  for (const comp of rule.competitors) {
    const icon = comp.isEnabled ? "✅" : "❌";
    const stepLabel =
      comp.step !== null && comp.step !== undefined
        ? `Шаг: ${comp.step.toFixed(2)}`
        : `Шаг: общий (${rule.step.toFixed(2)})`;

    kb.text(`${icon} ${comp.nickname}`, `toggle_comp:${comp.id}:${ruleId}`)
      .text(`📏 ${stepLabel}`, `ask_comp_step:${comp.id}:${ruleId}`)
      .text("🗑", `del_comp:${comp.id}:${ruleId}`)
      .row();
  }

  kb.text(
    "➕ Добавить конкурента (ник)",
    `ask_input:ADD_COMPETITOR:${ruleId}`,
  ).row();
  kb.text("⬅️ Назад к объявлению", `rule:${ruleId}`);

  await ctx
    .editMessageText(text, { parse_mode: "HTML", reply_markup: kb })
    .catch(() => {});
}

bot.callbackQuery(/^menu_comp:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderCompetitorsMenu(ctx, Number(ctx.match[1]));
});

bot.callbackQuery(/^toggle_comp:(\d+):(\d+)$/, async (ctx) => {
  const compId = Number(ctx.match[1]);
  const ruleId = Number(ctx.match[2]);
  const comp = await prisma.competitor.findUnique({ where: { id: compId } });
  if (!comp) return;

  await prisma.competitor.update({
    where: { id: compId },
    data: { isEnabled: !comp.isEnabled },
  });

  await ctx.answerCallbackQuery(
    comp.isEnabled ? "Конкурент отключен" : "Конкурент включен",
  );
  await renderCompetitorsMenu(ctx, ruleId);
});

bot.callbackQuery(/^del_comp:(\d+):(\d+)$/, async (ctx) => {
  const compId = Number(ctx.match[1]);
  const ruleId = Number(ctx.match[2]);
  await prisma.competitor.delete({ where: { id: compId } }).catch(() => {});
  await ctx.answerCallbackQuery("🗑 Конкурент удален");
  await renderCompetitorsMenu(ctx, ruleId);
});

bot.callbackQuery(/^ask_comp_step:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const compId = Number(ctx.match[1]);
  const ruleId = Number(ctx.match[2]);

  const comp = await prisma.competitor.findUnique({ where: { id: compId } });
  if (!comp) return;

  ctx.session.awaitingInput = {
    type: "COMP_STEP",
    ruleId,
    compId,
  };

  const kb = new InlineKeyboard()
    .text("🔄 Сбросить на общий шаг", `reset_comp_step:${compId}:${ruleId}`)
    .row()
    .text("❌ Отмена", `menu_comp:${ruleId}`);

  await ctx.editMessageText(
    `📏 Введите персональный шаг перебивания для <b>${comp.nickname}</b> в грн\n` +
      `(например: <code>0.00</code> для следования в цену или <code>0.01</code>):`,
    { parse_mode: "HTML", reply_markup: kb },
  );
});

bot.callbackQuery(/^reset_comp_step:(\d+):(\d+)$/, async (ctx) => {
  const compId = Number(ctx.match[1]);
  const ruleId = Number(ctx.match[2]);

  await prisma.competitor.update({
    where: { id: compId },
    data: { step: null },
  });

  ctx.session.awaitingInput = undefined;
  await ctx.answerCallbackQuery("Сброшено на общий шаг");
  await renderCompetitorsMenu(ctx, ruleId);
});

bot.callbackQuery(/^del_rule:(\d+)$/, async (ctx) => {
  const ruleId = Number(ctx.match[1]);
  const rule = await prisma.adRule.findUnique({ where: { id: ruleId } });
  if (!rule) return;

  await prisma.adRule.delete({ where: { id: ruleId } });
  await ctx.answerCallbackQuery("🗑 Объявление удалено");
  await showExchangeAds(ctx, rule.exchange);
});

bot.callbackQuery(/^ask_input:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const type = ctx.match[1] as NonNullable<
    SessionData["awaitingInput"]
  >["type"];
  const ruleId = Number(ctx.match[2]);

  ctx.session.awaitingInput = { type, ruleId };

  const prompts: Record<typeof type, string> = {
    STEP: "📏 Введите <b>общий шаг перебивания цены</b> в грн (например: <code>0.01</code> или <code>0.00</code>):",
    MIN_PRICE:
      "📉 Введите <b>минимальную (базовую) цену</b> в грн (например: <code>45.50</code>):",
    MAX_PRICE:
      "📈 Введите <b>максимальную цену (потолок)</b> в грн (например: <code>55.00</code>):",
    ADD_COMPETITOR:
      "👤 Введите точный <b>ник конкурента</b> на бирже (или несколько ников через запятую):",
    AD_ID: "🆔 Введите <b>ID вашего объявления</b> на бирже вручную:",
    AD_NAME:
      "✏️ Введите понятное <b>название для объявления</b> (например: <code>Моно Карта USDT #1</code>):",
    COMP_STEP: "📏 Введите персональный шаг:",
  };

  const kb = new InlineKeyboard().text("❌ Отмена", `rule:${ruleId}`);
  await ctx.editMessageText(prompts[type], {
    parse_mode: "HTML",
    reply_markup: kb,
  });
});

bot.on("message:text", async (ctx) => {
  const input = ctx.session.awaitingInput;
  if (!input) {
    await showMainMenu(ctx, false);
    return;
  }

  const { type, ruleId, compId } = input;
  const rawText = ctx.message.text.trim();

  if (type === "STEP" || type === "MIN_PRICE" || type === "MAX_PRICE") {
    const val = parseFloat(rawText.replace(",", "."));
    if (isNaN(val) || (type === "STEP" ? val < 0 : val <= 0)) {
      await ctx.reply(
        "❌ Ошибка! Введите корректное число (например: 0.00, 0.01 или 45.50).",
      );
      return;
    }

    const fieldMap = {
      STEP: "step",
      MIN_PRICE: "minPrice",
      MAX_PRICE: "maxPrice",
    } as const;

    await prisma.adRule.update({
      where: { id: ruleId },
      data: { [fieldMap[type]]: val },
    });

    ctx.session.awaitingInput = undefined;
    await ctx.reply("✅ Значение сохранено!");
    await showRuleCard(ctx, ruleId, false);
    return;
  }

  if (type === "COMP_STEP" && compId) {
    const val = parseFloat(rawText.replace(",", "."));
    if (isNaN(val) || val < 0) {
      await ctx.reply(
        "❌ Ошибка! Введите корректное число >= 0 (например: 0.00 или 0.01).",
      );
      return;
    }

    await prisma.competitor.update({
      where: { id: compId },
      data: { step: val },
    });

    ctx.session.awaitingInput = undefined;
    await ctx.reply("✅ Персональный шаг сохранен!");
    await renderCompetitorsMenu(ctx, ruleId);
    return;
  }

  if (type === "ADD_COMPETITOR") {
    const nicks = rawText
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);

    for (const nickname of nicks) {
      await prisma.competitor
        .upsert({
          where: { adRuleId_nickname: { adRuleId: ruleId, nickname } },
          update: { isEnabled: true },
          create: { adRuleId: ruleId, nickname, isEnabled: true },
        })
        .catch(() => {});
    }

    ctx.session.awaitingInput = undefined;
    await ctx.reply(`✅ Добавлено конкурентов: ${nicks.length}`);
    await showRuleCard(ctx, ruleId, false);
    return;
  }

  if (type === "AD_ID" || type === "AD_NAME") {
    await prisma.adRule.update({
      where: { id: ruleId },
      data: type === "AD_ID" ? { adId: rawText } : { name: rawText },
    });

    ctx.session.awaitingInput = undefined;
    await ctx.reply("✅ Обновлено!");
    await showRuleCard(ctx, ruleId, false);
  }
});
