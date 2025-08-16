// server.js
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { Telegraf, Markup } from "telegraf";

dotenv.config();

/* -------------------- PATHS / ENV -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 10000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_SECRET_PATH =
  process.env.BOT_SECRET_PATH || `telegraf-${Math.random().toString(36).slice(2)}`;

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/* -------------------- EXPRESS -------------------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Раздаём мини‑аппу из /webapp
const WEB_DIR = path.join(__dirname, "webapp");
app.use("/assets", express.static(path.join(WEB_DIR, "assets")));
app.get("/", (_req, res) => res.sendFile(path.join(WEB_DIR, "index.html")));

/* -------------------- PRISMA (ленивое подключение, безопасно) -------------------- */
let prisma = null;
async function tryConnectPrisma() {
  try {
    const p = new PrismaClient();
    await p.$connect();
    prisma = p;
    console.log("✅ Prisma connected");
  } catch (e) {
    prisma = null;
    console.warn("⚠️ Prisma unavailable, using in‑memory:", e?.code || e?.message);
  }
}
await tryConnectPrisma();

/* -------------------- IN-MEMORY FALLBACK -------------------- */
const mem = {
  games: new Map(),
};

const nowTs = () => Date.now();
const addMs = (d, ms) => new Date(d.getTime() + ms);
const genCode = () =>
  Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(2, 8).padEnd(6, "0");

/* -------------------- DAL -------------------- */
const DAL = {
  ensureMemGame(code, patch = {}) {
    if (!mem.games.has(code)) {
      mem.games.set(code, {
        code,
        gmId: patch.gmId || "0",
        started: patch.started ?? false,
        createdAt: patch.createdAt ? +patch.createdAt : nowTs(),
        expiresAt: patch.expiresAt ? +patch.expiresAt : nowTs() + SIX_HOURS_MS,
        players: new Map(),
        messages: [],
      });
    }
    return mem.games.get(code);
  },

  async createGame(gmId) {
    const now = new Date();

    if (!prisma) {
      let code = genCode();
      while (mem.games.has(code)) code = genCode();
      mem.games.set(code, {
        code,
        gmId,
        started: false,
        createdAt: nowTs(),
        expiresAt: nowTs() + SIX_HOURS_MS,
        players: new Map(),
        messages: [],
      });
      return { code, storage: "memory" };
    }

    for (let attempt = 0; attempt < 10; attempt++) {
      const code = genCode();
      try {
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
        return { code: game.code, storage: "db" };
      } catch (e) {
        if (e?.code === "P2002") continue; // коллизия кода — пробуем ещё
        console.warn("DB error on /new, fallback to memory:", e?.code || e?.message);
        mem.games.set(code, {
          code,
          gmId,
          started: false,
          createdAt: nowTs(),
          expiresAt: nowTs() + SIX_HOURS_MS,
          players: new Map(),
          messages: [],
        });
        return { code, storage: "memory-fallback" };
      }
    }
    throw new Error("FAILED_UNIQUE_CODE");
  },

  async getGame(code) {
    if (!code) return null;

    if (mem.games.has(code)) {
      const g = mem.games.get(code);
      return {
        code: g.code,
        gmId: g.gmId,
        started: g.started,
        createdAt: new Date(g.createdAt),
        expiresAt: new Date(g.expiresAt),
        players: Array.from(g.players.entries()).map(([id, p]) => ({
          id,
          name: p.name,
          avatar: p.avatar,
          joinedAt: new Date(p.joinedAt),
        })),
        messages: g.messages.map((m) => ({ text: m.text, createdAt: new Date(m.createdAt) })),
        storage: "memory",
      };
    }

    if (!prisma) return null;

    try {
      const g = await prisma.game.findUnique({
        where: { code },
        include: { players: true, messages: true },
      });
      if (!g) return null;
      return { ...g, storage: "db" };
    } catch (e) {
      console.warn("getGame DB error, try fallback to memory:", e?.code || e?.message);
      return mem.games.has(code) ? await this.getGame(code) : null;
    }
  },

  async joinLobby(code, { name, avatar }) {
    const codeU = String(code).toUpperCase();
    let game = await this.getGame(codeU);
    if (!game) throw new Error("GAME_NOT_FOUND");

    // Путь через память
    if (game.storage === "memory") {
      const pid = `p_${Math.random().toString(36).slice(2)}`;
      const g = mem.games.get(codeU);
      g.players.set(pid, { name, avatar, joinedAt: nowTs() });
      return { id: pid, name, avatar, storage: "memory" };
    }

    // Путь через БД (с защитой + fallback в память)
    try {
      const player = await prisma.player.create({
        data: { name, avatar, gameId: game.id },
        select: { id: true, name: true, avatar: true },
      });
      await prisma.game.update({
        where: { id: game.id },
        data: { lastActivity: new Date() },
      });
      return { ...player, storage: "db" };
    } catch (e) {
      console.warn("joinLobby DB error, fallback to memory:", e?.code || e?.message);
      // Конвертируем игру в памяти и пускаем игрока
      const gmem = this.ensureMemGame(codeU, {
        gmId: game.gmId || "0",
        started: game.started,
        createdAt: game.createdAt,
        expiresAt: game.expiresAt,
      });
      const pid = `p_${Math.random().toString(36).slice(2)}`;
      gmem.players.set(pid, { name, avatar, joinedAt: nowTs() });
      return { id: pid, name, avatar, storage: "memory-fallback" };
    }
  },

  async addMessage(code, text) {
    const game = await this.getGame(code);
    if (!game) throw new Error("GAME_NOT_FOUND");

    if (game.storage === "memory") {
      mem.games.get(code).messages.push({ text, createdAt: nowTs() });
      return;
    }

    try {
      await prisma.message.create({ data: { text, gameId: game.id } });
      await prisma.game.update({
        where: { id: game.id },
        data: { lastActivity: new Date() },
      });
    } catch (e) {
      console.warn("addMessage DB error, fallback to memory:", e?.code || e?.message);
      const gmem = this.ensureMemGame(game.code, {
        gmId: game.gmId || "0",
        started: game.started,
        createdAt: game.createdAt,
        expiresAt: game.expiresAt,
      });
      gmem.messages.push({ text, createdAt: nowTs() });
    }
  },

  async cleanupExpired() {
    const now = new Date();

    // память
    for (const [code, g] of mem.games.entries()) {
      if (g.expiresAt <= nowTs()) mem.games.delete(code);
    }

    // база
    if (prisma) {
      try {
        await prisma.message.deleteMany({ where: { game: { expiresAt: { lt: now } } } });
        await prisma.player.deleteMany({ where: { game: { expiresAt: { lt: now } } } });
        await prisma.game.deleteMany({ where: { expiresAt: { lt: now } } });
      } catch (e) {
        console.warn("cleanupExpired(DB):", e?.code || e?.message);
      }
    }
  },
};

/* -------------------- API -------------------- */

// Диагностика (поможет быстро понять, почему «не входит»)
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    prisma: !!prisma,
    memGames: mem.games.size,
    env: {
      PORT,
      APP_URL,
      hasBotToken: !!BOT_TOKEN,
    },
  });
});

// Получить состояние игры
app.get("/api/game", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim().toUpperCase();
    const game = await DAL.getGame(code);
    if (!game) return res.status(404).json({ ok: false, error: "GAME_NOT_FOUND" });
    res.json({ ok: true, game });
  } catch (e) {
    console.error("GET /api/game error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Войти в лобби
app.post("/api/lobby/join", async (req, res) => {
  try {
    const { code, name, avatar } = req.body || {};
    if (!code || !name) {
      return res.status(400).json({ ok: false, error: "BAD_INPUT" });
    }
    const sanitized = {
      code: String(code).toUpperCase(),
      name: String(name).trim().slice(0, 32) || "Hero",
      avatar: String(avatar || "🛡️").slice(0, 8),
    };

    const player = await DAL.joinLobby(sanitized.code, {
      name: sanitized.name,
      avatar: sanitized.avatar,
    });
    res.json({ ok: true, player });
  } catch (e) {
    console.error("POST /api/lobby/join error:", e);
    // Последний шанс — полностью в память
    try {
      const code = String((req.body?.code || "")).toUpperCase();
      if (!code) throw e;
      DAL.ensureMemGame(code);
      const pid = `p_${Math.random().toString(36).slice(2)}`;
      mem.games.get(code).players.set(pid, {
        name: (req.body?.name || "Hero").toString().slice(0, 32),
        avatar: (req.body?.avatar || "🛡️").toString().slice(0, 8),
        joinedAt: nowTs(),
      });
      return res.json({ ok: true, player: { id: pid, name: req.body?.name || "Hero" } });
    } catch {
      return res.status(500).json({ ok: false, error: "JOIN_FAILED" });
    }
  }
});

// Отправить сообщение в чат
app.post("/api/chat/send", async (req, res) => {
  try {
    const { code, text } = req.body || {};
    if (!code || !text) return res.status(400).json({ ok: false, error: "BAD_INPUT" });
    await DAL.addMessage(String(code).toUpperCase(), String(text).slice(0, 300));
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/chat/send error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* -------------------- TELEGRAM BOT -------------------- */
let bot = null;

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    await ctx.reply(
      "Dnd Mini App. Выбери действие:",
      Markup.inlineKeyboard([[Markup.button.webApp("Открыть мини‑апп", `${APP_URL}`)]])
    );
  });

  bot.command("new", async (ctx) => {
    const gmId = String(ctx.from.id);
    try {
      const g = await DAL.createGame(gmId);
      const note =
        g.storage && g.storage.startsWith("memory")
          ? "\n(временно без БД, игра сохранится на 6 часов)"
          : "";
      await ctx.reply(
        `Создана игра. Код: ${g.code}${note}\nОткрой мини‑апп и продолжай.`,
        Markup.inlineKeyboard([[Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${g.code}`)]])
      );
    } catch (e) {
      console.error("NEW failed:", e?.code || e?.message);
      await ctx.reply("Не удалось создать игру. Попробуй ещё раз.");
    }
  });

  bot.command("join", async (ctx) => {
    await ctx.reply("Введи код комнаты (6 символов):");
    bot.once("text", async (ctx2) => {
      const code = ctx2.message.text?.trim().toUpperCase();
      if (!code || code.length !== 6) return ctx2.reply("Код должен быть 6 символов.");
      const g = await DAL.getGame(code);
      if (!g) return ctx2.reply("Игра не найдена.");
      await ctx2.reply(
        `Код принят: ${code}. Открой мини‑апп и войди в лобби.`,
        Markup.inlineKeyboard([[Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${code}`)]])
      );
    });
  });

  // webhook
  app.use(bot.webhookCallback(`/telegraf/${BOT_SECRET_PATH}`, { timeout: 30000 }));
  bot.telegram
    .setWebhook(`${APP_URL}/telegraf/${BOT_SECRET_PATH}`)
    .then(() => console.log("🔗 Webhook set:", `${APP_URL}/telegraf/${BOT_SECRET_PATH}`))
    .catch((e) => console.warn("Webhook error:", e.message));
} else {
  console.warn("⚠️ BOT_TOKEN не задан — Telegram‑бот не активен");
}

/* -------------------- SERVER + CRON -------------------- */
app.listen(PORT, () => {
  console.log(`🌐 Web server on ${PORT}`);
});

setInterval(() => {
  DAL.cleanupExpired().catch((e) => console.warn("cleanup error:", e?.message));
}, 60 * 1000);
