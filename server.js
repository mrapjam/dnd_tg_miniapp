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

// ─────────────────────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_SECRET_PATH =
  process.env.BOT_SECRET_PATH || ("telegraf-" + Math.random().toString(36).slice(2));
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const prisma = new PrismaClient();

// статика мини-приложения
const WEB_DIR = path.join(__dirname, "webapp");
app.use(express.static(WEB_DIR));
app.get("/", (_, res) => res.sendFile(path.join(WEB_DIR, "index.html")));

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const nowTs = () => Date.now();
const genCode = () =>
  Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(2, 8);

function isGM(game, tgId) {
  return String(game.gmId) === String(tgId);
}

async function gameByCode(code) {
  return prisma.game.findUnique({
    where: { code },
  });
}

async function statePayload({ code, meTgId }) {
  const game = await prisma.game.findUnique({
    where: { code },
    include: {
      players: { include: { items: true }, orderBy: { createdAt: "asc" } },
      items: { where: { playerId: null }, orderBy: { createdAt: "asc" } }, // предметы "на полу"
      messages: { orderBy: { createdAt: "asc" }, take: 50, include: { author: true } },
      locations: true,
      currentLocation: true,
    },
  });

  if (!game) return null;

  // мой игрок (если есть)
  const me = game.players.find((p) => p.tgId === String(meTgId)) || null;
  const myItems = me ? me.items : [];

  // Схлопнем, чтобы не отдавать предметы всех игроков
  const playersSlim = game.players.map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    hp: p.hp,
    gold: p.gold,
    isGM: p.isGM,
  }));

  return {
    game: {
      code: game.code,
      started: game.started,
      gmId: game.gmId,
      location: game.currentLocation
        ? {
            id: game.currentLocation.id,
            name: game.currentLocation.name,
            description: game.currentLocation.description,
            imageUrl: game.currentLocation.imageUrl || null,
          }
        : null,
    },
    me: me
      ? { id: me.id, name: me.name, avatar: me.avatar, hp: me.hp, gold: me.gold, isGM: me.isGM }
      : null,
    players: playersSlim,
    floor: game.items.map((i) => ({ id: i.id, name: i.name })), // только на полу
    myItems: myItems.map((i) => ({ id: i.id, name: i.name })),
    messages: game.messages.map((m) => ({
      id: m.id,
      text: m.text,
      author: m.author ? { id: m.author.id, name: m.author.name, avatar: m.author.avatar } : null,
      ts: m.createdAt,
    })),
    locations: game.locations.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      imageUrl: l.imageUrl || null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// BOT (Telegraf)
// ─────────────────────────────────────────────────────────────
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is not set");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const kb = Markup.inlineKeyboard([
    Markup.button.webApp("Открыть мини‑апп", `${APP_URL}`),
  ]);
  await ctx.reply("Dnd Mini App. Выбери действие:", kb);
});

bot.command("new", async (ctx) => {
  try {
    // создаём игру
    const code = genCode();
    const game = await prisma.game.create({
      data: {
        code,
        gmId: String(ctx.from.id),
        started: false,
        expiresAt: new Date(nowTs() + SIX_HOURS_MS),
      },
    });

    // Добавим мастера в players, с флагом isGM
    await prisma.player.upsert({
      where: { id: `${game.id}_${ctx.from.id}` }, // не уникально по схеме, поэтому используем create
      update: {},
      create: {
        id: `${game.id}_${ctx.from.id}`,
        tgId: String(ctx.from.id),
        name: ctx.from.first_name || "GM",
        isGM: true,
        gameId: game.id,
      },
    });

    const kb = Markup.inlineKeyboard([
      Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${code}`),
    ]);
    await ctx.reply(`Создана игра. Код: ${code}\nОткрой мини‑апп и продолжай.`, kb);
  } catch (e) {
    console.error("NEW failed:", e?.code || e);
    await ctx.reply("Не удалось создать игру. Попробуй ещё раз.");
  }
});

// /join ожидает код и открывает мини‑апп
bot.command("join", async (ctx) => {
  await ctx.reply("Введи код комнаты (6 символов):");
  bot.on("text", async (ctx2) => {
    const code = (ctx2.message.text || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return;

    const g = await gameByCode(code);
    if (!g) return ctx2.reply("Код не найден. Проверь и попробуй ещё раз.");

    const kb = Markup.inlineKeyboard([
      Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${code}`),
    ]);
    await ctx2.reply(`Код принят: ${code}. Открой мини‑апп и введи имя в лобби.`, kb);
  });
});

// ─────────────────────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────────────────────
app.use(bot.webhookCallback(`/telegraf/${BOT_SECRET_PATH}`));
bot.telegram.setWebhook(`${APP_URL}/telegraf/${BOT_SECRET_PATH}`).catch(console.error);

// ─────────────────────────────────────────────────────────────
// API — общие
// ─────────────────────────────────────────────────────────────

// получить state
app.get("/api/state", async (req, res) => {
  try {
    const { code, tgId } = req.query;
    const st = await statePayload({ code, meTgId: tgId });
    if (!st) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, data: st });
  } catch (e) {
    console.error("state:", e);
    res.status(500).json({ ok: false });
  }
});

// вход в лобби (создаёт/обновляет игрока, если игра есть)
app.post("/api/joinLobby", async (req, res) => {
  try {
    const { code, name, avatar, tgId } = req.body;
    const game = await gameByCode(code);
    if (!game) return res.status(404).json({ ok: false, error: "game_not_found" });

    // существует ли уже игрок
    let player = await prisma.player.findFirst({
      where: { gameId: game.id, tgId: String(tgId) },
    });

    if (!player) {
      player = await prisma.player.create({
        data: {
          tgId: String(tgId),
          name: name?.toString().slice(0, 40) || "Hero",
          avatar: avatar || null,
          gameId: game.id,
        },
      });
      await prisma.message.create({
        data: { gameId: game.id, authorId: player.id, text: `${player.name} вошёл(ла) в лобби.` },
      });
    } else {
      // обновим имя/аватар
      await prisma.player.update({
        where: { id: player.id },
        data: { name: name?.toString().slice(0, 40) || player.name, avatar: avatar || player.avatar },
      });
    }

    const st = await statePayload({ code, meTgId: tgId });
    res.json({ ok: true, data: st });
  } catch (e) {
    console.error("joinLobby:", e);
    res.status(500).json({ ok: false });
  }
});

// чат
app.post("/api/chat", async (req, res) => {
  try {
    const { code, tgId, text } = req.body;
    const game = await gameByCode(code);
    if (!game) return res.status(404).json({ ok: false });

    const player = await prisma.player.findFirst({ where: { gameId: game.id, tgId: String(tgId) } });
    if (!player) return res.status(403).json({ ok: false });

    await prisma.message.create({
      data: {
        text: String(text || "").slice(0, 500),
        gameId: game.id,
        authorId: player.id,
      },
    });

    const st = await statePayload({ code, meTgId: tgId });
    res.json({ ok: true, data: st });
  } catch (e) {
    console.error("chat:", e);
    res.status(500).json({ ok: false });
  }
});

// бросок кубика
app.post("/api/roll", async (req, res) => {
  try {
    const { code, tgId, sides } = req.body;
    const n = Number(sides) || 20;
    const roll = Math.max(1, Math.floor(Math.random() * n) + 1);
    const game = await gameByCode(code);
    if (!game) return res.status(404).json({ ok: false });

    const player = await prisma.player.findFirst({ where: { gameId: game.id, tgId: String(tgId) } });
    if (!player) return res.status(403).json({ ok: false });

    await prisma.message.create({
      data: { gameId: game.id, authorId: player.id, text: `${player.name} кинул d${n}: ${roll}` },
    });

    const st = await statePayload({ code, meTgId: tgId });
    res.json({ ok: true, data: st, roll });
  } catch (e) {
    console.error("roll:", e);
    res.status(500).json({ ok: false });
  }
});

// подобрать предмет с пола (берём самый старый)
app.post("/api/pickupOne", async (req, res) => {
  try {
    const { code, tgId } = req.body;
    const game = await gameByCode(code);
    if (!game) return res.status(404).json({ ok: false });

    const player = await prisma.player.findFirst({ where: { gameId: game.id, tgId: String(tgId) } });
    if (!player) return res.status(403).json({ ok: false });

    const item = await prisma.item.findFirst({
      where: { gameId: game.id, playerId: null },
      orderBy: { createdAt: "asc" },
    });
    if (!item) return res.json({ ok: true, data: await statePayload({ code, meTgId: tgId }) });

    await prisma.item.update({ where: { id: item.id }, data: { playerId: player.id } });
    await prisma.message.create({
      data: { gameId: game.id, authorId: player.id, text: `${player.name} подобрал: ${item.name}` },
    });

    res.json({ ok: true, data: await statePayload({ code, meTgId: tgId }) });
  } catch (e) {
    console.error("pickupOne:", e);
    res.status(500).json({ ok: false });
  }
});

// ─────────────────────────────────────────────────────────────
// API — действия ГМа
// ─────────────────────────────────────────────────────────────
app.post("/api/gm/giveItem", async (req, res) => {
  try {
    const { code, gmTgId, playerId, name } = req.body;
    const game = await gameByCode(code);
    if (!game || !isGM(game, gmTgId)) return res.status(403).json({ ok: false });

    await prisma.item.create({
      data: {
        name: String(name || "предмет"),
        gameId: game.id,
        playerId,
      },
    });
    res.json({ ok: true, data: await statePayload({ code, meTgId: gmTgId }) });
  } catch (e) {
    console.error("gm/giveItem:", e);
    res.status(500).json({ ok: false });
  }
});

app.post("/api/gm/dropItem", async (req, res) => {
  try {
    const { code, gmTgId, name } = req.body;
    const game = await gameByCode(code);
    if (!game || !isGM(game, gmTgId)) return res.status(403).json({ ok: false });

    await prisma.item.create({ data: { name: String(name || "предмет"), gameId: game.id } });
    res.json({ ok: true, data: await statePayload({ code, meTgId: gmTgId }) });
  } catch (e) {
    console.error("gm/dropItem:", e);
    res.status(500).json({ ok: false });
  }
});

app.post("/api/gm/addGold", async (req, res) => {
  try {
    const { code, gmTgId, playerId, delta } = req.body;
    const game = await gameByCode(code);
    if (!game || !isGM(game, gmTgId)) return res.status(403).json({ ok: false });

    const p = await prisma.player.update({
      where: { id: playerId },
      data: { gold: { increment: Number(delta) || 0 } },
    });
    await prisma.message.create({
      data: { gameId: game.id, text: `ГМ изменил золото у ${p.name}: ${p.gold}`, authorId: null },
    });
    res.json({ ok: true, data: await statePayload({ code, meTgId: gmTgId }) });
  } catch (e) {
    console.error("gm/addGold:", e);
    res.status(500).json({ ok: false });
  }
});

app.post("/api/gm/addHP", async (req, res) => {
  try {
    const { code, gmTgId, playerId, delta } = req.body;
    const game = await gameByCode(code);
    if (!game || !isGM(game, gmTgId)) return res.status(403).json({ ok: false });

    const p = await prisma.player.update({
      where: { id: playerId },
      data: { hp: { increment: Number(delta) || 0 } },
    });
    await prisma.message.create({
      data: { gameId: game.id, text: `ГМ изменил HP у ${p.name}: ${p.hp}`, authorId: null },
    });
    res.json({ ok: true, data: await statePayload({ code, meTgId: gmTgId }) });
  } catch (e) {
    console.error("gm/addHP:", e);
    res.status(500).json({ ok: false });
  }
});

app.post("/api/gm/addLocation", async (req, res) => {
  try {
    const { code, gmTgId, name, description, imageUrl } = req.body;
    const game = await gameByCode(code);
    if (!game || !isGM(game, gmTgId)) return res.status(403).json({ ok: false });

    await prisma.location.create({
      data: {
        name: String(name || "Локация"),
        description: String(description || ""),
        imageUrl: imageUrl || null,
        gameId: game.id,
      },
    });
    res.json({ ok: true, data: await statePayload({ code, meTgId: gmTgId }) });
  } catch (e) {
    console.error("gm/addLocation:", e);
    res.status(500).json({ ok: false });
  }
});

app.post("/api/gm/setCurrentLocation", async (req, res) => {
  try {
    const { code, gmTgId, locationId } = req.body;
    const game = await gameByCode(code);
    if (!game || !isGM(game, gmTgId)) return res.status(403).json({ ok: false });

    await prisma.game.update({
      where: { id: game.id },
      data: { currentLocationId: locationId || null },
    });
    res.json({ ok: true, data: await statePayload({ code, meTgId: gmTgId }) });
  } catch (e) {
    console.error("gm/setCurrentLocation:", e);
    res.status(500).json({ ok: false });
  }
});

app.post("/api/gm/startGame", async (req, res) => {
  try {
    const { code, gmTgId } = req.body;
    const game = await gameByCode(code);
    if (!game || !isGM(game, gmTgId)) return res.status(403).json({ ok: false });

    await prisma.game.update({
      where: { id: game.id },
      data: { started: true },
    });
    await prisma.message.create({
      data: { gameId: game.id, text: "Игра началась!", authorId: null },
    });
    res.json({ ok: true, data: await statePayload({ code, meTgId: gmTgId }) });
  } catch (e) {
    console.error("gm/startGame:", e);
    res.status(500).json({ ok: false });
  }
});

// ─────────────────────────────────────────────────────────────
// HOUSEKEEPING: удаляем старые игры (TTL 6 часов)
// ─────────────────────────────────────────────────────────────
async function cleanupExpired() {
  try {
    await prisma.game.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch (e) {
    console.error("cleanupExpired:", e?.code || e);
  }
}
setInterval(cleanupExpired, 60_000);

// Обновляем TTL при любом вызове state или действии
app.post("/api/ping", async (req, res) => {
  try {
    const { code } = req.body;
    const g = await gameByCode(code);
    if (g) {
      await prisma.game.update({
        where: { id: g.id },
        data: { expiresAt: new Date(nowTs() + SIX_HOURS_MS) },
      });
    }
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("Web server on", PORT);
  console.log("Webhook set:", `${APP_URL}/telegraf/${BOT_SECRET_PATH}`);
});
