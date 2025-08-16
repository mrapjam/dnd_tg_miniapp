// server.js — Telegraf + Express + Prisma (raw SQL) + автосоздание таблиц
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
app.use(cors());
app.use(bodyParser.json());

const bot = new Telegraf(BOT_TOKEN);
const baseUrl = (APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const webhookPath = `/telegraf/${BOT_SECRET_PATH}`;

// ============ Устойчивость процесса ============
process.on('unhandledRejection', e => console.error('UNHANDLED:', e));
process.on('uncaughtException', e => console.error('UNCAUGHT:', e));

async function dbOk() {
  try { await prisma.$queryRaw`select 1`; return true; }
  catch (e) { console.error('DB check fail:', e?.code || e?.message); return false; }
}
function safe(res, fn) {
  return fn().catch(e => {
    console.error('DB error:', e?.code || e?.message);
    res.status(503).json({ error: 'db_unavailable' });
  });
}

// ============ Автосоздание таблиц ============
async function initDb() {
  await prisma.$executeRawUnsafe(`
    create table if not exists "Game" (
      id serial primary key,
      code text unique not null,
      "gmTgId" text not null,
      status text not null default 'lobby',
      "currentLocationId" integer null,
      "createdAt" timestamp with time zone default now()
    );
    create table if not exists "Player" (
      id serial primary key,
      "gameId" integer not null references "Game"(id) on delete cascade,
      "userTgId" text not null,
      name text not null,
      hp integer not null default 10,
      gold integer not null default 0,
      skills jsonb not null default '[]',
      photo text null,
      "createdAt" timestamp with time zone default now(),
      unique ("gameId","userTgId")
    );
    create table if not exists "Message" (
      id serial primary key,
      "gameId" integer not null references "Game"(id) on delete cascade,
      "userTgId" text not null,
      name text not null,
      text text not null,
      at timestamp with time zone default now()
    );
    create table if not exists "Location" (
      id serial primary key,
      "gameId" integer not null references "Game"(id) on delete cascade,
      title text not null,
      description text not null default '',
      "createdAt" timestamp with time zone default now()
    );
    create table if not exists "Item" (
      id serial primary key,
      "gameId" integer not null references "Game"(id) on delete cascade,
      "ownerPlayerId" integer null references "Player"(id) on delete set null,
      name text not null,
      qty integer not null default 1,
      note text not null default '',
      type text not null default 'misc',
      "locationId" integer null references "Location"(id) on delete set null,
      "createdAt" timestamp with time zone default now()
    );
    create table if not exists "Roll" (
      id serial primary key,
      "gameId" integer not null references "Game"(id) on delete cascade,
      "playerId" integer not null references "Player"(id) on delete cascade,
      die integer not null,
      result integer not null,
      at timestamp with time zone default now()
    );
  `);
}

// ============ Бот ============
const pendingJoin = new Map(); // userId -> ждём код

bot.use((ctx, next) => { console.log('Update:', ctx.updateType); return next(); });

function makeAppUrlWithUser(code, ctx) {
  const qp = new URLSearchParams();
  if (code) qp.set('code', code);
  if (ctx?.from?.id) qp.set('tgId', String(ctx.from.id));
  if (ctx?.from?.first_name) qp.set('name', ctx.from.first_name);
  return `${baseUrl}/?${qp.toString()}`;
}

bot.start(ctx =>
  ctx.reply('DnD Mini App. Выбери действие:',
    Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑апп', makeAppUrlWithUser('', ctx))]])
  )
);

bot.command('ping', ctx => ctx.reply('pong'));

bot.command(['new', 'startgame'], async (ctx) => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  await safe(ctx, async () => {
    await prisma.$executeRaw`
      insert into "Game"(code,"gmTgId") values (${code}, ${String(ctx.from.id)})
      on conflict (code) do nothing
    `;
    await ctx.reply(
      `Игра создана. Код: ${code}`,
      Markup.inlineKeyboard([[Markup.button.webApp('Панель мастера', makeAppUrlWithUser(code, ctx))]])
    );
  });
});

bot.command(['app', 'open'], async (ctx) => {
  const code = (ctx.message.text.split(/\s+/)[1] || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return ctx.reply('Использование: /app ABC123');
  await safe(ctx, async () => {
    const rows = await prisma.$queryRaw`select id from "Game" where code=${code} limit 1`;
    if (!rows?.length) return ctx.reply('Игра не найдена.');
    return ctx.reply(
      `Код принят: ${code}. Открой мини‑аппу:`,
      Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑апп', makeAppUrlWithUser(code, ctx))]])
    );
  });
});

bot.command('join', async (ctx) => {
  pendingJoin.set(ctx.from.id, true);
  ctx.reply('Введи код комнаты (6 символов):');
});

bot.on('text', async (ctx) => {
  if (!pendingJoin.get(ctx.from.id)) return;
  const code = (ctx.message.text || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return ctx.reply('Код должен быть из 6 символов. Попробуй ещё раз:');
  pendingJoin.delete(ctx.from.id);
  await safe(ctx, async () => {
    const rows = await prisma.$queryRaw`select id from "Game" where code=${code} limit 1`;
    if (!rows?.length) return ctx.reply('Игра не найдена. Введи другой код:');
    return ctx.reply(
      `Код принят: ${code}. Открой мини‑аппу и войди в лобби.`,
      Markup.inlineKeyboard([[Markup.button.webApp('Открыть мини‑апп', makeAppUrlWithUser(code, ctx))]])
    );
  });
});

// ============ Webhook
app.post(webhookPath, (req, res) => bot.webhookCallback(webhookPath)(req, res));
app.get(webhookPath, (_req, res) => res.status(200).send('ok'));

// ============ Static + health
app.use(express.static('webapp'));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/db-check', async (_req, res) => res.send((await dbOk()) ? 'db: ok' : 'db: fail'));

// ============ API
// создать игру (из мини‑аппы)
app.post('/api/games', (req, res) => safe(res, async () => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const gmTgId = String(req.body?.gmTgId || '0');
  await prisma.$executeRaw`insert into "Game"(code,"gmTgId") values (${code}, ${gmTgId})`;
  res.json({ code });
}));

// получить состояние игры
app.get('/api/games/:code', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const tgId = req.query.tgId ? String(req.query.tgId) : null;

  const games = await prisma.$queryRaw`
    select id, code, "gmTgId", status, "currentLocationId" from "Game" where code=${code} limit 1
  `;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  const game = games[0];
  const isGM = tgId ? (game.gmTgId === tgId) : false;

  const players = await prisma.$queryRaw`
    select id, "userTgId" as "tgId", name, hp, gold, skills, photo
    from "Player" where "gameId"=${game.id} order by id asc
  `;
  const rolls = await prisma.$queryRaw`
    select r.*, p."userTgId" as "tgId", p.name
    from "Roll" r join "Player" p on p.id=r."playerId"
    where r."gameId"=${game.id} order by r.at desc limit 50
  `;
  let currentLocation = null;
  if (game.currentLocationId) {
    const loc = await prisma.$queryRaw`
      select id, title, description from "Location" where id=${game.currentLocationId} limit 1
    `;
    currentLocation = loc?.[0] || null;
  }
  res.json({ code, status: game.status, isGM, gmTgId: game.gmTgId, currentLocation, players, rolls });
}));

// войти в лобби
app.post('/api/games/:code/join', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const { tgId, name } = req.body || {};
  if (!tgId) return res.status(400).json({ error: 'tgId required' });

  const games = await prisma.$queryRaw`select id from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  const gameId = games[0].id;

  await prisma.$executeRaw`
    insert into "Player"("gameId","userTgId",name) values (${gameId}, ${String(tgId)}, ${name || 'Hero'})
    on conflict ("gameId","userTgId") do update set name=excluded.name
  `;
  res.json({ ok: true });
}));

// чат
app.get('/api/games/:code/messages', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const games = await prisma.$queryRaw`select id from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  const rows = await prisma.$queryRaw`
    select id, "userTgId" as "tgId", name, text, at
    from "Message" where "gameId"=${games[0].id} order by at desc limit 50
  `;
  res.json(rows);
}));
app.post('/api/games/:code/messages', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const { tgId, name, text } = req.body || {};
  if (!tgId || !text) return res.status(400).json({ error: 'tgId & text required' });

  const games = await prisma.$queryRaw`select id from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });

  await prisma.$executeRaw`
    insert into "Message"("gameId","userTgId",name,text)
    values (${games[0].id}, ${String(tgId)}, ${name || 'Hero'}, ${text})
  `;
  res.json({ ok: true });
}));

// обновление игрока (HP/Gold/Name)
app.patch('/api/games/:code/players/:tgId', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const { name, hp, gold } = req.body || {};
  const games = await prisma.$queryRaw`select id from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  const gameId = games[0].id;

  const sets = [];
  if (name !== undefined) sets.push(`name=${prisma.$queryRaw`${String(name)}`.values[0]}`);
  if (hp   !== undefined) sets.push(`hp=${Number(hp)}`);
  if (gold !== undefined) sets.push(`gold=${Number(gold)}`);
  if (!sets.length) return res.json({ ok: true });

  await prisma.$executeRawUnsafe(`
    update "Player" set ${sets.join(',')}
    where "gameId"=${gameId} and "userTgId"='${String(req.params.tgId)}'
  `);
  res.json({ ok: true });
}));

// локации
app.get('/api/games/:code/locations', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const games = await prisma.$queryRaw`select id from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  const rows = await prisma.$queryRaw`
    select id, title, description from "Location"
    where "gameId"=${games[0].id} order by "createdAt" asc
  `;
  res.json(rows);
}));
app.post('/api/games/:code/locations', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const { title, description } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const games = await prisma.$queryRaw`select id from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  await prisma.$executeRaw`
    insert into "Location"("gameId",title,description)
    values (${games[0].id}, ${title}, ${description || ''})
  `;
  res.json({ ok: true });
}));
app.post('/api/games/:code/start', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const games = await prisma.$queryRaw`select id from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  const locs = await prisma.$queryRaw`
    select id from "Location" where "gameId"=${games[0].id} order by "createdAt" asc
  `;
  let firstId = locs?.[0]?.id;
  if (!firstId) {
    const r = await prisma.$queryRaw`
      insert into "Location"("gameId",title,description)
      values (${games[0].id}, ${'Первая локация'}, ${'Описание первой локации'}) returning id
    `;
    firstId = r?.[0]?.id;
  }
  await prisma.$executeRaw`
    update "Game" set status='started', "currentLocationId"=${firstId}
    where id=${games[0].id}
  `;
  res.json({ ok: true });
}));
app.post('/api/games/:code/locations/:locId/make-current', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const games = await prisma.$queryRaw`select id from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  await prisma.$executeRaw`
    update "Game" set "currentLocationId"=${Number(req.params.locId)}
    where id=${games[0].id}
  `;
  res.json({ ok: true });
}));

// кости
app.post('/api/games/:code/roll', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const { tgId, die } = req.body || {};
  const d = Number(die);
  if (!tgId || ![6,8,20].includes(d)) return res.status(400).json({ error: 'Invalid params' });

  const games = await prisma.$queryRaw`select id from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });

  const ps = await prisma.$queryRaw`
    select id from "Player" where "gameId"=${games[0].id} and "userTgId"=${String(tgId)} limit 1
  `;
  if (!ps?.length) return res.status(400).json({ error: 'Player not joined' });

  const result = 1 + Math.floor(Math.random() * d);
  const roll = await prisma.$queryRaw`
    insert into "Roll"("gameId","playerId",die,result)
    values (${games[0].id}, ${ps[0].id}, ${d}, ${result})
    returning die,result,at
  `;
  res.json({ tgId: String(tgId), die: roll[0].die, result: roll[0].result, at: roll[0].at });
}));

// инвентарь
app.get('/api/games/:code/items', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const ownerTgId = req.query.ownerTgId ? String(req.query.ownerTgId) : null;
  const games = await prisma.$queryRaw`select id,"currentLocationId" from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  const game = games[0];

  if (ownerTgId) {
    const rows = await prisma.$queryRaw`
      select i.id, i.name, i.qty, i.note, i.type, i."ownerPlayerId", i."locationId",
             p."userTgId" as "ownerTgId", p.name as "ownerName"
      from "Item" i join "Player" p on p.id=i."ownerPlayerId"
      where i."gameId"=${game.id} and p."userTgId"=${ownerTgId}
      order by i."createdAt" desc
    `;
    return res.json(rows);
  }

  const rows = await prisma.$queryRaw`
    select i.id, i.name, i.qty, i.note, i.type, i."ownerPlayerId", i."locationId",
           p."userTgId" as "ownerTgId", p.name as "ownerName"
    from "Item" i
    left join "Player" p on p.id=i."ownerPlayerId"
    where i."gameId"=${game.id}
    order by i."createdAt" desc
  `;
  res.json(rows.map(it => ({ ...it, isInCurrentLocation: it.locationId === game.currentLocationId })));
}));
app.post('/api/games/:code/items', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const { name, qty = 1, note = '', type = 'misc', ownerTgId = null } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const games = await prisma.$queryRaw`select id,"currentLocationId" from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  const game = games[0];

  let ownerPlayerId = null, locationId = null;
  if (ownerTgId) {
    const p = await prisma.$queryRaw`
      select id from "Player" where "gameId"=${game.id} and "userTgId"=${String(ownerTgId)} limit 1
    `;
    ownerPlayerId = p?.[0]?.id || null;
  } else {
    locationId = game.currentLocationId || null;
  }

  await prisma.$executeRaw`
    insert into "Item"("gameId","ownerPlayerId","name","qty","note","type","locationId")
    values (${game.id}, ${ownerPlayerId}, ${name}, ${Number(qty)||1}, ${note}, ${type}, ${locationId})
  `;
  res.json({ ok: true });
}));
app.post('/api/games/:code/items/:itemId/transfer', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const { toTgId = null } = req.body || {};
  const games = await prisma.$queryRaw`select id,"currentLocationId" from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  const game = games[0];

  let newOwnerId = null, locationId = null;
  if (toTgId) {
    const p = await prisma.$queryRaw`
      select id from "Player" where "gameId"=${game.id} and "userTgId"=${String(toTgId)} limit 1
    `;
    newOwnerId = p?.[0]?.id || null;
  } else {
    locationId = game.currentLocationId || null;
  }

  await prisma.$executeRaw`
    update "Item" set "ownerPlayerId"=${newOwnerId}, "locationId"=${locationId}
    where id=${Number(req.params.itemId)}
  `;
  res.json({ ok: true });
}));
app.delete('/api/games/:code/items/:itemId', (req, res) => safe(res, async () => {
  await prisma.$executeRaw`delete from "Item" where id=${Number(req.params.itemId)}`;
  res.json({ ok: true });
}));
app.post('/api/games/:code/gold/drop', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const { amount = 1 } = req.body || {};
  const games = await prisma.$queryRaw`select id,"currentLocationId" from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });
  await prisma.$executeRaw`
    insert into "Item"("gameId","ownerPlayerId","name","qty","note","type","locationId")
    values (${games[0].id}, null, ${'Золото'}, ${Number(amount)||1}, ${''}, ${'gold'}, ${games[0].currentLocationId || null})
  `;
  res.json({ ok: true });
}));
app.post('/api/games/:code/look-around', (req, res) => safe(res, async () => {
  const code = req.params.code;
  const { tgId } = req.body || {};
  if (!tgId) return res.status(400).json({ error: 'tgId required' });
  const games = await prisma.$queryRaw`select id,"currentLocationId" from "Game" where code=${code} limit 1`;
  if (!games?.length) return res.status(404).json({ error: 'Game not found' });

  const ps = await prisma.$queryRaw`
    select id from "Player" where "gameId"=${games[0].id} and "userTgId"=${String(tgId)} limit 1
  `;
  if (!ps?.length) return res.status(400).json({ error: 'Player not joined' });

  await prisma.$executeRaw`
    update "Item"
    set "ownerPlayerId"=${ps[0].id}, "locationId"=null
    where "gameId"=${games[0].id} and "ownerPlayerId" is null and "locationId"=${games[0].currentLocationId || null}
  `;
  res.json({ ok: true });
}));

// ============ Запуск
async function setWebhookWithRetry() {
  const url = `${baseUrl}${webhookPath}`;
  for (let i = 0; i < 8; i++) {
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
      await bot.telegram.setWebhook(url);
      console.log('🔗 Webhook set:', url);
      return;
    } catch (e) {
      console.error(`Webhook set failed (${i+1}/8):`, e?.response?.description || e.message);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  console.error('⚠️ Webhook not set, продолжаю работать (long retry).');
}

const server = app.listen(PORT, async () => {
  console.log('🌐 Web server on', PORT);
  await initDb();
  await setWebhookWithRetry();
});

process.once('SIGINT', () => server.close(() => process.exit(0)));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
