// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import { Telegraf, Markup } from "telegraf";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_SECRET_PATH = process.env.BOT_SECRET_PATH || ("telegraf-" + Math.random().toString(16).slice(2, 8));
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- STATIC FRONTEND (webapp/) ----------
const WEB_DIR = path.join(__dirname, "webapp");
app.use(express.static(WEB_DIR));
app.get("/", (req, res) => {
  res.sendFile(path.join(WEB_DIR, "index.html"));
});

// ---------- HELPERS ----------
const nowTs = () => Date.now();
const genCode = () =>
  Math.random().toString(36).replace(/[^a-z0-9]/gi, "").toUpperCase().slice(2, 8);

const AVATARS = [
  "shield", "sword", "bow", "mage", "scout", "horse"
];

const addMs = (d, ms) => new Date(d.getTime() + ms);

// ---------- PRISMA (fallback на память) ----------
let prisma = null;
try {
  if (process.env.DATABASE_URL) {
    prisma = new PrismaClient();
    // простая проверка подключения
    prisma.$queryRawUnsafe(`SELECT 1`).catch(() => {});
  }
} catch (_) {
  prisma = null;
}

// ---------- In‑memory для fallback ----------
const mem = {
  games: new Map(), // code -> { code, gmId, started, createdAt, expiresAt, locationId, players: Map(userId->player), floor:[], chat:[], locations: Map(id->{}) }
};

// ---------- DAL ----------
const DAL = {
  // Создать игру
  async createGame(gmId) {
    const code = genCode();
    const now = new Date();
    if (!prisma) {
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
    const game = await prisma.game.create({
      data: {
        code,
        gmId,
        started: false,
        createdAt: now,
        lastActivity: now,
        expiresAt: addMs(now, SIX_HOURS_MS),
      },
      select: { code: true },
    });
    return game;
  },

  // Получить игру + проверить TTL
  async getGame(code) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      if (g.expiresAt && g.expiresAt < nowTs()) {
        mem.games.delete(code);
        return null;
      }
      return g;
    }
    const g = await prisma.game.findUnique({ where: { code } });
    if (!g) return null;
    if (g.expiresAt && new Date(g.expiresAt) < new Date()) {
      await prisma.$transaction([
        prisma.message.deleteMany({ where: { gameCode: code } }),
        prisma.item.deleteMany({ where: { gameCode: code } }),
        prisma.player.deleteMany({ where: { gameCode: code } }),
        prisma.location.deleteMany({ where: { gameCode: code } }),
        prisma.game.delete({ where: { code } }),
      ]);
      return null;
    }
    return g;
  },

  // Вступить в игру (создать/обновить игрока)
  async joinGame({ code, userId, name, avatar }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      const p = g.players.get(userId);
      if (!p) {
        g.players.set(userId, {
          userId,
          name: name || "Hero",
          avatar: avatar || null,
          hp: 10,
          gold: 0,
          inventory: [],
        });
      } else {
        if (name) p.name = name;
        if (avatar) p.avatar = avatar;
      }
      return { ok: true };
    }
    const g = await this.getGame(code);
    if (!g) return null;

    await prisma.player.upsert({
      where: { gameCode_userId: { gameCode: code, userId } },
      update: { name, avatar },
      create: { gameCode: code, userId, name: name || "Hero", avatar, hp: 10, gold: 0 },
    });
    await prisma.game.update({
      where: { code },
      data: { lastActivity: new Date() },
    });
    return { ok: true };
  },

  // Список игроков
  async listPlayers(code) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return [];
      return Array.from(g.players.values());
    }
    return prisma.player.findMany({
      where: { gameCode: code },
      orderBy: { createdAt: "asc" },
    });
  },

  // Выдать/отнять золото
  async addGold({ code, userId, delta }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g || !g.players.has(userId)) return null;
      const p = g.players.get(userId);
      p.gold = Math.max(0, (p.gold || 0) + delta);
      return { gold: p.gold };
    }
    const g = await this.getGame(code);
    if (!g) return null;
    const upd = await prisma.player.update({
      where: { gameCode_userId: { gameCode: code, userId } },
      data: { gold: { increment: delta } },
      select: { gold: true },
    });
    await prisma.game.update({ where: { code }, data: { lastActivity: new Date() } });
    return { gold: upd.gold };
  },

  // Выдать/отнять HP
  async addHp({ code, userId, delta }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g || !g.players.has(userId)) return null;
      const p = g.players.get(userId);
      p.hp = Math.max(0, (p.hp || 0) + delta);
      return { hp: p.hp };
    }
    const g = await this.getGame(code);
    if (!g) return null;
    const upd = await prisma.player.update({
      where: { gameCode_userId: { gameCode: code, userId } },
      data: { hp: { increment: delta } },
      select: { hp: true },
    });
    await prisma.game.update({ where: { code }, data: { lastActivity: new Date() } });
    return { hp: upd.hp };
  },

  // Выдать предмет игроку
  async giveItemTo({ code, userId, itemName }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g || !g.players.has(userId)) return null;
      const p = g.players.get(userId);
      p.inventory.push({ id: "itm_" + nowTs(), name: itemName });
      return true;
    }
    const g = await this.getGame(code);
    if (!g) return null;
    const player = await prisma.player.findUnique({
      where: { gameCode_userId: { gameCode: code, userId } },
      select: { id: true },
    });
    await prisma.item.create({
      data: { gameCode: code, name: itemName, type: "item", onFloor: false, ownerId: player?.id || null },
    });
    await prisma.game.update({ where: { code }, data: { lastActivity: new Date() } });
    return true;
  },

  // Бросить предмет/золото на пол
  async dropItem({ code, itemName }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      g.floor.push({ id: "f_" + nowTs(), name: itemName, type: "item" });
      return true;
    }
    const g = await this.getGame(code);
    if (!g) return null;
    await prisma.item.create({ data: { gameCode: code, name: itemName, type: "item", onFloor: true } });
    await prisma.game.update({ where: { code }, data: { lastActivity: new Date() } });
    return true;
  },
  async dropGold({ code, amount }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      g.floor.push({ id: "g_" + nowTs(), type: "gold", name: "Gold", amount: Number(amount) || 1 });
      return true;
    }
    const g = await this.getGame(code);
    if (!g) return null;
    await prisma.item.create({ data: { gameCode: code, name: "Gold", type: "gold", onFloor: true, amount: Number(amount) || 1 } });
    await prisma.game.update({ where: { code }, data: { lastActivity: new Date() } });
    return true;
  },

  // Поднять с пола (по одному)
  async pickFromFloor({ code, userId }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return { picked: null };
      const p = g.players.get(userId);
      if (!p) return { picked: null };

      const item = g.floor.shift() || null;
      if (!item) return { picked: null, gold: p.gold, inventory: p.inventory };

      if (item.type === "gold") {
        p.gold = (p.gold || 0) + (item.amount || 1);
        return { picked: { type: "gold", amount: item.amount }, gold: p.gold, inventory: p.inventory };
      } else {
        const invItem = { id: "itm_" + nowTs(), name: item.name };
        p.inventory.push(invItem);
        return { picked: { type: "item", name: item.name }, gold: p.gold, inventory: p.inventory };
      }
    }
    const g = await this.getGame(code);
    if (!g) return { picked: null };
    const first = await prisma.item.findFirst({
      where: { gameCode: code, onFloor: true },
      orderBy: { createdAt: "asc" },
    });
    if (!first) return { picked: null };

    if (first.type === "gold") {
      await prisma.$transaction([
        prisma.player.update({
          where: { gameCode_userId: { gameCode: code, userId } },
          data: { gold: { increment: first.amount || 1 } },
        }),
        prisma.item.delete({ where: { id: first.id } }),
      ]);
      const p = await prisma.player.findUnique({
        where: { gameCode_userId: { gameCode: code, userId } },
        select: { gold: true },
      });
      await prisma.game.update({ where: { code }, data: { lastActivity: new Date() } });
      return { picked: { type: "gold", amount: first.amount || 1 }, gold: p?.gold || 0 };
    } else {
      const player = await prisma.player.findUnique({
        where: { gameCode_userId: { gameCode: code, userId } },
        select: { id: true },
      });
      await prisma.item.update({
        where: { id: first.id },
        data: { onFloor: false, ownerId: player?.id || null },
      });
      await prisma.game.update({ where: { code }, data: { lastActivity: new Date() } });
      return { picked: { type: "item", name: first.name } };
    }
  },

  // Локации
  async addLocation({ code, title, description, imageUrl }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      const id = "loc_" + nowTs();
      g.locations.set(id, { id, title, description: description || "", imageUrl: imageUrl || null });
      return { id, title, description, imageUrl };
    }
    const g = await this.getGame(code);
    if (!g) return null;
    const loc = await prisma.location.create({
      data: { gameCode: code, title, description: description || null, imageUrl: imageUrl || null },
    });
    await prisma.game.update({ where: { code }, data: { lastActivity: new Date() } });
    return loc;
  },
  async setCurrentLocation({ code, locationId }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      g.locationId = locationId;
      return { locationId };
    }
    const g = await this.getGame(code);
    if (!g) return null;
    await prisma.game.update({ where: { code }, data: { locationId, lastActivity: new Date() } });
    return { locationId };
  },

  // Запуск/остановка игры
  async setStarted({ code, started }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      g.started = !!started;
      return { started: g.started };
    }
    const g = await this.getGame(code);
    if (!g) return null;
    const upd = await prisma.game.update({
      where: { code },
      data: { started: !!started, lastActivity: new Date() },
      select: { started: true },
    });
    return upd;
  },

  // Текущее состояние для фронта
  async getState({ code, userId }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      const me = g.players.get(userId);
      const players = Array.from(g.players.values()).map(p => ({
        userId: p.userId, name: p.name, avatar: p.avatar, hp: p.hp, gold: p.gold, invCount: (p.inventory || []).length
      }));
      const location = g.locationId ? g.locations.get(g.locationId) : null;
      return {
        code: g.code,
        started: g.started,
        isGM: userId === g.gmId,
        me: me ? { userId: me.userId, name: me.name, avatar: me.avatar, hp: me.hp, gold: me.gold } : null,
        players,
        floorCount: g.floor.length,
        myInventory: me?.inventory || [],
        location,
        avatars: AVATARS,
      };
    }

    const g = await this.getGame(code);
    if (!g) return null;

    const [players, floorCount, me, myItems, location] = await Promise.all([
      prisma.player.findMany({ where: { gameCode: code }, orderBy: { createdAt: "asc" } }),
      prisma.item.count({ where: { gameCode: code, onFloor: true } }),
      prisma.player.findUnique({ where: { gameCode_userId: { gameCode: code, userId } } }),
      prisma.item.findMany({ where: { gameCode: code, owner: { gameCode: code, userId } } }),
      g.locationId ? prisma.location.findUnique({ where: { id: g.locationId } }) : null,
    ]);

    return {
      code: g.code,
      started: g.started,
      isGM: userId === g.gmId,
      me: me ? { userId: me.userId, name: me.name, avatar: me.avatar, hp: me.hp, gold: me.gold } : null,
      players: players.map(p => ({
        userId: p.userId, name: p.name, avatar: p.avatar, hp: p.hp, gold: p.gold, invCount: 0
      })),
      floorCount,
      myInventory: myItems.map(i => ({ id: i.id, name: i.name })),
      location: location || null,
      avatars: AVATARS,
    };
  },

  // Чат
  async sendChat({ code, userId, name, text }) {
    const safeText = (text || "").toString().slice(0, 500);
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      const msg = { id: "m_" + nowTs(), userId, name, text: safeText, ts: nowTs() };
      g.chat.push(msg);
      return msg;
    }
    const g = await this.getGame(code);
    if (!g) return null;
    const msg = await prisma.message.create({
      data: { gameCode: code, userId, name, text: safeText },
    });
    await prisma.game.update({ where: { code }, data: { lastActivity: new Date() } });
    return { id: msg.id, userId: msg.userId, name: msg.name, text: msg.text, ts: msg.createdAt.getTime() };
  },
  async listChat({ code, afterTs }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return [];
      return (g.chat || []).filter(m => !afterTs || m.ts > Number(afterTs));
    }
    const g = await this.getGame(code);
    if (!g) return [];
    const msgs = await prisma.message.findMany({
      where: { gameCode: code, ...(afterTs ? { createdAt: { gt: new Date(Number(afterTs)) } } : {}) },
      orderBy: { createdAt: "asc" },
    });
    return msgs.map(m => ({ id: m.id, userId: m.userId, name: m.name, text: m.text, ts: m.createdAt.getTime() }));
  },
};

// ---------- AUTO CLEANUP EXPIRED (каждые 10 мин) ----------
if (prisma) {
  setInterval(async () => {
    try {
      const now = new Date();
      const expired = await prisma.game.findMany({
        where: { expiresAt: { lt: now } },
        select: { code: true },
      });
      for (const g of expired) {
        await prisma.$transaction([
          prisma.message.deleteMany({ where: { gameCode: g.code } }),
          prisma.item.deleteMany({ where: { gameCode: g.code } }),
          prisma.player.deleteMany({ where: { gameCode: g.code } }),
          prisma.location.deleteMany({ where: { gameCode: g.code } }),
          prisma.game.delete({ where: { code: g.code } }),
        ]);
        console.log("🧹 removed expired game:", g.code);
      }
    } catch (e) {
      console.log("cleanup error:", e?.message || e);
    }
  }, 10 * 60 * 1000);
}

// ---------- API ----------
app.get("/healthz", (req, res) => res.json({ ok: true }));

// создать новую игру (GM)
app.post("/api/game/new", async (req, res) => {
  try {
    const gmId = (req.body?.gmId || "").toString();
    if (!gmId) return res.status(400).json({ error: "gmId required" });
    const game = await DAL.createGame(gmId);
    res.json({ code: game.code });
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// войти в игру
app.post("/api/game/join", async (req, res) => {
  try {
    const { code, userId, name, avatar } = req.body || {};
    if (!code || !userId) return res.status(400).json({ error: "code & userId required" });
    const ok = await DAL.joinGame({ code, userId, name, avatar });
    if (!ok) return res.status(404).json({ error: "game not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// запустить игру
app.post("/api/game/start", async (req, res) => {
  try {
    const { code, started } = req.body || {};
    const g = await DAL.setStarted({ code, started: !!started });
    if (!g) return res.status(404).json({ error: "game not found" });
    res.json(g);
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// состояние
app.get("/api/state", async (req, res) => {
  try {
    const code = (req.query.code || "").toString();
    const userId = (req.query.userId || "").toString();
    if (!code || !userId) return res.status(400).json({ error: "code & userId required" });
    const state = await DAL.getState({ code, userId });
    if (!state) return res.status(404).json({ error: "not found" });
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// gold/hp
app.post("/api/player/gold", async (req, res) => {
  try {
    const { code, userId, delta } = req.body || {};
    const r = await DAL.addGold({ code, userId, delta: Number(delta) || 0 });
    if (!r) return res.status(404).json({ error: "not found" });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});
app.post("/api/player/hp", async (req, res) => {
  try {
    const { code, userId, delta } = req.body || {};
    const r = await DAL.addHp({ code, userId, delta: Number(delta) || 0 });
    if (!r) return res.status(404).json({ error: "not found" });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// предметы
app.post("/api/item/give", async (req, res) => {
  try {
    const { code, userId, name } = req.body || {};
    const ok = await DAL.giveItemTo({ code, userId, itemName: name });
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

app.post("/api/item/drop", async (req, res) => {
  try {
    const { code, name } = req.body || {};
    const ok = await DAL.dropItem({ code, itemName: name });
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});
app.post("/api/gold/drop", async (req, res) => {
  try {
    const { code, amount } = req.body || {};
    const ok = await DAL.dropGold({ code, amount: Number(amount) || 1 });
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

app.post("/api/floor/pick", async (req, res) => {
  try {
    const { code, userId } = req.body || {};
    const r = await DAL.pickFromFloor({ code, userId });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// локации
app.post("/api/location/add", async (req, res) => {
  try {
    const { code, title, description, imageUrl } = req.body || {};
    const r = await DAL.addLocation({ code, title, description, imageUrl });
    if (!r) return res.status(404).json({ error: "not found" });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});
app.post("/api/location/set", async (req, res) => {
  try {
    const { code, locationId } = req.body || {};
    const r = await DAL.setCurrentLocation({ code, locationId });
    if (!r) return res.status(404).json({ error: "not found" });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// чат
app.post("/api/chat/send", async (req, res) => {
  try {
    const { code, userId, name, text } = req.body || {};
    const r = await DAL.sendChat({ code, userId, name, text });
    if (!r) return res.status(404).json({ error: "not found" });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});
app.get("/api/chat", async (req, res) => {
  try {
    const code = (req.query.code || "").toString();
    const afterTs = req.query.afterTs ? Number(req.query.afterTs) : undefined;
    const r = await DAL.listChat({ code, afterTs });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e?.message || "failed" });
  }
});

// ---------- TELEGRAM BOT (Telegraf, webhook) ----------
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    const kb = Markup.inlineKeyboard([
      [Markup.button.webApp("Открыть мини‑апп", `${APP_URL}`)],
    ]);
    await ctx.reply("Dnd Mini App. Выбери действие:", kb);
  });

  bot.command("new", async (ctx) => {
    const gmId = String(ctx.from.id);
    try {
      const g = await DAL.createGame(gmId);
      await ctx.reply(`Создан новый код комнаты: ${g.code}\nОткрой мини‑апп и поделись кодом.`);
    } catch (e) {
      await ctx.reply("Не удалось создать игру. Попробуй ещё раз.");
    }
  });

  bot.command("join", async (ctx) => {
    await ctx.reply("Введи код комнаты (6 символов):");
    bot.on("text", async (inner) => {
      const code = (inner.message.text || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return;
      await inner.reply(`Код принят: ${code}. Открой мини‑апп и войди в лобби.`);
    });
  });

  app.use(bot.webhookCallback(`/telegraf/${BOT_SECRET_PATH}`));
  const hookUrl = `${APP_URL}/telegraf/${BOT_SECRET_PATH}`;
  bot.telegram.setWebhook(hookUrl).then(() => {
    console.log("🔗 Webhook set:", hookUrl);
  }).catch(e => {
    console.log("Webhook error:", e?.message || e);
  });
} else {
  console.log("⚠️ BOT_TOKEN not set — бот отключён");
}

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`🌐 Web server on ${PORT}`);
});
