const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const STORE_API = "https://superjsonblob.com/api/jsonBlob";
const categoriesExpense = ["餐飲","日用品","交通","家庭","育兒","購物","娛樂","醫療","住房","旅行","保險","其他"];
const categoriesIncome = ["薪資","獎金","投資","退款","其他收入"];

let data = null;
let storageId = null;
let keyText = null;
let cryptoKey = null;
let entryType = "expense";
let editId = null;
let viewMonth = new Date();
let saving = false;
let refreshing = false;

function money(n) {
  return new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: "TWD",
    maximumFractionDigits: 0
  }).format(Number(n) || 0);
}

function nowIso() {
  return new Date().toISOString();
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function uid() {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function defaultData() {
  return {
    version: 2,
    settings: { memberA: "David", memberB: "太太", monthlyBudget: 0 },
    settingsUpdatedAt: "1970-01-01T00:00:00.000Z",
    entries: [],
    tombstones: {},
    modifiedAt: nowIso()
  };
}

function setStatus(text, kind = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function renderMonthLabel() {
  $("#monthLabel").textContent = new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "long"
  }).format(viewMonth);
}

function escapeHtml(value = "") {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return String(value).replace(/[&<>"']/g, (m) => map[m]);
}

function b64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function makeKey() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { key, text: b64url(raw) };
}

async function importKey(text) {
  const raw = fromB64url(text);
  if (raw.length !== 32) throw new Error("Invalid key");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptData(value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plain);
  return {
    format: "dc-ledger-aesgcm-v1",
    iv: b64url(iv),
    ciphertext: b64url(new Uint8Array(encrypted))
  };
}

async function decryptData(envelope) {
  if (!envelope || envelope.format !== "dc-ledger-aesgcm-v1") throw new Error("Unknown ledger format");
  const iv = fromB64url(envelope.iv);
  const ciphertext = fromB64url(envelope.ciphertext);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
  return JSON.parse(new TextDecoder().decode(plain));
}

function normalizeData(input) {
  const base = defaultData();
  if (!input || typeof input !== "object") return base;

  const settings = input.settings || {};
  base.settings = {
    memberA: String(settings.memberA || "David").slice(0, 30),
    memberB: String(settings.memberB || "太太").slice(0, 30),
    monthlyBudget: Math.max(0, Number(settings.monthlyBudget) || 0)
  };
  base.settingsUpdatedAt = String(input.settingsUpdatedAt || "1970-01-01T00:00:00.000Z");
  base.modifiedAt = String(input.modifiedAt || base.modifiedAt);
  base.tombstones = input.tombstones && typeof input.tombstones === "object" ? { ...input.tombstones } : {};
  base.entries = Array.isArray(input.entries)
    ? input.entries
        .map((e) => ({
          id: String(e.id || ""),
          type: e.type === "income" ? "income" : "expense",
          amount: Math.max(0, Number(e.amount) || 0),
          category: String(e.category || "其他").slice(0, 30),
          member: e.member === "B" ? "B" : "A",
          note: String(e.note || "").slice(0, 200),
          date: /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || "")) ? String(e.date) : localDate(),
          createdAt: String(e.createdAt || nowIso()),
          updatedAt: String(e.updatedAt || e.createdAt || nowIso())
        }))
        .filter((e) => e.id && e.amount > 0)
    : [];

  return base;
}

function maxIso(a, b) {
  return String(a || "") >= String(b || "") ? String(a || "") : String(b || "");
}

function mergeData(leftInput, rightInput) {
  const left = normalizeData(leftInput);
  const right = normalizeData(rightInput);
  const merged = defaultData();

  if (left.settingsUpdatedAt >= right.settingsUpdatedAt) {
    merged.settings = left.settings;
    merged.settingsUpdatedAt = left.settingsUpdatedAt;
  } else {
    merged.settings = right.settings;
    merged.settingsUpdatedAt = right.settingsUpdatedAt;
  }

  merged.tombstones = { ...left.tombstones };
  for (const [id, deletedAt] of Object.entries(right.tombstones)) {
    merged.tombstones[id] = maxIso(merged.tombstones[id], deletedAt);
  }

  const byId = new Map();
  for (const entry of [...left.entries, ...right.entries]) {
    const current = byId.get(entry.id);
    if (!current || entry.updatedAt > current.updatedAt) byId.set(entry.id, entry);
  }

  merged.entries = [...byId.values()].filter((entry) => {
    const deletedAt = merged.tombstones[entry.id];
    return !deletedAt || entry.updatedAt > deletedAt;
  });

  merged.modifiedAt = maxIso(left.modifiedAt, right.modifiedAt);
  return merged;
}

function stableSnapshot(value) {
  const v = normalizeData(value);
  v.entries.sort((a, b) => a.id.localeCompare(b.id));
  v.tombstones = Object.fromEntries(Object.entries(v.tombstones).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(v);
}

function readShareFragment() {
  const params = new URLSearchParams(location.hash.slice(1));
  const b = params.get("b");
  const k = params.get("k");
  if (!b || !k) return null;
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(b) || !/^[A-Za-z0-9_-]{40,60}$/.test(k)) return null;
  return { storageId: b, keyText: k };
}

function writeShareFragment(id, key) {
  const url = new URL(location.href);
  url.hash = new URLSearchParams({ b: id, k: key }).toString();
  history.replaceState(null, "", url);
}

async function createRemote(envelope) {
  const res = await fetch(STORE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope)
  });
  if (!res.ok) throw new Error("Create failed");
  const json = await res.json();
  if (!json.id) throw new Error("Missing blob id");
  return json.id;
}

async function readRemote() {
  const res = await fetch(`${STORE_API}/${encodeURIComponent(storageId)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" }
  });
  if (!res.ok) throw new Error("Read failed");
  const envelope = await res.json();
  return normalizeData(await decryptData(envelope));
}

async function writeRemote(nextData) {
  const envelope = await encryptData(nextData);
  const res = await fetch(`${STORE_API}/${encodeURIComponent(storageId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope)
  });
  if (!res.ok) throw new Error("Write failed");
  return res.json().catch(() => ({}));
}

async function bootStorage() {
  const shared = readShareFragment();

  if (shared) {
    storageId = shared.storageId;
    keyText = shared.keyText;
    cryptoKey = await importKey(keyText);
    data = await readRemote();
    return;
  }

  setStatus("第一次使用 · 正在建立加密帳本…");
  const generated = await makeKey();
  cryptoKey = generated.key;
  keyText = generated.text;
  data = defaultData();
  const envelope = await encryptData(data);
  storageId = await createRemote(envelope);
  writeShareFragment(storageId, keyText);
}

function setType(type) {
  entryType = type;
  $$(".type-btn").forEach((b) => b.classList.toggle("active", b.dataset.type === type));
  const categories = type === "income" ? categoriesIncome : categoriesExpense;
  $("#category").innerHTML = categories.map((c) => `<option value="${c}">${c}</option>`).join("");
}

function renderMembers() {
  $("#member").innerHTML =
    `<option value="A">${escapeHtml(data.settings.memberA)}</option>` +
    `<option value="B">${escapeHtml(data.settings.memberB)}</option>`;
  $("#memberAName").value = data.settings.memberA;
  $("#memberBName").value = data.settings.memberB;
  $("#monthlyBudget").value = data.settings.monthlyBudget || "";
}

function visibleEntries() {
  const mk = monthKey(viewMonth);
  return data.entries
    .filter((e) => e.date.startsWith(mk))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

function render() {
  if (!data) return;

  renderMonthLabel();
  renderMembers();

  const rows = visibleEntries();
  const expenses = rows.filter((e) => e.type === "expense");
  const incomes = rows.filter((e) => e.type === "income");
  const expense = expenses.reduce((s, e) => s + e.amount, 0);
  const income = incomes.reduce((s, e) => s + e.amount, 0);

  $("#expenseTotal").textContent = money(expense);
  $("#incomeTotal").textContent = money(income);
  $("#balanceTotal").textContent = money(income - expense);
  $("#entryCount").textContent = `${rows.length} 筆`;

  const budget = Number(data.settings.monthlyBudget) || 0;
  $("#budgetWrap").classList.toggle("hidden", budget <= 0);
  if (budget > 0) {
    const pct = Math.min(100, (expense / budget) * 100);
    $("#budgetBar").style.width = `${pct}%`;
    $("#budgetText").textContent =
      `${Math.round((expense / budget) * 100)}% · 尚餘 ${money(Math.max(0, budget - expense))}`;
  }

  const a = expenses.filter((e) => e.member === "A").reduce((s, e) => s + e.amount, 0);
  const b = expenses.filter((e) => e.member === "B").reduce((s, e) => s + e.amount, 0);
  const total = a + b || 1;

  $("#memberSplit").innerHTML = [
    [data.settings.memberA, a],
    [data.settings.memberB, b]
  ].map(([name, value]) =>
    `<div class="person"><span>${escapeHtml(name)} · ${Math.round((value / total) * 100)}%</span><strong>${money(value)}</strong></div>`
  ).join("");

  const byCat = {};
  expenses.forEach((e) => {
    byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  });

  const cats = Object.entries(byCat).sort((x, y) => y[1] - x[1]);
  $("#categoryBars").innerHTML = cats.length
    ? cats.slice(0, 8).map(([cat, value]) =>
        `<div class="bar-row"><b>${escapeHtml(cat)}</b><div class="bar"><i style="width:${Math.max(3, (value / (expense || 1)) * 100)}%"></i></div><span>${money(value)}</span></div>`
      ).join("")
    : '<div class="empty">這個月還沒有支出</div>';

  $("#entries").innerHTML = rows.length
    ? rows.map((e) => {
        const member = e.member === "A" ? data.settings.memberA : data.settings.memberB;
        return `<div class="entry">
          <div class="entry-main">
            <div class="entry-title">${escapeHtml(e.category)} <span class="tag">${escapeHtml(member)}</span></div>
            <div class="entry-meta">${e.date}${e.note ? " · " + escapeHtml(e.note) : ""}</div>
          </div>
          <div class="entry-side">
            <div class="entry-amount ${e.type}">${e.type === "income" ? "+" : "−"}${money(e.amount)}</div>
            <div class="entry-actions">
              <button data-edit="${e.id}">編輯</button>
              <button data-delete="${e.id}">刪除</button>
            </div>
          </div>
        </div>`;
      }).join("")
    : '<div class="empty">這個月還沒有紀錄。第一筆從上面開始。</div>';

  $$("[data-edit]").forEach((btn) => {
    btn.onclick = () => startEdit(btn.dataset.edit);
  });

  $$("[data-delete]").forEach((btn) => {
    btn.onclick = () => removeEntry(btn.dataset.delete);
  });
}

async function syncMutation(mutator) {
  if (saving) return false;
  saving = true;
  setStatus("加密同步中…");

  try {
    const remote = await readRemote();
    const next = mergeData(data, remote);
    await mutator(next);
    next.modifiedAt = nowIso();
    await writeRemote(next);
    data = next;
    render();
    setStatus("已同步 · AES‑256 加密", "ok");
    return true;
  } catch (error) {
    console.error(error);
    setStatus("同步失敗，資料未送出；請檢查網路後再試", "error");
    return false;
  } finally {
    saving = false;
  }
}

async function refreshFromRemote(silent = true) {
  if (saving || refreshing || !storageId || !cryptoKey) return;
  refreshing = true;

  try {
    const remote = await readRemote();
    const merged = mergeData(data, remote);
    const localSnap = stableSnapshot(data);
    const remoteSnap = stableSnapshot(remote);
    const mergedSnap = stableSnapshot(merged);

    if (mergedSnap !== localSnap) {
      data = merged;
      render();
      if (!silent) setStatus("已收到另一台裝置的更新", "ok");
    }

    if (mergedSnap !== remoteSnap) {
      merged.modifiedAt = nowIso();
      await writeRemote(merged);
      data = merged;
      if (!silent) setStatus("已合併兩台裝置的更新", "ok");
    }
  } catch (error) {
    if (!silent) setStatus("目前無法更新，稍後會再試", "error");
  } finally {
    refreshing = false;
  }
}

function resetForm() {
  editId = null;
  $("#amount").value = "";
  $("#note").value = "";
  $("#date").value = localDate();
  setType("expense");
  $("#saveEntry").textContent = "＋ 記一筆";
  $("#cancelEdit").classList.add("hidden");
}

async function saveEntry() {
  const amount = Number($("#amount").value);
  if (!(amount > 0)) {
    $("#amount").focus();
    return;
  }

  const draft = {
    type: entryType,
    amount,
    category: $("#category").value,
    member: $("#member").value,
    note: $("#note").value.trim(),
    date: $("#date").value || localDate()
  };

  const editing = editId;
  const success = await syncMutation((next) => {
    const stamp = nowIso();

    if (editing) {
      const index = next.entries.findIndex((e) => e.id === editing);
      if (index >= 0) {
        next.entries[index] = {
          ...next.entries[index],
          ...draft,
          updatedAt: stamp
        };
      }
    } else {
      next.entries.push({
        id: uid(),
        ...draft,
        createdAt: stamp,
        updatedAt: stamp
      });
    }
  });

  if (success) resetForm();
}

function startEdit(id) {
  const entry = data.entries.find((e) => e.id === id);
  if (!entry) return;

  editId = id;
  setType(entry.type);
  $("#amount").value = entry.amount;
  $("#member").value = entry.member;
  $("#category").value = entry.category;
  $("#date").value = entry.date;
  $("#note").value = entry.note || "";
  $("#saveEntry").textContent = "儲存修改";
  $("#cancelEdit").classList.remove("hidden");
  $(".entry-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function removeEntry(id) {
  if (!confirm("刪除這筆紀錄？")) return;

  await syncMutation((next) => {
    const stamp = nowIso();
    next.entries = next.entries.filter((e) => e.id !== id);
    next.tombstones[id] = stamp;
  });
}

async function saveSettings() {
  const memberA = $("#memberAName").value.trim() || "成員 A";
  const memberB = $("#memberBName").value.trim() || "成員 B";
  const monthlyBudget = Math.max(0, Number($("#monthlyBudget").value) || 0);

  await syncMutation((next) => {
    next.settings = { memberA, memberB, monthlyBudget };
    next.settingsUpdatedAt = nowIso();
  });
}

function exportCsv() {
  const rows = [["日期", "類型", "成員", "分類", "金額", "備註"]];

  data.entries
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((e) => {
      rows.push([
        e.date,
        e.type === "expense" ? "支出" : "收入",
        e.member === "A" ? data.settings.memberA : data.settings.memberB,
        e.category,
        e.amount,
        e.note || ""
      ]);
    });

  const csv = "\ufeff" + rows
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `couple-ledger-${localDate()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function shareBook() {
  const url = location.href;

  try {
    if (navigator.share) {
      await navigator.share({
        title: "兩個人的帳本",
        text: "我們的加密共用帳本。這個完整網址就是鑰匙，請勿轉傳。",
        url
      });
    } else {
      await navigator.clipboard.writeText(url);
      setStatus("共用帳本連結已複製", "ok");
    }
  } catch {}
}

async function init() {
  try {
    const legacyUrl = new URL(location.href);
    if (legacyUrl.searchParams.has("book")) {
      legacyUrl.searchParams.delete("book");
      history.replaceState(null, "", legacyUrl);
    }
    if (!window.crypto?.subtle) throw new Error("Web Crypto unavailable");

    await bootStorage();
    setType("expense");
    $("#date").value = localDate();
    render();
    setStatus("已同步 · AES‑256 加密共用", "ok");

    setInterval(() => {
      if (document.visibilityState === "visible") refreshFromRemote(true);
    }, 15000);
  } catch (error) {
    console.error(error);
    setStatus("無法開啟帳本。請確認共用網址完整，或稍後重新整理。", "error");
  }
}

$(".type-toggle").onclick = (event) => {
  const button = event.target.closest("[data-type]");
  if (button) setType(button.dataset.type);
};

$("#saveEntry").onclick = saveEntry;
$("#cancelEdit").onclick = resetForm;
$("#saveSettings").onclick = saveSettings;
$("#exportBtn").onclick = exportCsv;
$("#shareBtn").onclick = shareBook;

$("#prevMonth").onclick = () => {
  viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1);
  render();
};

$("#nextMonth").onclick = () => {
  viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1);
  render();
};

$("#monthLabel").onclick = () => {
  viewMonth = new Date();
  render();
};

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshFromRemote(false);
});

init();
