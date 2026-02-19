// KVZ Dolzhniki PWA — v3.0 (клиенты + история операций)
const APP_VERSION = "3.1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : ("id-" + Math.random().toString(16).slice(2) + Date.now()));
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso) => iso ? new Date(iso + "T12:00:00").toLocaleDateString("ru-RU") : "—";
const fmtMoney = (n) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(Number(n || 0));
const clampInt = (v) => {
  const s = String(v ?? "").replace(/[^\d-]/g, "");
  const n = parseInt(s || "0", 10);
  return Number.isFinite(n) ? n : 0;
};

// ===== IndexedDB (compat with v2.x stores)
const DB_NAME = "dolzhniki_db";
const DB_VER = 2; // bump for indexes/migrations

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;

      // old: "debtors" and "tx" — keep them
      if (!db.objectStoreNames.contains("debtors")) {
        const s = db.createObjectStore("debtors", { keyPath: "id" });
        s.createIndex("name", "name", { unique: false });
      } else {
        const s = req.transaction.objectStore("debtors");
        if (!s.indexNames.contains("name")) s.createIndex("name", "name", { unique: false });
      }

      if (!db.objectStoreNames.contains("tx")) {
        const s = db.createObjectStore("tx", { keyPath: "id" });
        s.createIndex("debtorId", "debtorId", { unique: false });
        s.createIndex("date", "date", { unique: false });
      } else {
        const s = req.transaction.objectStore("tx");
        if (!s.indexNames.contains("debtorId")) s.createIndex("debtorId", "debtorId", { unique: false });
        if (!s.indexNames.contains("date")) s.createIndex("date", "date", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const s = tx.objectStore(store);
    const req = s.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, obj) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(obj);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// ===== Persistent storage request (best-effort)
async function tryPersist() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch { /* ignore */ }
}

// ===== State
let state = {
  q: "",
  model: [],
};

// ===== Model
function normalizeTx(t) {
  // New format:
  // { id, debtorId, date: 'YYYY-MM-DD', amount: signed int, comment }
  // Old format (v2): { type: 'debt'|'payment', amount: positive } => map to signed
  let amount = Number(t.amount ?? 0);
  if (!Number.isFinite(amount)) amount = 0;

  if (typeof t.type === "string") {
    if (t.type === "debt") amount = Math.abs(amount);
    if (t.type === "payment") amount = -Math.abs(amount);
  }
  amount = Math.trunc(amount);

  return {
    id: t.id,
    debtorId: t.debtorId,
    date: (t.date || todayISO()).slice(0, 10),
    amount,
    comment: (t.comment ?? t.note ?? "").toString().trim(),
  };
}

async function getModel() {
  const [clientsRaw, txRaw] = await Promise.all([idbGetAll("debtors"), idbGetAll("tx")]);
  const clients = (clientsRaw || [])
    .filter(c => !c.isArchived) // ignore old archived clients
    .map(c => ({
      id: c.id,
      name: (c.name ?? "").toString().trim(),
      createdAt: c.createdAt || c.created || c.ts || new Date().toISOString(),
    }))
    .filter(c => c.name);

  const tx = (txRaw || []).map(normalizeTx).filter(t => t.debtorId);

  const map = new Map();
  for (const t of tx) {
    if (!map.has(t.debtorId)) map.set(t.debtorId, []);
    map.get(t.debtorId).push(t);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (b.date || "").localeCompare(a.date || "")); // newest first
  }

  const enriched = clients.map(c => {
    const list = map.get(c.id) || [];
    const balance = list.reduce((s, t) => s + Number(t.amount || 0), 0);
    const lastDate = list[0]?.date || "";
    return { ...c, balance, lastDate, entries: list };
  });

  // Sort: by abs(balance) desc then name
  enriched.sort((a, b) => (Math.abs(b.balance) - Math.abs(a.balance)) || a.name.localeCompare(b.name, "ru"));

  return enriched;
}

function applySearch(items) {
  const q = (state.q || "").trim().toLowerCase();
  if (!q) return items;

  return items.filter(c => {
    const inName = (c.name || "").toLowerCase().includes(q);
    if (inName) return true;
    return (c.entries || []).some(e => (e.comment || "").toLowerCase().includes(q));
  });
}

// ===== Modal
const modal = {
  open(title, bodyNode) {
    $("#sheetTitle").textContent = title || "—";
    const b = $("#sheetBody");
    b.innerHTML = "";
    b.appendChild(bodyNode);
    $("#modal").classList.add("on");
    $("#modal").setAttribute("aria-hidden", "false");
  },
  close() {
    $("#modal").classList.remove("on");
    $("#modal").setAttribute("aria-hidden", "true");
    $("#sheetBody").innerHTML = "";
    // update main screen after closing any sheet
    try { render(); } catch { /* ignore */ }
  }
};

// ===== UI builders
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function makeClientRow(c) {
  const card = el("div", "card client");
  const top = el("div", "row between");
  const name = el("div", "cname", escapeHtml(c.name));
  const bal = el("div", "cbal " + (c.balance > 0 ? "neg" : c.balance < 0 ? "pos" : "zero"), escapeHtml(fmtMoney(c.balance)));
  top.append(name, bal);

  const sub = el("div", "muted small", c.lastDate ? `Последняя запись: ${escapeHtml(fmtDate(c.lastDate))}` : "Нет записей");
  card.append(top, sub);

  card.addEventListener("click", () => openClient(c.id));
  return card;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function makeEmpty() {
  const d = el("div", "empty", 'Пусто. Нажми <b>"+"</b> чтобы добавить клиента.');
  return d;
}

function setStats(items) {
  const totalClients = items.length;
  const totalDebt = items.reduce((s, c) => s + (c.balance > 0 ? c.balance : 0), 0);
  $("#statsLine").textContent = `Клиентов: ${totalClients} · Должны: ${fmtMoney(totalDebt)}`;
  $("#appVersion").textContent = `Версия: ${APP_VERSION}`;
}

// ===== Screens
async function render() {
  state.model = await getModel();
  const shown = applySearch(state.model);

  setStats(state.model);

  const list = $("#list");
  list.innerHTML = "";
  if (!shown.length) {
    list.appendChild(makeEmpty());
    return;
  }
  for (const c of shown) list.appendChild(makeClientRow(c));
}

function openAddClient() {
  const root = el("div", "form");

  root.appendChild(el("div", "label", "Имя / название"));
  const name = el("input", "input");
  name.placeholder = "Например: Брат / Клиент";
  name.autocomplete = "off";
  name.autocapitalize = "words";
  name.spellcheck = false;

  const actions = el("div", "row between mt");
  const btnCancel = el("button", "btn2", "Отмена");
  const btnCreate = el("button", "btnPrimary", "Создать");

  btnCancel.type = "button";
  btnCreate.type = "button";

  actions.append(btnCancel, btnCreate);
  root.append(name, actions);

  btnCancel.addEventListener("click", () => modal.close());
  btnCreate.addEventListener("click", async () => {
    const n = (name.value || "").trim();
    if (!n) {
      name.focus();
      return;
    }
    const client = { id: uuid(), name: n, createdAt: new Date().toISOString() };
    await idbPut("debtors", client);
    modal.close();
    await render();
    // open created client
    openClient(client.id);
  });

  modal.open("Новый клиент", root);
  setTimeout(() => name.focus(), 50);
}

async function openClient(clientId) {
  // refresh model to include new entries before opening
  state.model = await getModel();
  const c = state.model.find(x => x.id === clientId);
  if (!c) return;

  const root = el("div", "clientSheet");

  // Header line
  const head = el("div", "row between mb");
  const title = el("div", "sheetH", escapeHtml(c.name));
  const bal = el("div", "bigBal " + (c.balance > 0 ? "neg" : c.balance < 0 ? "pos" : "zero"), escapeHtml(fmtMoney(c.balance)));
  head.append(title, bal);

  // Actions: Взял / Отдал
  const act = el("div", "row gap mb");
  const btnTook = el("button", "btnPrimary", "Взял");
  const btnGave = el("button", "btn2", "Отдал");
  btnTook.type = "button";
  btnGave.type = "button";
  act.append(btnTook, btnGave);

  // List entries
  const list = el("div", "history");
  if (!c.entries.length) {
    list.appendChild(el("div", "empty2", "Нет записей."));
  } else {
    for (const e of c.entries) list.appendChild(makeEntryRow(c, e));
  }

  // Footer actions
  const foot = el("div", "row between mt");
  const btnDelete = el("button", "btnDanger", "Удалить клиента");
  btnDelete.type = "button";
  const hint = el("div", "muted small", "Тап по строке — редактировать");
  foot.append(hint, btnDelete);

  root.append(head, act, list, foot);

  btnTook.addEventListener("click", () => openEntryEditor({ client: c, mode: "took" }));
  btnGave.addEventListener("click", () => openEntryEditor({ client: c, mode: "gave" }));

  btnDelete.addEventListener("click", async () => {
    if (!confirm(`Удалить клиента "${c.name}" и всю историю?`)) return;
    // delete entries
    for (const e of c.entries) await idbDel("tx", e.id);
    await idbDel("debtors", c.id);
    modal.close();
    await render();
  });

  modal.open(c.name, root);
}

function makeEntryRow(client, e) {
  const row = el("div", "entry");
  const left = el("div", "eleft");
  const date = el("div", "edate", escapeHtml(fmtDate(e.date)));
  const comm = el("div", "ecomm", escapeHtml(e.comment || "—"));
  left.append(date, comm);

  const right = el("div", "eamt " + (e.amount > 0 ? "neg" : e.amount < 0 ? "pos" : "zero"), escapeHtml(fmtMoney(e.amount)));
  row.append(left, right);

  row.addEventListener("click", () => openEntryEditor({ client, entry: e, mode: e.amount >= 0 ? "took" : "gave" }));
  return row;
}

function openEntryEditor({ client, mode, entry }) {
  const isEdit = !!entry;
  const root = el("div", "form");

  // Amount
  root.appendChild(el("div", "label", "Сумма"));
  const amount = el("input", "input");
  amount.inputMode = "numeric";
  amount.placeholder = "Например: 10000";
  amount.autocomplete = "off";
  amount.autocorrect = "off";
  amount.spellcheck = false;
  root.appendChild(amount);

  // Date
  root.appendChild(el("div", "label mt2", "Дата"));
  const date = el("input", "input");
  date.type = "date";
  date.value = entry?.date || todayISO();
  root.appendChild(date);

  // Comment
  root.appendChild(el("div", "label mt2", "За что (комментарий)"));
  const comment = el("textarea", "input ta");
  comment.placeholder = "Например: займ, блок питания, ремонт…";
  root.appendChild(comment);

  // Fill
  if (isEdit) {
    amount.value = String(Math.abs(entry.amount || 0) || "");
    comment.value = entry.comment || "";
  }

  // Mode chips
  const chips = el("div", "row gap mt");
  const btnTook = el("button", "btnPrimary", "Взял");
  const btnGave = el("button", "btn2", "Отдал");
  btnTook.type = "button";
  btnGave.type = "button";

  function setMode(m) {
    mode = m;
    if (m === "took") {
      btnTook.classList.add("on");
      btnGave.classList.remove("on");
    } else {
      btnGave.classList.add("on");
      btnTook.classList.remove("on");
    }
  }
  setMode(mode || (entry?.amount < 0 ? "gave" : "took"));

  chips.append(btnTook, btnGave);
  root.appendChild(chips);

  const meta = el("div", "muted small mt2", "Автосохранение: включено");
  root.appendChild(meta);

  const actions = el("div", "row between mt");
  const btnClose = el("button", "btn2", "Готово");
  btnClose.type = "button";

  const btnDel = el("button", "btnDanger", isEdit ? "Удалить" : "Очистить");
  btnDel.type = "button";

  actions.append(btnClose, btnDel);
  root.appendChild(actions);

  // autosave (debounced)
  let saveTimer = null;
  let lastSaved = null;

  const getPayload = () => {
    const a = clampInt(amount.value);
    const signed = mode === "gave" ? -Math.abs(a) : Math.abs(a);
    return {
      id: entry?.id || uuid(),
      debtorId: client.id,
      date: (date.value || todayISO()).slice(0, 10),
      amount: signed,
      comment: (comment.value || "").trim(),
    };
  };

  async function doSave(force = false) {
    const payload = getPayload();
    const key = JSON.stringify(payload);
    if (!force && key === lastSaved) return;
    lastSaved = key;

    // don't save empty new entry
    if (!isEdit && Math.abs(payload.amount) === 0 && !payload.comment) return;

    await idbPut("tx", payload);
    entry = payload; // promote to edit state

    // keep client sheet fresh
    state.model = await getModel();
    // update background stats/list too
    try { setStats(state.model); } catch {}
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => doSave(false), 450);
  }

  amount.addEventListener("input", scheduleSave);
  comment.addEventListener("input", scheduleSave);
  date.addEventListener("change", scheduleSave);

  btnTook.addEventListener("click", async () => { setMode("took"); await doSave(true); });
  btnGave.addEventListener("click", async () => { setMode("gave"); await doSave(true); });

  btnClose.addEventListener("click", async () => {
    await doSave(true);
    modal.close(); // close sheet and refresh list
  });

  btnDel.addEventListener("click", async () => {
    if (entry?.id) {
      if (!confirm("Удалить запись?")) return;
      await idbDel("tx", entry.id);
      modal.close();
    } else {
      amount.value = "";
      comment.value = "";
      date.value = todayISO();
    }
  });

  modal.open(isEdit ? "Редактирование" : "Новая запись", root);
  setTimeout(() => amount.focus(), 50);
}
// ===== Export / Import
async function exportJSON() {
  const [clients, tx] = await Promise.all([idbGetAll("debtors"), idbGetAll("tx")]);
  const payload = {
    app: "kvz-dolzhniki",
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    clients: (clients || []).filter(c => !c.isArchived),
    tx: (tx || []).map(normalizeTx),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });

  // iOS share sheet if possible
  const file = new File([blob], `dolzhniki_backup_${new Date().toISOString().slice(0,10)}.json`, { type: "application/json" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: "Резервная копия" });
      return;
    }
  } catch { /* ignore */ }

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

async function importJSON(file) {
  const text = await file.text();
  const data = JSON.parse(text);

  if (!data || !Array.isArray(data.clients) || !Array.isArray(data.tx)) {
    alert("Неверный файл импорта.");
    return;
  }

  if (!confirm("Импорт заменит текущие данные на телефоне. Продолжить?")) return;

  // wipe existing
  const [clientsOld, txOld] = await Promise.all([idbGetAll("debtors"), idbGetAll("tx")]);
  for (const c of (clientsOld || [])) await idbDel("debtors", c.id);
  for (const t of (txOld || [])) await idbDel("tx", t.id);

  // write new
  for (const c of data.clients) {
    if (c?.id && c?.name) await idbPut("debtors", { id: c.id, name: String(c.name), createdAt: c.createdAt || new Date().toISOString() });
  }
  for (const t of data.tx) {
    const n = normalizeTx(t);
    if (n?.id && n?.debtorId) await idbPut("tx", n);
  }

  await render();
}

// ===== Events
function bind() {
  $("#appVersion").textContent = `Версия: ${APP_VERSION}`;

  $("#q").addEventListener("input", (e) => {
    state.q = e.target.value || "";
    render();
  });

  $("#btnAddClient").addEventListener("click", openAddClient);
  $("#btnClose").addEventListener("click", modal.close);
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") modal.close(); });

  $("#btnExport").addEventListener("click", exportJSON);
  $("#importFile").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try { await importJSON(f); } catch { alert("Ошибка импорта."); }
  });
}

(async function init() {
  await tryPersist();
  bind();
  await render();
})();
