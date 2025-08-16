// server.js — рабочий сервер: Telegraf + Express + Prisma (BIGINT)

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { PrismaClient } from '@prisma/client';

dotenv.config();

// ===== ENV =====
const PORT = process.env.PORT || 10000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_SECRET_PATH = process.env.BOT_SECRET_PATH || 'telegraf-9f2c1a';

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is not set'); process.exit(1);
}

const prisma = new PrismaClient();

// ===== Helpers =====
function code6() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function addHours(h) {
  return new Date(Date.now() + h * 3600 * 1000);
}

// ===== Express =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// раздача статики мини‑аппы (папка webapp/)
app.use(express.static('webapp'));

// health
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ===== API: state =====
app.get('/api/state', async (req, res) => {
  try {
    const code = String(req.query.code || '').toUpperCase();
    const me = req.query.me ? String(req.query.me) : null;
    if (!code) return res.json({ ok: true, exists: false });

    const game = await prisma.game.findUnique({
      where: { code },
      include: {
        players: { orderBy: { createdAt: 'asc' } }
      }
    });
    if (!game) return res.json({ ok: true, exists: false });

    // не суём BigInt напрямую в JSON
    const players = game.players.map(p => ({
      id: Number(p.id),
      tgId: p.tgId,
      name: p.name,
      avatar: p.avatar,
      hp: p.hp,
      gold: p.gold,
      isGM: p.isGM,
      locationId: p.locationId ? Number(p.locationId) : null,
      createdAt: p.createdAt
    }));
    const you = me ? players.find(p => p.tgId === me) : null;

    res.json({
      ok: true,
      exists: true,
      code: game.code,
      gmId: game.gmId,
      started: game.started,
      expiresAt: game.expiresAt,
      you,
      players
    });
  } catch (e) {
    console.error('GET /api/state error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ===== API: lobby/join =====
app.post('/api/lobby/join', async (req, res) => {
  try {
    const { code, tgId, name, avatar } = req.body || {};
    if (!code || !tgId || !name) {
      return res.status(400).json({ ok: false, error: 'BAD_PAYLOAD' });
    }
    const game = await prisma.game.findUnique({ where: { code: String(code).toUpperCase() } });
    if (!game) return res.status(404).json({ ok: false, error: 'GAME_NOT_FOUND' });

    // upsert по уникальному ключу (gameId, tgId)
    const player = await prisma.player.upsert({
      where: { gameId_tgId: { gameId: game.id, tgId: String(tgId) } },
      update: {
        name: String(name).slice(0, 64),
        avatar: avatar ? String(avatar).slice(0, 32) : null
      },
      create: {
        gameId: game.id,
        tgId: String(tgId),
        name: String(name).slice(0, 64),
        avatar: avatar ? String(avatar).slice(0, 32) : null
      }
    });

    res.json({
      ok: true,
      player: {
        id: Number(player.id),
        tgId: player.tgId,
        name: player.name,
        avatar: player.avatar,
        hp: player.hp,
        gold: player.gold,
        isGM: player.isGM
      }
    });
  } catch (e) {
    console.error('POST /api/lobby/join error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ===== Bot (webhook) =====
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 12000 });

async function replySafe(ctx, make) {
  try { await make(); }
  catch (e) { console.error('reply error:', e?.response?.description || e.message || e); }
}

// /start
bot.start(async (ctx) => {
  await replySafe(ctx, () => ctx.reply(
    'Привет! Я жив. Используй /new чтобы создать игру (хранится 6 часов).'
  ));
});

// /new — создать игру
bot.command('new', async (ctx) => {
  try {
    const gmId = String(ctx.from?.id || '');
    if (!gmId) return;

    // генерим уникальный код
    let code = '';
    for (let i = 0; i < 8; i++) {
      const c = code6();
      const found = await prisma.game.findUnique({ where: { code: c } });
      if (!found) { code = c; break; }
    }
    if (!code) code = code6();

    const game = await prisma.game.create({
      data: {
        code,
        gmId,
        started: false,
        expiresAt: addHours(6)
      }
    });

    await replySafe(ctx, () => ctx.reply(
      `Создана игра. Код: ${game.code}\nДействует 6 часов.`,
      Markup.inlineKeyboard([
        [Markup.button.webApp('Открыть мини‑аппу', `${APP_URL}/?code=${game.code}`)]
      ])
    ));
  } catch (e) {
    console.error('/new error:', e);
    await replySafe(ctx, () => ctx.reply('Произошла ошибка при создании игры.'));
  }
});

// логи апдейтов (на всякий случай)
bot.on('message', (ctx, next) => { try { console.log('📩', JSON.stringify(ctx.update)); } catch {} return next(); });

// Webhook: быстрый 200 и асинхронный handleUpdate
const webhookRoute = `/telegraf/${BOT_SECRET_PATH}`;
app.post(webhookRoute, (req, res) => {
  res.status(200).end();
  bot.handleUpdate(req.body).catch(e => console.error('handleUpdate error:', e));
});

// ===== Start =====
app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);

  try {
    await prisma.$connect();
    console.log('✅ Prisma connected');
  } catch (e) {
    console.error('❌ Prisma connect error:', e.message || e);
  }

  const full = `${APP_URL}${webhookRoute}`;
  try {
    await bot.telegram.setWebhook(full, {
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    });
    console.log('🔗 Webhook set:', full);
  } catch (e) {
    console.error('❌ setWebhook:', e?.response?.description || e.message || e);
  }
});
