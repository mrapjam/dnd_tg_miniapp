// server.js — Telegraf webhook + расширенные логи ответов

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

// ====== APP ======
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Простой корневой маршрут (чтобы браузером видеть «жив» ли сервер)
app.get('/', (_req, res) => {
  res.status(200).send(`Dnd Mini App backend is up. Webhook: /telegraf/${BOT_SECRET_PATH}`);
});

// Диагностика
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/whoami', (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    appUrl: APP_URL,
    webhookPath: `/telegraf/${BOT_SECRET_PATH}`,
  });
});

// Лог всех запросов к вебхуку (до Telegraf)
app.use(`/telegraf/${BOT_SECRET_PATH}`, (req, _res, next) => {
  const ua = req.headers['user-agent'] || '';
  console.log(`⟵ HTTP ${req.method} ${req.originalUrl} UA=${ua}`);
  if (req.body && typeof req.body === 'object') {
    console.log('⟵ Update body:', JSON.stringify(req.body));
  } else {
    console.log('⟵ No or invalid JSON body');
  }
  next();
});

// ====== BOT ======
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 12_000 });

// Универсальный обёртчик для логирования результата отправки
async function safeReply(ctx, action) {
  try {
    const res = await action();
    console.log('✅ reply sent:', JSON.stringify({
      chatId: ctx.chat?.id,
      messageId: res?.message_id,
      text: res?.text?.slice?.(0, 120)
    }));
  } catch (err) {
    const desc = err?.response?.description || err?.message || String(err);
    console.error('❌ reply error:', desc);
  }
}

// /start — контроль, что бот отвечает
bot.start(async (ctx) => {
  await safeReply(ctx, () => ctx.reply(
    'Привет! Я на вебхуке и жив. Используй /new для теста кнопки.'
  ));
});

// /new — просто генерим тестовый код + кнопку
bot.command('new', async (ctx) => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  await safeReply(ctx, () => ctx.reply(
    `Создана тест-игра. Код: ${code}\nНажми "Открыть мини-апп" (заглушка).`,
    Markup.inlineKeyboard([
      [Markup.button.webApp('Открыть мини-апп', `${APP_URL}/`)]
    ])
  ));
});

// Логируем любые другие сообщения/колбэки (на случай если пишешь не командами)
bot.on('message', async (ctx, next) => {
  try {
    console.log('📩 on(message):', JSON.stringify(ctx.update));
  } catch (_) {}
  return next();
});

bot.on('callback_query', async (ctx, next) => {
  try {
    console.log('🔘 on(callback_query):', JSON.stringify(ctx.update));
  } catch (_) {}
  return next();
});

// Подключаем вебхук как middleware
const webhookRoute = `/telegraf/${BOT_SECRET_PATH}`;
app.use(webhookRoute, bot.webhookCallback(webhookRoute));

// ====== START ======
app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);

  const fullWebhookUrl = `${APP_URL}${webhookRoute}`;
  try {
    // На всякий случай сносим прежний вебхук
    await bot.telegram.deleteWebhook().catch(() => {});
    // Ставим новый
    await bot.telegram.setWebhook(fullWebhookUrl, {
      allowed_updates: ['message', 'callback_query'],
    });
    console.log(`🔗 Webhook set: ${fullWebhookUrl}`);
  } catch (e) {
    console.error('❌ setWebhook error:', e?.response?.description || e.message || e);
  }

  try {
    const info = await bot.telegram.getWebhookInfo();
    console.log('ℹ️ getWebhookInfo:', info);
  } catch (e) {
    console.log('getWebhookInfo error:', e?.response?.description || e.message || e);
  }
});
