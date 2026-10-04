const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const categoriesExpense = ["餐飲","日用品","交通","家庭","育兒","購物","娛樂","醫療","住房","旅行","保險","其他"];
const categoriesIncome = ["薪資","獎金","投資","退款","其他收入"];

let data = null;
let etag = null;
let book = null;
let entryType = "expense";
let editId = null;
let viewMonth = new Date();
let saving = false;

function money(n) {
  return new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: "TWD",
    maximumFractionDigits: 0
  }).format(Number(n) || 0);
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function uid() {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function makeBook() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ensureBook() {
  const url = new URL(location.href);
  let key = url.searchParams.get("book");
  if (!/^[a-f0-9]{32}$/.test(key || "")) {
    key = makeBook();
    url.searchParams.set("book", key);
    history.replaceState(null, "", url);
  }
  return key;
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
    ["A", data.settings.memberA, a],
    ["B", data.settings.memberB, b]
  ].map(([, name, value]) =>
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

async function load() {
  setStatus("正在連上共用帳本…");
  const res = await fetch(`/api/ledger?book=${encodeURIComponent(book)}`, { cache: "no-store" });
  if (!res.ok) throw new Error("無法讀取帳本");

  const json = await res.json();
  data = json.data;
  etag = json.etag;

  setType("expense");
  $("#date").value = localDate();
  render();
  setStatus("已同步 · 夫妻共用雲端帳本", "ok");
}

async function persist(nextData = data) {
  if (saving) return false;

  saving = true;
  setStatus("同步中…");

  try {
    const res = await fetch("/api/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ book, data: nextData, etag })
    });

    const json = await res.json();

    if (res.status === 409) {
      data = json.data || data;
      etag = json.etag || etag;
      render();
      setStatus("另一台裝置剛更新過，已載入最新資料；請再操作一次", "error");
      return false;
    }

    if (!res.ok) throw new Error(json.error || "同步失敗");

    data = json.data;
    etag = json.etag;
    render();
    setStatus("已同步", "ok");
    return true;
  } catch {
    setStatus("同步失敗，請檢查網路後再試", "error");
    return false;
  } finally {
    saving = false;
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

  const now = new Date().toISOString();
  const next = structuredClone(data);

  if (editId) {
    const index = next.entries.findIndex((e) => e.id === editId);
    if (index >= 0) {
      next.entries[index] = {
        ...next.entries[index],
        type: entryType,
        amount,
        category: $("#category").value,
        member: $("#member").value,
        note: $("#note").value.trim(),
        date: $("#date").value || localDate(),
        updatedAt: now
      };
    }
  } else {
    next.entries.push({
      id: uid(),
      type: entryType,
      amount,
      category: $("#category").value,
      member: $("#member").value,
      note: $("#note").value.trim(),
      date: $("#date").value || localDate(),
      createdAt: now,
      updatedAt: now
    });
  }

  if (await persist(next)) resetForm();
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

  const next = structuredClone(data);
  next.entries = next.entries.filter((e) => e.id !== id);
  await persist(next);
}

async function saveSettings() {
  const next = structuredClone(data);
  next.settings.memberA = $("#memberAName").value.trim() || "成員 A";
  next.settings.memberB = $("#memberBName").value.trim() || "成員 B";
  next.settings.monthlyBudget = Math.max(0, Number($("#monthlyBudget").value) || 0);
  await persist(next);
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
      await navigator.share({ title: "兩個人的帳本", text: "我們的共用帳本", url });
    } else {
      await navigator.clipboard.writeText(url);
      setStatus("共用連結已複製", "ok");
    }
  } catch {}
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

book = ensureBook();
load().catch(() => setStatus("帳本暫時連不上，重新整理再試", "error"));
