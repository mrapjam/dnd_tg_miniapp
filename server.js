// server.js — чистый старт: бот + мини‑аппа, память с TTL 6 часов

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';

dotenv.config();

// ===== ENV =====
const PORT = process.env.PORT || 10000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_SECRET_PATH = process.env.BOT_SECRET_PATH || 'telegraf-9f2c1a';

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is not set'); process.exit(1);
}

// ===== In‑Memory store (TTL 6h) =====
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const games = new Map(); // gameCode -> {code, gmId, createdAt, expiresAt, players: Map}

// создаём игру
function createGame(gmId) {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const now = Date.now();
  const game = {
    code,
    gmId: String(gmId),
    createdAt: now,
    expiresAt: now + SIX_HOURS_MS,
    players: new Map() // key: tgId -> {tgId,name,avatar,gold,hp}
  };
  games.set(code, game);
  return game;
}

// чистим просроченные игры
function cleanupExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [code, g] of games) {
    if (g.expiresAt <= now) {
      games.delete(code);
      removed++;
    }
  }
  if (removed) console.log('🧹 memory cleanup:', removed);
}
setInterval(cleanupExpired, 60 * 1000);

// ===== WebApp (мини‑аппа) =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// статика
app.use(express.static('webapp'));

// health
app.get('/healthz', (_req, res) => res.send('ok'));

// API: состояние по коду игры
app.get('/api/state', (req, res) => {
  const { code, me } = req.query;
  const game = code && games.get(String(code).toUpperCase());
  if (!game) return res.json({ ok: true, exists: false });

  const you = me ? game.players.get(String(me)) : null;
  const players = [...game.players.values()].map(p => ({
    tgId: p.tgId, name: p.name, avatar: p.avatar, gold: p.gold, hp: p.hp
  }));

  res.json({
    ok: true,
    exists: true,
    code: game.code,
    gmId: game.gmId,
    expiresAt: game.expiresAt,
    you,
    players
  });
});

// API: вход в лобби (создаёт/обновляет игрока)
app.post('/api/lobby/join', (req, res) => {
  const { code, tgId, name, avatar } = req.body || {};
  const game = code && games.get(String(code).toUpperCase());
  if (!game) return res.status(400).json({ ok: false, error: 'GAME_NOT_FOUND' });
  if (!tgId || !name) return res.status(400).json({ ok: false, error: 'BAD_PAYLOAD' });

  const key = String(tgId);
  const prev = game.players.get(key);
  const player = {
    tgId: key,
    name: String(name).slice(0, 64),
    avatar: String(avatar || '').slice(0, 16),
    gold: prev?.gold ?? 0,
    hp: prev?.hp ?? 10
  };
  game.players.set(key, player);

  res.json({ ok: true, player });
});

// ===== БОТ (webhook) =====
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 12000 });

async function safeReply(ctx, fn) {
  try { await fn(); }
  catch (e) { console.error('❌ send error:', e?.response?.description || e?.message || e); }
}

bot.start(async (ctx) => {
  await safeReply(ctx, () => ctx.reply(
    'Привет! Используй /new чтобы создать комнату (игра хранится 6 часов).'
  ));
});

bot.command('new', async (ctx) => {
  const gmId = ctx.from?.id;
  if (!gmId) return;

  const game = createGame(gmId);
  const btn = Markup.inlineKeyboard([
    [Markup.button.webApp('Открыть мини‑аппу', `${APP_URL}/?code=${game.code}`)]
  ]);

  await safeReply(ctx, () =>
    ctx.reply(`Создана игра. Код: ${game.code}\n(данные хранятся в памяти 6 часов)`, btn)
  );
});

// универсальные логи
bot.on('message', (ctx, next) => { try { console.log('📩', JSON.stringify(ctx.update)); } catch {} return next(); });

// Webhook: мгновенный 200 и асинхронная обработка
const webhookRoute = `/telegraf/${BOT_SECRET_PATH}`;
app.post(webhookRoute, (req, res) => {
  res.status(200).end(); // сразу отвечаем Telegram
  bot.handleUpdate(req.body).catch(e => console.error('❌ handleUpdate:', e));
});

// ===== START =====
app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);

  try {
    const me = await bot.telegram.getMe();
    console.log('👤 Bot:', me);
  } catch (e) {
    console.error('❌ getMe:', e?.response?.description || e?.message || e);
  }

  const fullWebhook = `${APP_URL}${webhookRoute}`;
  try {
    await bot.telegram.setWebhook(fullWebhook, {
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });
    console.log('🔗 Webhook set:', fullWebhook);

    const info = await bot.telegram.getWebhookInfo();
    console.log('ℹ️ getWebhookInfo:', info);
  } catch (e) {
    console.error('❌ setWebhook:', e?.response?.description || e?.message || e);
  }
});
