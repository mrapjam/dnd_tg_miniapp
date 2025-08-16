// server.js — in-memory версия с Telegram вебхуком и мини‑аппой
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ============================ ENV ============================ */
const PORT = process.env.PORT || 10000;
const RAW_APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const APP_URL = RAW_APP_URL.replace(/\/+$/, ""); // без завершающего /
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBHOOK_PATH = "/telegraf/telegraf-9f2c1a";
const WEBHOOK_URL = `${APP_URL}${WEBHOOK_PATH}`;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN не задан. Укажи в переменных окружения.");
  process.exit(1);
}

/* ============================ APP ============================ */
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// отдать мини‑аппу
const WEB_DIR = path.join(__dirname, "webapp");
app.use("/assets", express.static(path.join(WEB_DIR, "assets")));
app.get("/", (_req, res) => res.sendFile(path.join(WEB_DIR, "index.html")));

// health (для пинга и «пробуждения» Render)
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ============================ IN-MEMORY STATE ============================ */
// Game state в памяти с TTL 6 часов
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const games = new Map();
/*
 game: {
   code, gmId, createdAt, expiresAt, started: false,
   players: Map<tgId, {tgId, name, avatar, hp, gold, isGM, description, inventory: Array<{id,name}>}>,
   floor: Array<{id,name,goldAmount?}>,
   messages: Array<{authorTgId|null, text, ts}>,
   locations: Array<{id,name,description,imageUrl?}>,
   currentLocationId: string|null
 }
*/

const genCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let r = "";
  for (let i = 0; i < 6; i++) r += alphabet[Math.floor(Math.random() * alphabet.length)];
  return r;
};
const genId = () => Math.random().toString(36).slice(2, 10);

function createGame(gmId) {
  let code = genCode();
  while (games.has(code)) code = genCode();
  games.set(code, {
    code,
    gmId: String(gmId),
    createdAt: Date.now(),
    expiresAt: Date.now() + SIX_HOURS_MS,
    started: false,
    players: new Map(),
    floor: [],
    messages: [],
    locations: [],
    currentLocationId: null
  });
  return code;
}

function getGame(code) {
  const g = games.get(code);
  if (!g) return null;
  // продлеваем TTL при обращении
  g.expiresAt = Date.now() + SIX_HOURS_MS;
  return g;
}

function getPlayer(g, tgId) {
  return g.players.get(String(tgId)) || null;
}

function isGM(g, tgId) {
  return String(g.gmId) === String(tgId);
}

// очистка просроченных игр
setInterval(() => {
  const now = Date.now();
  for (const [code, g] of games.entries()) {
    if (g.expiresAt <= now) games.delete(code);
  }
}, 60_000);

/* ============================ API (микро-REST) ============================ */

// удобный state для фронта
function packState(g, meTgId) {
  const me = meTgId ? getPlayer(g, meTgId) : null;
  // игроки (для списка)
  const players = Array.from(g.players.values()).map((p) => ({
    tgId: p.tgId,
    name: p.name,
    avatar: p.avatar,
    hp: p.hp,
    gold: p.gold,
    isGM: p.isGM,
    description: p.description || ""
  }));

  // Текущая локация
  const currentLoc = g.currentLocationId
    ? g.locations.find((l) => l.id === g.currentLocationId) || null
    : null;

  // Пол (для игроков не раскрываем состав, только количество)
  const floorForMe = isGM(g, meTgId) ? g.floor.slice(0, 20) : []; // ГМ видит, игрок — через «осмотреться»
  const floorCount = g.floor.length;

  return {
    game: {
      code: g.code,
      gmId: g.gmId,
      started: g.started,
      floorCount,
      currentLocation: currentLoc
        ? {
            id: currentLoc.id,
            name: currentLoc.name,
            description: currentLoc.description,
            imageUrl: currentLoc.imageUrl || null
          }
        : null
    },
    me: me
      ? {
          tgId: me.tgId,
          name: me.name,
          avatar: me.avatar,
          hp: me.hp,
          gold: me.gold,
          isGM: me.isGM,
          description: me.description || "",
          inventory: me.inventory.slice(0, 50)
        }
      : null,
    players,
    locations: g.locations.slice(0, 50),
    messages: g.messages.slice(-50) // последние 50
  };
}

// состояние для мини‑аппы
app.get("/api/state", (req, res) => {
  try {
    const code = String(req.query.code || "").toUpperCase();
    const tgId = String(req.query.tgId || "");
    const g = getGame(code);
    if (!g) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, data: packState(g, tgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// вход в лобби
app.post("/api/lobby/join", (req, res) => {
  try {
    const { code, tgId, name, avatar } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    if (!tgId || !name) return res.status(400).json({ ok: false, error: "BAD_INPUT" });

    if (!g.players.has(String(tgId))) {
      g.players.set(String(tgId), {
        tgId: String(tgId),
        name: String(name).slice(0, 32),
        avatar: avatar || "🛡️",
        hp: 10,
        gold: 0,
        isGM: isGM(g, tgId),
        description: "",
        inventory: []
      });
      g.messages.push({ authorTgId: null, text: `${name} вошёл(ла) в лобби.`, ts: Date.now() });
    } else {
      const p = g.players.get(String(tgId));
      p.name = String(name).slice(0, 32);
      p.avatar = avatar || p.avatar;
    }
    return res.json({ ok: true, data: packState(g, tgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// чат
app.post("/api/chat/send", (req, res) => {
  try {
    const { code, tgId, text } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g) return res.status(404).json({ ok: false });
    const p = getPlayer(g, tgId);
    if (!p) return res.status(403).json({ ok: false });
    const t = String(text || "").trim().slice(0, 500);
    if (!t) return res.json({ ok: true, data: packState(g, tgId) });
    g.messages.push({ authorTgId: p.tgId, text: t, ts: Date.now() });
    return res.json({ ok: true, data: packState(g, tgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// бросок кубика
app.post("/api/roll", (req, res) => {
  try {
    const { code, tgId, sides } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g) return res.status(404).json({ ok: false });
    const p = getPlayer(g, tgId);
    if (!p) return res.status(403).json({ ok: false });

    const n = Math.max(2, Math.min(100, Number(sides) || 20));
    const roll = Math.floor(Math.random() * n) + 1;
    g.messages.push({ authorTgId: null, text: `${p.name} кинул d${n}: ${roll}`, ts: Date.now() });
    return res.json({ ok: true, data: packState(g, tgId), roll });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// «осмотреться» — забрать один предмет с пола
app.post("/api/look", (req, res) => {
  try {
    const { code, tgId } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g) return res.status(404).json({ ok: false });
    const p = getPlayer(g, tgId);
    if (!p) return res.status(403).json({ ok: false });
    if (!g.started) return res.status(400).json({ ok: false, error: "NOT_STARTED" });

    const item = g.floor.shift();
    if (!item) return res.json({ ok: true, data: packState(g, tgId) });

    if (item.goldAmount) {
      p.gold += item.goldAmount;
      g.messages.push({
        authorTgId: null,
        text: `${p.name} нашёл ${item.goldAmount} золота.`,
        ts: Date.now()
      });
    } else {
      p.inventory.push({ id: item.id, name: item.name });
      g.messages.push({
        authorTgId: null,
        text: `${p.name} подобрал предмет: ${item.name}.`,
        ts: Date.now()
      });
    }
    return res.json({ ok: true, data: packState(g, tgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

/* -------- GM endpoints -------- */
// старт игры
app.post("/api/gm/start", (req, res) => {
  try {
    const { code, gmTgId } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g || !isGM(g, gmTgId)) return res.status(403).json({ ok: false });
    g.started = true;
    g.messages.push({ authorTgId: null, text: "Игра началась!", ts: Date.now() });
    return res.json({ ok: true, data: packState(g, gmTgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// золото (+/-)
app.post("/api/gm/addGold", (req, res) => {
  try {
    const { code, gmTgId, playerTgId, delta } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g || !isGM(g, gmTgId)) return res.status(403).json({ ok: false });
    const p = getPlayer(g, playerTgId);
    if (!p) return res.status(404).json({ ok: false });

    const d = Number(delta) || 0;
    p.gold += d;
    g.messages.push({
      authorTgId: null,
      text: `ГМ ${d >= 0 ? "добавил" : "снял"} золото ${p.name}: теперь ${p.gold}.`,
      ts: Date.now()
    });
    return res.json({ ok: true, data: packState(g, gmTgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// жизни (+/-)
app.post("/api/gm/addHP", (req, res) => {
  try {
    const { code, gmTgId, playerTgId, delta } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g || !isGM(g, gmTgId)) return res.status(403).json({ ok: false });
    const p = getPlayer(g, playerTgId);
    if (!p) return res.status(404).json({ ok: false });

    const d = Number(delta) || 0;
    p.hp += d;
    g.messages.push({
      authorTgId: null,
      text: `ГМ изменил HP ${p.name}: теперь ${p.hp}.`,
      ts: Date.now()
    });
    return res.json({ ok: true, data: packState(g, gmTgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// выдать предмет игроку
app.post("/api/gm/giveItem", (req, res) => {
  try {
    const { code, gmTgId, playerTgId, name } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g || !isGM(g, gmTgId)) return res.status(403).json({ ok: false });
    const p = getPlayer(g, playerTgId);
    if (!p) return res.status(404).json({ ok: false });

    const itemName = String(name || "предмет").slice(0, 64);
    p.inventory.push({ id: genId(), name: itemName });
    g.messages.push({ authorTgId: null, text: `ГМ выдал ${p.name}: ${itemName}.`, ts: Date.now() });
    return res.json({ ok: true, data: packState(g, gmTgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// бросить предмет на пол (невидим для игроков до "осмотреться")
app.post("/api/gm/dropItem", (req, res) => {
  try {
    const { code, gmTgId, name, goldAmount } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g || !isGM(g, gmTgId)) return res.status(403).json({ ok: false });

    if (goldAmount) {
      g.floor.push({ id: genId(), name: "золото", goldAmount: Number(goldAmount) || 1 });
    } else {
      const itemName = String(name || "предмет").slice(0, 64);
      g.floor.push({ id: genId(), name: itemName });
    }
    // в чат ничего не пишем, пока игрок не "осмотрится"
    return res.json({ ok: true, data: packState(g, gmTgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// локации: добавить
app.post("/api/gm/addLocation", (req, res) => {
  try {
    const { code, gmTgId, name, description, imageUrl } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g || !isGM(g, gmTgId)) return res.status(403).json({ ok: false });

    const loc = {
      id: genId(),
      name: String(name || "Локация").slice(0, 64),
      description: String(description || "").slice(0, 500),
      imageUrl: imageUrl || null
    };
    g.locations.push(loc);
    return res.json({ ok: true, data: packState(g, gmTgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// локации: текущая
app.post("/api/gm/setLocation", (req, res) => {
  try {
    const { code, gmTgId, locationId } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g || !isGM(g, gmTgId)) return res.status(403).json({ ok: false });
    const loc = g.locations.find((l) => l.id === locationId) || null;
    g.currentLocationId = loc ? loc.id : null;
    return res.json({ ok: true, data: packState(g, gmTgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// ГМ может задать описание игроку
app.post("/api/gm/setPlayerDescription", (req, res) => {
  try {
    const { code, gmTgId, playerTgId, description } = req.body || {};
    const g = getGame(String(code || "").toUpperCase());
    if (!g || !isGM(g, gmTgId)) return res.status(403).json({ ok: false });
    const p = getPlayer(g, playerTgId);
    if (!p) return res.status(404).json({ ok: false });
    p.description = String(description || "").slice(0, 500);
    return res.json({ ok: true, data: packState(g, gmTgId) });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

/* ============================ TELEGRAM BOT ============================ */
const bot = new Telegraf(BOT_TOKEN);

// /start — кнопка открыть мини‑апп
bot.start(async (ctx) => {
  try {
    await ctx.reply(
      "Dnd Mini App. Выбери действие:",
      Markup.inlineKeyboard([
        [Markup.button.webApp("Открыть мини‑апп", `${APP_URL}`)]
      ])
    );
  } catch (e) {
    console.error("start error:", e);
  }
});

// /new — создать игру, выдать код и кнопку открыть мини‑апп
bot.command("new", async (ctx) => {
  try {
    const gmId = String(ctx.from.id);
    const code = createGame(gmId);
    // ГМ как игрок (не добавляем по умолчанию), но он — владелец игры
    await ctx.reply(
      `Создана игра. Код: ${code}\nОткрой мини‑апп, введи имя и жди игроков.`,
      Markup.inlineKeyboard([[Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${code}`)]])
    );
  } catch (e) {
    console.error("new error:", e);
    await ctx.reply("Не удалось создать игру. Попробуй ещё раз.");
  }
});

// /join — попросим код и дадим кнопку открыть мини‑апп с кодом
bot.command("join", async (ctx) => {
  await ctx.reply("Введи код комнаты (6 символов):");
  bot.once("text", async (ctx2) => {
    const code = (ctx2.message.text || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return ctx2.reply("Неверный код. Пример: ABC123");
    // даже если мини‑аппа создаст игру по /new, здесь просто даём кнопку открыть
    await ctx2.reply(
      `Код принят: ${code}. Открой мини‑апп и введи имя.`,
      Markup.inlineKeyboard([[Markup.button.webApp("Открыть мини‑апп", `${APP_URL}?code=${code}`)]])
    );
  });
});

// повесим вебхук на ТАКОЙ ЖЕ путь
app.get(WEBHOOK_PATH, (_req, res) => res.status(200).send("Webhook OK (GET)"));
app.use(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

/* ============================ START ============================ */
app.listen(PORT, async () => {
  console.log(`🌐 Web server on ${PORT}`);
  try {
    // сброс и установка вебхука
    await bot.telegram.deleteWebhook().catch(() => {});
    await bot.telegram.setWebhook(WEBHOOK_URL, { drop_pending_updates: true });
    console.log("🔗 Webhook set:", WEBHOOK_URL);
  } catch (e) {
    console.error("Failed to set webhook:", e);
  }
});
