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

// ===== Prisma =====
const prisma = new PrismaClient();
const asNum = (v) => (typeof v === 'bigint' ? Number(v) : v);
const code6 = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const addHours = (h) => new Date(Date.now() + h * 3600 * 1000);

// ===== Express =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// статика мини‑аппы
app.use(express.static('webapp'));

// health
app.get('/healthz', (_req, res) => res.send('ok'));

// TTL cleaner
setInterval(async () => {
  try {
    const r = await prisma.game.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    if (r.count) console.log('🧹 cleanupExpired:', r.count);
  } catch (e) {
    console.log('cleanupExpired error:', e.message || e);
  }
}, 60_000);

// ===== API: STATE =====
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

    const players = game.players.map(p => ({
      id: asNum(p.id), tgId: p.tgId, name: p.name, avatar: p.avatar,
      hp: p.hp, gold: p.gold, isGM: p.isGM,
      locationId: p.locationId ? asNum(p.locationId) : null,
      createdAt: p.createdAt
    }));
    const you = me ? players.find(p => p.tgId === me) : null;

    res.json({
      ok: true, exists: true,
      code: game.code, gmId: game.gmId, started: game.started, expiresAt: game.expiresAt,
      you, players
    });
  } catch (e) {
    console.error('GET /api/state error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ===== API: LOBBY JOIN =====
app.post('/api/lobby/join', async (req, res) => {
  try {
    const { code, tgId, name, avatar } = req.body || {};
    if (!code || !tgId || !name) return res.status(400).json({ ok: false, error: 'BAD_PAYLOAD' });

    const game = await prisma.game.findUnique({ where: { code: String(code).toUpperCase() } });
    if (!game) return res.status(404).json({ ok: false, error: 'GAME_NOT_FOUND' });

    const player = await prisma.player.upsert({
      where: { gameId_tgId: { gameId: game.id, tgId: String(tgId) } },
      update: { name: String(name).slice(0, 64), avatar: avatar ? String(avatar).slice(0, 32) : null },
      create: { gameId: game.id, tgId: String(tgId), name: String(name).slice(0, 64), avatar: avatar ? String(avatar).slice(0, 32) : null }
    });

    res.json({ ok: true, player: {
      id: asNum(player.id), tgId: player.tgId, name: player.name, avatar: player.avatar,
      hp: player.hp, gold: player.gold, isGM: player.isGM
    }});
  } catch (e) {
    console.error('POST /api/lobby/join error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ===== GM API =====
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

// ===== Bot =====
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 12000 });
const replySafe = async (ctx, f) => { try { await f(); } catch (e) { console.error('reply error:', e?.response?.description || e.message || e); } };

// /start с диплинком: t.me/<bot>?start=ABC123
bot.start(async (ctx) => {
  const payload = ctx.startPayload; // код игры, если пришли по ссылке
  if (!payload) {
    await replySafe(ctx, () => ctx.reply('Привет! /new — создать игру (ты будешь ГМ) • /join CODE — войти как игрок'));
    return;
  }
  const code = String(payload).toUpperCase();
  const game = await prisma.game.findUnique({ where: { code } });
  if (!game) return replySafe(ctx, () => ctx.reply('❌ Игра не найдена'));

  // авто‑вход как игрок
  const tgId = String(ctx.from.id);
  await prisma.player.upsert({
    where: { gameId_tgId: { gameId: game.id, tgId } },
    update: {},
    create: { gameId: game.id, tgId, name: ctx.from.first_name || 'Игрок' }
  });
  await replySafe(ctx, () => ctx.reply(
    `✅ Ты присоединился к игре ${code}`,
    Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑аппу', `${APP_URL}/?code=${code}&role=player`)]])
  ));
});

// /new — создать игру (автор = ГМ)
bot.command('new', async (ctx) => {
  try {
    const gmId = String(ctx.from?.id || '');
    if (!gmId) return;
    // уникальный код
    let code = '';
    for (let i = 0; i < 8; i++) {
      const t = code6();
      const exists = await prisma.game.findUnique({ where: { code: t } });
      if (!exists) { code = t; break; }
    }
    if (!code) code = code6();

    const game = await prisma.game.create({
      data: { code, gmId, started: false, expiresAt: addHours(6) }
    });
    // ГМ как игрок
    await prisma.player.upsert({
      where: { gameId_tgId: { gameId: game.id, tgId: gmId } },
      update: { isGM: true, name: 'GM', avatar: '🎲' },
      create: { gameId: game.id, tgId: gmId, name: 'GM', avatar: '🎲', isGM: true }
    });

    const deepLink = `https://t.me/${ctx.botInfo.username}?start=${game.code}`;
    await replySafe(ctx, () => ctx.reply(
      `Создана игра. Код: ${game.code}\n\nОтправь эту ссылку игрокам:`,
      Markup.inlineKeyboard([[Markup.button.url('🔗 Присоединиться', deepLink)]])
    ));
    await replySafe(ctx, () => ctx.reply(
      `ГМ-панель:`,
      Markup.inlineKeyboard([[Markup.button.webApp('Открыть (ГМ)', `${APP_URL}/?code=${game.code}&role=gm`)]])
    ));
  } catch (e) {
    console.error('/new error:', e);
    await replySafe(ctx, () => ctx.reply('Произошла ошибка при создании игры.'));
  }
});

// /join CODE — «старый» способ входа
bot.command('join', async (ctx) => {
  try {
    const parts = (ctx.message?.text || '').trim().split(/\s+/);
    const code = (parts[1] || '').toUpperCase();
    if (!code) return replySafe(ctx, () => ctx.reply('Использование: /join CODE'));

    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return replySafe(ctx, () => ctx.reply('Игра не найдена'));

    await replySafe(ctx, () => ctx.reply(
      `Комната: ${code}`,
      Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑аппу', `${APP_URL}/?code=${code}&role=player`)]])
    ));
  } catch (e) {
    console.error('/join error:', e);
    await replySafe(ctx, () => ctx.reply('Ошибка при /join.'));
  }
});

// лог апдейтов (диагностика)
bot.on('message', (ctx, next) => { try { console.log('📩', JSON.stringify(ctx.update)); } catch {} return next(); });

// webhook (мгновенный 200, обработка асинхронно)
const webhookRoute = `/telegraf/${BOT_SECRET_PATH}`;
app.post(webhookRoute, (req, res) => { res.status(200).end(); bot.handleUpdate(req.body).catch(e => console.error('handleUpdate error:', e)); });

// start
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
