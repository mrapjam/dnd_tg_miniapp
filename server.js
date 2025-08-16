import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Telegraf, Markup } from 'telegraf';
import { PrismaClient } from '@prisma/client';

const {
  BOT_TOKEN,
  BOT_SECRET_PATH = 'telegraf-9f2c1a',
  APP_URL,
  DATABASE_URL,
  PORT = 3000,
} = process.env;

if (!BOT_TOKEN) console.error('❌ BOT_TOKEN is required');
if (!DATABASE_URL) console.error('❌ DATABASE_URL is required');

const prisma = new PrismaClient();
const app = express();
app.use(cors({ maxAge: 60 }));
app.use(bodyParser.json({ limit: '8mb' })); // для dataURL фото

// --- BOT -------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);
const baseUrl = (APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const webhookPath = `/telegraf/${BOT_SECRET_PATH}`;

const pendingJoin = new Map();
const genCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const appUrl = (code, ctx) => {
  const q = new URLSearchParams();
  if (code) q.set('code', code);
  if (ctx?.from?.id) q.set('tgId', String(ctx.from.id));
  if (ctx?.from?.first_name) q.set('name', ctx.from.first_name);
  return `${baseUrl}/?${q.toString()}`;
};

bot.start(ctx =>
  ctx.reply('DnD Mini App. Выбери действие:',
    Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑апп', appUrl('', ctx))]])
  )
);

bot.command(['new', 'startgame'], async (ctx) => {
  try {
    const code = genCode();
    await prisma.game.create({ data: { code, gmTgId: String(ctx.from.id) } });
    await ctx.reply(
      `Игра создана. Код: ${code}`,
      Markup.inlineKeyboard([[Markup.button.webApp('Панель мастера', appUrl(code, ctx))]])
    );
  } catch (e) { console.error(e); ctx.reply('Не удалось создать игру.'); }
});

bot.command('join', (ctx) => {
  pendingJoin.set(ctx.from.id, true);
  ctx.reply('Введи код комнаты (6 символов):');
});
bot.on('text', async (ctx) => {
  if (!pendingJoin.get(ctx.from.id)) return;
  const code = (ctx.message.text || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return ctx.reply('Код должен быть из 6 символов. Попробуй ещё раз:');
  const game = await prisma.game.findUnique({ where: { code } });
  if (!game) return ctx.reply('Игра не найдена. Введи другой код:');
  pendingJoin.delete(ctx.from.id);
  ctx.reply(
    `Код принят: ${code}. Открой мини‑аппу, введи имя и зайди в лобби.`,
    Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑апп', appUrl(code, ctx))]])
  );
});

app.post(webhookPath, (req, res) => bot.webhookCallback(webhookPath)(req, res));
app.get(webhookPath, (_req, res) => res.status(200).send('ok'));

// --- STATIC & HEALTH ------------------------------------
app.use(express.static('webapp'));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/db-check', async (_req, res) => {
  try { await prisma.$queryRaw`select 1`; res.send('db: ok'); }
  catch { res.status(503).send('db: fail'); }
});

// --- API -------------------------------------------------

// состояние игры для клиента
app.get('/api/games/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const tgId = req.query.tgId ? String(req.query.tgId) : null;

    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const me = tgId
      ? await prisma.player.findUnique({
          where: { gameId_userTgId: { gameId: game.id, userTgId: tgId } }
        })
      : null;

    const players = await prisma.player.findMany({
      where: { gameId: game.id },
      orderBy: { id: 'asc' },
      select: { id:true, userTgId:true, name:true, hp:true, gold:true, skills:true, photo:true, note:true }
    });

    let currentLocation = null;
    if (game.currentLocationId) {
      currentLocation = await prisma.location.findUnique({
        where: { id: game.currentLocationId },
        select: { id: true, title: true, description: true, image: true }
      });
    }

    // броски последних 50
    const rolls = await prisma.roll.findMany({
      where: { gameId: game.id },
      orderBy: { at: 'desc' },
      take: 50,
      include: { player: { select: { name: true, userTgId: true } } }
    });

    res.json({
      code,
      status: game.status,
      isGM: tgId ? game.gmTgId === tgId : false,
      joined: Boolean(me),
      me,
      currentLocation,
      players: players.map(p => ({ tgId: p.userTgId, ...p })),
      rolls: rolls.map(r => ({ die: r.die, result: r.result, at: r.at, name: r.player.name, tgId: r.player.userTgId }))
    });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

// вход в лобби (имя + аватар)
app.post('/api/games/:code/join', async (req, res) => {
  try {
    const code = req.params.code;
    const { tgId, name, photo } = req.body || {};
    if (!tgId) return res.status(400).json({ error: 'tgId required' });

    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    await prisma.player.upsert({
      where: { gameId_userTgId: { gameId: game.id, userTgId: String(tgId) } },
      create: { gameId: game.id, userTgId: String(tgId), name: name || 'Hero', photo: photo || null },
      update: { name: name || undefined, photo: photo === undefined ? undefined : photo }
    });

    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

// чат
app.get('/api/games/:code/messages', async (req, res) => {
  try {
    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const msgs = await prisma.message.findMany({
      where: { gameId: game.id },
      orderBy: { at: 'desc' },
      take: 50
    });
    res.json(msgs.reverse());
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});
app.post('/api/games/:code/messages', async (req, res) => {
  try {
    const { tgId, name, text } = req.body || {};
    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    await prisma.message.create({ data: { gameId: game.id, userTgId: String(tgId||'0'), name: name || 'Hero', text } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

// правки игрока (hp/gold/name/note/photo)
app.patch('/api/games/:code/players/:tgId', async (req, res) => {
  try {
    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const { name, hp, gold, note, photo } = req.body || {};
    await prisma.player.update({
      where: { gameId_userTgId: { gameId: game.id, userTgId: String(req.params.tgId) } },
      data: {
        name:  name  === undefined ? undefined : String(name),
        hp:    hp    === undefined ? undefined : Number(hp),
        gold:  gold  === undefined ? undefined : Number(gold),
        note:  note  === undefined ? undefined : String(note),
        photo: photo === undefined ? undefined : photo
      }
    });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

// локации
app.get('/api/games/:code/locations', async (req, res) => {
  try {
    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const locs = await prisma.location.findMany({
      where: { gameId: game.id }, orderBy: { createdAt: 'asc' },
      select: { id:true, title:true, description:true, image:true }
    });
    res.json(locs);
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});
app.post('/api/games/:code/locations', async (req, res) => {
  try {
    const { title, description, image } = req.body || {};
    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    await prisma.location.create({ data: { gameId: game.id, title, description: description || '', image: image || null } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});
app.post('/api/games/:code/start', async (req, res) => {
  try {
    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    let loc = await prisma.location.findFirst({ where: { gameId: game.id }, orderBy: { createdAt: 'asc' } });
    if (!loc) loc = await prisma.location.create({ data: { gameId: game.id, title: 'Первая локация', description: 'Описание первой локации' } });
    await prisma.game.update({ where: { id: game.id }, data: { status: 'started', currentLocationId: loc.id } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});
app.post('/api/games/:code/locations/:locId/make-current', async (req, res) => {
  try {
    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    await prisma.game.update({ where: { id: game.id }, data: { currentLocationId: Number(req.params.locId) } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

// броски
app.post('/api/games/:code/roll', async (req, res) => {
  try {
    const { tgId, die } = req.body || {};
    const d = Number(die);
    if (!tgId || ![6,8,20].includes(d)) return res.status(400).json({ error: 'Invalid params' });

    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const player = await prisma.player.findUnique({ where: { gameId_userTgId: { gameId: game.id, userTgId: String(tgId) } } });
    if (!player) return res.status(400).json({ error: 'Player not joined' });

    const result = 1 + Math.floor(Math.random() * d);
    const roll = await prisma.roll.create({ data: { gameId: game.id, playerId: player.id, die: d, result } });
    res.json({ tgId: String(tgId), die: roll.die, result: roll.result, at: roll.at });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

// предметы / инвентарь
// ВНИМАНИЕ: "инвентарь игры" теперь НЕ возвращает предметы на полу (они скрыты до "осмотреться")
app.get('/api/games/:code/items', async (req, res) => {
  try {
    const ownerTgId = req.query.ownerTgId ? String(req.query.ownerTgId) : null;
    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    if (ownerTgId) {
      const owner = await prisma.player.findUnique({ where: { gameId_userTgId: { gameId: game.id, userTgId: ownerTgId } } });
      if (!owner) return res.json([]);
      const rows = await prisma.item.findMany({ where: { gameId: game.id, ownerPlayerId: owner.id }, orderBy: { createdAt: 'desc' } });
      return res.json(rows);
    }
    // скрываем содержимое пола
    return res.json([]);
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

// создать предмет: если ownerTgId нет — кладём на пол текущей локации (невидимый до "осмотреться")
app.post('/api/games/:code/items', async (req, res) => {
  try {
    const { name, qty = 1, note = '', type = 'misc', ownerTgId = null } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    let ownerPlayerId = null, locationId = null;
    if (ownerTgId) {
      const owner = await prisma.player.findUnique({ where: { gameId_userTgId: { gameId: game.id, userTgId: String(ownerTgId) } } });
      ownerPlayerId = owner?.id ?? null;
    } else {
      locationId = game.currentLocationId ?? null;
    }
    await prisma.item.create({ data: { gameId: game.id, ownerPlayerId, name, qty: Number(qty)||1, note, type, locationId } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

// передать предмет игроку / обратно на пол
app.post('/api/games/:code/items/:itemId/transfer', async (req, res) => {
  try {
    const { toTgId = null } = req.body || {};
    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    let data = {};
    if (toTgId) {
      const owner = await prisma.player.findUnique({ where: { gameId_userTgId: { gameId: game.id, userTgId: String(toTgId) } } });
      data = { ownerPlayerId: owner?.id ?? null, locationId: null };
    } else {
      data = { ownerPlayerId: null, locationId: game.currentLocationId ?? null };
    }
    await prisma.item.update({ where: { id: Number(req.params.itemId) }, data });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

app.delete('/api/games/:code/items/:itemId', async (req, res) => {
  try { await prisma.item.delete({ where: { id: Number(req.params.itemId) } }); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

// бросить золото на пол (невидимо до "осмотреться")
app.post('/api/games/:code/gold/drop', async (req, res) => {
  try {
    const amount = Math.max(1, Number(req.body?.amount || 1));
    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });
    await prisma.item.create({
      data: { gameId: game.id, ownerPlayerId: null, name: 'Золото', qty: amount, type: 'gold', note: '', locationId: game.currentLocationId ?? null }
    });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

// "осмотреться": подобрать ОДИН предмет из пола текущей локации (если qty>1 — забираем 1 шт.)
app.post('/api/games/:code/look-around', async (req, res) => {
  try {
    const { tgId } = req.body || {};
    const game = await prisma.game.findUnique({ where: { code: req.params.code } });
    if (!game) return res.status(404).json({ error: 'Game not found' });

    const player = await prisma.player.findUnique({ where: { gameId_userTgId: { gameId: game.id, userTgId: String(tgId) } } });
    if (!player) return res.status(400).json({ error: 'Player not joined' });

    const floor = await prisma.item.findFirst({
      where: { gameId: game.id, ownerPlayerId: null, locationId: game.currentLocationId ?? undefined },
      orderBy: { createdAt: 'asc' }
    });
    if (!floor) return res.json({ picked: null });

    let picked;
    if (floor.qty > 1) {
      // забираем 1 шт игроку
      await prisma.item.update({ where: { id: floor.id }, data: { qty: floor.qty - 1 } });
      picked = await prisma.item.create({
        data: { gameId: game.id, ownerPlayerId: player.id, name: floor.name, qty: 1, note: floor.note, type: floor.type }
      });
    } else {
      // целиком предмет игроку
      picked = await prisma.item.update({
        where: { id: floor.id }, data: { ownerPlayerId: player.id, locationId: null }
      });
    }
    res.json({ picked });
  } catch (e) { console.error(e); res.status(503).json({ error: 'db_unavailable' }); }
});

// --- START & WEBHOOK ------------------------------------
const server = app.listen(PORT, async () => {
  console.log('🌐 Web server on', PORT);
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    await bot.telegram.setWebhook(`${baseUrl}${webhookPath}`);
    console.log('🔗 Webhook set:', `${baseUrl}${webhookPath}`);
  } catch (e) { console.error('Webhook error:', e?.response?.description || e.message); }
});

process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
