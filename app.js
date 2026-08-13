import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  increment,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const USERS = [
  { id: "acacia", name: "Acacia" },
  { id: "david", name: "David" },
];

// Fixed ID for the default bucket so two devices on first launch can both
// "ensure" it without racing. Renameable; not archivable.
const DEFAULT_BUCKET_ID = "month-money";

const CATEGORIES = [
  "Kitchen",
  "Bathroom",
  "Laundry",
  "Living areas",
  "Bedroom",
  "Outside",
  "Self-care",
  "Other",
];

const state = {
  activeUser: localStorage.getItem("activeUser") || "acacia",
  activeBucket: localStorage.getItem("activeBucket") || DEFAULT_BUCKET_ID,
  buckets: [],
  chores: [],
  history: [],
  monthHistory: [],
  monthlySummaries: [],
  tombstones: [],
  balances: {},
  itemCounts: {},
  search: "",
  defaultBucketEnsured: false,
};

// Aggregated balances live in the `balances` collection, one doc per
// user+bucket, updated atomically alongside every history write. This keeps
// balances correct even though the history listener is capped at limit(200)
// for display — summing the truncated history would silently drop old
// deposits once total activity passed 200 entries.
const balanceDocId = (userId, bucketId) => `${userId}__${bucketId}`;

const ITEM_GOAL = 20;
const itemCounterDocId = (userId) => `items-${userId}`;

// Finalized per-user monthly totals live in `monthlySummaries`, one doc per
// user+month, written only once a month has fully ended (so the "This month"
// tile stays the sole source for the current month). Fixed doc IDs make the
// lazy backfill idempotent when two devices race to finalize the same month.
const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const summaryDocId = (userId, key) => `${userId}__${key}`;

if (!USERS.find((u) => u.id === state.activeUser)) {
  state.activeUser = "acacia";
}

// ---------- DOM refs ----------
const $balance = document.getElementById("balance");
const $balanceLabel = document.getElementById("balance-label");
const $userBtns = document.querySelectorAll(".user-btn");
const $bucketList = document.getElementById("bucket-list");
const $monthBtn = document.getElementById("month-btn");
const $holidayBtn = document.getElementById("holiday-btn");
const $customBtn = document.getElementById("custom-btn");
const $spendForm = document.getElementById("spend-form");
const $spendInput = document.getElementById("spend-input");
const $search = document.getElementById("chore-search");
const $choreList = document.getElementById("chore-list");
const $historyList = document.getElementById("history-list");
const $choreForm = document.getElementById("chore-form");
const $newChoreName = document.getElementById("new-chore-name");
const $newChoreAmount = document.getElementById("new-chore-amount");
const $manageList = document.getElementById("manage-list");
const $bucketForm = document.getElementById("bucket-form");
const $newBucketName = document.getElementById("new-bucket-name");
const $manageBuckets = document.getElementById("manage-buckets");
const $status = document.getElementById("status");
const $holidayList = document.getElementById("holiday-list");
const $monthlySummary = document.getElementById("monthly-summary");
const $transferBtn = document.getElementById("transfer-btn");
const $transferModal = document.getElementById("transfer-modal");
const $transferForm = document.getElementById("transfer-form");
const $transferFrom = document.getElementById("transfer-from");
const $transferTo = document.getElementById("transfer-to");
const $transferAmount = document.getElementById("transfer-amount");
const $transferCancel = document.getElementById("transfer-cancel");
const $itemCounterBtn = document.getElementById("item-counter-btn");
const $itemCounterCount = document.getElementById("item-counter-count");
const $itemsPlus5Btn = document.getElementById("items-plus5-btn");
const $itemsRemainingBtn = document.getElementById("items-remaining-btn");
const $monthlyHistory = document.getElementById("monthly-history");
const $customModal = document.getElementById("custom-modal");
const $customBody = document.getElementById("custom-body");
const $customPicker = document.getElementById("custom-picker");
const $customCancel = document.getElementById("custom-cancel");
const $customDisplay = document.getElementById("custom-display");

// ---------- Helpers ----------
const fmt = (n) => {
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toFixed(2);
};

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );

let statusTimer = null;
function toast(msg, kind = "info") {
  $status.textContent = msg;
  $status.dataset.kind = kind;
  $status.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    $status.hidden = true;
  }, 2200);
}

function userName(id) {
  return USERS.find((u) => u.id === id)?.name ?? id;
}

function bucketName(id) {
  return state.buckets.find((b) => b.id === id)?.name ?? "Unknown bucket";
}

function isVisibleToUser(bucket, userId) {
  if (bucket.archived) return false;
  // The default jar is shown to both users (each has their own balance in it).
  // Every other bucket belongs to exactly one user.
  if (bucket.id === DEFAULT_BUCKET_ID) return true;
  return bucket.owner === userId;
}

function activeBuckets(userId = state.activeUser) {
  return state.buckets
    .filter((b) => isVisibleToUser(b, userId))
    .sort((a, b) => {
      if (a.id === DEFAULT_BUCKET_ID) return -1;
      if (b.id === DEFAULT_BUCKET_ID) return 1;
      return a.name.localeCompare(b.name);
    });
}

function ensureActiveBucketValid() {
  const active = state.buckets.find(
    (b) => b.id === state.activeBucket && isVisibleToUser(b, state.activeUser),
  );
  if (active) return;
  const fallback =
    state.buckets.find(
      (b) =>
        b.id === DEFAULT_BUCKET_ID && isVisibleToUser(b, state.activeUser),
    ) || activeBuckets()[0];
  if (fallback && fallback.id !== state.activeBucket) {
    state.activeBucket = fallback.id;
    localStorage.setItem("activeBucket", state.activeBucket);
  }
}

function isThisMonth(date) {
  if (!date) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth()
  );
}

function timeAgo(date) {
  if (!date) return "";
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  const days = Math.floor(diff / 86400);
  if (days < 7) return days + "d ago";
  return date.toLocaleDateString();
}

function labelFor(entry) {
  if (entry.type === "chore") return entry.choreName || "Chore";
  if (entry.type === "spend") return "Spend";
  if (entry.type === "holiday") return entry.holidayName || "Holiday";
  if (entry.type === "monthly") return "Month start";
  if (entry.type === "starting") return "Starting balance";
  if (entry.type === "custom") return "Custom";
  if (entry.type === "quick") return "Quick add";
  if (entry.type === "items") return "20 items put away";
  if (entry.type === "transfer") {
    const other = entry.otherBucketId ? bucketName(entry.otherBucketId) : "bucket";
    return entry.amount < 0 ? `Transfer to ${other}` : `Transfer from ${other}`;
  }
  return entry.type;
}

// ---------- Bucket bootstrap ----------
async function ensureDefaultBucket() {
  if (state.defaultBucketEnsured) return;
  state.defaultBucketEnsured = true;
  try {
    // merge:true so racing devices don't clobber a user's rename.
    await setDoc(
      doc(db, "buckets", DEFAULT_BUCKET_ID),
      {
        name: "Month Money",
        archived: false,
        isDefault: true,
      },
      { merge: true },
    );
  } catch (err) {
    console.error(err);
    state.defaultBucketEnsured = false;
  }
}

// ---------- Balance computation ----------
function balanceFor(userId, bucketId) {
  return Number(state.balances[balanceDocId(userId, bucketId)]) || 0;
}

function computeReversals(history) {
  const reversedIds = new Set();
  const reverserIds = new Set();
  for (const h of history) {
    if (h.reversesId) {
      reversedIds.add(h.reversesId);
      reverserIds.add(h.id);
    }
  }
  return { reversedIds, reverserIds };
}

// ---------- Render ----------
function render() {
  ensureActiveBucketValid();

  $userBtns.forEach((btn) => {
    const isActive = btn.dataset.user === state.activeUser;
    btn.setAttribute("aria-selected", String(isActive));
  });

  const bal = balanceFor(state.activeUser, state.activeBucket);
  $balance.textContent = fmt(bal);
  $balance.classList.toggle("negative", bal < 0);
  $balanceLabel.textContent = bucketName(state.activeBucket);

  renderBuckets();
  renderItemCounter();
  renderChores();
  renderHistory();
  renderManage();
  renderManageBuckets();
  renderMonthlySummary();
  renderMonthlyHistory();
}

// Per-user summary of the current calendar month. Earned/spent come from the
// month-scoped history listener (transfers between buckets are internal, so
// excluded); "spent on" lists the buckets the active user closed out —
// archived or deleted — this month, with how much had accumulated in each.
// The isThisMonth guard keeps totals correct if the app stays open across a
// month boundary (the query's lower bound is fixed at attach time).
function renderMonthlySummary() {
  const userId = state.activeUser;
  let earned = 0;
  let spent = 0;
  for (const h of state.monthHistory) {
    if (h.userId !== userId || h.type === "transfer") continue;
    const when = h.createdAt?.toDate ? h.createdAt.toDate() : null;
    if (!isThisMonth(when)) continue;
    const amt = Number(h.amount) || 0;
    if (h.type === "spend") spent += -amt;
    else earned += amt;
  }

  const spentOn = [];
  for (const b of state.buckets) {
    if (!b.archived || (b.owner && b.owner !== userId)) continue;
    const when = b.archivedAt?.toDate ? b.archivedAt.toDate() : null;
    if (!isThisMonth(when)) continue;
    spentOn.push({
      name: b.name,
      amount: balanceFor(userId, b.id),
      status: "Archived",
    });
  }
  for (const t of state.tombstones) {
    if (t.owner && t.owner !== userId) continue;
    const when = t.deletedAt?.toDate ? t.deletedAt.toDate() : null;
    if (!isThisMonth(when)) continue;
    spentOn.push({
      name: t.name || "Deleted bucket",
      amount: Number(t.balances?.[userId]) || 0,
      status: "Deleted",
    });
  }
  spentOn.sort((a, b) => a.name.localeCompare(b.name));

  const monthLabel = new Date().toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const earnedStr = (earned >= 0 ? "+" : "") + fmt(earned);
  const spentStr = spent > 0 ? "-" + fmt(spent) : fmt(spent);

  const spentOnHtml = spentOn.length
    ? spentOn
        .map(
          (s) => `
        <li class="summary-bucket-row">
          <span class="summary-bucket-name">${esc(s.name)}<span class="summary-bucket-status">${esc(
            s.status,
          )}</span></span>
          <span class="summary-bucket-amount">${fmt(s.amount)}</span>
        </li>`,
        )
        .join("")
    : `<li class="summary-empty">No buckets closed out this month.</li>`;

  $monthlySummary.innerHTML = `
    <p class="summary-month">${esc(monthLabel)}</p>
    <div class="summary-totals">
      <div class="summary-stat">
        <span class="summary-stat-label">Earned</span>
        <span class="summary-stat-value positive">${earnedStr}</span>
      </div>
      <div class="summary-stat">
        <span class="summary-stat-label">Spent</span>
        <span class="summary-stat-value negative">${spentStr}</span>
      </div>
    </div>
    <h4 class="summary-heading">Spent on</h4>
    <ul class="summary-bucket-list">${spentOnHtml}</ul>`;
}

// Past-year totals for the active user, one row per completed month, newest
// first. The current month never appears here — see finalizeMonthlySummaries.
function renderMonthlyHistory() {
  const userId = state.activeUser;
  const rows = state.monthlySummaries
    .filter((s) => s.userId === userId)
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, 12);

  if (rows.length === 0) {
    $monthlyHistory.innerHTML = `<p class="summary-empty">No completed months yet — totals show up here once a month ends.</p>`;
    return;
  }

  const rowsHtml = rows
    .map((r) => {
      const [y, m] = r.month.split("-").map(Number);
      const label = new Date(y, m - 1, 1).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
      const earned = Number(r.earned) || 0;
      const spent = Number(r.spent) || 0;
      const earnedStr = (earned >= 0 ? "+" : "") + fmt(earned);
      const spentStr = spent > 0 ? "-" + fmt(spent) : fmt(spent);
      return `
        <li class="month-history-row">
          <span class="month-history-name">${esc(label)}</span>
          <span class="month-history-amount positive">${earnedStr}</span>
          <span class="month-history-amount negative">${spentStr}</span>
        </li>`;
    })
    .join("");

  $monthlyHistory.innerHTML = `
    <ul class="month-history-list">
      <li class="month-history-row head" aria-hidden="true">
        <span class="month-history-name"></span>
        <span class="month-history-amount">Earned</span>
        <span class="month-history-amount">Spent</span>
      </li>
      ${rowsHtml}
    </ul>`;
}

// Lazily backfill `monthlySummaries` for any completed month in the past year
// that doesn't have docs yet (normally just last month, right after rollover).
// Runs once per app load, after the first summaries snapshot arrives so we
// know what's missing. Totals mirror renderMonthlySummary: transfers are
// internal moves so they're excluded, spends count positive toward "spent".
let summariesFinalized = false;
async function finalizeMonthlySummaries() {
  if (summariesFinalized) return;
  summariesFinalized = true;

  const now = new Date();
  const currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearAgoStart = new Date(now.getFullYear() - 1, now.getMonth(), 1);

  // The 12 completed months, oldest first.
  const keys = [];
  for (let i = 12; i >= 1; i--) {
    keys.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }

  const existing = new Set(state.monthlySummaries.map((s) => s.id));
  const anyMissing = keys.some((k) =>
    USERS.some((u) => !existing.has(summaryDocId(u.id, k))),
  );
  if (!anyMissing) return;

  try {
    const snap = await getDocs(
      query(
        collection(db, "history"),
        where("createdAt", ">=", yearAgoStart),
        where("createdAt", "<", currentStart),
      ),
    );

    const totals = new Map(); // summaryDocId -> { earned, spent }
    let firstActivityKey = null;
    for (const d of snap.docs) {
      const h = d.data();
      if (h.type === "transfer" || !h.userId) continue;
      const when = h.createdAt?.toDate ? h.createdAt.toDate() : null;
      if (!when) continue;
      const key = monthKey(when);
      if (!firstActivityKey || key < firstActivityKey) firstActivityKey = key;
      const id = summaryDocId(h.userId, key);
      const t = totals.get(id) || { earned: 0, spent: 0 };
      const amt = Number(h.amount) || 0;
      if (h.type === "spend") t.spent += -amt;
      else t.earned += amt;
      totals.set(id, t);
    }

    // Nothing before this month yet — no months to close out, and skipping
    // months before the first activity keeps pre-app months from showing as
    // empty $0 rows.
    if (!firstActivityKey) return;

    const batch = writeBatch(db);
    let writes = 0;
    for (const key of keys) {
      if (key < firstActivityKey) continue;
      for (const u of USERS) {
        const id = summaryDocId(u.id, key);
        if (existing.has(id)) continue;
        const t = totals.get(id) || { earned: 0, spent: 0 };
        batch.set(doc(db, "monthlySummaries", id), {
          userId: u.id,
          month: key,
          earned: t.earned,
          spent: t.spent,
        });
        writes++;
      }
    }
    if (writes > 0) await batch.commit();
  } catch (err) {
    console.error(err);
    summariesFinalized = false; // let a later snapshot retry
  }
}

function renderItemCounter() {
  const count = Number(state.itemCounts[state.activeUser]) || 0;
  const clamped = Math.max(0, Math.min(ITEM_GOAL - 1, count));
  $itemCounterCount.textContent = `${clamped}/${ITEM_GOAL}`;
  $itemCounterBtn.classList.toggle("ready", clamped === ITEM_GOAL - 1);
}

function renderBuckets() {
  const buckets = activeBuckets();
  if (buckets.length === 0) {
    $bucketList.innerHTML = "";
    return;
  }
  $bucketList.innerHTML = buckets
    .map((b) => {
      const isActive = b.id === state.activeBucket;
      const bal = balanceFor(state.activeUser, b.id);
      // The default jar never carries a goal.
      const goal = b.id === DEFAULT_BUCKET_ID ? 0 : Number(b.goal) || 0;
      const hasGoal = goal > 0;
      const pct = hasGoal
        ? Math.max(0, Math.min(100, (bal / goal) * 100))
        : 0;
      const amountHtml = hasGoal
        ? `<span class="bucket-amount">${fmt(bal)}<span class="bucket-goal"> / ${fmt(goal)}</span></span>`
        : `<span class="bucket-amount">${fmt(bal)}</span>`;
      return `
        <li class="bucket-card ${isActive ? "active" : ""} ${
          bal < 0 ? "neg" : ""
        }" data-action="pick-bucket" data-id="${esc(b.id)}" style="--progress: ${pct}%">
          <span class="bucket-name">${esc(b.name)}</span>
          ${amountHtml}
        </li>`;
    })
    .join("");
}

function categoryRank(cat) {
  const i = CATEGORIES.indexOf(cat);
  return i === -1 ? CATEGORIES.length : i;
}

function renderChores() {
  const q = state.search.trim().toLowerCase();
  const visible = state.chores
    .filter((c) => !c.archived)
    .filter((c) => !q || c.name.toLowerCase().includes(q));

  if (visible.length === 0) {
    $choreList.innerHTML = `<li class="chore-empty">${
      state.chores.length === 0
        ? "No chores yet — add some in Manage chores below."
        : "No chores match."
    }</li>`;
    return;
  }

  const groups = new Map();
  for (const c of visible) {
    const cat = c.category || "Other";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(c);
  }
  const cats = [...groups.keys()].sort((a, b) => {
    const diff = categoryRank(a) - categoryRank(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  let html = "";
  for (const cat of cats) {
    html += `<li class="chore-cat-header">${esc(cat)}</li>`;
    const chores = groups.get(cat).sort((a, b) => a.name.localeCompare(b.name));
    for (const c of chores) {
      html += `
        <li class="chore-row" data-id="${esc(c.id)}">
          <span class="chore-name">${esc(c.name)}</span>
          <span class="chore-amount">${fmt(Number(c.amount) || 0)}</span>
          <button class="chore-add-btn" data-action="add-chore" data-id="${esc(
            c.id,
          )}" aria-label="Add ${esc(c.name)}">+</button>
        </li>`;
    }
  }
  $choreList.innerHTML = html;
}

function renderHistory() {
  const mine = state.history.filter((h) => h.userId === state.activeUser);
  const { reversedIds, reverserIds } = computeReversals(state.history);

  if (mine.length === 0) {
    $historyList.innerHTML = `<li class="history-empty">No activity yet.</li>`;
    return;
  }

  $historyList.innerHTML = mine
    .slice(0, 10)
    .map((h) => {
      const isReversed = reversedIds.has(h.id);
      const isReverser = reverserIds.has(h.id);
      const cls = [
        "history-row",
        isReversed ? "reversed" : "",
        isReverser ? "reverses" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const amt = Number(h.amount) || 0;
      const amtCls = amt >= 0 ? "positive" : "negative";
      const showUndo = !isReversed && !isReverser;
      const when = h.createdAt?.toDate ? timeAgo(h.createdAt.toDate()) : "";
      const meta = [bucketName(h.bucketId || DEFAULT_BUCKET_ID), when]
        .filter(Boolean)
        .join(" · ");
      return `
        <li class="${cls}" data-id="${esc(h.id)}">
          <span class="history-label">${esc(labelFor(h))}${
            meta ? `<span class="history-meta">${esc(meta)}</span>` : ""
          }</span>
          <span class="history-amount ${amtCls}">${
            amt >= 0 ? "+" : ""
          }${fmt(amt)}</span>
          ${
            showUndo
              ? `<button class="undo-btn" data-action="undo" data-id="${esc(
                  h.id,
                )}">Undo</button>`
              : `<span></span>`
          }
        </li>`;
    })
    .join("");
}

function renderManage() {
  const sorted = [...state.chores].sort((a, b) => {
    if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
    const rd = categoryRank(a.category || "Other") - categoryRank(b.category || "Other");
    if (rd !== 0) return rd;
    return a.name.localeCompare(b.name);
  });

  if (sorted.length === 0) {
    $manageList.innerHTML = "";
    return;
  }

  const catOptions = CATEGORIES.map(
    (c) => `<option value="${esc(c)}">${esc(c)}</option>`,
  ).join("");

  $manageList.innerHTML = sorted
    .map((c) => {
      const cat = c.category || "Other";
      const selectOptions = CATEGORIES.map(
        (opt) =>
          `<option value="${esc(opt)}" ${opt === cat ? "selected" : ""}>${esc(opt)}</option>`,
      ).join("");
      return `
        <li class="manage-row chore ${c.archived ? "archived" : ""}" data-id="${esc(
          c.id,
        )}">
          <input type="text" data-field="name" value="${esc(c.name)}" aria-label="Name" />
          <input type="number" min="0" step="0.01" inputmode="decimal" data-field="amount" value="${
            Number(c.amount) || 0
          }" aria-label="Amount" />
          <select data-field="category" aria-label="Category">${selectOptions}</select>
          <button class="archive-btn" data-action="toggle-archive" data-id="${esc(
            c.id,
          )}">${c.archived ? "Restore" : "Archive"}</button>
        </li>`;
    })
    .join("");
}

function ownerLabel(owner) {
  if (!owner) return "Unassigned";
  return userName(owner);
}

function renderManageBuckets() {
  // The default jar plus buckets owned by the active user. (Any legacy
  // ownerless bucket also shows so it can be assigned an owner.) Unlike the
  // main list we keep archived buckets so they can be restored or deleted.
  const sorted = state.buckets
    .filter(
      (b) =>
        b.id === DEFAULT_BUCKET_ID ||
        !b.owner ||
        b.owner === state.activeUser,
    )
    .sort((a, b) => {
      if (a.id === DEFAULT_BUCKET_ID) return -1;
      if (b.id === DEFAULT_BUCKET_ID) return 1;
      if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

  if (sorted.length === 0) {
    $manageBuckets.innerHTML = "";
    return;
  }

  $manageBuckets.innerHTML = sorted
    .map((b) => {
      const isDefault = b.id === DEFAULT_BUCKET_ID;
      const archiveLabel = isDefault
        ? "Default"
        : b.archived
          ? "Restore"
          : "Archive";
      const ownerBtn = isDefault
        ? ""
        : `<button class="owner-btn" data-action="cycle-owner" data-id="${esc(
            b.id,
          )}">${esc(ownerLabel(b.owner))}</button>`;
      const goalVal = Number(b.goal) > 0 ? Number(b.goal) : "";
      // The default jar can't be renamed or given a goal.
      const nameField = isDefault
        ? `<span class="bucket-name-fixed" data-field="name">${esc(b.name)}</span>`
        : `<input type="text" data-field="name" value="${esc(b.name)}" aria-label="Bucket name" />`;
      const goalField = isDefault
        ? `<span class="bucket-goal-fixed"></span>`
        : `<input class="bucket-goal-input" type="number" min="0" step="0.01" inputmode="decimal" data-field="goal" value="${goalVal}" placeholder="Goal $" aria-label="Goal amount" />`;
      return `
        <li class="manage-row bucket ${
          b.archived ? "archived" : ""
        }" data-id="${esc(b.id)}">
          ${nameField}
          ${goalField}
          ${ownerBtn}
          <button class="archive-btn" data-action="toggle-bucket-archive" data-id="${esc(
            b.id,
          )}" ${isDefault ? "disabled" : ""}>${archiveLabel}</button>
          ${
            isDefault
              ? ""
              : `<button class="delete-btn" data-action="delete-bucket" data-id="${esc(
                  b.id,
                )}" aria-label="Delete ${esc(b.name)}">Delete</button>`
          }
        </li>`;
    })
    .join("");
}

// ---------- Actions ----------
// Adds a history doc and the matching balance increment to a batch, so the
// append-only ledger and the aggregated balance always move together. Returns
// the new history doc ref.
function writeHistoryToBatch(batch, entry) {
  const bucketId = entry.bucketId || state.activeBucket;
  const amount = Number(entry.amount) || 0;
  const ref = doc(collection(db, "history"));
  batch.set(ref, {
    ...entry,
    bucketId,
    amount,
    createdAt: serverTimestamp(),
  });
  batch.set(
    doc(db, "balances", balanceDocId(entry.userId, bucketId)),
    { userId: entry.userId, bucketId, balance: increment(amount) },
    { merge: true },
  );
  return ref;
}

async function addHistory(entry) {
  try {
    const batch = writeBatch(db);
    writeHistoryToBatch(batch, entry);
    await batch.commit();
  } catch (err) {
    console.error(err);
    toast("Couldn't save — check connection", "error");
  }
}

async function tapChore(choreId) {
  const chore = state.chores.find((c) => c.id === choreId);
  if (!chore) return;
  await addHistory({
    userId: state.activeUser,
    type: "chore",
    amount: Number(chore.amount) || 0,
    choreId: chore.id,
    choreName: chore.name,
  });
  toast(`${chore.name} +${fmt(Number(chore.amount) || 0)} → ${bucketName(state.activeBucket)}`);
}

async function tapHoliday() {
  await addHistory({
    userId: state.activeUser,
    type: "holiday",
    amount: 10,
  });
  toast(`Holiday +$10 → ${bucketName(state.activeBucket)}`);
}

async function tapMonth() {
  await addHistory({
    userId: state.activeUser,
    type: "monthly",
    amount: 25,
  });
  toast(`Month start +$25 → ${bucketName(state.activeBucket)}`);
}

// Add n items to the active user's counter. Every full lap of ITEM_GOAL pays
// $1 and the leftover carries into the next lap (18 + 5 → $1 and 3/20).
async function addItems(n) {
  const userId = state.activeUser;
  const current = Number(state.itemCounts[userId]) || 0;
  const total = current + n;
  const awards = Math.floor(total / ITEM_GOAL);
  const nextCount = total % ITEM_GOAL;
  try {
    await setDoc(
      doc(db, "counters", itemCounterDocId(userId)),
      { count: nextCount },
      { merge: true },
    );
  } catch (err) {
    console.error(err);
    toast("Couldn't save count", "error");
    return;
  }
  if (awards > 0) {
    await addHistory({
      userId,
      type: "items",
      amount: awards,
    });
    toast(`${ITEM_GOAL} items put away — +${fmt(awards)} → ${bucketName(state.activeBucket)}`);
  } else if (n > 1) {
    toast(`+${n} items (${nextCount}/${ITEM_GOAL})`);
  }
}

function tapItemCounter() {
  return addItems(1);
}

async function tapQuick(amount) {
  if (!isFinite(amount) || amount <= 0) return;
  await addHistory({
    userId: state.activeUser,
    type: "quick",
    amount,
  });
  toast(`+${fmt(amount)} → ${bucketName(state.activeBucket)}`);
}

// Digits typed into the custom keypad (no leading zeros). Max 4 digits keeps
// amounts sane.
let customDigits = "";

function renderCustomDisplay() {
  const amount = parseInt(customDigits, 10) || 0;
  $customDisplay.textContent = `$${amount}`;
}

function openCustomModal() {
  $customBody.textContent = `Add to ${bucketName(state.activeBucket)} for ${userName(
    state.activeUser,
  )}:`;
  customDigits = "";
  renderCustomDisplay();
  $customModal.hidden = false;
}

function closeCustomModal() {
  $customModal.hidden = true;
}

function pressCustomKey(key) {
  if (key === "enter") {
    applyCustom(parseInt(customDigits, 10) || 0);
    return;
  }
  if (key === "back") {
    customDigits = customDigits.slice(0, -1);
    renderCustomDisplay();
    return;
  }
  // A digit: ignore a leading zero, cap length.
  if (customDigits === "" && key === "0") return;
  if (customDigits.length >= 4) return;
  customDigits += key;
  renderCustomDisplay();
}

async function applyCustom(amount) {
  if (!isFinite(amount) || amount <= 0) {
    toast("Enter an amount above 0", "error");
    return;
  }
  closeCustomModal();
  await addHistory({
    userId: state.activeUser,
    type: "custom",
    amount,
  });
  toast(`Custom +${fmt(amount)} → ${bucketName(state.activeBucket)}`);
}

async function submitSpend(e) {
  e.preventDefault();
  const raw = parseFloat($spendInput.value);
  if (!isFinite(raw) || raw <= 0) {
    toast("Enter an amount above 0", "error");
    return;
  }
  await addHistory({
    userId: state.activeUser,
    type: "spend",
    amount: -Math.abs(raw),
  });
  $spendInput.value = "";
  toast(`Spent ${fmt(raw)} from ${bucketName(state.activeBucket)}`);
}

async function undo(historyId) {
  const original = state.history.find((h) => h.id === historyId);
  if (!original) return;

  if (original.transferId) {
    const paired = state.history.find(
      (h) =>
        h.transferId === original.transferId &&
        h.id !== original.id &&
        !h.reversesId,
    );
    try {
      const batch = writeBatch(db);
      writeHistoryToBatch(batch, {
        userId: original.userId,
        type: "transfer",
        amount: -(Number(original.amount) || 0),
        bucketId: original.bucketId || DEFAULT_BUCKET_ID,
        otherBucketId: original.otherBucketId ?? null,
        transferId: original.transferId,
        reversesId: original.id,
      });
      if (paired) {
        writeHistoryToBatch(batch, {
          userId: paired.userId,
          type: "transfer",
          amount: -(Number(paired.amount) || 0),
          bucketId: paired.bucketId || DEFAULT_BUCKET_ID,
          otherBucketId: paired.otherBucketId ?? null,
          transferId: paired.transferId,
          reversesId: paired.id,
        });
      }
      await batch.commit();
      toast("Transfer undone");
    } catch (err) {
      console.error(err);
      toast("Couldn't undo transfer", "error");
    }
    return;
  }

  await addHistory({
    userId: original.userId,
    type: original.type,
    amount: -(Number(original.amount) || 0),
    bucketId: original.bucketId || DEFAULT_BUCKET_ID,
    choreId: original.choreId ?? null,
    choreName: original.choreName ?? null,
    reversesId: original.id,
  });
  toast("Undone");
}

// ---------- Chore CRUD ----------
async function submitNewChore(e) {
  e.preventDefault();
  const name = $newChoreName.value.trim();
  const amount = parseFloat($newChoreAmount.value);
  if (!name || !isFinite(amount)) {
    toast("Need a name and amount", "error");
    return;
  }
  try {
    await addDoc(collection(db, "chores"), {
      name,
      amount,
      archived: false,
    });
    $newChoreName.value = "";
    $newChoreAmount.value = "";
    toast("Chore added");
  } catch (err) {
    console.error(err);
    toast("Couldn't add chore", "error");
  }
}

async function updateChoreField(choreId, field, value) {
  const chore = state.chores.find((c) => c.id === choreId);
  if (!chore) return;
  const patch = {};
  if (field === "name") {
    const name = String(value).trim();
    if (!name || name === chore.name) return;
    patch.name = name;
  } else if (field === "amount") {
    const amount = parseFloat(value);
    if (!isFinite(amount) || amount === Number(chore.amount)) return;
    patch.amount = amount;
  } else if (field === "category") {
    const category = String(value);
    if (category === (chore.category || "Other")) return;
    patch.category = category;
  } else return;
  try {
    await updateDoc(doc(db, "chores", choreId), patch);
  } catch (err) {
    console.error(err);
    toast("Couldn't update chore", "error");
  }
}

async function toggleArchive(choreId) {
  const chore = state.chores.find((c) => c.id === choreId);
  if (!chore) return;
  try {
    await updateDoc(doc(db, "chores", choreId), {
      archived: !chore.archived,
    });
  } catch (err) {
    console.error(err);
    toast("Couldn't update chore", "error");
  }
}

// ---------- Bucket CRUD ----------
async function submitNewBucket(e) {
  e.preventDefault();
  const name = $newBucketName.value.trim();
  if (!name) {
    toast("Need a name", "error");
    return;
  }
  try {
    await addDoc(collection(db, "buckets"), {
      name,
      archived: false,
      owner: state.activeUser,
    });
    $newBucketName.value = "";
    toast(`Bucket added for ${userName(state.activeUser)}`);
  } catch (err) {
    console.error(err);
    toast("Couldn't add bucket", "error");
  }
}

async function renameBucket(bucketId, value) {
  if (bucketId === DEFAULT_BUCKET_ID) return; // default jar can't be renamed
  const bucket = state.buckets.find((b) => b.id === bucketId);
  if (!bucket) return;
  const name = String(value).trim();
  if (!name || name === bucket.name) return;
  try {
    await updateDoc(doc(db, "buckets", bucketId), { name });
  } catch (err) {
    console.error(err);
    toast("Couldn't rename bucket", "error");
  }
}

async function updateBucketGoal(bucketId, value) {
  if (bucketId === DEFAULT_BUCKET_ID) return; // default jar has no goal
  const bucket = state.buckets.find((b) => b.id === bucketId);
  if (!bucket) return;
  const raw = String(value).trim();
  const currentGoal = Number(bucket.goal) || 0;
  let nextGoal;
  if (raw === "") {
    nextGoal = 0;
  } else {
    const parsed = parseFloat(raw);
    if (!isFinite(parsed) || parsed < 0) {
      toast("Goal must be 0 or more", "error");
      return;
    }
    nextGoal = parsed;
  }
  if (nextGoal === currentGoal) return;
  try {
    await updateDoc(doc(db, "buckets", bucketId), {
      goal: nextGoal > 0 ? nextGoal : null,
    });
  } catch (err) {
    console.error(err);
    toast("Couldn't update goal", "error");
  }
}

async function toggleBucketArchive(bucketId) {
  if (bucketId === DEFAULT_BUCKET_ID) return;
  const bucket = state.buckets.find((b) => b.id === bucketId);
  if (!bucket) return;
  const archiving = !bucket.archived;
  try {
    await updateDoc(doc(db, "buckets", bucketId), {
      archived: archiving,
      // Stamp when it was archived so the monthly summary can show buckets
      // closed out this month; clear it on restore.
      archivedAt: archiving ? serverTimestamp() : null,
    });
  } catch (err) {
    console.error(err);
    toast("Couldn't update bucket", "error");
  }
}

async function deleteBucket(bucketId) {
  if (bucketId === DEFAULT_BUCKET_ID) return;
  const bucket = state.buckets.find((b) => b.id === bucketId);
  if (!bucket) return;
  if (
    !window.confirm(
      `Delete "${bucket.name}"? Its balances and past activity can't be recovered.`,
    )
  ) {
    return;
  }
  try {
    // Deleting the bucket doc loses its name and balances, so leave a
    // tombstone first — the monthly summary reads it to show what was closed
    // out. (Balances/history are append-only per the rules, so this is how we
    // keep a record.)
    const balances = {};
    for (const u of USERS) balances[u.id] = balanceFor(u.id, bucketId);
    await addDoc(collection(db, "bucketTombstones"), {
      name: bucket.name,
      owner: bucket.owner ?? null,
      balances,
      deletedAt: serverTimestamp(),
    });
    await deleteDoc(doc(db, "buckets", bucketId));
    if (state.activeBucket === bucketId) {
      state.activeBucket = DEFAULT_BUCKET_ID;
      localStorage.setItem("activeBucket", state.activeBucket);
    }
    toast(`Deleted ${bucket.name}`);
  } catch (err) {
    console.error(err);
    toast("Couldn't delete bucket", "error");
  }
}

// Buckets are always individual now — the toggle just moves a bucket between
// the two users (a legacy ownerless bucket resolves to the first user).
const OWNER_CYCLE = ["acacia", "david"];
async function cycleBucketOwner(bucketId) {
  if (bucketId === DEFAULT_BUCKET_ID) return;
  const bucket = state.buckets.find((b) => b.id === bucketId);
  if (!bucket) return;
  const idx = OWNER_CYCLE.indexOf(bucket.owner);
  const next = OWNER_CYCLE[(idx + 1) % OWNER_CYCLE.length];
  try {
    await updateDoc(doc(db, "buckets", bucketId), {
      owner: next,
    });
  } catch (err) {
    console.error(err);
    toast("Couldn't update bucket", "error");
  }
}

function pickBucket(bucketId) {
  if (state.activeBucket === bucketId) return;
  state.activeBucket = bucketId;
  localStorage.setItem("activeBucket", bucketId);
  render();
}

// ---------- Transfer ----------
function fillTransferSelect(select, selectedId) {
  const buckets = activeBuckets();
  select.innerHTML = buckets
    .map(
      (b) =>
        `<option value="${esc(b.id)}" ${b.id === selectedId ? "selected" : ""}>${esc(b.name)}</option>`,
    )
    .join("");
}

function openTransferModal() {
  const buckets = activeBuckets();
  if (buckets.length < 2) {
    toast("Need at least two buckets to transfer", "error");
    return;
  }
  const fromId = state.activeBucket;
  const toId = (buckets.find((b) => b.id !== fromId) || buckets[0]).id;
  fillTransferSelect($transferFrom, fromId);
  fillTransferSelect($transferTo, toId);
  $transferAmount.value = "";
  $transferModal.hidden = false;
  setTimeout(() => $transferAmount.focus(), 50);
}

function closeTransferModal() {
  $transferModal.hidden = true;
}

async function submitTransfer(e) {
  e.preventDefault();
  const fromId = $transferFrom.value;
  const toId = $transferTo.value;
  const amount = parseFloat($transferAmount.value);
  if (fromId === toId) {
    toast("Pick two different buckets", "error");
    return;
  }
  if (!isFinite(amount) || amount <= 0) {
    toast("Enter an amount above 0", "error");
    return;
  }
  const transferId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  try {
    const batch = writeBatch(db);
    writeHistoryToBatch(batch, {
      userId: state.activeUser,
      type: "transfer",
      amount: -Math.abs(amount),
      bucketId: fromId,
      otherBucketId: toId,
      transferId,
    });
    writeHistoryToBatch(batch, {
      userId: state.activeUser,
      type: "transfer",
      amount: Math.abs(amount),
      bucketId: toId,
      otherBucketId: fromId,
      transferId,
    });
    await batch.commit();
    closeTransferModal();
    toast(
      `Transferred ${fmt(amount)}: ${bucketName(fromId)} → ${bucketName(toId)}`,
    );
  } catch (err) {
    console.error(err);
    toast("Couldn't transfer", "error");
  }
}

// ---------- Wiring ----------
$userBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.activeUser = btn.dataset.user;
    localStorage.setItem("activeUser", state.activeUser);
    state.search = "";
    $search.value = "";
    render();
  });
});

$bucketList.addEventListener("click", (e) => {
  const card = e.target.closest("[data-action='pick-bucket']");
  if (!card) return;
  pickBucket(card.dataset.id);
});

$monthBtn.addEventListener("click", tapMonth);
$holidayBtn.addEventListener("click", tapHoliday);
$customBtn.addEventListener("click", openCustomModal);
$customCancel.addEventListener("click", closeCustomModal);
$customPicker.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-key]");
  if (!btn) return;
  pressCustomKey(btn.dataset.key);
});
$spendForm.addEventListener("submit", submitSpend);

document.querySelectorAll(".quick-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    tapQuick(parseFloat(btn.dataset.quick));
  });
});

$itemCounterBtn.addEventListener("click", tapItemCounter);
$itemsPlus5Btn.addEventListener("click", () => addItems(5));
$itemsRemainingBtn.addEventListener("click", () => {
  const current = Number(state.itemCounts[state.activeUser]) || 0;
  addItems(ITEM_GOAL - current);
});
$transferBtn.addEventListener("click", openTransferModal);
$transferCancel.addEventListener("click", closeTransferModal);
$transferForm.addEventListener("submit", submitTransfer);

$search.addEventListener("input", () => {
  state.search = $search.value;
  renderChores();
});

$choreList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='add-chore']");
  if (!btn) return;
  tapChore(btn.dataset.id);
});

$historyList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='undo']");
  if (!btn) return;
  undo(btn.dataset.id);
});

$choreForm.addEventListener("submit", submitNewChore);

$manageList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='toggle-archive']");
  if (!btn) return;
  toggleArchive(btn.dataset.id);
});

$manageList.addEventListener("change", (e) => {
  const field = e.target.closest("[data-field]");
  if (!field) return;
  const row = field.closest(".manage-row");
  if (!row) return;
  updateChoreField(row.dataset.id, field.dataset.field, field.value);
});

$bucketForm.addEventListener("submit", submitNewBucket);

$manageBuckets.addEventListener("click", (e) => {
  const archive = e.target.closest("[data-action='toggle-bucket-archive']");
  if (archive && !archive.disabled) {
    toggleBucketArchive(archive.dataset.id);
    return;
  }
  const owner = e.target.closest("[data-action='cycle-owner']");
  if (owner) {
    cycleBucketOwner(owner.dataset.id);
    return;
  }
  const del = e.target.closest("[data-action='delete-bucket']");
  if (del) {
    deleteBucket(del.dataset.id);
  }
});

$manageBuckets.addEventListener("change", (e) => {
  const input = e.target.closest("input[data-field]");
  if (!input) return;
  const row = input.closest(".manage-row");
  if (!row) return;
  const field = input.dataset.field;
  if (field === "name") {
    renameBucket(row.dataset.id, input.value);
  } else if (field === "goal") {
    updateBucketGoal(row.dataset.id, input.value);
  }
});

// ---------- Holidays ----------
// Floating dates are looked up by year; fixed dates are checked by MM-DD.
const EASTER = {
  2026: "04-05",
  2027: "03-28",
  2028: "04-16",
  2029: "04-01",
  2030: "04-21",
  2031: "04-13",
  2032: "03-28",
  2033: "04-17",
  2034: "04-09",
  2035: "03-25",
};
const CHINESE_NEW_YEAR = {
  2026: "02-17",
  2027: "02-06",
  2028: "01-26",
  2029: "02-13",
  2030: "02-03",
  2031: "01-23",
  2032: "02-11",
  2033: "01-31",
  2034: "02-19",
  2035: "02-08",
};

function fourthThursdayOfNov(year) {
  // First Thursday: Nov has 30 days; Jan 1 + offset. Iterate.
  for (let day = 22; day <= 28; day++) {
    const d = new Date(year, 10, day);
    if (d.getDay() === 4) return pad2(day);
  }
  return "27"; // safe fallback
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

const HOLIDAY_AMOUNT = 10;

// Fixed-date holidays (same MM-DD every year). Easter, Chinese New Year, and
// Thanksgiving float, so they're resolved per-year below.
const FIXED_HOLIDAYS = [
  { id: "valentines", name: "Valentine's Day", md: "02-14" },
  { id: "july-4", name: "Independence Day", md: "07-04" },
  { id: "halloween", name: "Halloween", md: "10-31" },
  { id: "christmas", name: "Christmas", md: "12-25" },
];

// Every recognised holiday resolved to its MM-DD for the given year, sorted by
// date. Powers the "Show holidays" reference list.
function holidaysForYear(year) {
  const list = FIXED_HOLIDAYS.map((h) => ({ id: h.id, name: h.name, md: h.md }));
  if (EASTER[year]) list.push({ id: "easter", name: "Easter", md: EASTER[year] });
  if (CHINESE_NEW_YEAR[year]) {
    list.push({
      id: "chinese-new-year",
      name: "Chinese New Year",
      md: CHINESE_NEW_YEAR[year],
    });
  }
  list.push({
    id: "thanksgiving",
    name: "Thanksgiving",
    md: `11-${fourthThursdayOfNov(year)}`,
  });
  return list.sort((a, b) => a.md.localeCompare(b.md));
}

function formatHolidayDate(md, year) {
  const [mm, dd] = md.split("-").map(Number);
  return new Date(year, mm - 1, dd).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function renderHolidays() {
  const year = new Date().getFullYear();
  $holidayList.innerHTML = holidaysForYear(year)
    .map(
      (h) => `
        <li class="holiday-row">
          <span class="holiday-name">${esc(h.name)}</span>
          <span class="holiday-date">${esc(formatHolidayDate(h.md, year))}</span>
          <span class="holiday-amount">+$${HOLIDAY_AMOUNT}</span>
        </li>`,
    )
    .join("");
}

// ---------- Listeners ----------
onSnapshot(collection(db, "chores"), (snap) => {
  state.chores = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
});

onSnapshot(collection(db, "buckets"), (snap) => {
  state.buckets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!state.buckets.find((b) => b.id === DEFAULT_BUCKET_ID)) {
    ensureDefaultBucket();
  }
  render();
});

// Display list only — capped at 200. Balances come from the `balances`
// collection, not from summing this truncated set.
onSnapshot(
  query(collection(db, "history"), orderBy("createdAt", "desc"), limit(200)),
  (snap) => {
    state.history = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  },
);

// Month-scoped ledger for the "This month" summary. No limit, so the totals
// stay correct however busy the month gets. The lower bound is fixed at attach
// time; renderMonthlySummary re-filters by current month so it survives a
// midnight/month rollover while the app is left open.
const monthStart = (() => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
})();
onSnapshot(
  query(collection(db, "history"), where("createdAt", ">=", monthStart)),
  (snap) => {
    state.monthHistory = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  },
);

onSnapshot(collection(db, "bucketTombstones"), (snap) => {
  state.tombstones = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
});

// Finalization waits for the first snapshot so it can tell which completed
// months are already written; the flag inside keeps it from looping on its
// own writes.
onSnapshot(collection(db, "monthlySummaries"), (snap) => {
  state.monthlySummaries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
  finalizeMonthlySummaries();
});

onSnapshot(collection(db, "balances"), (snap) => {
  const next = {};
  for (const d of snap.docs) {
    next[d.id] = Number(d.data().balance) || 0;
  }
  state.balances = next;
  render();
});

onSnapshot(collection(db, "counters"), (snap) => {
  const next = {};
  for (const d of snap.docs) {
    const data = d.data();
    for (const u of USERS) {
      if (d.id === itemCounterDocId(u.id)) {
        next[u.id] = Number(data.count) || 0;
      }
    }
  }
  state.itemCounts = next;
  render();
});

render();
renderHolidays();
