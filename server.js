// server.js — минимально рабочий вебхук Telegraf + Express с логами

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';

dotenv.config();

// ====== ENV ======
const PORT = process.env.PORT || 10000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_SECRET_PATH = process.env.BOT_SECRET_PATH || 'telegraf-9f2c1a';

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is not set');
  process.exit(1);
}

// ====== APP & BOT ======
const app = express();

// важный порядок: сначала json, потом логгер, потом вебхук
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// логгер запросов к вебхуку — чтобы в Render Logs видеть тел тела апдейтов
app.use(`/telegraf/${BOT_SECRET_PATH}`, (req, res, next) => {
  try {
    const ua = req.headers['user-agent'] || '';
    console.log(`⟵ HTTP ${req.method} ${req.originalUrl} UA=${ua}`);
    // Telegram присылает JSON-апдейт в body
    if (req.body && typeof req.body === 'object') {
      console.log('⟵ Update body:', JSON.stringify(req.body));
    } else {
      console.log('⟵ No/invalid JSON body');
    }
  } catch (e) {
    console.log('log middleware error', e);
  }
  next();
});

const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 12_000,
});

// Базовые обработчики для проверки, что бот «слышит»
bot.start(async (ctx) => {
  await ctx.reply('Привет! Я на вебхуке и жив. Команда /new создаст тестовый код.');
});

bot.command('new', async (ctx) => {
  // простой «код игры» для проверки
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  await ctx.reply(
    `Создана тест-игра. Код: ${code}\nНажми "Открыть мини-апп" (заглушка).`,
    Markup.inlineKeyboard([
      [Markup.button.webApp('Открыть мини-апп', `${APP_URL}/`)]
    ])
  );
});

// Логируем всё остальное, чтобы видеть апдейты
bot.on('message', async (ctx, next) => {
  try {
    const u = ctx.update;
    console.log('📩 message update:', JSON.stringify(u));
  } catch (e) {}
  return next();
});

bot.on('callback_query', async (ctx, next) => {
  try {
    console.log('🔘 callback_query:', JSON.stringify(ctx.update));
  } catch (e) {}
  return next();
});

// ====== Маршруты диагностики ======
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/whoami', (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    appUrl: APP_URL,
    webhookPath: `/telegraf/${BOT_SECRET_PATH}`,
  });
});

// 404 на любые другие GET — это нормально для вебхука
app.get('*', (req, res) => {
  res.status(404).send(`Cannot GET ${req.originalUrl}`);
});

// ====== Подключаем вебхук Telegraf к Express ======
const webhookRoute = `/telegraf/${BOT_SECRET_PATH}`;
app.use(webhookRoute, bot.webhookCallback(webhookRoute, {
  // на всякий случай ограничим только нужные типы
  // (не обязательно, но так чище в логах)
  // Telegraf сам возьмёт update из req.body
}));

// ====== Запускаем сервер и регистрируем вебхук в Telegram ======
app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);

  const fullWebhookUrl = `${APP_URL}${webhookRoute}`;
  try {
    // сброс старого вебхука (полезно при переездах)
    await bot.telegram.deleteWebhook().catch(() => {});
    // ставим вебхук
    await bot.telegram.setWebhook(fullWebhookUrl, {
      // можно ограничить типы апдейтов
      allowed_updates: ['message', 'callback_query'],
      // secret_token — не обязателен, у нас секьюрность за счёт уникального пути
    });
    console.log(`🔗 Webhook set: ${fullWebhookUrl}`);
  } catch (e) {
    console.error('❌ setWebhook error:', e?.response?.description || e.message || e);
  }

  // проверим у Telegram, что реально записалось
  try {
    const info = await bot.telegram.getWebhookInfo();
    console.log('ℹ️ getWebhookInfo:', info);
  } catch (e) {
    console.log('getWebhookInfo error:', e?.response?.description || e.message || e);
  }
});
