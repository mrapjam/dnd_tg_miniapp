// server.js
// DnD Mini App — Express + Telegraf + (Prisma|InMemory)
// Работает даже без базы (фолбэк на память), чтобы не падало на деплое.

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN || ""; // если нет — бот просто не включится
const BOT_SECRET_PATH = process.env.BOT_SECRET_PATH || `telegraf-${Math.random().toString(36).slice(2, 8)}`;

// -----------------------------
// Prisma (optional)
// -----------------------------
let prisma = null;
try {
  // Ленивая загрузка, чтобы не падать, если prisma client не сгенерен
  const { PrismaClient } = await import("@prisma/client");
  prisma = new PrismaClient();
  // маленькая проверка подключения
  if (process.env.DATABASE_URL) {
    await prisma.$queryRawUnsafe("SELECT 1;");
    console.log("✅ Prisma connected");
  }
} catch (e) {
  console.log("⚠️ Prisma is not available, will use in-memory store. Reason:", e?.message || e);
  prisma = null;
}

// -----------------------------
// In-memory store (fallback)
// -----------------------------
const mem = {
  games: new Map(), // code -> { code, gmId, started, locationId, players: Map(userId->player), floor: [items], chat: [msg], locations: Map(id->loc) }
};
const genCode = () => Math.random().toString(36).replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 6);
const nowTs = () => Date.now();

// Модель аватаров по умолчанию (можно расширить в интерфейсе)
const AVATARS = [
  `${APP_URL}/uploads/av1.png`,
  `${APP_URL}/uploads/av2.png`,
  `${APP_URL}/uploads/av3.png`,
  `${APP_URL}/uploads/av4.png`,
  `${APP_URL}/uploads/av5.png`,
  `${APP_URL}/uploads/av6.png`,
];

// -----------------------------
// Data access layer: DB or Memory
// -----------------------------
const DAL = {
  async createGame(gmId) {
    const code = genCode();
    if (!prisma) {
      mem.games.set(code, {
        code,
        gmId,
        started: false,
        createdAt: nowTs(),
        locationId: null,
        players: new Map(), // userId -> {userId, name, avatar, hp, gold, inventory:[]}
        floor: [], // [{id, name, type: 'item'|'gold', amount?}]
        chat: [], // [{id, userId, name, text, ts}]
        locations: new Map(), // id -> {id, title, description, imageUrl}
      });
      return { code };
    }
    // Prisma вариант — под свой schema.prisma (пример):
    const game = await prisma.game.create({
      data: { code, gmId, started: false },
      select: { code: true },
    });
    return game;
  },

  async getGame(code) {
    if (!prisma) {
      return mem.games.get(code) || null;
    }
    const game = await prisma.game.findUnique({
      where: { code },
      include: {
        players: true,
        locations: true,
        floorItems: true,
        chat: true,
      },
    });
    return game;
  },

  async joinGame({ code, userId, name, avatar }) {
    if (!prisma) {
      const game = mem.games.get(code);
      if (!game) return null;
      if (!game.players.has(userId)) {
        game.players.set(userId, {
          userId,
          name: name || "Hero",
          avatar: avatar || AVATARS[0],
          hp: 10,
          gold: 0,
          inventory: [],
          joinedAt: nowTs(),
        });
      } else {
        // обновим имя/аватар, если прислали
        const p = game.players.get(userId);
        if (name) p.name = name;
        if (avatar) p.avatar = avatar;
      }
      return { ok: true };
    }
    // Prisma: создаём или апдейтим игрока
    await prisma.player.upsert({
      where: { gameCode_userId: { gameCode: code, userId } },
      update: { name, avatar },
      create: { gameCode: code, userId, name, avatar, hp: 10, gold: 0 },
    });
    return { ok: true };
  },

  async listPlayers(code) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return [];
      return Array.from(g.players.values());
    }
    const players = await prisma.player.findMany({
      where: { gameCode: code },
      orderBy: { createdAt: "asc" },
    });
    return players;
  },

  async addGold({ code, userId, delta }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g || !g.players.has(userId)) return null;
      const p = g.players.get(userId);
      p.gold = Math.max(0, (p.gold || 0) + delta);
      return { gold: p.gold };
    }
    const updated = await prisma.player.update({
      where: { gameCode_userId: { gameCode: code, userId } },
      data: { gold: { increment: delta } },
      select: { gold: true },
    });
    return updated;
  },

  async addHp({ code, userId, delta }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g || !g.players.has(userId)) return null;
      const p = g.players.get(userId);
      p.hp = Math.max(0, (p.hp || 0) + delta);
      return { hp: p.hp };
    }
    const updated = await prisma.player.update({
      where: { gameCode_userId: { gameCode: code, userId } },
      data: { hp: { increment: delta } },
      select: { hp: true },
    });
    return updated;
  },

  async giveItemTo({ code, userId, itemName }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g || !g.players.has(userId)) return null;
      const p = g.players.get(userId);
      p.inventory.push({ id: "itm_" + nowTs(), name: itemName });
      return p.inventory;
    }
    // Prisma: создаём запись Item c owner = player
    const item = await prisma.item.create({
      data: { name: itemName, gameCode: code, ownerId: userId, onFloor: false },
    });
    return item;
  },

  async dropItem({ code, itemName }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      g.floor.push({ id: "floor_" + nowTs(), name: itemName, type: "item" });
      return true;
    }
    await prisma.item.create({
      data: { name: itemName, gameCode: code, onFloor: true },
    });
    return true;
  },

  async dropGold({ code, amount }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      g.floor.push({ id: "gold_" + nowTs(), type: "gold", amount: Number(amount) || 1, name: "Gold" });
      return true;
    }
    await prisma.item.create({
      data: { name: "Gold", amount: Number(amount) || 1, gameCode: code, onFloor: true, type: "gold" },
    });
    return true;
  },

  // Игрок "осмотреться": подбираем 1 предмет с пола (первый в очереди)
  async pickFromFloor({ code, userId }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return { picked: null, inventory: [] };
      const item = g.floor.shift() || null;
      if (!item) return { picked: null, inventory: Array.from(g.players.get(userId)?.inventory || []) };

      if (item.type === "gold") {
        const p = g.players.get(userId);
        p.gold = (p.gold || 0) + (item.amount || 1);
        return { picked: { type: "gold", amount: item.amount }, inventory: p.inventory, gold: p.gold };
      } else {
        const p = g.players.get(userId);
        p.inventory.push({ id: "itm_" + nowTs(), name: item.name });
        return { picked: { type: "item", name: item.name }, inventory: p.inventory, gold: p.gold || 0 };
      }
    }
    // Prisma-вариант: найти первый onFloor=true, перекинуть игроку
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
      const p = await prisma.player.findUnique({ where: { gameCode_userId: { gameCode: code, userId } } });
      return { picked: { type: "gold", amount: first.amount || 1 }, gold: p.gold };
    } else {
      await prisma.item.update({
        where: { id: first.id },
        data: { onFloor: false, ownerId: userId },
      });
      return { picked: { type: "item", name: first.name } };
    }
  },

  async setStarted({ code, started }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      g.started = !!started;
      return { started: g.started };
    }
    const game = await prisma.game.update({
      where: { code },
      data: { started: !!started },
      select: { started: true },
    });
    return game;
  },

  async addLocation({ code, title, description, imageUrl }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      const id = "loc_" + nowTs();
      g.locations.set(id, { id, title, description, imageUrl: imageUrl || null });
      return { id, title, description, imageUrl };
    }
    const loc = await prisma.location.create({
      data: { gameCode: code, title, description, imageUrl: imageUrl || null },
    });
    return loc;
  },

  async setCurrentLocation({ code, locationId }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      g.locationId = locationId;
      return { locationId };
    }
    await prisma.game.update({
      where: { code },
      data: { locationId },
    });
    return { locationId };
  },

  async getState({ code, userId }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      const me = g.players.get(userId);
      const isGM = userId === g.gmId;
      const players = Array.from(g.players.values()).map(p => ({
        userId: p.userId, name: p.name, avatar: p.avatar, hp: p.hp, gold: p.gold, invCount: p.inventory.length
      }));
      const location = g.locationId ? g.locations.get(g.locationId) : null;
      const myInv = me ? me.inventory : [];
      return {
        code: g.code,
        started: g.started,
        isGM,
        me: me ? { userId: me.userId, name: me.name, avatar: me.avatar, hp: me.hp, gold: me.gold } : null,
        players,
        floorCount: g.floor.length,
        myInventory: myInv,
        location,
        avatars: AVATARS,
      };
    }
    // Prisma-вариант — собрать состояние из таблиц (пример)
    const game = await prisma.game.findUnique({
      where: { code },
      include: {
        players: true,
        locations: true,
        floorItems: true,
        location: true,
      }
    });
    if (!game) return null;
    const me = await prisma.player.findUnique({ where: { gameCode_userId: { gameCode: code, userId } } });
    const myItems = await prisma.item.findMany({ where: { gameCode: code, ownerId: userId } });
    return {
      code: game.code,
      started: game.started,
      isGM: userId === game.gmId,
      me: me ? { userId: me.userId, name: me.name, avatar: me.avatar, hp: me.hp, gold: me.gold } : null,
      players: game.players.map(p => ({ userId: p.userId, name: p.name, avatar: p.avatar, hp: p.hp, gold: p.gold, invCount: 0 })),
      floorCount: game.floorItems.length,
      myInventory: myItems.map(i => ({ id: i.id, name: i.name })),
      location: game.location || null,
      avatars: AVATARS,
    };
  },

  async sendChat({ code, userId, name, text }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return null;
      const msg = { id: "m_" + nowTs(), userId, name, text: (text || "").toString().slice(0, 500), ts: nowTs() };
      g.chat.push(msg);
      return msg;
    }
    const msg = await prisma.message.create({
      data: { gameCode: code, userId, name, text },
    });
    return msg;
  },

  async listChat({ code, afterTs }) {
    if (!prisma) {
      const g = mem.games.get(code);
      if (!g) return [];
      return (g.chat || []).filter(m => !afterTs || m.ts > Number(afterTs));
    }
    const msgs = await prisma.message.findMany({
      where: { gameCode: code, ...(afterTs ? { createdAt: { gt: new Date(Number(afterTs)) } } : {}) },
      orderBy: { createdAt: "asc" },
    });
    // нормализуем под единый ответ
    return msgs.map(m => ({ id: m.id, userId: m.userId, name: m.name, text: m.text, ts: new Date(m.createdAt).getTime() }));
  },
};

// -----------------------------
// Express app
// -----------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Статика: webapp и загрузки
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static(path.join(__dirname, "webapp")));

// Файлы (фото локации, временно диском)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "uploads")),
  filename: (req, file, cb) => {
    const ext = (file.originalname || "").split(".").pop();
    cb(null, `loc_${Date.now()}.${ext || "jpg"}`);
  },
});
const upload = multer({ storage });

// --------- API: game / lobby / state ----------
app.post("/api/game/new", async (req, res) => {
  try {
    const { gmId } = req.body;
    if (!gmId) return res.status(400).json({ error: "gmId required" });
    const g = await DAL.createGame(gmId);
    res.json(g);
  } catch (e) {
    console.error("new game error:", e);
    res.status(500).json({ error: "failed" });
  }
});

app.post("/api/game/join", async (req, res) => {
  try {
    const { code, userId, name, avatar } = req.body;
    if (!code || !userId) return res.status(400).json({ error: "code & userId required" });
    const ok = await DAL.joinGame({ code: code.toUpperCase(), userId, name, avatar });
    if (!ok) return res.status(404).json({ error: "game not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error("join error:", e);
    res.status(500).json({ error: "failed" });
  }
});

app.get("/api/game/state", async (req, res) => {
  try {
    const { code, userId } = req.query;
    if (!code || !userId) return res.status(400).json({ error: "code & userId required" });
    const state = await DAL.getState({ code: String(code).toUpperCase(), userId: String(userId) });
    if (!state) return res.status(404).json({ error: "not found" });
    res.json(state);
  } catch (e) {
    console.error("state error:", e);
    res.status(500).json({ error: "failed" });
  }
});

app.post("/api/game/start", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "code required" });
    const r = await DAL.setStarted({ code: code.toUpperCase(), started: true });
    res.json(r || { started: true });
  } catch (e) {
    console.error("start error:", e);
    res.status(500).json({ error: "failed" });
  }
});

// --------- API: GM controls ----------
app.post("/api/gm/gold", async (req, res) => {
  try {
    const { code, userId, delta } = req.body;
    const r = await DAL.addGold({ code: code.toUpperCase(), userId, delta: Number(delta) || 0 });
    res.json(r || { error: "fail" });
  } catch (e) {
    console.error("gm gold error:", e);
    res.status(500).json({ error: "failed" });
  }
});

app.post("/api/gm/hp", async (req, res) => {
  try {
    const { code, userId, delta } = req.body;
    const r = await DAL.addHp({ code: code.toUpperCase(), userId, delta: Number(delta) || 0 });
    res.json(r || { error: "fail" });
  } catch (e) {
    console.error("gm hp error:", e);
    res.status(500).json({ error: "failed" });
  }
});

app.post("/api/gm/item-give", async (req, res) => {
  try {
    const { code, userId, name } = req.body;
    const r = await DAL.giveItemTo({ code: code.toUpperCase(), userId, itemName: name });
    res.json({ ok: true, data: r });
  } catch (e) {
    console.error("gm give item error:", e);
    res.status(500).json({ error: "failed" });
  }
});

app.post("/api/gm/item-drop", async (req, res) => {
  try {
    const { code, name } = req.body;
    const r = await DAL.dropItem({ code: code.toUpperCase(), itemName: name });
    res.json({ ok: !!r });
  } catch (e) {
    console.error("gm drop item error:", e);
    res.status(500).json({ error: "failed" });
  }
});

app.post("/api/gm/gold-drop", async (req, res) => {
  try {
    const { code, amount } = req.body;
    const r = await DAL.dropGold({ code: code.toUpperCase(), amount: Number(amount) || 1 });
    res.json({ ok: !!r });
  } catch (e) {
    console.error("gm drop gold error:", e);
    res.status(500).json({ error: "failed" });
  }
});

// --------- API: player look (pickup) ----------
app.post("/api/player/look", async (req, res) => {
  try {
    const { code, userId } = req.body;
    const r = await DAL.pickFromFloor({ code: code.toUpperCase(), userId });
    res.json(r || { picked: null });
  } catch (e) {
    console.error("player look error:", e);
    res.status(500).json({ error: "failed" });
  }
});

// --------- API: locations ----------
app.post("/api/location/add", upload.single("image"), async (req, res) => {
  try {
    const { code, title, description } = req.body;
    const imageUrl = req.file ? `${APP_URL}/uploads/${req.file.filename}` : null;
    const loc = await DAL.addLocation({ code: code.toUpperCase(), title, description, imageUrl });
    res.json(loc || { error: "fail" });
  } catch (e) {
    console.error("add location error:", e);
    res.status(500).json({ error: "failed" });
  }
});

app.post("/api/location/set", async (req, res) => {
  try {
    const { code, locationId } = req.body;
    const r = await DAL.setCurrentLocation({ code: code.toUpperCase(), locationId });
    res.json(r || { error: "fail" });
  } catch (e) {
    console.error("set location error:", e);
    res.status(500).json({ error: "failed" });
  }
});

// --------- API: chat ----------
app.post("/api/chat/send", async (req, res) => {
  try {
    const { code, userId, name, text } = req.body;
    const msg = await DAL.sendChat({ code: code.toUpperCase(), userId, name, text });
    res.json(msg || { error: "fail" });
  } catch (e) {
    console.error("chat send error:", e);
    res.status(500).json({ error: "failed" });
  }
});

app.get("/api/chat/list", async (req, res) => {
  try {
    const { code, after } = req.query;
    const list = await DAL.listChat({ code: String(code).toUpperCase(), afterTs: after ? Number(after) : undefined });
    res.json(list);
  } catch (e) {
    console.error("chat list error:", e);
    res.status(500).json({ error: "failed" });
  }
});

// --------- Telegram bot (Telegraf) ----------
let bot = null;
if (BOT_TOKEN) {
  try {
    const { Telegraf, Markup } = await import("telegraf");

    bot = new Telegraf(BOT_TOKEN, {
      telegram: { webhookReply: true },
    });

    bot.start(async (ctx) => {
      await ctx.reply(
        "Dnd Mini App. Выбери действие:",
        Markup.inlineKeyboard([Markup.button.webApp("Открыть мини‑апп", `${APP_URL}`)])
      );
    });

    bot.command("new", async (ctx) => {
      const code = (await DAL.createGame(String(ctx.from.id))).code;
      await ctx.reply(`Создана игра. Код: ${code}\nОткрой мини‑апп и продолжай.`, Markup.inlineKeyboard([
        Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${code}`)
      ]));
    });

    bot.command("join", async (ctx) => {
      await ctx.reply("Введи код комнаты (6 символов):");
      bot.on("text", async (c2) => {
        const code = (c2.message.text || "").trim().toUpperCase();
        if (code.length === 6) {
          await c2.reply(`Код принят: ${code}. Открой мини‑апп и войди в лобби.`, Markup.inlineKeyboard([
            Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${code}`)
          ]));
        }
      });
    });

    // webhook
    const hookPath = `/telegraf/${BOT_SECRET_PATH}`;
    await bot.telegram.setWebhook(`${APP_URL}${hookPath}`);
    app.use(bot.webhookCallback(hookPath));
    console.log("🤖 Bot webhook set:", `${APP_URL}${hookPath}`);
  } catch (e) {
    console.log("⚠️ Telegraf not started:", e?.message || e);
  }
} else {
  console.log("ℹ️ BOT_TOKEN is empty — бот не запущен (веб‑часть работает).");
}

// --------- Fallback для SPA ----------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "webapp", "index.html"));
});

// --------- Start ----------
app.listen(PORT, () => {
  console.log(`🌐 Web server on ${PORT}`);
});
