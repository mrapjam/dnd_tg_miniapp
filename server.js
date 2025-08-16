// server.js — Telegraf + Express с корректным вебхуком

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";

dotenv.config();

// ────────────────────────────────────────────────────────────
// Константы окружения
// ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN;

// Секретная часть пути вебхука (фиксированное значение, чтобы совпало с тем,
// что видим в getWebhookInfo: ".../telegraf/telegraf-9f2c1a")
const WEBHOOK_PATH = "/telegraf/telegraf-9f2c1a";
const WEBHOOK_URL = `${APP_URL}${WEBHOOK_PATH}`;

// ────────────────────────────────────────────────────────────
// Базовые проверки
// ────────────────────────────────────────────────────────────
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing. Set it in environment variables.");
  process.exit(1);
}

// ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// __dirname для ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Отдача статики мини‑аппа (если используешь папку webapp с index.html)
const WEB_DIR = path.join(__dirname, "webapp");
app.use(express.static(WEB_DIR));

// health‑чек
app.get("/", (_req, res) => res.send("Bot is running 🚀"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ────────────────────────────────────────────────────────────
// Инициализация бота
// ────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// Простейшая команда /start
bot.start(async (ctx) => {
  try {
    await ctx.reply(
      "Dnd Mini App. Нажми, чтобы открыть мини‑приложение:",
      Markup.inlineKeyboard([
        Markup.button.webApp("Открыть мини‑апп", APP_URL),
      ])
    );
  } catch (e) {
    console.error("Error on /start:", e);
  }
});

// Пример: /new (просто подтверждаем, что бот жив)
bot.command("new", async (ctx) => {
  await ctx.reply("Команда /new получена ✅. (Тест вебхука)");
});

// Логируем все апдейты (на первых порах полезно)
bot.on("message", (ctx) => {
  console.log("Update: message from", ctx.from?.id, "text:", ctx.message?.text);
});

// Повесили обработчик вебхука на ТОТ ЖЕ путь
app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

// ────────────────────────────────────────────────────────────
// Старт сервера + установка вебхука
// ────────────────────────────────────────────────────────────
async function bootstrap() {
  // Запускаем http‑сервер
  app.listen(PORT, async () => {
    console.log(`🌐 Web server on ${PORT}`);
    try {
      // Сначала удалим старый вебхук (если был)
      await bot.telegram.deleteWebhook().catch(() => {});
      // Ставим новый на точный URL
      await bot.telegram.setWebhook(WEBHOOK_URL);
      console.log("🔗 Webhook set:", WEBHOOK_URL);

      // Проверим, что Telegram его видит
      const info = await bot.telegram.getWebhookInfo();
      console.log("ℹ️ getWebhookInfo:", info);
    } catch (err) {
      console.error("❌ Failed to set webhook:", err);
    }
  });
}

bootstrap().catch((e) => console.error("Bootstrap error:", e));

// Без graceful‑shutdown Render иногда долго держит процесс
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e));
