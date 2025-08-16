// server.js — минимально-рабочий webhook-сервер Telegraf

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";

dotenv.config();

// ====== НАСТРОЙКИ ======
const PORT = process.env.PORT || 10000;

// В .env/Render ENV задай APP_URL = https://dnd-tg-miniapp.onrender.com (БЕЗ слеша в конце)
const RAW_APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const APP_URL = RAW_APP_URL.replace(/\/+$/, ""); // убираем завершающий слеш

// Твой токен
const BOT_TOKEN = process.env.BOT_TOKEN || "7496680205:AAFn9GaZEysoBJmyVohLmzQiZDayCGmKlBs";

// ВАЖНО: один и тот же путь в Express + setWebhook!
const WEBHOOK_PATH = "/telegraf/telegraf-9f2c1a";
const WEBHOOK_URL = `${APP_URL}${WEBHOOK_PATH}`;

// ====== EXPRESS ======
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Простой корень, чтобы не было “Cannot GET /”
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// ВАЖНО: Telegram дергает POST по webhook-пути. Мы ещё вернём 200 и на GET,
// чтобы ваши ручные проверки не видели 404.
app.get(WEBHOOK_PATH, (req, res) => {
  res.status(200).send("Webhook OK (GET)");
});

// ====== BOT (Telegraf) ======
if (!BOT_TOKEN || !/^(\d+):[\w-]+$/.test(BOT_TOKEN)) {
  console.error("❌ BOT_TOKEN пустой или некорректный. Проверь переменные окружения.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN, {
  // Оставляем стандартные настройки
});

// Команды для проверки
bot.start(async (ctx) => {
  try {
    await ctx.reply(
      "Dnd Mini App: бот жив. Используй /new для генерации кода мини-аппа.",
      Markup.inlineKeyboard([
        Markup.button.url("Открыть мини-апп", `${APP_URL}/?code=${genCode()}`)
      ])
    );
  } catch (e) {
    console.error("start error:", e);
  }
});

bot.command("new", async (ctx) => {
  const code = genCode();
  try {
    await ctx.reply(
      `Создана игра. Код: ${code}\nОткрой мини‑апп и продолжай.`,
      Markup.inlineKeyboard([
        Markup.button.url("Открыть мини‑апп", `${APP_URL}/?code=${code}`)
      ])
    );
  } catch (e) {
    console.error("new error:", e);
    await ctx.reply("Не удалось создать игру. Попробуй ещё раз.");
  }
});

// Хэндлер на всё остальное — просто молчим/логируем
bot.on("message", (ctx) => {
  console.log("Update:", ctx.updateType);
});

// ====== ПОДКЛЮЧАЕМ WEBHOOK В EXPRESS ======
app.use(bot.webhookCallback(WEBHOOK_PATH));

// ====== СТАРТ СЕРВЕРА И УСТАНОВКА ВЕБХУКА ======
app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);
  try {
    // снимаем старый вебхук на всякий
    await bot.telegram.deleteWebhook().catch(() => {});

    // ставим новый
    await bot.telegram.setWebhook(WEBHOOK_URL, {
      drop_pending_updates: true
    });

    // проверяем что Telegram принял адрес
    const info = await bot.telegram.getWebhookInfo();
    console.log("🔗 Webhook set:", info.url || WEBHOOK_URL);
  } catch (e) {
    console.error("Failed to set webhook:", e);
  }
});

// ====== utils ======
function genCode() {
  return Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(2, 8);
}
