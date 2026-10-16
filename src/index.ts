import { prisma } from "./database/prisma";
import { bot } from "./bot/bot";
import { RepricingWorker } from "./engine/worker";
import "dotenv/config";

process.on("unhandledRejection", (reason: any) => {
  console.error("⚠️ [Unhandled Rejection]:", reason?.message || reason);
});

process.on("uncaughtException", (err: Error) => {
  console.error("❌ [Uncaught Exception]:", err.message);
});

async function bootstrap() {
  console.log("🚀 Запуск P2P-репрайсинга...");

  try {
    const count = await prisma.adRule.count();
    console.log(`✅ SQLite база подключена (активных правил: ${count})`);
  } catch (err: any) {
    console.error("❌ Ошибка подключения БД:", err.message);
  }

  const worker = new RepricingWorker();
  worker.start(15000);

  bot.catch((err) => {
    console.error("❌ Ошибка в Telegram-боте:", err.message);
  });

  await bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Бот @${botInfo.username} онлайн и слушает команды`);
    },
  });
}

bootstrap();