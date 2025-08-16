// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telegraf, Markup } from 'telegraf';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// -------- static & uploads
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ dest: path.join(__dirname, 'uploads') });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/', express.static(path.join(__dirname, 'public')));

// -------- helpers
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_SECRET_PATH = process.env.BOT_SECRET_PATH || 'telegraf-secret';
const APP_URL = process.env.APP_URL?.replace(/\/$/, '');

// util: gen 6-digit code
function code6() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

// ---- health/db check
app.get('/health', (_, res) => res.send('ok'));
app.get('/db-check', async (_, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ db: 'ok' });
  } catch (e) {
    res.status(500).json({ db: 'fail', error: String(e) });
  }
});

// ================== API ==================

// state for mini-app
app.get('/api/state', async (req, res) => {
  try {
    const { code, tgId } = req.query;
    const game = await prisma.game.findUnique({
      where: { code: String(code) },
      include: {
        players: true,
        items: true,
        locations: true,
        currentLocation: true,
      },
    });
    if (!game) return res.status(404).json({ error: 'GAME_NOT_FOUND' });

    const me = tgId
      ? await prisma.player.findFirst({ where: { gameId: game.id, tgId: String(tgId) } })
      : null;

    const floorHidden = game.items.filter((i) => i.onFloor && !i.revealed);
    const floorVisible = game.items.filter((i) => i.onFloor && i.revealed);

    res.json({
      me,
      game: {
        code: game.code,
        started: game.started,
        currentLocation: game.currentLocation
          ? {
              id: game.currentLocation.id,
              title: game.currentLocation.title,
              descr: game.currentLocation.descr,
              imageUrl: game.currentLocation.imageUrl || null,
            }
          : null,
      },
      players: game.players.map((p) => ({
        id: p.id,
        tgId: p.tgId,
        name: p.name,
        avatar: p.avatar,
        role: p.role,
        hp: p.hp,
        gold: p.gold,
        desc: p.desc,
      })),
      myInventory: me ? await prisma.item.findMany({ where: { ownerId: me.id } }) : [],
      floorVisible, // видно всем
      floorHiddenCount: floorHidden.length, // для кнопки «Осмотреться»
    });
  } catch (e) {
    console.error('state error', e);
    res.status(500).json({ error: 'STATE_FAIL' });
  }
});

// join lobby: set name + avatar
app.post('/api/join-lobby', async (req, res) => {
  try {
    const { code, tgId, name, avatar } = req.body;
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ error: 'GAME_NOT_FOUND' });

    let pl = await prisma.player.findFirst({ where: { gameId: game.id, tgId } });
    if (pl) {
      pl = await prisma.player.update({
        where: { id: pl.id },
        data: { name, avatar },
      });
    } else {
      pl = await prisma.player.create({
        data: { name, avatar, role: tgId === game.ownerTgId ? 'gm' : 'player', tgId, gameId: game.id },
      });
    }
    res.json({ ok: true, player: pl });
  } catch (e) {
    console.error('join-lobby', e);
    res.status(500).json({ error: 'JOIN_FAIL' });
  }
});

// chat: list
app.get('/api/chat', async (req, res) => {
  try {
    const { code, limit = 50 } = req.query;
    const game = await prisma.game.findUnique({ where: { code: String(code) } });
    if (!game) return res.status(404).json({ error: 'GAME_NOT_FOUND' });

    const msgs = await prisma.message.findMany({
      where: { gameId: game.id },
      orderBy: { createdAt: 'asc' },
      take: Number(limit),
    });
    res.json(msgs);
  } catch (e) {
    console.error('chat list', e);
    res.status(500).json({ error: 'CHAT_LIST_FAIL' });
  }
});

// chat: send
app.post('/api/chat', async (req, res) => {
  try {
    const { code, tgId, author, text } = req.body;
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ error: 'GAME_NOT_FOUND' });

    const pl = await prisma.player.findFirst({ where: { gameId: game.id, tgId } });
    if (!pl) return res.status(403).json({ error: 'NOT_IN_GAME' });

    const msg = await prisma.message.create({
      data: { gameId: game.id, authorId: pl.id, author: author || pl.name, text },
    });
    res.json(msg);
  } catch (e) {
    console.error('chat send', e);
    res.status(500).json({ error: 'CHAT_SEND_FAIL' });
  }
});

// player: look (reveal one floor thing to player)
app.post('/api/look', async (req, res) => {
  try {
    const { code, tgId } = req.body;
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ error: 'GAME_NOT_FOUND' });
    if (!game.started) return res.status(400).json({ error: 'NOT_STARTED' });

    const me = await prisma.player.findFirst({ where: { gameId: game.id, tgId } });
    if (!me) return res.status(403).json({ error: 'NOT_IN_GAME' });

    const item = await prisma.item.findFirst({
      where: { gameId: game.id, onFloor: true, revealed: false },
      orderBy: { createdAt: 'asc' },
    });
    if (!item) return res.json({ ok: true, picked: null });

    const updated = await prisma.item.update({
      where: { id: item.id },
      data: { revealed: true, onFloor: false, ownerId: me.id },
    });
    res.json({ ok: true, picked: updated });
  } catch (e) {
    console.error('look', e);
    res.status(500).json({ error: 'LOOK_FAIL' });
  }
});

// GM: adjust HP/Gold
app.post('/api/gm/adjust', async (req, res) => {
  try {
    const { code, tgId, playerId, hpDelta = 0, goldDelta = 0 } = req.body;
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ error: 'GAME_NOT_FOUND' });
    if (tgId !== game.ownerTgId) return res.status(403).json({ error: 'NOT_GM' });

    const pl = await prisma.player.update({
      where: { id: playerId },
      data: { hp: { increment: hpDelta }, gold: { increment: goldDelta } },
    });
    res.json({ ok: true, player: pl });
  } catch (e) {
    console.error('gm adjust', e);
    res.status(500).json({ error: 'GM_ADJUST_FAIL' });
  }
});

// GM: give item to player or drop to floor
app.post('/api/gm/item', async (req, res) => {
  try {
    const { code, tgId, title, toPlayerId, kind = 'item', amount = 1, toFloor = false } = req.body;
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ error: 'GAME_NOT_FOUND' });
    if (tgId !== game.ownerTgId) return res.status(403).json({ error: 'NOT_GM' });

    const data = {
      title,
      kind,
      amount,
      gameId: game.id,
      onFloor: !!toFloor,
      revealed: false,
    };
    if (!toFloor && toPlayerId) data['ownerId'] = toPlayerId;

    const item = await prisma.item.create({ data });
    res.json({ ok: true, item });
  } catch (e) {
    console.error('gm item', e);
    res.status(500).json({ error: 'GM_ITEM_FAIL' });
  }
});

// GM: drop gold to floor (as item kind=gold)
app.post('/api/gm/gold-floor', async (req, res) => {
  try {
    const { code, tgId, amount = 1 } = req.body;
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ error: 'GAME_NOT_FOUND' });
    if (tgId !== game.ownerTgId) return res.status(403).json({ error: 'NOT_GM' });

    const item = await prisma.item.create({
      data: { title: 'Gold', kind: 'gold', amount, onFloor: true, revealed: false, gameId: game.id },
    });
    res.json({ ok: true, item });
  } catch (e) {
    console.error('gm gold floor', e);
    res.status(500).json({ error: 'GM_GOLD_FLOOR_FAIL' });
  }
});

// GM: add location (with image upload), set current, start game
app.post('/api/gm/location', upload.single('image'), async (req, res) => {
  try {
    const { code, tgId, title, descr } = req.body;
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ error: 'GAME_NOT_FOUND' });
    if (tgId !== game.ownerTgId) return res.status(403).json({ error: 'NOT_GM' });

    let imageUrl = null;
    if (req.file) {
      imageUrl = `${APP_URL}/uploads/${req.file.filename}`;
    }

    const loc = await prisma.location.create({
      data: { title, descr: descr || '', imageUrl, gameId: game.id },
    });
    res.json({ ok: true, location: loc });
  } catch (e) {
    console.error('gm location', e);
    res.status(500).json({ error: 'GM_LOCATION_FAIL' });
  }
});

app.post('/api/gm/set-location', async (req, res) => {
  try {
    const { code, tgId, locationId } = req.body;
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ error: 'GAME_NOT_FOUND' });
    if (tgId !== game.ownerTgId) return res.status(403).json({ error: 'NOT_GM' });

    const up = await prisma.game.update({
      where: { id: game.id },
      data: { currentLocationId: locationId },
      include: { currentLocation: true },
    });
    res.json({ ok: true, currentLocation: up.currentLocation });
  } catch (e) {
    console.error('set-location', e);
    res.status(500).json({ error: 'SET_LOCATION_FAIL' });
  }
});

app.post('/api/gm/start', async (req, res) => {
  try {
    const { code, tgId } = req.body;
    const game = await prisma.game.findUnique({ where: { code } });
    if (!game) return res.status(404).json({ error: 'GAME_NOT_FOUND' });
    if (tgId !== game.ownerTgId) return res.status(403).json({ error: 'NOT_GM' });

    const up = await prisma.game.update({ where: { id: game.id }, data: { started: true } });
    res.json({ ok: true, started: up.started });
  } catch (e) {
    console.error('start game', e);
    res.status(500).json({ error: 'START_FAIL' });
  }
});

// ================== BOT (Telegraf) ==================
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing');
} else {
  const bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    return ctx.reply(
      'Dnd Mini App. Выбери действие:',
      Markup.inlineKeyboard([
        Markup.button.webApp('Открыть мини‑апп', `${APP_URL}?code=&tgId=${ctx.from.id}`),
      ])
    );
  });

  bot.command('new', async (ctx) => {
    const tgId = String(ctx.from.id);
    const code = code6();
    try {
      // создаём игру и ГМа (или апдейтим имя ГМа как #test)
      await prisma.game.create({
        data: { code, ownerTgId: tgId },
      });
      await prisma.player.upsert({
        where: { tgId_gameId: { tgId, gameId: (await prisma.game.findUnique({ where: { code } })).id } },
        create: { tgId, name: '#test', role: 'gm', gameId: (await prisma.game.findUnique({ where: { code } })).id },
        update: {},
      });
      await ctx.reply(`Игра создана. Код: ${code}`);
      return ctx.reply(
        'Открыть панель мастера',
        Markup.inlineKeyboard([Markup.button.webApp('Открыть мини‑апп', `${APP_URL}?code=${code}&tgId=${tgId}`)])
      );
    } catch (e) {
      console.error('new', e);
      return ctx.reply('Не удалось создать игру. Попробуй ещё раз через минуту.');
    }
  });

  bot.command('join', async (ctx) => {
    await ctx.reply('Введи код комнаты (6 символов):');
    bot.once('text', async (m) => {
      const code = (m.text || '').trim().toUpperCase();
      const game = await prisma.game.findUnique({ where: { code } }).catch(() => null);
      if (!game) return ctx.reply('Код неверный. Попробуй ещё раз.');
      await ctx.reply(
        `Код принят: ${code}. Открой мини‑аппу и введи имя в лобби.`,
        Markup.inlineKeyboard([
          Markup.button.webApp('Открыть мини‑апп', `${APP_URL}?code=${code}&tgId=${ctx.from.id}`)
        ])
      );
    });
  });

  // webhook
  if (APP_URL) {
    const secretPath = `/telegraf/${BOT_SECRET_PATH}`;
    app.use(secretPath, bot.webhookCallback(secretPath));
    await bot.telegram.setWebhook(`${APP_URL}${secretPath}`);
    console.log('🔗 Webhook set:', `${APP_URL}${secretPath}`);
  } else {
    bot.launch();
    console.log('🤖 Bot started with long polling');
  }
}

// ================== START ==================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 Web server on ${PORT}`));
