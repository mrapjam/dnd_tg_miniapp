const tg = window.Telegram?.WebApp; if (tg?.expand) tg.expand();

const qs = new URLSearchParams(location.search);
const state = {
  code: (qs.get('code') || '').toUpperCase(),
  me: null, you: null, game: null
};
$('#codePill').textContent = state.code || '— — — — — —';

const API = {
  async get(p){ const r=await fetch(p); if(!r.ok) throw new Error(r.status); return r.json(); },
  async post(p,b){ const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}); if(!r.ok) throw new Error(r.status); return r.json(); },
  async upload(p,file){ const fd=new FormData(); fd.append('file',file); const r=await fetch(p,{method:'POST',body:fd}); if(!r.ok) throw new Error(r.status); return r.json(); }
};
const $ = s=>document.querySelector(s);
const show = (el,yes=true)=>el.classList.toggle('hidden',!yes);
const toast = (m,ms=2200)=>{ const t=$('#toast'); t.textContent=m; show(t,true); setTimeout(()=>show(t,false),ms); };

function getMe(){
  if (tg?.initDataUnsafe?.user?.id) return { id:String(tg.initDataUnsafe.user.id), name:tg.initDataUnsafe.user.first_name||'Игрок' };
  let saved=localStorage.getItem('me'); if (saved) return JSON.parse(saved);
  const me={ id:`web_${Math.random().toString(36).slice(2,8)}`, name:'Hero' };
  localStorage.setItem('me', JSON.stringify(me)); return me;
}
state.me = getMe();

// === Avatars
const AVATARS = ['🛡️','🗡️','🏹','🧙','🧝','🐺','🐉','🧟','👹','🦄'];
let avatarSel = AVATARS[0];
function renderAvatars(){
  const box=$('#avatarList'); box.innerHTML='';
  AVATARS.forEach(a=>{
    const span=document.createElement('span');
    span.className='avatar'+(a===avatarSel?' selected':'');
    span.textContent=a; span.onclick=()=>{avatarSel=a; renderAvatars();};
    box.appendChild(span);
  });
}
renderAvatars();
$('#avatarFile').addEventListener('change', e=>{
  const file=e.target.files?.[0]; if(!file) return;
  avatarSel='🖼️'; toast('Фото выбрано как аватар');
});

// === Tabs
const tabs=$('#tabs');
const sections={ lobby:$('#lobby'), chat:$('#chat'), map:$('#map'), gm:$('#gm') };
function activateTab(name){
  [...tabs.querySelectorAll('button')].forEach(b=>b.classList.toggle('active', b.dataset.tab===name));
  Object.entries(sections).forEach(([k,el])=> show(el, k===name));
}
function afterJoinUI(){
  show($('#chatTab'), true);
  show($('#mapTab'), !!state.game?.started);
  show($('#gmTab'), !!state.you?.isgm);
  tabs.classList.remove('hidden');
  activateTab('chat');
}

// === Render
function renderYou(){
  const z=$('#youInfo'); if (!state.you) { z.innerHTML=''; return; }
  z.innerHTML = `<div class="list">
    <li><b>${state.you.avatar||'🙂'}</b> ${state.you.name}</li>
    <li>HP: ${state.you.hp} • Gold: ${state.you.gold}</li>
    <li>${state.you.isgm ? 'Вы — Мастер игры' : 'Игрок'}</li>
  </div>`;
  $('#youBio').textContent = state.you.bio?.trim() || '—';
  $('#youSheet').textContent = state.you.sheet?.trim() || '—';
}
function renderChat(id='#chatList'){
  const box=$(id); box.innerHTML='';
  (state.game?.messages||[]).forEach(m=>{
    const mine = state.you && m.authorid===state.you.id;
    const d=document.createElement('div'); d.className='msg'+(mine?' me':''); d.textContent=m.text; box.appendChild(d);
  }); box.scrollTop=1e9;
}
function renderLocation(){
  const started=!!state.game?.started;
  show($('#mapTab'), started);
  show($('#map'), started && tabs.querySelector('.active')?.dataset.tab==='map');
  if (!started) return;
  const you=state.you;
  const loc=(state.game?.locations||[]).find(l=>l.id===you?.locationid);
  $('#locBlock').innerHTML = loc
    ? `<h3>${loc.name}</h3><p class="muted">${loc.descr||''}</p>${loc.imageurl?`<img src="${loc.imageurl}" alt="">`:''}`
    : `<p class="muted">Локация не назначена.</p>`;
  const ul=$('#floorList'); ul.innerHTML='';
  (state.game?.floorItems||[]).forEach(i=>{ const li=document.createElement('li'); li.textContent=`${i.name} × ${i.qty}`; ul.appendChild(li); });
}
function renderGM(){
  const isGM=!!state.you?.isgm;
  show($('#gmTab'), isGM);
  show($('#gm'), isGM && tabs.querySelector('.active')?.dataset.tab==='gm');
  if (!isGM) return;
  $('#gmBadge').textContent = `Вы — ГМ. Игра ${state.game?.started?'начата':'в лобби'}.`;
  const ul=$('#gmPlayers'); ul.innerHTML='';
  (state.game?.players||[]).forEach(p=>{
    const li=document.createElement('li');
    li.innerHTML=`<div><b>${p.avatar||'🙂'}</b> ${p.name}</div>
      <div>
        <button class="btn" data-act="hp-" data-id="${p.id}">-HP</button>
        <button class="btn" data-act="hp+" data-id="${p.id}">+HP</button>
        <button class="btn" data-act="g-" data-id="${p.id}">-Gold</button>
        <button class="btn" data-act="g+" data-id="${p.id}">+Gold</button>
      </div>`;
    ul.appendChild(li);
  });
  ul.onclick=async e=>{
    const b=e.target.closest('button'); if(!b) return;
    const id=Number(b.dataset.id), act=b.dataset.act;
    try{
      if(act.startsWith('hp')) await API.post('/api/gm/grant-hp',{playerId:id,delta:act==='hp+'?1:-1});
      else await API.post('/api/gm/grant-gold',{playerId:id,delta:act==='g+'?1:-1});
      await refresh();
    }catch(err){ console.error(err); toast('Ошибка изменения параметров'); }
  };
  // селекты
  const locSel=$('#startLoc'); locSel.innerHTML='';
  const locSel2=$('#itemLoc'); locSel2.innerHTML='<option value="">(нет)</option>';
  (state.game?.locations||[]).forEach(l=>{ locSel.add(new Option(l.name,l.id)); locSel2.add(new Option(l.name,l.id)); });
  const ownerSel=$('#itemOwner'); ownerSel.innerHTML='<option value="">(на пол)</option>';
  (state.game?.players||[]).forEach(p=> ownerSel.add(new Option(p.name,p.id)));
}
function renderAll(){ renderYou(); renderChat('#chatList'); renderChat('#chatList2'); renderLocation(); renderGM(); }

// === Refresh
async function refresh(){
  if (!state.code) return;
  const meId=state.me?.id||'';
  const data=await API.get(`/api/state?code=${encodeURIComponent(state.code)}&me=${encodeURIComponent(meId)}`);
  if (!data.ok && !data.exists) return;
  state.game = data.exists ? data : null;
  state.you = data.you || null;
  if (state.you) { afterJoinUI(); }
  renderAll();
}

// === Actions
$('#applyCode').onclick = ()=>{
  const val = ($('#codeInput').value||'').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(val)) { toast('Код из 6 символов'); return; }
  state.code = val; $('#codePill').textContent = val; toast('Код применён');
};

$('#joinBtn').onclick = async ()=>{
  if (!state.code) { toast('Сначала укажи код комнаты'); return; }
  try{
    const name=($('#nameInput').value||'').trim() || state.me.name || 'Hero';
    const asGM = $('#asGM').checked;
    await API.post('/api/lobby/join',{ code:state.code, tgId:state.me.id, name, avatar:avatarSel, asGM });
    $('#joinHint').textContent='Готово!'; await refresh();
  }catch(e){ console.error(e); toast('Не удалось войти'); }
};

async function sendChat(inpSel){
  const inp=$(inpSel); const txt=(inp.value||'').trim(); if(!txt) return;
  try{ await API.post('/api/message',{ gameId:state.game.id, authorId: state.you?.id||null, text:txt }); inp.value=''; await refresh(); }
  catch(e){ console.error(e); toast('Не отправилось'); }
}
$('#sendMsg').onclick = ()=> sendChat('#chatInput');
$('#sendMsg2').onclick = ()=> sendChat('#chatInput2');

$('#rollBtn').onclick = async ()=>{
  try{
    const die=Number($('#dieSelect').value||20);
    const r=await API.post('/api/roll',{ gameId:state.game.id, playerId: state.you?.id||null, die });
    toast(`Бросок d${die}: ${r.roll.result}`); await refresh();
  }catch(e){ console.error(e); toast('Не удалось бросить'); }
};
$('#lookBtn').onclick = async ()=>{
  try{ await API.post('/api/look',{ gameId:state.game.id, playerId: state.you.id }); await refresh(); }
  catch(e){ console.error(e); toast('Не удалось осмотреться'); }
};

$('#uploadLocImg').onclick = async ()=>{
  const f=$('#locFile').files?.[0]; if(!f){ toast('Выбери файл'); return; }
  try{ const r=await API.upload('/api/location/upload', f); $('#locImg').value=r.url; toast('Фото загружено'); }
  catch(e){ console.error(e); toast('Загрузка не удалась'); }
};
$('#addLoc').onclick = async ()=>{
  try{
    await API.post('/api/location',{ gameId:state.game.id, name:$('#locName').value||'Локация',
      descr:$('#locDescr').value||'', imageUrl:$('#locImg').value||null });
    $('#locName').value=''; $('#locDescr').value=''; $('#locImg').value='';
    toast('Локация добавлена'); await refresh();
  }catch(e){ console.error(e); toast('Не удалось создать локацию'); }
};
$('#startGame').onclick = async ()=>{
  try{
    const loc=Number($('#startLoc').value||0)||null;
    await API.post(`/api/game/${state.game.id}/start`, { locationId:loc });
    toast('Игра началась'); await refresh(); activateTab('map');
  }catch(e){ console.error(e); toast('Не удалось начать'); }
};
$('#giveItem').onclick = async ()=>{
  try{
    const name=$('#itemName').value||'Предмет';
    const qty=Number($('#itemQty').value||1);
    const ownerId=Number($('#itemOwner').value||0)||null;
    const onFloor = $('#itemOnFloor').checked || !ownerId;
    const locationId=Number($('#itemLoc').value||0)||null;
    await API.post('/api/item',{ gameId:state.game.id, name, qty, ownerId, onFloor, locationId });
    $('#itemName').value=''; $('#itemQty').value='1'; $('#itemOwner').value=''; $('#itemOnFloor').checked=false; $('#itemLoc').value='';
    toast('Предмет создан'); await refresh();
  }catch(e){ console.error(e); toast('Не удалось создать предмет'); }
};

$('#tabs').onclick = (e)=>{
  const b=e.target.closest('button'); if(!b) return;
  const tab=b.dataset.tab;
  if (tab==='map' && !state.game?.started) return;
  if (tab==='gm' && !state.you?.isgm) return;
  activateTab(tab);
};

// init
(async function init(){
  // если кода нет — показываем поле ввода кода
  show($('#codeRow'), !state.code);
  if (state.code) { tabs.classList.remove('hidden'); activateTab('lobby'); await refresh().catch(()=>{}); }
  setInterval(()=>refresh().catch(()=>{}), 3000);
})();
