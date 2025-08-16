// Telegraf (webhook) + Express + Prisma. GM-панель, инвентарь с типами.
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

// /new — создаёт игру. По договорённости — делает это мастер.
bot.command(['new', 'startgame'], async (ctx) => {
  try {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    await prisma.game.create({ data: { code, gmTgId: String(ctx.from.id) } });
    await ctx.reply(
      `Игра создана. Код: ${code}`,
      Markup.inlineKeyboard([[Markup.button.webApp('Панель мастера', `${baseUrl}/?code=${code}`)]])
    );
  } catch (e) {
    console.error('ERROR /new:', e);
    await ctx.reply('Не удалось создать игру. Проверь подключение к базе и попробуй снова.');
  }
});

// /join — 2 шага: код → имя
bot.command('join', (ctx) => {
  ctx.reply('Введи код комнаты (6 символов):');
  const askCode = async (ctx2) => {
    const code = (ctx2.message.text || '').trim().toUpperCase();
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) { await ctx2.reply('Игры с таким кодом нет. Введи код ещё раз:'); return; }

    await ctx2.reply('Отлично! Введи имя персонажа (как тебя будут видеть):');

    const askName = async (ctx3) => {
      const name = (ctx3.message.text || '').trim().slice(0, 40) || ctx3.from.first_name;
      const tgId = String(ctx3.from.id);

      await prisma.player.upsert({
        where: { gameId_userTgId: { gameId: game.id, userTgId: tgId } },
        create: { gameId: game.id, userTgId: tgId, name },
        update: { name }
      });

      await ctx3.reply(
        `Готово, ${name}!`,
        Markup.inlineKeyboard([[Markup.button.webApp('Открыть игру', `${baseUrl}/?code=${code}`)]])
      );
      bot.off('text', askName);
    };

    bot.off('text', askCode);
    bot.on('text', askName);
  };
  bot.on('text', askCode);
});

// Быстрые броски из чата
bot.hears(/^\/roll (d6|d8|d20)$/i, (ctx) => {
  const die = Number(ctx.match[1].slice(1));
  const result = 1 + Math.floor(Math.random() * die);
  return ctx.reply(`🎲 ${ctx.from.first_name} бросил d${die}: *${result}*`, { parse_mode: 'Markdown' });
});

// ===== Webhook маршруты (до остальных) =====
app.post(webhookPath, (req, res) => bot.webhookCallback(webhookPath)(req, res));
app.get(webhookPath, (_req, res) => res.status(200).send('ok'));

// ===== Static + health =====
app.use(express.static('webapp'));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/db-check', async (_req, res) => {
  try { await prisma.$queryRaw`select 1 as ok`; res.send('db: ok'); }
  catch(e){ console.error(e); res.status(500).send('db: fail'); }
});

// ===== API: игры/игроки/броски =====

// Создать игру из мини‑аппы (показывается только без кода/для ГМа)
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

// Join из мини‑аппы
app.post('/api/games/:code/join', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { code: req.params.code } });
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const { tgId, name } = req.body || {};
  if (!tgId) return res.status(400).json({ error: 'tgId required' });

  await prisma.player.upsert({
    where: { gameId_userTgId: { gameId: game.id, userTgId: String(tgId) } },
    create: { gameId: game.id, userTgId: String(tgId), name: name || 'Player' },
    update: name ? { name } : {}
  });

  res.json({ ok: true });
});

// Информация об игре (+ isGM)
app.get('/api/games/:code', async (req, res) => {
  const game = await prisma.game.findUnique({
    where: { code: req.params.code },
    include: { players: true, rolls: { orderBy: { at: 'desc' }, take: 50 } }
  });
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const qTgId = req.query.tgId ? String(req.query.tgId) : null;
  const isGM = qTgId ? (game.gmTgId === qTgId) : false;

  res.json({
    code: game.code,
    isGM,
    gmTgId: game.gmTgId,
    players: game.players.map(p => ({
      id: p.id, tgId: p.userTgId, name: p.name, hp: p.hp, gold: p.gold, skills: p.skills, photo: p.photo
    })),
    rolls: game.rolls
  });
});

// Патч игрока (имя/HP/Gold) — используется в GM‑панели и при вводе имени
app.patch('/api/games/:code/players/:tgId', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { code: req.params.code } });
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

// Бросок кости
app.post('/api/games/:code/roll', async (req, res) => {
  const { tgId, die } = req.body || {};
  const d = Number(die);
  if (!tgId || ![6, 8, 20].includes(d)) return res.status(400).json({ error: 'Invalid params' });

  const game = await prisma.game.findUnique({ where: { code: req.params.code } });
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

// ===== API: Инвентарь (через raw SQL; колонка "type" добавлена SQL-скриптом) =====

// Список предметов игры. ?ownerTgId=... — только этого игрока.
app.get('/api/games/:code/items', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { code: req.params.code } });
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const ownerTgId = req.query.ownerTgId ? String(req.query.ownerTgId) : null;

  if (ownerTgId) {
    const items = await prisma.$queryRaw`
      select i.id, i.name, i.qty, i.note, i.type, i."ownerPlayerId",
             p."userTgId" as "ownerTgId", p.name as "ownerName"
      from "Item" i
      join "Player" p on p.id = i."ownerPlayerId"
      where i."gameId" = ${game.id} and p."userTgId" = ${ownerTgId}
      order by i."createdAt" desc
    `;
    return res.json(items);
  }

  const items = await prisma.$queryRaw`
    select i.id, i.name, i.qty, i.note, i.type, i."ownerPlayerId",
           p."userTgId" as "ownerTgId", p.name as "ownerName"
    from "Item" i
    left join "Player" p on p.id = i."ownerPlayerId"
    where i."gameId" = ${game.id}
    order by i."createdAt" desc
  `;
  res.json(items);
});

// Добавить/выдать предмет (GM)
app.post('/api/games/:code/items', async (req, res) => {
  const { name, qty = 1, note = '', type = 'misc', ownerTgId = null } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const game = await prisma.game.findUnique({ where: { code: req.params.code } });
  if (!game) return res.status(404).json({ error: 'Game not found' });

  let ownerPlayerId = null;
  if (ownerTgId) {
    const p = await prisma.player.findUnique({
      where: { gameId_userTgId: { gameId: game.id, userTgId: String(ownerTgId) } }
    });
    ownerPlayerId = p?.id || null;
  }

  await prisma.$executeRaw`
    insert into "Item" ("gameId","ownerPlayerId","name","qty","note","type")
    values (${game.id}, ${ownerPlayerId}, ${name}, ${Number(qty)||1}, ${note}, ${type})
  `;
  res.json({ ok: true });
});

// Передать предмет (или уронить на пол)
app.post('/api/games/:code/items/:itemId/transfer', async (req, res) => {
  const { toTgId = null } = req.body || {};
  const game = await prisma.game.findUnique({ where: { code: req.params.code } });
  if (!game) return res.status(404).json({ error: 'Game not found' });

  let newOwnerId = null;
  if (toTgId) {
    const p = await prisma.player.findUnique({
      where: { gameId_userTgId: { gameId: game.id, userTgId: String(toTgId) } }
    });
    newOwnerId = p?.id || null;
  }

  await prisma.$executeRaw`
    update "Item" set "ownerPlayerId" = ${newOwnerId}
    where id = ${req.params.itemId}
  `;
  res.json({ ok: true });
});

// Удалить предмет
app.delete('/api/games/:code/items/:itemId', async (req, res) => {
  await prisma.$executeRaw`delete from "Item" where id = ${req.params.itemId}`;
  res.json({ ok: true });
});

// ===== Start + set webhook =====
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
