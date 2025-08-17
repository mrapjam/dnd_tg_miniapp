// Telegram WebApp bootstrap (без него тоже работает в браузере)
const tg = window.Telegram?.WebApp;
if (tg?.expand) tg.expand();

// ----- helpers -----
const qs = new URLSearchParams(location.search);
const state = {
  code: (qs.get('code') || '').toUpperCase(),
  role: qs.get('role') || '', // 'gm' | 'player'
  me: null,       // { id, name, username }
  you: null,      // player-объект
  game: null,     // состояние игры целиком
  reveal: 0,      // сколько предметов уже “открыто” кнопкой Осмотреться
};
const API = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) throw new Error(`POST ${path} -> ${r.status}`);
    return r.json();
  }
};

const $ = (sel) => document.querySelector(sel);
const show = (el, yes = true) => el.classList.toggle('hidden', !yes);
const toast = (msg, ms = 2200) => {
  const t = $('#toast');
  t.textContent = msg;
  show(t, true);
  setTimeout(() => show(t, false), ms);
};
const codePill = $('#codePill');

function getMe() {
  // из Telegram
  if (tg?.initDataUnsafe?.user?.id) {
    return {
      id: String(tg.initDataUnsafe.user.id),
      name: tg.initDataUnsafe.user.first_name || 'Игрок',
      username: tg.initDataUnsafe.user.username || ''
    };
  }
  // фоллбэк в браузере
  let saved = localStorage.getItem('me');
  if (saved) return JSON.parse(saved);
  const rnd = Math.random().toString(36).slice(2, 8);
  const m = { id: `web_${rnd}`, name: 'Hero', username: '' };
  localStorage.setItem('me', JSON.stringify(m));
  return m;
}

// ----- аватары -----
const AVATARS = ['🛡️','🗡️','🏹','🧙','🧝','🐺','🐉','🧟','👹','🦄'];
let selectedAvatar = AVATARS[0];
function renderAvatars() {
  const wrap = $('#avatarList'); wrap.innerHTML = '';
  AVATARS.forEach(a => {
    const span = document.createElement('span');
    span.className = 'avatar' + (a === selectedAvatar ? ' selected' : '');
    span.textContent = a;
    span.onclick = () => { selectedAvatar = a; renderAvatars(); };
    wrap.appendChild(span);
  });
}

// ----- вкладки -----
const tabs = $('#tabs');
const tabBtns = [...tabs.querySelectorAll('button')];
const sections = {
  lobby: $('#lobby'),
  chat: $('#chat'),
  map: $('#map'),
  gm: $('#gm'),
};
function activateTab(name) {
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  Object.entries(sections).forEach(([k, el]) => show(el, k === name));
}

// ----- UI заполнение -----
function renderYou() {
  const card = $('#youCard');
  const zone = $('#youInfo');
  if (!state.you) { show(card, false); return; }
  show(card, true);
  zone.innerHTML = `
    <div class="list">
      <li><b>${state.you.avatar || '🙂'}</b> ${state.you.name}</li>
      <li>HP: ${state.you.hp} • Gold: ${state.you.gold}</li>
      <li>${state.you.isGM ? 'Вы — Мастер игры' : 'Игрок'}</li>
    </div>
  `;
}

function renderPlayers() {
  const card = $('#playerListCard');
  const ul = $('#playerList');
  if (!state.game?.players?.length) { show(card, false); return; }
  show(card, true);
  ul.innerHTML = '';
  state.game.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<div><b>${p.avatar || '🙂'}</b> ${p.name}</div>
      <div class="muted">HP ${p.hp} • Gold ${p.gold}${p.isGM ? ' • ГМ' : ''}</div>`;
    ul.appendChild(li);
  });
}

function renderChat() {
  const box = $('#chatList');
  box.innerHTML = '';
  (state.game?.messages || []).forEach(m => {
    const mine = state.you && m.authorId === state.you.id;
    const div = document.createElement('div');
    div.className = 'msg' + (mine ? ' me' : '');
    div.textContent = m.text;
    box.appendChild(div);
  });
  box.scrollTop = 1e9;
}

function renderLocation() {
  const b = $('#locBlock');
  const playerLocId = state.you?.locationId || null;
  const loc = (state.game?.locations || []).find(l => l.id === playerLocId);
  b.innerHTML = loc
    ? `<h3>${loc.name}</h3><p class="muted">${loc.descr || ''}</p>${loc.imageUrl ? `<img src="${loc.imageUrl}" alt="">` : ''}`
    : `<p class="muted">Локация не назначена.</p>`;

  // Показ предметов: постепенно по кнопке "Осмотреться"
  const floor = (state.game?.items || [])
    .filter(i => i.onFloor && (!i.locationId || i.locationId === playerLocId));
  const ul = $('#floorList'); ul.innerHTML = '';
  const slice = floor.slice(0, state.reveal || 0);
  slice.forEach(i => {
    const li = document.createElement('li');
    li.textContent = `${i.name} × ${i.qty}`;
    ul.appendChild(li);
  });
}

function renderGM() {
  const gmTab = $('#gmTab');
  const gmSec = $('#gm');
  const isGM = Boolean(state.you?.isGM);
  show(gmTab, isGM);
  show(gmSec, isGM && tabs.querySelector('.active')?.dataset.tab === 'gm');
  if (!isGM) return;

  $('#gmBadge').textContent = `Вы — ГМ. Игра ${state.game?.started ? 'начата' : 'в лобби'}.`;

  // список игроков с +HP/-HP и +Gold/-Gold
  const ul = $('#gmPlayers'); ul.innerHTML = '';
  (state.game?.players || []).forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div><b>${p.avatar || '🙂'}</b> ${p.name}</div>
      <div>
        <button class="btn" data-act="hp-" data-id="${p.id}">-HP</button>
        <button class="btn" data-act="hp+" data-id="${p.id}">+HP</button>
        <button class="btn" data-act="g-" data-id="${p.id}">-Gold</button>
        <button class="btn" data-act="g+" data-id="${p.id}">+Gold</button>
      </div>`;
    ul.appendChild(li);
  });

  ul.onclick = async (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.act;
    try {
      if (act === 'hp+' || act === 'hp-') {
        const delta = act === 'hp+' ? 1 : -1;
        await API.post('/api/gm/grant-hp', { code: state.code, me: state.me.id, playerId: id, delta });
      } else {
        const delta = act === 'g+' ? 1 : -1;
        await API.post('/api/gm/grant-gold', { code: state.code, me: state.me.id, playerId: id, delta });
      }
      await refreshState();
    } catch (err) {
      toast('Ошибка изменения параметров игрока'); console.error(err);
    }
  };

  // выпадашки (локации, владельцы)
  const locSel = $('#startLoc'); locSel.innerHTML = '';
  const locSel2 = $('#itemLoc'); locSel2.innerHTML = '<option value="">(нет)</option>';
  (state.game?.locations || []).forEach(l => {
    const o = new Option(l.name, l.id); locSel.add(o);
    const o2 = new Option(l.name, l.id); locSel2.add(o2);
  });

  const ownerSel = $('#itemOwner'); ownerSel.innerHTML = '<option value="">(на пол)</option>';
  (state.game?.players || []).forEach(p => ownerSel.add(new Option(p.name, p.id)));
}

// ----- общий рендер -----
function renderAll() {
  codePill.textContent = state.code || '— — — — — —';
  const hasYou = Boolean(state.you);

  // включаем вкладки после входа
  show(tabs, true);
  show($('#gmTab'), Boolean(state.you?.isGM));

  renderYou();
  renderPlayers();
  renderChat();
  renderLocation();
  renderGM();

  // если не вошёл — показываем лобби
  if (!hasYou) activateTab('lobby');
}

// ----- загрузка состояния -----
async function refreshState() {
  if (!state.code) return;
  const data = await API.get(`/api/state?code=${encodeURIComponent(state.code)}&me=${encodeURIComponent(state.me?.id || '')}`);
  if (!data.ok) return;
  state.game = data.exists ? data : null;
  state.you = data.you || null;
  renderAll();
}

// ----- join flow -----
$('#joinBtn').onclick = async () => {
  try {
    const name = ($('#nameInput').value || '').trim() || state.me.name || 'Hero';
    await API.post('/api/lobby/join', {
      code: state.code,
      tgId: state.me.id,
      name,
      avatar: selectedAvatar
    });
    $('#joinHint').textContent = 'Готово! Перехожу к чату…';
    await refreshState();
    activateTab('chat');
  } catch (e) {
    toast('Не удалось войти в лобби'); console.error(e);
  }
};

// чат
$('#sendMsg').onclick = async () => {
  const txt = ($('#chatInput').value || '').trim();
  if (!txt) return;
  try {
    await API.post('/api/message', { gameId: state.game.id, authorId: state.you?.id || null, text: txt });
    $('#chatInput').value = '';
    await refreshState();
  } catch (e) { console.error(e); toast('Не удалось отправить'); }
};

// бросок
$('#rollBtn').onclick = async () => {
  try {
    const die = Number($('#dieSelect').value || 20);
    const r = await API.post('/api/roll', { gameId: state.game.id, playerId: state.you?.id || null, die });
    toast(`Бросок d${die}: ${r.roll.result}`);
    await refreshState();
  } catch (e) { console.error(e); toast('Не удалось бросить'); }
};

// осмотреться — показываем ещё один предмет
$('#lookBtn').onclick = () => {
  state.reveal = (state.reveal || 0) + 1;
  renderLocation();
};

// ГМ: создать локацию
$('#addLoc').onclick = async () => {
  try {
    await API.post('/api/location', {
      gameId: state.game.id,
      name: $('#locName').value || 'Локация',
      descr: $('#locDescr').value || '',
      imageUrl: $('#locImg').value || null
    });
    $('#locName').value = ''; $('#locDescr').value = ''; $('#locImg').value = '';
    toast('Локация добавлена');
    await refreshState();
  } catch (e) { console.error(e); toast('Не удалось создать локацию'); }
};

// ГМ: старт игры
$('#startGame').onclick = async () => {
  try {
    const locId = Number($('#startLoc').value || 0) || null;
    await API.post(`/api/game/${state.game.id}/start`, { locationId: locId });
    toast('Игра началась');
    await refreshState();
    activateTab('map');
  } catch (e) { console.error(e); toast('Не удалось начать игру'); }
};

// ГМ: выдать предмет
$('#giveItem').onclick = async () => {
  try {
    const name = $('#itemName').value || 'Предмет';
    const qty = Number($('#itemQty').value || 1);
    const ownerId = Number($('#itemOwner').value || 0) || null;
    const onFloor = $('#itemOnFloor').checked || !ownerId;
    const locationId = Number($('#itemLoc').value || 0) || null;
    await API.post('/api/item', {
      gameId: state.game.id, name, qty, ownerId, onFloor, locationId
    });
    $('#itemName').value = ''; $('#itemQty').value = '1'; $('#itemOwner').value = ''; $('#itemOnFloor').checked = false; $('#itemLoc').value = '';
    toast('Предмет создан');
    await refreshState();
  } catch (e) { console.error(e); toast('Не удалось создать предмет'); }
};

// переключение вкладок
tabs.onclick = (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const tab = btn.dataset.tab;
  if (tab === 'gm' && !state.you?.isGM) return;
  activateTab(tab);
};

// ----- старт -----
(async function init(){
  state.me = getMe();
  renderAvatars();

  // если зашли через дип‑линк с role, сразу на нужную вкладку
  if (state.role === 'gm') activateTab('gm');
  else activateTab('lobby');

  if (!state.code) {
    toast('Открой мини‑аппу из бота (нет кода комнаты)');
    return;
  }
  await refreshState();
  // автообновление
  setInterval(() => refreshState().catch(() => {}), 3000);
})();
