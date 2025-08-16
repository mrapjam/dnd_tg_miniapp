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
const BOT_SECRET_PATH = process.env.BOT_SECRET_PATH || "telegraf-" + Math.random().toString(32).slice(2);
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// статика мини-аппа
const WEB_DIR = path.join(__dirname, "webapp");
app.get("/", (_, res) => res.sendFile(path.join(WEB_DIR, "index.html")));
app.use("/webapp", express.static(WEB_DIR));

// ---------- PRISMA ----------
const prisma = new PrismaClient();
let prismaOk = false;
async function connectPrisma() {
  try {
    await prisma.$connect();
    prismaOk = true;
    console.log("✅ Prisma connected");
  } catch (e) {
    prismaOk = false;
    console.error("❌ Prisma connect error:", e.code || e.message);
  }
}
await connectPrisma();

// DB fallback (in-memory), если БД ляжет
const mem = {
  games: new Map(), // code -> { code, gmId, createdAt, expiresAt, players: Map(tgId -> player) }
};

// общий хелпер кодов
function genCode() {
  const s = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let r = "";
  for (let i = 0; i < 6; i++) r += s[Math.floor(Math.random() * s.length)];
  return r;
}

// ---------- API ----------
/**
 * Создать игру (через бота /new)
 * body: { gmId: string, title?: string }
 * resp: { code }
 */
app.post("/api/game/new", async (req, res) => {
  const { gmId, title } = req.body || {};
  if (!gmId) return res.status(400).json({ ok: false, error: "gmId required" });

  const code = genCode();
  const expiresAt = new Date(Date.now() + SIX_HOURS_MS);

  if (prismaOk) {
    try {
      await prisma.game.create({
        data: { code, gmId, title: title || null, expiresAt, started: false }
      });
      return res.json({ ok: true, code });
    } catch (e) {
      console.error("DB error on /new, fallback to memory:", e.code || e.message);
    }
  }

  // fallback memory
  mem.games.set(code, {
    code,
    gmId,
    title: title || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + SIX_HOURS_MS,
    started: false,
    players: new Map()
  });
  res.json({ ok: true, code, memory: true });
});

/**
 * Получить краткое состояние игры (для мини-аппа при загрузке)
 */
app.get("/api/game/:code", async (req, res) => {
  const { code } = req.params;
  if (prismaOk) {
    try {
      const game = await prisma.game.findUnique({
        where: { code },
        include: {
          players: true,
          locations: true,
          items: true
        }
      });
      if (!game) return res.status(404).json({ ok: false, error: "Not found" });
      return res.json({ ok: true, game });
    } catch (e) {
      console.error("DB /api/game/:code:", e.code || e.message);
    }
  }
  const g = mem.games.get(code);
  if (!g) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({
    ok: true,
    game: {
      code: g.code,
      gmId: g.gmId,
      started: g.started,
      expiresAt: new Date(g.expiresAt).toISOString(),
      players: Array.from(g.players.values())
    }
  });
});

/**
 * Вход в лобби
 * body: { tgId: string, name: string, avatar?: string }
 */
app.post("/api/game/:code/lobby/join", async (req, res) => {
  const { code } = req.params;
  const { tgId, name, avatar } = req.body || {};
  if (!tgId || !name) return res.status(400).json({ ok: false, error: "tgId & name required" });

  if (prismaOk) {
    try {
      const game = await prisma.game.findUnique({ where: { code } });
      if (!game) return res.status(404).json({ ok: false, error: "Game not found" });

      // если уже есть — окей
      const exists = await prisma.player.findFirst({ where: { gameId: game.id, tgId } });
      if (exists) return res.json({ ok: true, playerId: exists.id });

      const created = await prisma.player.create({
        data: {
          gameId: game.id,
          tgId,
          name,
          avatar: avatar || null,
          role: "PLAYER",
          hp: 10,
          gold: 0
        }
      });
      return res.json({ ok: true, playerId: created.id });
    } catch (e) {
      console.error("DB /lobby/join:", e.code || e.message);
    }
  }

  // fallback memory
  const g = mem.games.get(code);
  if (!g) return res.status(404).json({ ok: false, error: "Game not found" });
  if (!g.players.has(tgId)) {
    g.players.set(tgId, { tgId, name, avatar: avatar || null, role: "PLAYER", hp: 10, gold: 0 });
  }
  res.json({ ok: true, memory: true });
});

// периодическая чистилка просроченных игр в БД/памяти
async function cleanupExpired() {
  const now = new Date();
  if (prismaOk) {
    try {
      await prisma.game.deleteMany({
        where: { expiresAt: { lt: now } }
      });
    } catch (e) {
      console.error("cleanupExpired(DB):", e.code || e.message);
    }
  }
  // memory
  for (const [code, g] of mem.games) {
    if (Date.now() > g.expiresAt) mem.games.delete(code);
  }
}
setInterval(cleanupExpired, 60 * 1000);

// ---------- BOT (Telegraf) ----------
let bot;
if (process.env.BOT_TOKEN) {
  bot = new Telegraf(process.env.BOT_TOKEN);

  bot.start(async (ctx) => {
    return ctx.reply(
      "DnD Mini App. Выбери действие:",
      Markup.inlineKeyboard([
        [Markup.button.url("Открыть мини‑апп", `${APP_URL}/?code=`)],
      ])
    );
  });

  bot.command("new", async (ctx) => {
    const gmId = String(ctx.from.id);
    // создаём игру через API, чтобы логика была в одном месте
    try {
      const r = await fetch(`${APP_URL}/api/game/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gmId })
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "create failed");
      const openLink = `${APP_URL}/?code=${data.code}`;
      await ctx.reply(
        `Создана игра. Код: ${data.code}\nОткрой мини‑апп и продолжай.`,
        Markup.inlineKeyboard([[Markup.button.url("Открыть мини‑апп", openLink)]])
      );
    } catch (e) {
      console.error("BOT /new:", e.message);
      await ctx.reply("Не удалось создать игру. Попробуй ещё раз.");
    }
  });

  // простая команда /join — просим код и даём кнопку открыть мини‑апп
  bot.command("join", async (ctx) => {
    await ctx.reply("Введи код комнаты (6 символов):");
    bot.on("text", async (ctx2) => {
      const code = (ctx2.message.text || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return;
      const link = `${APP_URL}/?code=${code}`;
      await ctx2.reply(
        `Код принят: ${code}. Открой мини‑апп и введи имя в лобби.`,
        Markup.inlineKeyboard([[Markup.button.url("Открыть мини‑апп", link)]])
      );
    });
  });

  // webhook
  app.use(`/telegraf/${BOT_SECRET_PATH}`, bot.webhookCallback(`/telegraf/${BOT_SECRET_PATH}`));
  try {
    await bot.telegram.setWebhook(`${APP_URL}/telegraf/${BOT_SECRET_PATH}`);
    console.log("🔗 Webhook set:", `${APP_URL}/telegraf/${BOT_SECRET_PATH}`);
  } catch (e) {
    console.error("setWebhook failed:", e.message);
  }
} else {
  console.log("ℹ️ BOT_TOKEN не задан — бот не запущен.");
}

app.listen(PORT, () => {
  console.log(`🌐 Web server on ${PORT}`);
});
