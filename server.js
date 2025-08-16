// Telegraf + Express + Prisma + Lobby/Chat/Locations + Inventory with floor-by-location + GM guard
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

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN is required'); process.exit(1); }
if (!DATABASE_URL) { console.error('❌ DATABASE_URL is required'); process.exit(1); }

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== Telegram Bot =====
const bot = new Telegraf(BOT_TOKEN);
const baseUrl = APP_URL || `http://localhost:${PORT}`;
const webhookPath = `/telegraf/${BOT_SECRET_PATH}`;

bot.use((ctx, next) => { console.log('Update:', ctx.updateType); return next(); });

bot.start((ctx) =>
  ctx.reply(
    'DnD Mini App. Выбери действие:',
    Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑апп', `${baseUrl}/`)]])
  )
);

bot.command('ping', (ctx) => ctx.reply('pong'));

// /new — только в чате
bot.command(['new', 'startgame'], async (ctx) => {
  try {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    await prisma.game.create({ data: { code, gmTgId: String(ctx.from.id) } });
    await ctx.reply(
      `Игра создана. Код: ${code}\nОткрой мини‑аппу.`,
      Markup.inlineKeyboard([[Markup.button.webApp('Панель мастера', `${baseUrl}/?code=${code}`)]])
    );
  } catch (e) {
    console.error('ERROR /new:', e);
    await ctx.reply('Не удалось создать игру. Проверь БД и попробуй снова.');
  }
});

// /join — имя вводим в mini-app
bot.command('join', (ctx) => {
  ctx.reply('Введи код комнаты (6 символов):');
  const askCode = async (ctx2) => {
    const code = (ctx2.message.text || '').trim().toUpperCase();
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) { await ctx2.reply('Игры с таким кодом нет. Введи код ещё раз:'); return; }
    await ctx2.reply(
      'Открывай мини‑аппу и введи имя в лобби.',
      Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑апп', `${baseUrl}/?code=${code}`)]])
    );
    bot.off('text', askCode);
  };
  bot.on('text', askCode);
});

// Быстрые броски из чата
bot.hears(/^\/roll (d6|d8|d20)$/i, (ctx) => {
  const die = Number(ctx.match[1].slice(1));
  const result = 1 + Math.floor(Math.random() * die);
  return ctx.reply(`🎲 ${ctx.from.first_name} бросил d${die}: *${result}*`, { parse_mode: 'Markdown' });
});

// ===== Webhook
app.post(webhookPath, (req, res) => bot.webhookCallback(webhookPath)(req, res));
app.get(webhookPath, (_req, res) => res.status(200).send('ok'));

// ===== Static + health
app.use(express.static('webapp'));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/db-check', async (_req, res) => {
  try { await prisma.$queryRaw`select 1`; res.send('db: ok'); }
  catch(e){ console.error(e); res.status(500).send('db: fail'); }
});

// ===== Helpers
async function findGameByCode(code) {
  return prisma.game.findUnique({ where: { code } });
}
async function ensurePlayer(gameId, tgId, name) {
  return prisma.player.upsert({
    where: { gameId_userTgId: { gameId, userTgId: String(tgId) } },
    create: { gameId, userTgId: String(tgId), name: name || 'Hero' },
    update: name ? { name } : {}
  });
}
// Простая проверка «ГМ ли это»: клиент шлёт заголовок X-Tg-Id (его Telegram user id)
// В проде стоит проверять initData hash — для MVP оставим так.
async function assertGM(req, res, next) {
  const tgId = String(req.headers['x-tg-id'] || '');
  const code = req.params.code;
  const game = await findGameByCode(code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (tgId !== game.gmTgId) return res.status(403).json({ error: 'forbidden' });
  req.game = game;
  next();
}

// ===== API: core game
app.post('/api/games', async (req, res) => {
  try {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const { gmTgId } = req.body || {};
    await prisma.game.create({ data: { code, gmTgId: String(gmTgId || '0') } });
    res.json({ code });
  } catch (e) {
    console.error('API create game error', e);
    res.status(500).json({ error: 'create_failed' });
  }
});

// Войти в лобби
app.post('/api/games/:code/join', async (req, res) => {
  const game = await findGameByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const { tgId, name } = req.body || {};
  if (!tgId) return res.status(400).json({ error: 'tgId required' });
  await ensurePlayer(game.id, tgId, name);
  res.json({ ok: true });
});

// Состояние игры
app.get('/api/games/:code', async (req, res) => {
  const game = await prisma.game.findUnique({
    where: { code: req.params.code },
    include: { players: true, rolls: { orderBy: { at: 'desc' }, take: 50 } }
  });
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const qTgId = req.query.tgId ? String(req.query.tgId) : null;
  const isGM = qTgId ? (game.gmTgId === qTgId) : false;

  let currentLocation = null;
  if (game.currentLocationId) {
    const rows = await prisma.$queryRaw`
      select id, title, description from "Location" where id = ${game.currentLocationId} limit 1
    `;
    currentLocation = rows?.[0] || null;
  }

  res.json({
    code: game.code,
    status: game.status,
    isGM,
    gmTgId: game.gmTgId,
    currentLocation,
    players: game.players.map(p => ({
      id: p.id, tgId: p.userTgId, name: p.name, hp: p.hp, gold: p.gold, skills: p.skills, photo: p.photo
    })),
    rolls: game.rolls
  });
});

// Обновить игрока (имя/HP/Gold)
app.patch('/api/games/:code/players/:tgId', async (req, res) => {
  const game = await findGameByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const { name, hp, gold } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = String(name);
  if (hp   !== undefined) data.hp   = Number(hp);
  if (gold !== undefined) data.gold = Number(gold);
  const player = await prisma.player.update({
    where: { gameId_userTgId: { gameId: game.id, userTgId: String(req.params.tgId) } },
    data
  });
  res.json({ ok: true, player });
});

// ===== Lobby: chat
app.get('/api/games/:code/messages', async (req, res) => {
  const game = await findGameByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const rows = await prisma.$queryRaw`
    select id, "userTgId", name, text, at
    from "Message"
    where "gameId" = ${game.id}
    order by at desc
    limit 50
  `;
  res.json(rows);
});

app.post('/api/games/:code/messages', async (req, res) => {
  const game = await findGameByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const { tgId, name, text } = req.body || {};
  if (!tgId || !text) return res.status(400).json({ error: 'tgId & text required' });
  await ensurePlayer(game.id, tgId, name);
  await prisma.$executeRaw`
    insert into "Message" ("gameId","userTgId","name","text")
    values (${game.id}, ${String(tgId)}, ${name || 'Hero'}, ${text})
  `;
  res.json({ ok: true });
});

// ===== Locations (GM-only)
app.get('/api/games/:code/locations', async (req, res) => {
  const game = await findGameByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const rows = await prisma.$queryRaw`
    select id, title, description from "Location"
    where "gameId" = ${game.id}
    order by "createdAt" asc
  `;
  res.json(rows);
});

app.post('/api/games/:code/locations', assertGM, async (req, res) => {
  const game = req.game;
  const { title, description } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  await prisma.$executeRaw`
    insert into "Location" ("gameId","title","description")
    values (${game.id}, ${title}, ${description || ''})
  `;
  res.json({ ok: true });
});

app.post('/api/games/:code/start', assertGM, async (req, res) => {
  const game = req.game;
  const locs = await prisma.$queryRaw`
    select id from "Location" where "gameId" = ${game.id} order by "createdAt" asc
  `;
  const firstId = locs?.[0]?.id;
  if (!firstId) {
    const rows = await prisma.$queryRaw`
      insert into "Location" ("gameId","title","description")
      values (${game.id}, ${'Первая локация'}, ${'Описание первой локации'})
      returning id
    `;
    await prisma.$executeRaw`
      update "Game"
      set "status" = 'started', "currentLocationId" = ${rows?.[0]?.id}
      where id = ${game.id}
    `;
  } else {
    await prisma.$executeRaw`
      update "Game"
      set "status" = 'started', "currentLocationId" = ${firstId}
      where id = ${game.id}
    `;
  }
  res.json({ ok: true });
});

app.post('/api/games/:code/locations/:locId/make-current', assertGM, async (req, res) => {
  const game = req.game;
  await prisma.$executeRaw`
    update "Game"
    set "currentLocationId" = ${req.params.locId}
    where id = ${game.id}
  `;
  res.json({ ok: true });
});

// ===== Dice
app.post('/api/games/:code/roll', async (req, res) => {
  const { tgId, die } = req.body || {};
  const d = Number(die);
  if (!tgId || ![6, 8, 20].includes(d)) return res.status(400).json({ error: 'Invalid params' });

  const game = await findGameByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const player = await prisma.player.findUnique({
    where: { gameId_userTgId: { gameId: game.id, userTgId: String(tgId) } }
  });
  if (!player) return res.status(400).json({ error: 'Player not joined' });

  const result = 1 + Math.floor(Math.random() * d);
  const roll = await prisma.roll.create({
    data: { gameId: game.id, playerId: player.id, die: d, result }
  });

  res.json({ tgId: player.userTgId, die: roll.die, result: roll.result, at: roll.at });
});

// ===== Inventory & floor-by-location
// Список предметов игры. ?ownerTgId=... — только этого игрока.
app.get('/api/games/:code/items', async (req, res) => {
  const game = await findGameByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const ownerTgId = req.query.ownerTgId ? String(req.query.ownerTgId) : null;

  if (ownerTgId) {
    const items = await prisma.$queryRaw`
      select i.id, i.name, i.qty, i.note, i.type, i."ownerPlayerId", i."locationId",
             p."userTgId" as "ownerTgId", p.name as "ownerName"
      from "Item" i
      join "Player" p on p.id = i."ownerPlayerId"
      where i."gameId" = ${game.id} and p."userTgId" = ${ownerTgId}
      order by i."createdAt" desc
    `;
    return res.json(items);
  }

  const curLocId = game.currentLocationId || null;
  const items = await prisma.$queryRaw`
    select i.id, i.name, i.qty, i.note, i.type, i."ownerPlayerId", i."locationId",
           p."userTgId" as "ownerTgId", p.name as "ownerName",
           case when i."ownerPlayerId" is null and i."locationId" is not null then 'floor' else 'inv' end as place
    from "Item" i
    left join "Player" p on p.id = i."ownerPlayerId"
    where i."gameId" = ${game.id}
    order by i."createdAt" desc
  `;
  res.json(items.map(it => ({ ...it, isInCurrentLocation: it.locationId === curLocId })));
});

// Добавить/выдать предмет (GM). ownerTgId=null => на пол в ТЕКУЩЕЙ локации
app.post('/api/games/:code/items', assertGM, async (req, res) => {
  const game = req.game;
  const { name, qty = 1, note = '', type = 'misc', ownerTgId = null } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  let ownerPlayerId = null;
  let locationId = null;

  if (ownerTgId) {
    const p = await prisma.player.findUnique({
      where: { gameId_userTgId: { gameId: game.id, userTgId: String(ownerTgId) } }
    });
    ownerPlayerId = p?.id || null;
  } else {
    // на пол в текущей локации (если игра уже начата)
    locationId = game.currentLocationId || null;
  }

  await prisma.$executeRaw`
    insert into "Item" ("gameId","ownerPlayerId","name","qty","note","type","locationId")
    values (${game.id}, ${ownerPlayerId}, ${name}, ${Number(qty)||1}, ${note}, ${type}, ${locationId})
  `;
  res.json({ ok: true });
});

// Передать предмет (или на пол ТЕКУЩЕЙ локации)
app.post('/api/games/:code/items/:itemId/transfer', async (req, res) => {
  const { toTgId = null } = req.body || {};
  const game = await findGameByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  let newOwnerId = null;
  let locationId = null;

  if (toTgId) {
    const p = await prisma.player.findUnique({
      where: { gameId_userTgId: { gameId: game.id, userTgId: String(toTgId) } }
    });
    newOwnerId = p?.id || null;
  } else {
    // на пол в текущей локации
    locationId = game.currentLocationId || null;
  }

  await prisma.$executeRaw`
    update "Item" set "ownerPlayerId" = ${newOwnerId}, "locationId" = ${locationId}
    where id = ${req.params.itemId}
  `;
  res.json({ ok: true });
});

// Удалить предмет (GM-only)
app.delete('/api/games/:code/items/:itemId', assertGM, async (req, res) => {
  await prisma.$executeRaw`delete from "Item" where id = ${req.params.itemId}`;
  res.json({ ok: true });
});

// Осмотреться: взять ВСЁ «на полу в текущей локации»
app.post('/api/games/:code/look-around', async (req, res) => {
  const { tgId } = req.body || {};
  const game = await findGameByCode(req.params.code);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (!tgId) return res.status(400).json({ error: 'tgId required' });

  const player = await prisma.player.findUnique({
    where: { gameId_userTgId: { gameId: game.id, userTgId: String(tgId) } }
  });
  if (!player) return res.status(400).json({ error: 'Player not joined' });

  await prisma.$executeRaw`
    update "Item"
    set "ownerPlayerId" = ${player.id}, "locationId" = null
    where "gameId" = ${game.id}
      and "ownerPlayerId" is null
      and "locationId" = ${game.currentLocationId || null}
  `;
  res.json({ ok: true });
});

// Бросить золото на пол (GM-only) — предмет "Золото" в текущей локации
app.post('/api/games/:code/gold/drop', assertGM, async (req, res) => {
  const game = req.game;
  const { amount = 1 } = req.body || {};
  await prisma.$executeRaw`
    insert into "Item" ("gameId","ownerPlayerId","name","qty","note","type","locationId")
    values (${game.id}, null, ${'Золото'}, ${Number(amount)||1}, ${''}, ${'gold'}, ${game.currentLocationId || null})
  `;
  res.json({ ok: true });
});

// ===== Start server + webhook
const server = app.listen(PORT, async () => {
  console.log('🌐 Web server on', PORT);
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    await bot.telegram.setWebhook(`${baseUrl}${webhookPath}`);
    console.log('🔗 Webhook set:', `${baseUrl}${webhookPath}`);
  } catch (e) {
    console.error('❌ Failed to set webhook:', e?.response?.description || e.message);
    process.exit(1);
  }
});

process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
