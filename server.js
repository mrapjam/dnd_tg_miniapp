// server.js — минимально-рабочий Telegraf + Express с корректным вебхуком и логами
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";

dotenv.config();

// ─── ENV ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;

// ВАЖНО: без завершающего слэша
const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");
if (!APP_URL) {
  console.error("❌ APP_URL is not set. Example: https://dnd-tg-miniapp.onrender.com");
  process.exit(1);
}

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is not set");
  process.exit(1);
}

// Секретный путь вебхука. Если в ENV задан, используем его.
// ГАРАНТИРУЕМ ведущий слэш и формат /telegraf/<что-то>
let BOT_SECRET_PATH = process.env.BOT_SECRET_PATH || "telegraf-9f2c1a";
if (!BOT_SECRET_PATH.startsWith("/")) BOT_SECRET_PATH = "/" + BOT_SECRET_PATH;
if (!BOT_SECRET_PATH.startsWith("/telegraf/")) BOT_SECRET_PATH = "/telegraf" + (BOT_SECRET_PATH === "/" ? "" : BOT_SECRET_PATH);
const WEBHOOK_PATH = BOT_SECRET_PATH;
const WEBHOOK_URL = `${APP_URL}${WEBHOOK_PATH}`;

console.log("ENV check:", { APP_URL, WEBHOOK_PATH, WEBHOOK_URL });

// ─── EXPRESS ────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// корень и health
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/healthz", (req, res) => res.json({ ok: true, appUrl: APP_URL, webhook: WEBHOOK_PATH }));

// ЛОГ ВСЕХ ЗАПРОСОВ на вебхук (для отладки 404)
app.all(WEBHOOK_PATH, (req, res, next) => {
  console.log(`📬 HTTP ${req.method} ${req.originalUrl}  UA=${req.headers["user-agent"] || ""}`);
  next();
});

// ─── BOT ────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// Логируем каждый апдейт от Telegram (если он вообще доходит)
bot.use(async (ctx, next) => {
  try {
    const u = ctx.update;
    console.log("➡️  Update:", {
      type: u.message ? "message" :
            u.callback_query ? "callback_query" :
            u.my_chat_member ? "my_chat_member" : Object.keys(u)[0],
      chat: u.message?.chat?.id || u.callback_query?.message?.chat?.id || null,
      text: u.message?.text || null
    });
  } catch {}
  return next();
});

// /start
bot.start(async (ctx) => {
  await ctx.reply(
    "Dnd Mini App. Нажми, чтобы открыть мини‑апп:",
    Markup.inlineKeyboard([Markup.button.webApp("Открыть", `${APP_URL}/`)])
  );
});

// /new — тестовая реакция
bot.command("new", async (ctx) => {
  await ctx.reply("Команда /new получена ✅");
});

// ПОДКЛЮЧАЕМ ХЭНДЛЕР ВЕБХУКА ИМЕННО НА ЭТОТ ПУТЬ
app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

// ─── START + setWebhook ─────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);
  try {
    // снимаем старый вебхук и дропаем накопившиеся апдейты
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    // ставим новый ровно на WEBHOOK_URL
    await bot.telegram.setWebhook(WEBHOOK_URL);
    const info = await bot.telegram.getWebhookInfo();
    console.log("🔗 getWebhookInfo:", info);
    console.log("✅ Expecting POST to:", WEBHOOK_URL);
  } catch (e) {
    console.error("❌ setWebhook error:", e);
  }
});
