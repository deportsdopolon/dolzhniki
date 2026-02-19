// ===== Utilities
const APP_VERSION = "2.2"; // iPhone iOS17 UI + autosave

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const fmtMoney = (n) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(n || 0);
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("ru-RU") : "—";
const todayISO = () => new Date().toISOString().slice(0,10);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : ("id-"+Math.random().toString(16).slice(2)+Date.now()));

// ===== IndexedDB
const DB_NAME = "dolzhniki_db";
const DB_VER = 1;

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains("debtors")){
        const s = db.createObjectStore("debtors", { keyPath: "id" });
        s.createIndex("name", "name", { unique:false });
        s.createIndex("isArchived", "isArchived", { unique:false });
      }
      if(!db.objectStoreNames.contains("tx")){
        const s = db.createObjectStore("tx", { keyPath: "id" });
        s.createIndex("debtorId", "debtorId", { unique:false });
        s.createIndex("date", "date", { unique:false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(store){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const s = tx.objectStore(store);
    const req = s.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, obj){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(obj);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(store, key){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// ===== State
let state = {
  filter: "active", // active | overdue | closed | all
  q: ""
};

// ===== Data ops
async function getModel(){
  const [debtors, tx] = await Promise.all([idbGetAll("debtors"), idbGetAll("tx")]);

  // group tx by debtorId
  const map = new Map();
  for(const t of tx){
    if(!map.has(t.debtorId)) map.set(t.debtorId, []);
    map.get(t.debtorId).push(t);
  }
  for(const arr of map.values()){
    arr.sort((a,b) => (a.date||"").localeCompare(b.date||""));
  }

  const enriched = debtors.map(d => {
    const list = map.get(d.id) || [];
    let debt = 0, pay = 0;
    for(const t of list){
      if(t.type === "debt") debt += Number(t.amount||0);
      if(t.type === "payment") pay += Number(t.amount||0);
    }
    const balance = debt - pay;

    const due = d.dueDate ? new Date(d.dueDate) : null;
    const now = new Date();
    const isOverdue = !d.isArchived && due && new Date(d.dueDate+"T23:59:59") < now && balance > 0;

    return { ...d, tx: list, debt, pay, balance, isOverdue };
  });

  enriched.sort((a,b) => (b.balance||0) - (a.balance||0));
  return enriched;
}

function applyFilter(items){
  const q = (state.q||"").trim().toLowerCase();
  return items.filter(d => {
    const matchesQ = !q || [
      d.name, d.phone, d.note
    ].filter(Boolean).join(" ").toLowerCase().includes(q);

    if(!matchesQ) return false;

    if(state.filter === "all") return true;
    if(state.filter === "closed") return !!d.isArchived;
    if(state.filter === "overdue") return !!d.isOverdue;
    // active
    return !d.isArchived;
  });
}

// ===== UI render
async function render(){
  const model = await getModel();
  const view = applyFilter(model);

  // stats
  const active = model.filter(d => !d.isArchived);
  const total = active.reduce((s,d)=>s+(d.balance||0),0);
  $("#statsLine").textContent = `Активных: ${active.length} • Сумма: ${fmtMoney(total)}`;

  const list = $("#list");
  list.innerHTML = "";

  if(view.length === 0){
    list.innerHTML = `<div class="card"><div class="muted">Пусто. Нажми “＋” чтобы добавить должника.</div></div>`;
    return;
  }

  for(const d of view){
    const badge = d.isArchived
      ? `<span class="badge green">Закрыт</span>`
      : d.isOverdue
        ? `<span class="badge red">Просрочено</span>`
        : `<span class="badge yellow">Активен</span>`;

    const meta = [
      d.phone ? `Тел: ${escapeHtml(d.phone)}` : null,
      d.dueDate ? `Срок: ${fmtDate(d.dueDate)}` : null,
      d.note ? `Комментарий: ${escapeHtml(trimOneLine(d.note))}` : null
    ].filter(Boolean).join(" • ");

    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="cardTop">
        <div>
          <div class="name">${escapeHtml(d.name || "Без имени")}</div>
          <div class="meta">${meta || "—"}</div>
          ${badge}
        </div>
        <div class="sum">${fmtMoney(d.balance)}</div>
      </div>

      <div class="cardBtns">
        <button class="small" data-open="${d.id}">Открыть</button>
        <button class="small" data-pay="${d.id}">Оплата</button>
        <button class="small" data-debt="${d.id}">+ Долг</button>
      </div>
    `;
    list.appendChild(el);
  }
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function trimOneLine(s){
  const t = String(s||"").trim().replace(/\s+/g," ");
  return t.length > 64 ? t.slice(0,64)+"…" : t;
}


function debounce(fn, ms){
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
// ===== Modal helpers
let modalOnClose = null;
function openModal(title, html, onClose){
  modalOnClose = typeof onClose === "function" ? onClose : null;
  $("#sheetTitle").textContent = title;
  $("#sheetBody").innerHTML = html;
  $("#modal").classList.add("on");
  $("#modal").setAttribute("aria-hidden","false");
}
function closeModal(){
  $("#modal").classList.remove("on");
  $("#modal").setAttribute("aria-hidden","true");
  try { if(modalOnClose) modalOnClose(); } catch(e){}
  modalOnClose = null;
}

// ===== Forms
function debtorForm(d = null){
  const isEdit = !!d;
  const name = d?.name ?? "";
  const phone = d?.phone ?? "";
  const note = d?.note ?? "";
  const dueDate = d?.dueDate ?? "";

  return `
    <div class="field">
      <div class="fieldLabel">Имя / название</div>
      <input class="input" id="f_name" value="${escapeHtml(name)}" placeholder="Например: Иван / Клиент" />
    </div>

    <div class="field">
      <div class="fieldLabel">Телефон (необязательно)</div>
      <input class="input" id="f_phone" value="${escapeHtml(phone)}" placeholder="+7..." inputmode="tel" autocomplete="new-password" autocorrect="off" autocapitalize="off" spellcheck="false" name="no_autofill_phone" />
    </div>

    <div class="field">
      <div class="fieldLabel">Срок (необязательно)</div>
      <input class="input" id="f_due" type="date" value="${escapeHtml(dueDate)}" />
    </div>

    <div class="field">
      <div class="fieldLabel">Комментарий (необязательно)</div>
      <textarea class="input" id="f_note" placeholder="Например: ремонт ноутбука, договорились до пятницы">${escapeHtml(note)}</textarea>
      <div class="autosave" id="autosaveState">Автосохранение: —</div>
    </div>

    <div class="row" style="justify-content:space-between; gap:8px; flex-wrap:wrap">
      ${isEdit ? `<button class="btn2" id="btnToggle">${d.isArchived ? "Сделать активным" : "Закрыть"}</button>` : `<span></span>`}
      <div class="actions">
        ${isEdit ? `<button class="btn2" id="btnDelete">Удалить</button>` : ``}
        <button class="btn2" id="btnSave">${isEdit ? "Сохранить" : "Добавить"}</button>
      </div>
    </div>
  `;
}

function txForm(type, debtorId){
  return `
    <div class="field">
      <div class="fieldLabel">Сумма</div>
      <input class="input" id="t_amount" inputmode="numeric" placeholder="Например: 5000" />
    </div>

    <div class="field">
      <div class="fieldLabel">Дата</div>
      <input class="input" id="t_date" type="date" value="${todayISO()}" />
    </div>

    <div class="field">
      <div class="fieldLabel">Комментарий (необязательно)</div>
      <input class="input" id="t_note" placeholder="Например: аванс" />
    </div>

    <div class="row" style="justify-content:flex-end">
      <button class="btn2" id="btnTxSave" data-type="${type}" data-debtor="${debtorId}">Сохранить</button>
    </div>
  `;
}

// ===== Detail
async function openDebtor(id){
  const model = await getModel();
  const d = model.find(x => x.id === id);
  if(!d) return;

  const txRows = (d.tx || []).slice().reverse().map(t => {
    const sign = t.type === "payment" ? "−" : "+";
    const label = t.type === "payment" ? "Оплата" : "Долг";
    return `
      <div class="card" style="background:#0f0f0f">
        <div class="cardTop">
          <div>
            <div class="name" style="font-size:14px">${label}</div>
            <div class="meta">${fmtDate(t.date)}${t.note ? " • " + escapeHtml(t.note) : ""}</div>
          </div>
          <div class="sum">${sign} ${fmtMoney(t.amount)}</div>
        </div>
        <div class="cardBtns">
          <button class="small" data-deltx="${t.id}" data-open="${d.id}">Удалить операцию</button>
        </div>
      </div>
    `;
  }).join("");

  openModal(
    d.name || "Должник",
    `
      <div class="card">
        <div class="cardTop">
          <div>
            <div class="name">${escapeHtml(d.name || "Без имени")}</div>
            <div class="meta">
              ${d.phone ? `Тел: ${escapeHtml(d.phone)} • ` : ``}
              Создан: ${fmtDate(d.createdAt)}${d.dueDate ? ` • Срок: ${fmtDate(d.dueDate)}` : ``}
            </div>
          </div>
          <div class="sum">${fmtMoney(d.balance)}</div>
        </div>
        ${d.note ? `<div class="hint" style="margin-top:10px">${escapeHtml(d.note)}</div>` : ``}

        <div class="cardBtns">
          <button class="small" data-edit="${d.id}">Изменить</button>
          <button class="small" data-pay="${d.id}">Оплата</button>
          <button class="small" data-debt="${d.id}">+ Долг</button>
        </div>
      </div>

      <div class="muted" style="margin-top:6px">История операций</div>
      ${txRows || `<div class="card"><div class="muted">Операций нет.</div></div>`}
    `
  );
}

async function openEditDebtor(id){
  const debtors = await idbGetAll("debtors");
  const d = debtors.find(x => x.id === id);
  if(!d) return;

  openModal("Редактировать", debtorForm(d));

  const setAuto = (t) => { const el = $("#autosaveState"); if(el) el.textContent = t; };
  const collect = () => ({
      ...d,
      name: ($("#f_name").value || "").trim(),
      phone: ($("#f_phone").value || "").trim(),
      dueDate: $("#f_due").value || "",
      note: ($("#f_note").value || "").trim()
  });
  const autoSave = debounce(async () => {
    const upd = collect();
    if(!upd.name){ setAuto("Автосохранение: укажи имя"); return; }
    await idbPut("debtors", upd);
    setAuto("Автосохранение: сохранено " + new Date().toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}));
  }, 350);
  ["f_name","f_phone","f_due","f_note"].forEach(id => {
    const el = $("#"+id);
    if(!el) return;
    el.addEventListener("input", autoSave);
    el.addEventListener("change", autoSave);
  });
  setAuto("Автосохранение: включено");

  $("#btnSave").onclick = async () => {
    const upd = {
      ...d,
      name: ($("#f_name").value || "").trim(),
      phone: ($("#f_phone").value || "").trim(),
      dueDate: $("#f_due").value || "",
      note: ($("#f_note").value || "").trim()
    };
    if(!upd.name) return alert("Укажи имя/название.");
    await idbPut("debtors", upd);
    closeModal();
    await render();
  };

  $("#btnToggle").onclick = async () => {
    d.isArchived = !d.isArchived;
    await idbPut("debtors", d);
    closeModal();
    await render();
  };

  $("#btnDelete").onclick = async () => {
    if(!confirm("Удалить должника и все его операции?")) return;
    const tx = await idbGetAll("tx");
    for(const t of tx.filter(x => x.debtorId === id)){
      await idbDel("tx", t.id);
    }
    await idbDel("debtors", id);
    closeModal();
    await render();
  };
}

// ===== Add debtor
function openAddDebtor(){
  // draft autosave (iPhone-friendly)
  const draft = {
    id: uuid(),
    name: "",
    phone: "",
    note: "",
    createdAt: new Date().toISOString(),
    dueDate: "",
    isArchived: false
  };
  let saved = false;

  const setAuto = (t) => { const el = $("#autosaveState"); if(el) el.textContent = t; };
  const collect = () => ({
    ...draft,
    name: ($("#f_name").value || "").trim(),
    phone: ($("#f_phone").value || "").trim(),
    dueDate: $("#f_due").value || "",
    note: ($("#f_note").value || "").trim()
  });

  openModal("Новый должник", debtorForm(null), () => {
    // если закрыли и имя пустое — чистим черновик
    if(saved && !draft.name) idbDel("debtors", draft.id);
  });

  // кнопка — просто закрыть (всё сохраняется автоматически)
  $("#btnSave").textContent = "Готово";
  $("#btnSave").onclick = async () => {
    const cur = collect();
    draft.name = cur.name;
    if(!draft.name){
      // ничего не добавили — просто закрываем
      closeModal();
      return;
    }
    // гарантируем запись перед закрытием
    await idbPut("debtors", cur);
    saved = true;
    closeModal();
    await render();
  };

  const autoSave = debounce(async () => {
    const cur = collect();
    draft.name = cur.name;
    if(!cur.name){
      setAuto("Автосохранение: укажи имя");
      if(saved){
        // если уже сохраняли, но стерли имя — удаляем запись
        await idbDel("debtors", draft.id);
        saved = false;
      }
      return;
    }
    await idbPut("debtors", cur);
    saved = true;
    setAuto("Автосохранение: сохранено " + new Date().toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}));
  }, 350);

  ["f_name","f_phone","f_due","f_note"].forEach(id => {
    const el = $("#"+id);
    if(!el) return;
    el.addEventListener("input", autoSave);
    el.addEventListener("change", autoSave);
  });

  setAuto("Автосохранение: включено");
}

// ===== Add tx
function openAddTx(type, debtorId){
  openModal(type === "payment" ? "Оплата" : "+ Долг", txForm(type, debtorId));
  $("#btnTxSave").onclick = async (e) => {
    const btn = e.currentTarget;

    const amount = Number(($("#t_amount").value || "").replace(/[^\d]/g,""));
    if(!amount || amount <= 0) return alert("Укажи сумму.");
    const date = $("#t_date").value || todayISO();

    const tx = {
      id: uuid(),
      debtorId,
      type,
      amount,
      date,
      note: ($("#t_note").value || "").trim()
    };
    await idbPut("tx", tx);
    closeModal();
    await render();
  };
}

// ===== Export / Import
async function exportData(){
  const [debtors, tx] = await Promise.all([idbGetAll("debtors"), idbGetAll("tx")]);
  const payload = { version: 1, exportedAt: new Date().toISOString(), debtors, tx };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dolzhniki_backup_${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importData(file){
  const text = await file.text();
  let payload;
  try{ payload = JSON.parse(text); } catch { return alert("Файл не JSON."); }

  if(!payload || !Array.isArray(payload.debtors) || !Array.isArray(payload.tx)){
    return alert("Неверный формат файла.");
  }

  if(!confirm("Импорт добавит данные из файла. Продолжить?")) return;

  for(const d of payload.debtors) await idbPut("debtors", d);
  for(const t of payload.tx) await idbPut("tx", t);

  alert("Импорт завершён.");
  await render();
}

try { const v = $("#appVersion"); if(v) v.textContent = "Версия: " + APP_VERSION; } catch(e){}
if(navigator.storage && navigator.storage.persist){ navigator.storage.persist().then((ok)=>{ /* optional */ }); }

// ===== Events
$("#btnAdd").addEventListener("click", openAddDebtor);
$("#btnClose").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if(e.target.id === "modal") closeModal(); });

$("#q").addEventListener("input", async (e) => {
  state.q = e.target.value || "";
  await render();
});

$$(".chip").forEach(ch => ch.addEventListener("click", async () => {
  $$(".chip").forEach(x => x.classList.remove("chip-on"));
  ch.classList.add("chip-on");
  state.filter = ch.dataset.filter;
  await render();
}));

$("#list").addEventListener("click", async (e) => {
  const t = e.target;
  if(!(t instanceof HTMLElement)) return;

  const openId = t.getAttribute("data-open");
  const payId = t.getAttribute("data-pay");
  const debtId = t.getAttribute("data-debt");

  if(openId) return openDebtor(openId);
  if(payId) return openAddTx("payment", payId);
  if(debtId) return openAddTx("debt", debtId);
});

$("#sheetBody").addEventListener("click", async (e) => {
  const t = e.target;
  if(!(t instanceof HTMLElement)) return;

  const editId = t.getAttribute("data-edit");
  const payId = t.getAttribute("data-pay");
  const debtId = t.getAttribute("data-debt");
  const delTxId = t.getAttribute("data-deltx");
  const reopenId = t.getAttribute("data-open");

  if(editId) return openEditDebtor(editId);
  if(payId) return openAddTx("payment", payId);
  if(debtId) return openAddTx("debt", debtId);

  if(delTxId){
    if(!confirm("Удалить операцию?")) return;
    await idbDel("tx", delTxId);
    if(reopenId) {
      closeModal();
      await render();
      return openDebtor(reopenId);
    }
    closeModal();
    await render();
  }
});

$("#btnExport").addEventListener("click", exportData);
$("#importFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  e.target.value = "";
  if(f) await importData(f);
});

// ===== First render
render();
