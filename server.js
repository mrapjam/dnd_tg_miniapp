// server.js — Telegraf + Express + Prisma (BIGINT), /new, /join, GM-панель API

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
const SIX_HOURS = 6 * 60 * 60 * 1000;
function code6() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function addHours(h) { return new Date(Date.now() + h * 3600 * 1000); }
function asNum(bi) { return typeof bi === 'bigint' ? Number(bi) : bi; }

// ===== Express =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// статика мини‑аппы
app.use(express.static('webapp'));

// health
app.get('/healthz', (_req, res) => res.send('ok'));

// ========== CLEANUP (TTL игр) ==========
async function cleanupExpired() {
  try {
    const now = new Date();
    const deleted = await prisma.game.deleteMany({ where: { expiresAt: { lt: now } } });
    if (deleted.count) console.log('🧹 cleanupExpired:', deleted.count);
  } catch (e) {
    console.log('cleanupExpired error:', e.message || e);
  }
}
setInterval(cleanupExpired, 60_000);

// ========== API: STATE ==========
app.get('/api/state', async (req, res) => {
  try {
    const code = String(req.query.code || '').toUpperCase();
    const me = req.query.me ? String(req.query.me) : null;
    if (!code) return res.json({ ok: true, exists: false });

    const game = await prisma.game.findUnique({
      where: { code },
      include: { players: { orderBy: { createdAt: 'asc' } } }
    });
    if (!game) return res.json({ ok: true, exists: false });

    const you = me ? game.players.find(p => p.tgId === me) : null;

    res.json({
      ok: true,
      exists: true,
      code: game.code,
      gmId: game.gmId,
      started: game.started,
      expiresAt: game.expiresAt,
      you: you ? {
        id: asNum(you.id), tgId: you.tgId, name: you.name, avatar: you.avatar,
        hp: you.hp, gold: you.gold, isGM: you.isGM, locationId: you.locationId ? asNum(you.locationId) : null
      } : null,
      players: game.players.map(p => ({
        id: asNum(p.id), tgId: p.tgId, name: p.name, avatar: p.avatar,
        hp: p.hp, gold: p.gold, isGM: p.isGM, locationId: p.locationId ? asNum(p.locationId) : null
      }))
    });
  } catch (e) {
    console.error('GET /api/state error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ========== API: LOBBY JOIN ==========
app.post('/api/lobby/join', async (req, res) => {
  try {
    const { code, tgId, name, avatar } = req.body || {};
    if (!code || !tgId || !name) return res.status(400).json({ ok: false, error: 'BAD_PAYLOAD' });

    const game = await prisma.game.findUnique({ where: { code: String(code).toUpperCase() } });
    if (!game) return res.status(404).json({ ok: false, error: 'GAME_NOT_FOUND' });

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
        id: asNum(player.id), tgId: player.tgId, name: player.name,
        avatar: player.avatar, hp: player.hp, gold: player.gold, isGM: player.isGM
      }
    });
  } catch (e) {
    console.error('POST /api/lobby/join error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ========== API: GM — список игроков ==========
app.get('/api/gm/players', async (req, res) => {
  try {
    const code = String(req.query.code || '').toUpperCase();
    const me = String(req.query.me || '');
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ ok: false, error: 'GAME_NOT_FOUND' });
    if (String(game.gmId) !== me) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    const players = await prisma.player.findMany({ where: { gameId: game.id }, orderBy: { createdAt: 'asc' } });
    res.json({ ok: true, players: players.map(p => ({
      id: asNum(p.id), name: p.name, tgId: p.tgId, avatar: p.avatar, gold: p.gold, hp: p.hp, isGM: p.isGM
    })) });
  } catch (e) {
    console.error('GET /api/gm/players error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ========== API: GM — начислить золото ==========
app.post('/api/gm/grant-gold', async (req, res) => {
  try {
    const { code, me, playerId, delta } = req.body || {};
    const game = await prisma.game.findUnique({ where: { code: String(code).toUpperCase() } });
    if (!game) return res.status(404).json({ ok: false, error: 'GAME_NOT_FOUND' });
    if (String(game.gmId) !== String(me)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    const p = await prisma.player.update({
      where: { id: BigInt(playerId) },
      data: { gold: { increment: Number(delta || 0) } }
    });
    res.json({ ok: true, gold: p.gold });
  } catch (e) {
    console.error('POST /api/gm/grant-gold error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ========== API: GM — изменить HP ==========
app.post('/api/gm/grant-hp', async (req, res) => {
  try {
    const { code, me, playerId, delta } = req.body || {};
    const game = await prisma.game.findUnique({ where: { code: String(code).toUpperCase() } });
    if (!game) return res.status(404).json({ ok: false, error: 'GAME_NOT_FOUND' });
    if (String(game.gmId) !== String(me)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    const p = await prisma.player.update({
      where: { id: BigInt(playerId) },
      data: { hp: { increment: Number(delta || 0) } }
    });
    res.json({ ok: true, hp: p.hp });
  } catch (e) {
    console.error('POST /api/gm/grant-hp error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ========== Bot (webhook) ==========
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 12000 });

async function replySafe(ctx, make) {
  try { await make(); }
  catch (e) { console.error('reply error:', e?.response?.description || e.message || e); }
}

// /start
bot.start(async (ctx) => {
  await replySafe(ctx, () => ctx.reply(
    'Привет! /new — создать игру (ты будешь ГМ), /join CODE — присоединиться как игрок.'
  ));
});

// /new — создать игру, выдать ссылку ГМ
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
      data: { code, gmId, started: false, expiresAt: addHours(6) }
    });

    // создадим запись ГМа как игрока (isGM=true), чтобы он был в списке игроков
    await prisma.player.upsert({
      where: { gameId_tgId: { gameId: game.id, tgId: gmId } },
      update: { isGM: true, name: 'GM', avatar: '🎲' },
      create: { gameId: game.id, tgId: gmId, name: 'GM', avatar: '🎲', isGM: true }
    });

    await replySafe(ctx, () => ctx.reply(
      `Создана игра. Код: ${game.code}\nГМ-панель:`,
      Markup.inlineKeyboard([
        [Markup.button.webApp('Открыть (ГМ)', `${APP_URL}/?code=${game.code}&role=gm`)]
      ])
    ));

    // отдельно кнопка для игроков — можно форвардить
    await replySafe(ctx, () => ctx.reply(
      `Ссылка для игроков:`,
      Markup.inlineKeyboard([
        [Markup.button.webApp('Войти как игрок', `${APP_URL}/?code=${game.code}&role=player`)]
      ])
    ));
  } catch (e) {
    console.error('/new error:', e);
    await replySafe(ctx, () => ctx.reply('Произошла ошибка при создании игры.'));
  }
});

// /join CODE — для игроков
bot.command('join', async (ctx) => {
  try {
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/);
    const code = (parts[1] || '').toUpperCase();

    if (!code) {
      await replySafe(ctx, () => ctx.reply('Использование: /join CODE'));
      return;
    }
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) {
      await replySafe(ctx, () => ctx.reply('Игра с таким кодом не найдена.'));
      return;
    }
    await replySafe(ctx, () => ctx.reply(
      `Комната найдена: ${code}. Войдите как игрок:`,
      Markup.inlineKeyboard([
        [Markup.button.webApp('Открыть мини‑аппу', `${APP_URL}/?code=${code}&role=player`)]
      ])
    ));
  } catch (e) {
    console.error('/join error:', e);
    await replySafe(ctx, () => ctx.reply('Ошибка при /join.'));
  }
});

// логи апдейтов
bot.on('message', (ctx, next) => { try { console.log('📩', JSON.stringify(ctx.update)); } catch {} return next(); });

// Webhook
const webhookRoute = `/telegraf/${BOT_SECRET_PATH}`;
app.post(webhookRoute, (req, res) => { res.status(200).end(); bot.handleUpdate(req.body).catch(e => console.error('handleUpdate error:', e)); });

// ===== Start =====
app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);

  try { await prisma.$connect(); console.log('✅ Prisma connected'); }
  catch (e) { console.error('❌ Prisma connect error:', e.message || e); }

  const full = `${APP_URL}${webhookRoute}`;
  try {
    await bot.telegram.setWebhook(full, { allowed_updates: ['message','callback_query'], drop_pending_updates: true });
    console.log('🔗 Webhook set:', full);
  } catch (e) {
    console.error('❌ setWebhook:', e?.response?.description || e.message || e);
  }
});
