// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Telegraf, Markup } from "telegraf";

// Prisma (опционально)
let PrismaClient = null;
try {
  ({ PrismaClient } = await import('@prisma/client'));
} catch (_) {
  // нет prisma в зависимостях — ок, уйдём в память
}

dotenv.config();

// ---------- Paths / Const ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT          = process.env.PORT || 10000;
const APP_URL       = process.env.APP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN     = process.env.BOT_TOKEN;
const BOT_SECRET    = process.env.BOT_SECRET_PATH || ("telegraf-" + Math.random().toString(36).slice(2));
const SIX_HOURS_MS  = 6 * 60 * 60 * 1000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- Static ----------
const WEB_DIR = path.join(__dirname, "webapp");
if (process.env.NODE_ENV !== 'production') {
  console.log("Static from:", WEB_DIR);
}
app.use(express.static(WEB_DIR));
// root fallback на корневой index.html (если он есть)
app.get("/", (req, res, next) => {
  const rootIndex = path.join(__dirname, "index.html");
  res.sendFile(rootIndex, (err) => {
    if (err) res.sendFile(path.join(WEB_DIR, "index.html"));
  });
});

// ---------- Helpers ----------
const nowTs = () => Date.now();
const addMs = (d, ms) => new Date(d.getTime() + ms);
const genCode = () =>
  Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(2, 8).padEnd(6, 'X').slice(0, 6);

const ok = (res, data={}) => res.json({ ok: true, data });
const err = (res, message="error") => res.status(400).json({ ok:false, error: message });

// ---------- In-memory store (fallback) ----------
const mem = {
  games: new Map(), // code -> game
};

// Структуры in-memory:
// game: { code, gmId, started, createdAt(ms), expiresAt(ms), locationId, players(Map userId->player), floor:[item], chat:[msg], locations: Map locId -> {id,name,desc,photoUrl}, }
// player: { userId, name, avatar, hp, gold, inventory:[{id,name,type}] , joinedAt(ms) }
// item: { id, name, type }
// msg: { ts, userId, name, text }

// ---------- Prisma DAL (если есть) ----------
const prisma = (PrismaClient && process.env.DATABASE_URL) ? new PrismaClient() : null;

// Небольшая прослойка DAL с одинаковыми методами для памяти и Prisma
const DAL = {

  // авто‑очистка старых игр
  async cleanupExpired() {
    if (!prisma) {
      const now = nowTs();
      for (const [code, g] of mem.games) {
        if (g.expiresAt && g.expiresAt <= now) mem.games.delete(code);
      }
      return;
    }
    try {
      await prisma.game.deleteMany({
        where: { expiresAt: { lte: new Date() } }
      });
    } catch (e) {
      console.error("cleanupExpired:", e.message);
    }
  },

  async touch(code) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (g) g.expiresAt = nowTs() + SIX_HOURS_MS;
      return;
    }
    try {
      await prisma.game.update({
        where: { code },
        data: { lastActivity: new Date(), expiresAt: addMs(new Date(), SIX_HOURS_MS) }
      });
    } catch (_) {}
  },

  // --- Game ---
  async createGame(gmId) {
    const now = new Date();

    if (!prisma) {
      // подобрать уникальный код
      let code;
      for (let i=0;i<10;i++) {
        const cand = genCode();
        if (!mem.games.has(cand)) { code = cand; break; }
      }
      if (!code) throw new Error("code generation failed");

      mem.games.set(code, {
        code,
        gmId,
        started: false,
        createdAt: nowTs(),
        expiresAt: nowTs() + SIX_HOURS_MS,
        locationId: null,
        players: new Map(),
        floor: [],
        chat: [],
        locations: new Map(),
      });
      return { code };
    }

    // Prisma: ретрай при P2002 (unique violation)
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = genCode();
      try {
        const game = await prisma.game.create({
          data: {
            code, gmId,
            started: false,
            createdAt: now,
            lastActivity: now,
            expiresAt: addMs(now, SIX_HOURS_MS),
          },
          select: { code: true }
        });
        return game;
      } catch (e) {
        if (e?.code === "P2002") continue;
        throw e;
      }
    }
    throw new Error("failed to create unique code");
  },

  async getGame(code) {
    if (!prisma) {
      const g = mem.games.get(code);
      return g ? structuredClone(g) : null;
    }
    const game = await prisma.game.findUnique({
      where: { code },
      include: {
        players: true,
        locations: true,
        floorItems: true,
        chat: { orderBy: { ts: 'asc' } }
      }
    });
    if (!game) return null;
    // приведение к in-memory форме наверх (минимум, что нужно фронту)
    return {
      code: game.code,
      gmId: game.gmId,
      started: game.started,
      locationId: game.locationId,
      players: new Map(game.players.map(p => [p.userId, {
        userId: p.userId, name: p.name, avatar: p.avatar, hp: p.hp, gold: p.gold,
        inventory: p.inventory ?? []
      }])),
      floor: game.floorItems ?? [],
      chat: game.chat ?? [],
      locations: new Map(game.locations.map(l => [l.id, { id:l.id, name:l.name, desc:l.desc, photoUrl:l.photoUrl }])),
    };
  },

  async addPlayer(code, userId, name, avatar) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) throw new Error("game_not_found");
      if (!g.players.has(userId)) {
        g.players.set(userId, { userId, name, avatar, hp: 10, gold: 0, inventory: [], joinedAt: nowTs() });
      } else {
        const p = g.players.get(userId);
        p.name = name; p.avatar = avatar;
      }
      return g.players.get(userId);
    }
    // upsert
    const p = await prisma.player.upsert({
      where: { gameCode_userId: { gameCode: code, userId } },
      create: { gameCode: code, userId, name, avatar, hp: 10, gold: 0, inventory: [] },
      update: { name, avatar }
    });
    return p;
  },

  async listPlayers(code) {
    const g = await this.getGame(code);
    if (!g) return [];
    return Array.from(g.players.values());
  },

  async addGold(code, userId, delta) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) throw new Error("game_not_found");
      const p = g.players.get(userId);
      if (!p) throw new Error("player_not_found");
      p.gold = Math.max(0, (p.gold||0) + Number(delta||0));
      return p.gold;
    }
    const p = await prisma.player.update({
      where: { gameCode_userId: { gameCode: code, userId } },
      data: { gold: { increment: Number(delta||0) } },
      select: { gold: true }
    });
    return p.gold;
  },

  async addHp(code, userId, delta) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) throw new Error("game_not_found");
      const p = g.players.get(userId);
      if (!p) throw new Error("player_not_found");
      p.hp = Math.max(0, (p.hp||0) + Number(delta||0));
      return p.hp;
    }
    const p = await prisma.player.update({
      where: { gameCode_userId: { gameCode: code, userId } },
      data: { hp: { increment: Number(delta||0) } },
      select: { hp: true }
    });
    return p.hp;
  },

  async giveItemToPlayer(code, userId, itemName) {
    const item = { id: "it_" + Math.random().toString(36).slice(2,9), name: itemName, type: "misc" };
    if (!prisma) {
      const g = mem.games.get(code);
      const p = g?.players.get(userId);
      if (!g || !p) throw new Error("not found");
      p.inventory.push(item);
      return item;
    }
    // упростим — храним инвентарь как JSON
    const p = await prisma.player.update({
      where: { gameCode_userId: { gameCode: code, userId } },
      data: {
        inventory: {
          push: item
        }
      },
      select: { inventory: true }
    });
    return item;
  },

  async dropItemToFloor(code, itemName) {
    const item = { id: "it_" + Math.random().toString(36).slice(2,9), name: itemName, type: "misc" };
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) throw new Error("game_not_found");
      g.floor.push(item);
      return item;
    }
    await prisma.floorItem.create({ data: { gameCode: code, id: item.id, name: item.name, type: item.type } });
    return item;
  },

  async lookAround(code, userId) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) throw new Error("game_not_found");
      if (!g.floor.length) return null;
      const item = g.floor.shift();
      const p = g.players.get(userId);
      if (!p) throw new Error("player_not_found");
      p.inventory.push(item);
      return item;
    }
    // В БД: взять первый предмет (по времени вставки), переложить игроку
    const first = await prisma.floorItem.findFirst({
      where: { gameCode: code },
      orderBy: { createdAt: 'asc' }
    });
    if (!first) return null;
    await prisma.floorItem.delete({ where: { id: first.id } });
    await prisma.player.update({
      where: { gameCode_userId: { gameCode: code, userId } },
      data: { inventory: { push: { id: first.id, name: first.name, type: first.type } } }
    });
    return { id:first.id, name:first.name, type:first.type };
  },

  async addLocation(code, name, desc, photoUrl) {
    const loc = { id: "loc_" + Math.random().toString(36).slice(2,8), name, desc, photoUrl: photoUrl || null };
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) throw new Error("game_not_found");
      g.locations.set(loc.id, loc);
      return loc;
    }
    await prisma.location.create({ data: { gameCode: code, id: loc.id, name, desc, photoUrl: loc.photoUrl } });
    return loc;
  },

  async setCurrentLocation(code, locId) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) throw new Error("game_not_found");
      g.locationId = locId;
      return;
    }
    await prisma.game.update({ where:{ code }, data:{ locationId: locId } });
  },

  async startGame(code) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) throw new Error("game_not_found");
      g.started = true;
      return;
    }
    await prisma.game.update({ where:{ code }, data:{ started: true } });
  },

  async addChat(code, userId, name, text) {
    const m = { ts: new Date().toISOString(), userId, name, text };
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) throw new Error("game_not_found");
      g.chat.push(m);
      return m;
    }
    await prisma.message.create({ data: { gameCode: code, ts: new Date(m.ts), userId, name, text } });
    return m;
  },

  async getChat(code) {
    if (!prisma) {
      const g = mem.games.get(code);
      return g ? (g.chat || []) : [];
    }
    const rows = await prisma.message.findMany({
      where:{ gameCode: code },
      orderBy:{ ts: 'asc' }
    });
    return rows.map(r => ({ ts:r.ts.toISOString(), userId:r.userId, name:r.name, text:r.text }));
  }
};

// периодически чистим игры
setInterval(() => DAL.cleanupExpired().catch(()=>{}), 60 * 1000);

// ---------- Telegram Bot ----------
if (!BOT_TOKEN) {
  console.warn("BOT_TOKEN is not set — бот не запускается.");
}
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

// ждём коды join ровно от тех, кого попросили
const pendingJoinUsers = new Set();

if (bot) {
  bot.start(async (ctx) => {
    await ctx.reply("Dnd Mini App. Выбери действие:", Markup.inlineKeyboard([
      [ Markup.button.webApp("Открыть мини‑апп", `${APP_URL}`) ]
    ]));
  });

  bot.command("new", async (ctx) => {
    const gmId = String(ctx.from.id);
    try {
      const g = await DAL.createGame(gmId);
      await ctx.reply(`Создана игра. Код: ${g.code}\nОткрой мини‑апп и продолжай.`, Markup.inlineKeyboard([
        [ Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${g.code}`) ]
      ]));
    } catch (e) {
      console.error("NEW failed:", e?.code, e?.message);
      await ctx.reply("Не удалось создать игру. Попробуй ещё раз.");
    }
  });

  bot.command("join", async (ctx) => {
    const uid = String(ctx.from.id);
    pendingJoinUsers.add(uid);
    await ctx.reply("Введи код комнаты (6 символов):");
  });

  bot.on("text", async (ctx) => {
    const uid = String(ctx.from.id);
    if (!pendingJoinUsers.has(uid)) return;
    const code = (ctx.message.text || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      await ctx.reply("Код должен быть 6 символов (латиница/цифры). Попробуй ещё раз.");
      return;
    }
    pendingJoinUsers.delete(uid);
    await ctx.reply(`Код принят: ${code}. Открой мини‑апп и войди в лобби.`, Markup.inlineKeyboard([
      [ Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${code}`) ]
    ]));
  });

  // webhook
  app.use(bot.webhookCallback(`/telegraf/${BOT_SECRET}`));
}

// ---------- API для мини‑аппы ----------

// состояние игры/роли
app.get("/api/game/:code/state", async (req, res) => {
  try {
    const { code } = req.params;
    const userId = String(req.query.userId || "");
    const game = await DAL.getGame(code);
    if (!game) return err(res, "game_not_found");

    const isGM = userId && userId === String(game.gmId);
    const p = userId ? Array.from(game.players.values()).find(x => x.userId === userId) : null;

    ok(res, {
      game: {
        code: game.code,
        started: game.started,
        locationId: game.locationId,
        players: Array.from(game.players.values()).map(p => ({ userId:p.userId, name:p.name, avatar:p.avatar, hp:p.hp, gold:p.gold })),
        floor: game.floor,
        locations: Array.from(game.locations.values()),
      },
      me: p || null,
      role: isGM ? "gm" : (p ? "player" : "guest")
    });
  } catch (e) {
    err(res, e.message);
  }
});

// вход в лобби
app.post("/api/lobby/join", async (req, res) => {
  try {
    const { code, userId, name, avatar } = req.body;
    if (!code || !userId || !name) return err(res, "bad_request");
    const g = await DAL.getGame(code);
    if (!g) return err(res, "game_not_found");
    const p = await DAL.addPlayer(code, String(userId), String(name).slice(0,32), String(avatar||""));
    await DAL.touch(code);
    ok(res, { player: p });
  } catch (e) {
    err(res, e.message);
  }
});

// чат
app.get("/api/chat", async (req, res) => {
  try {
    const { code } = req.query;
    const list = await DAL.getChat(String(code));
    ok(res, { list });
  } catch (e) { err(res, e.message); }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { code, userId, name, text } = req.body;
    const m = await DAL.addChat(code, String(userId), String(name), String(text||""));
    ok(res, { message: m });
  } catch (e) { err(res, e.message); }
});

// GM: золото/хп
app.post("/api/gm/gold", async (req,res) => {
  try {
    const { code, userId, delta } = req.body;
    const val = await DAL.addGold(code, String(userId), Number(delta||0));
    ok(res, { gold: val });
  } catch (e) { err(res, e.message); }
});
app.post("/api/gm/hp", async (req,res) => {
  try {
    const { code, userId, delta } = req.body;
    const val = await DAL.addHp(code, String(userId), Number(delta||0));
    ok(res, { hp: val });
  } catch (e) { err(res, e.message); }
});

// GM: предметы
app.post("/api/gm/give-item", async (req,res) => {
  try {
    const { code, userId, name } = req.body;
    const item = await DAL.giveItemToPlayer(code, String(userId), String(name));
    ok(res, { item });
  } catch (e) { err(res, e.message); }
});
app.post("/api/gm/drop-item", async (req,res) => {
  try {
    const { code, name } = req.body;
    const item = await DAL.dropItemToFloor(code, String(name));
    ok(res, { item });
  } catch (e) { err(res, e.message); }
});

// игрок: осмотреться — забрать 1 предмет с пола
app.post("/api/player/look-around", async (req,res) => {
  try {
    const { code, userId } = req.body;
    const item = await DAL.lookAround(code, String(userId));
    ok(res, { item }); // может быть null — тогда «пусто»
  } catch (e) { err(res, e.message); }
});

// локации
app.post("/api/gm/location/add", async (req,res) => {
  try {
    const { code, name, desc, photoUrl } = req.body;
    const loc = await DAL.addLocation(code, String(name), String(desc||""), String(photoUrl||""));
    ok(res, { location: loc });
  } catch (e) { err(res, e.message); }
});
app.post("/api/gm/location/set", async (req,res) => {
  try {
    const { code, locId } = req.body;
    await DAL.setCurrentLocation(code, String(locId));
    ok(res);
  } catch (e) { err(res, e.message); }
});
app.post("/api/gm/start", async (req,res) => {
  try {
    const { code } = req.body;
    await DAL.startGame(code);
    ok(res);
  } catch (e) { err(res, e.message); }
});

// ---------- Start ----------
app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);
  if (bot) {
    const hook = `${APP_URL}/telegraf/${BOT_SECRET}`;
    try {
      await bot.telegram.setWebhook(hook);
      console.log("🔗 Webhook set:", hook);
    } catch (e) {
      console.error("Webhook error:", e.message);
    }
  }
});
