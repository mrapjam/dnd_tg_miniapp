// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";

dotenv.config();

// ====== ENV ======
const PORT = process.env.PORT || 10000;
// Пример: https://dnd-tg-miniapp.onrender.com
const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");
// Пример: /telegraf/telegraf-9f2c1a
const BOT_SECRET_PATH = process.env.BOT_SECRET_PATH || `/telegraf/telegraf-${Math.random().toString(16).slice(2, 8)}`;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is not set in environment");
  process.exit(1);
}
if (!APP_URL) {
  console.error("❌ APP_URL is not set in environment (e.g. https://<your>.onrender.com)");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json()); // Telegram шлёт JSON

// ====== BOT ======
const bot = new Telegraf(BOT_TOKEN);

// Логируем все апдейты, чтобы понять — вообще приходят или нет
bot.use(async (ctx, next) => {
  try {
    const u = ctx.update;
    console.log("➡️  Update:", JSON.stringify({
      type: u.message ? "message" :
            u.callback_query ? "callback_query" :
            u.my_chat_member ? "my_chat_member" : "other",
      chat: u.message?.chat?.id || u.callback_query?.message?.chat?.id,
      text: u.message?.text
    }));
  } catch (e) {}
  return next();
});

// Команды
bot.start(async (ctx) => {
  await ctx.reply(
    "Dnd Mini App. Выбери действие:",
    Markup.inlineKeyboard([
      [Markup.button.webApp("Открыть мини‑апп", `${APP_URL}/`)]
    ])
  );
});

bot.command("new", async (ctx) => {
  try {
    await ctx.reply("Команда /new получена. (тестовый ответ)");
    // здесь потом вставим логику создания игры
  } catch (e) {
    console.error("ERROR in /new:", e);
  }
});

// ====== WEBHOOK ======
// Подвешиваем обработчик вебхука на Express
app.use(bot.webhookCallback(BOT_SECRET_PATH));

// Для наглядности: покажем где нас слушает вебхук
app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    webhookPath: BOT_SECRET_PATH,
    appUrl: APP_URL,
  });
});

// Любой корневой GET (для веб‑миниаппа подставь свою раздачу статики)
// Временно просто ответ 200, чтобы Render не ругался
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// Стартуем HTTP и настраиваем вебхук
app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);
  const url = `${APP_URL}${BOT_SECRET_PATH}`;
  try {
    // Сбрасываем старый вебхук (на всякий случай)
    await bot.telegram.deleteWebhook();
    // Ставим новый точный URL
    await bot.telegram.setWebhook(url);
    const info = await bot.telegram.getWebhookInfo();
    console.log("🔗 Webhook set to:", info.url || url);
  } catch (e) {
    console.error("❌ setWebhook error:", e);
  }
});
