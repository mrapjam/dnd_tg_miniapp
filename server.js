// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { Telegraf, Markup } from 'telegraf';

dotenv.config();

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const BOT_SECRET_PATH = process.env.BOT_SECRET_PATH || 'telegraf-9f2c1a';

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан');
  process.exit(1);
}

// ---------- PRISMA (с логами) ----------
const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});

// helper для BigInt -> Number
const asNum = (v) => (typeof v === 'bigint' ? Number(v) : v);
const code6 = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const addHours = (h) => new Date(Date.now() + h * 3600 * 1000);

// ---------- EXPRESS ----------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('webapp'));

// health/debug
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/debug/env', (_req, res) => {
  res.json({
    PORT,
    APP_URL,
    BOT_SECRET_PATH,
    HAS_DB_URL: Boolean(process.env.DATABASE_URL),
  });
});
app.get('/debug/db', async (_req, res) => {
  try {
    const r = await prisma.$queryRaw`SELECT 1 as ok`;
    res.json({ ok: true, result: r });
  } catch (e) {
    console.error('DB PING ERROR:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- TTL cleaner ----------
setInterval(async () => {
  try {
    const r = await prisma.game.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    if (r.count) console.log('🧹 cleanupExpired:', r.count);
  } catch (e) {
    console.error('cleanupExpired error:', e);
  }
}, 60_000);

// ---------- API: STATE (для мини-аппы) ----------
app.get('/api/state', async (req, res) => {
  try {
    const code = String(req.query.code || '').toUpperCase();
    const me = req.query.me ? String(req.query.me) : null;
    if (!code) return res.json({ ok: true, exists: false });

    const game = await prisma.game.findUnique({
      where: { code },
      include: {
        players: { orderBy: { createdAt: 'asc' } },
        locations: true,
        items: true,
        messages: { orderBy: { at: 'asc' } },
        rolls: { orderBy: { at: 'asc' } },
      },
    });
    if (!game) return res.json({ ok: true, exists: false });

    const players = game.players.map(p => ({
      id: asNum(p.id),
      tgId: p.tgId,
      name: p.name,
      avatar: p.avatar,
      hp: p.hp,
      gold: p.gold,
      isGM: p.isGM,
      locationId: p.locationId ?? null,
      createdAt: p.createdAt,
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
      players,
      locations: game.locations.map(l => ({
        id: asNum(l.id),
        name: l.name,
        descr: l.descr,
        imageUrl: l.imageUrl,
      })),
      items: game.items.map(i => ({
        id: asNum(i.id),
        name: i.name,
        qty: i.qty,
        ownerId: i.ownerId ? asNum(i.ownerId) : null,
        locationId: i.locationId ? asNum(i.locationId) : null,
        onFloor: i.onFloor,
        type: i.type,
      })),
      messages: game.messages.map(m => ({
        id: asNum(m.id),
        authorId: m.authorId ? asNum(m.authorId) : null,
        text: m.text,
        at: m.at,
      })),
      rolls: game.rolls.map(r => ({
        id: asNum(r.id),
        playerId: r.playerId ? asNum(r.playerId) : null,
        die: r.die,
        result: r.result,
        at: r.at,
      })),
    });
  } catch (e) {
    console.error('GET /api/state error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---------- API: LOBBY JOIN ----------
app.post('/api/lobby/join', async (req, res) => {
  try {
    const { code, tgId, name, avatar } = req.body || {};
    if (!code || !tgId || !name) return res.status(400).json({ ok: false, error: 'BAD_PAYLOAD' });

    const game = await prisma.game.findUnique({ where: { code: String(code).toUpperCase() } });
    if (!game) return res.status(404).json({ ok: false, error: 'GAME_NOT_FOUND' });

    const player = await prisma.player.upsert({
      where: { gameId_tgId: { gameId: game.id, tgId: String(tgId) } },
      update: { name: String(name).slice(0, 64), avatar: avatar ? String(avatar).slice(0, 64) : null },
      create: { gameId: game.id, tgId: String(tgId), name: String(name).slice(0, 64), avatar: avatar ? String(avatar).slice(0, 64) : null },
    });

    res.json({
      ok: true,
      player: {
        id: asNum(player.id),
        tgId: player.tgId,
        name: player.name,
        avatar: player.avatar,
        hp: player.hp,
        gold: player.gold,
        isGM: player.isGM,
      },
    });
  } catch (e) {
    console.error('POST /api/lobby/join error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---------- API: GM ----------
app.get('/api/gm/players', async (req, res) => {
  try {
    const code = String(req.query.code || '').toUpperCase();
    const me = String(req.query.me || '');
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ ok: false, error: 'GAME_NOT_FOUND' });
    if (String(game.gmId) !== me) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    const players = await prisma.player.findMany({ where: { gameId: game.id }, orderBy: { createdAt: 'asc' } });
    res.json({
      ok: true,
      players: players.map(p => ({
        id: asNum(p.id),
        name: p.name,
        tgId: p.tgId,
        avatar: p.avatar,
        gold: p.gold,
        hp: p.hp,
        isGM: p.isGM,
        locationId: p.locationId ?? null,
      })),
    });
  } catch (e) {
    console.error('GET /api/gm/players error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

app.post('/api/gm/grant-gold', async (req, res) => {
  try {
    const { code, me, playerId, delta } = req.body || {};
    const game = await prisma.game.findUnique({ where: { code: String(code).toUpperCase() } });
    if (!game) return res.status(404).json({ ok: false, error: 'GAME_NOT_FOUND' });
    if (String(game.gmId) !== String(me)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    const p = await prisma.player.update({
      where: { id: Number(playerId) },
      data: { gold: { increment: Number(delta || 0) } },
    });
    res.json({ ok: true, gold: p.gold });
  } catch (e) {
    console.error('POST /api/gm/grant-gold error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

app.post('/api/gm/grant-hp', async (req, res) => {
  try {
    const { code, me, playerId, delta } = req.body || {};
    const game = await prisma.game.findUnique({ where: { code: String(code).toUpperCase() } });
    if (!game) return res.status(404).json({ ok: false, error: 'GAME_NOT_FOUND' });
    if (String(game.gmId) !== String(me)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    const p = await prisma.player.update({
      where: { id: Number(playerId) },
      data: { hp: { increment: Number(delta || 0) } },
    });
    res.json({ ok: true, hp: p.hp });
  } catch (e) {
    console.error('POST /api/gm/grant-hp error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// создать локацию
app.post('/api/location', async (req, res) => {
  try {
    const { gameId, name, descr, imageUrl } = req.body || {};
    const loc = await prisma.location.create({ data: { gameId: Number(gameId), name, descr, imageUrl } });
    res.json({ ok: true, location: { ...loc, id: asNum(loc.id) } });
  } catch (e) {
    console.error('POST /api/location error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// создать предмет
app.post('/api/item', async (req, res) => {
  try {
    const { gameId, name, qty, ownerId, locationId, onFloor, type } = req.body || {};
    const item = await prisma.item.create({
      data: {
        gameId: Number(gameId),
        name: String(name),
        qty: Number(qty || 1),
        ownerId: ownerId ? Number(ownerId) : null,
        locationId: locationId ? Number(locationId) : null,
        onFloor: Boolean(onFloor),
        type: type ? String(type) : 'misc',
      },
    });
    res.json({ ok: true, item: { ...item, id: asNum(item.id) } });
  } catch (e) {
    console.error('POST /api/item error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// чат
app.post('/api/message', async (req, res) => {
  try {
    const { gameId, authorId, text } = req.body || {};
    const msg = await prisma.message.create({
      data: {
        gameId: Number(gameId),
        authorId: authorId ? Number(authorId) : null,
        text: String(text).slice(0, 500),
      },
    });
    res.json({ ok: true, message: { ...msg, id: asNum(msg.id) } });
  } catch (e) {
    console.error('POST /api/message error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// броски
app.post('/api/roll', async (req, res) => {
  try {
    const { gameId, playerId, die } = req.body || {};
    const d = Number(die || 20);
    const result = 1 + Math.floor(Math.random() * d);
    const roll = await prisma.roll.create({
      data: { gameId: Number(gameId), playerId: playerId ? Number(playerId) : null, die: d, result },
    });
    res.json({ ok: true, roll: { ...roll, id: asNum(roll.id) } });
  } catch (e) {
    console.error('POST /api/roll error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// старт игры: started=true + всех игроков в указанную локацию
app.post('/api/game/:id/start', async (req, res) => {
  try {
    const gameId = Number(req.params.id);
    const { locationId } = req.body || {};
    await prisma.game.update({ where: { id: gameId }, data: { started: true } });
    if (locationId) {
      await prisma.player.updateMany({ where: { gameId }, data: { locationId: Number(locationId) } });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/game/:id/start error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---------- TELEGRAM BOT ----------
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 12000 });
const safeReply = async (ctx, f) => { try { await f(); } catch (e) { console.error('bot reply error:', e?.response?.description || e.message || e); } };

// диплинк /start <code>
bot.start(async (ctx) => {
  try {
    const payload = ctx.startPayload;
    if (!payload) return safeReply(ctx, () => ctx.reply('Привет! /new — создать игру, /join CODE — присоединиться'));
    const code = String(payload).toUpperCase();
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return safeReply(ctx, () => ctx.reply('❌ Игра не найдена'));

    const tgId = String(ctx.from.id);
    await prisma.player.upsert({
      where: { gameId_tgId: { gameId: game.id, tgId } },
      update: {},
      create: { gameId: game.id, tgId, name: ctx.from.first_name || 'Игрок' },
    });

    const openUrl = APP_URL ? `${APP_URL}/?code=${code}&role=player` : undefined;
    return safeReply(ctx, () => ctx.reply(
      `✅ Ты присоединился к игре ${code}`,
      openUrl ? Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑аппу', openUrl)]]) : undefined
    ));
  } catch (e) {
    console.error('bot.start error:', e);
  }
});

// /new — создать игру и сделать автора ГМ
bot.command('new', async (ctx) => {
  try {
    const gmId = String(ctx.from.id);
    let code = '';
    for (let i = 0; i < 8; i++) {
      const c = code6();
      const exist = await prisma.game.findUnique({ where: { code: c } });
      if (!exist) { code = c; break; }
    }
    if (!code) code = code6();

    const game = await prisma.game.create({
      data: { code, gmId, started: false, expiresAt: addHours(6) },
    });

    await prisma.player.upsert({
      where: { gameId_tgId: { gameId: game.id, tgId: gmId } },
      update: { isGM: true, name: 'GM', avatar: '🎲' },
      create: { gameId: game.id, tgId: gmId, name: 'GM', avatar: '🎲', isGM: true },
    });

    const deepLink = `https://t.me/${ctx.botInfo.username}?start=${game.code}`;
    await safeReply(ctx, () => ctx.reply(
      `Создана игра. Код: ${game.code}\nОтправь ссылку игрокам:`,
      Markup.inlineKeyboard([[Markup.button.url('🔗 Присоединиться', deepLink)]])
    ));
    const gmUrl = APP_URL ? `${APP_URL}/?code=${game.code}&role=gm` : undefined;
    if (gmUrl) await safeReply(ctx, () => ctx.reply('ГМ‑панель:', Markup.inlineKeyboard([[Markup.button.webApp('Открыть (ГМ)', gmUrl)]])));
  } catch (e) {
    console.error('/new error:', e);
    await safeReply(ctx, () => ctx.reply('Ошибка при создании игры.'));
  }
});

// /join CODE — быстрый вход
bot.command('join', async (ctx) => {
  try {
    const parts = (ctx.message?.text || '').trim().split(/\s+/);
    const code = (parts[1] || '').toUpperCase();
    if (!code) return safeReply(ctx, () => ctx.reply('Использование: /join CODE'));

    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return safeReply(ctx, () => ctx.reply('Игра не найдена'));

    const openUrl = APP_URL ? `${APP_URL}/?code=${code}&role=player` : undefined;
    await safeReply(ctx, () => ctx.reply(
      `Комната: ${code}`,
      openUrl ? Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑аппу', openUrl)]]) : undefined
    ));
  } catch (e) {
    console.error('/join error:', e);
    await safeReply(ctx, () => ctx.reply('Ошибка при /join.'));
  }
});

bot.on('message', (ctx, next) => {
  try { console.log('📩 update:', JSON.stringify(ctx.update)); } catch {}
  return next();
});

// быстрый 200 и асинхронная обработка
const webhookRoute = `/telegraf/${BOT_SECRET_PATH}`;
app.post(webhookRoute, (req, res) => { res.status(200).end(); bot.handleUpdate(req.body).catch(e => console.error('handleUpdate error:', e)); });

// ---------- START ----------
app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1 as ok`; // ping
    console.log('✅ Prisma connected & DB ping ok');
  } catch (e) {
    console.error('❌ Prisma connect/ping error:', e);
  }

  const fullWebhook = (APP_URL ? `${APP_URL}${webhookRoute}` : null);
  if (fullWebhook) {
    try {
      await bot.telegram.setWebhook(fullWebhook, { allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      console.log('🔗 Webhook set:', fullWebhook);
    } catch (e) {
      console.error('❌ setWebhook error:', e?.response?.description || e.message || e);
    }
  } else {
    console.warn('⚠️ APP_URL не задан — вебхук не установлен. Укажи APP_URL в .env');
  }
});

// глобальные ловушки
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
