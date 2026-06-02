import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  query,
  orderBy,
  limit,
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

const state = {
  activeUser: localStorage.getItem("activeUser") || "acacia",
  activeBucket: localStorage.getItem("activeBucket") || DEFAULT_BUCKET_ID,
  buckets: [],
  chores: [],
  history: [],
  search: "",
  defaultBucketEnsured: false,
};

if (!USERS.find((u) => u.id === state.activeUser)) {
  state.activeUser = "acacia";
}

// ---------- DOM refs ----------
const $balance = document.getElementById("balance");
const $balanceLabel = document.getElementById("balance-label");
const $otherBalance = document.getElementById("other-balance");
const $userBtns = document.querySelectorAll(".user-btn");
const $bucketList = document.getElementById("bucket-list");
const $monthBtn = document.getElementById("month-btn");
const $holidayBtn = document.getElementById("holiday-btn");
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

function otherUserId(id) {
  return USERS.find((u) => u.id !== id)?.id;
}

function bucketName(id) {
  return state.buckets.find((b) => b.id === id)?.name ?? "Unknown bucket";
}

function activeBuckets() {
  return state.buckets
    .filter((b) => !b.archived)
    .sort((a, b) => {
      if (a.id === DEFAULT_BUCKET_ID) return -1;
      if (b.id === DEFAULT_BUCKET_ID) return 1;
      return a.name.localeCompare(b.name);
    });
}

function ensureActiveBucketValid() {
  const active = state.buckets.find(
    (b) => b.id === state.activeBucket && !b.archived,
  );
  if (active) return;
  const fallback =
    state.buckets.find((b) => b.id === DEFAULT_BUCKET_ID && !b.archived) ||
    activeBuckets()[0];
  if (fallback && fallback.id !== state.activeBucket) {
    state.activeBucket = fallback.id;
    localStorage.setItem("activeBucket", state.activeBucket);
  }
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
  if (entry.type === "holiday") return "Holiday";
  if (entry.type === "monthly") return "Month start";
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
  let sum = 0;
  for (const h of state.history) {
    if (h.userId !== userId) continue;
    if ((h.bucketId || DEFAULT_BUCKET_ID) !== bucketId) continue;
    sum += Number(h.amount) || 0;
  }
  return sum;
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

  const other = otherUserId(state.activeUser);
  const otherParts = activeBuckets().map(
    (b) => `${b.name}: ${fmt(balanceFor(other, b.id))}`,
  );
  $otherBalance.textContent = `${userName(other)} — ${otherParts.join("  ·  ")}`;

  renderBuckets();
  renderChores();
  renderHistory();
  renderManage();
  renderManageBuckets();
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
      return `
        <li class="bucket-card ${isActive ? "active" : ""} ${
          bal < 0 ? "neg" : ""
        }" data-action="pick-bucket" data-id="${esc(b.id)}">
          <span class="bucket-name">${esc(b.name)}</span>
          <span class="bucket-amount">${fmt(bal)}</span>
        </li>`;
    })
    .join("");
}

function renderChores() {
  const q = state.search.trim().toLowerCase();
  const visible = state.chores
    .filter((c) => !c.archived)
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (visible.length === 0) {
    $choreList.innerHTML = `<li class="chore-empty">${
      state.chores.length === 0
        ? "No chores yet — add some in Manage chores below."
        : "No chores match."
    }</li>`;
    return;
  }

  $choreList.innerHTML = visible
    .map(
      (c) => `
        <li class="chore-row" data-id="${esc(c.id)}">
          <span class="chore-name">${esc(c.name)}</span>
          <span class="chore-amount">${fmt(Number(c.amount) || 0)}</span>
          <button class="chore-add-btn" data-action="add-chore" data-id="${esc(
            c.id,
          )}" aria-label="Add ${esc(c.name)}">+</button>
        </li>`,
    )
    .join("");
}

function renderHistory() {
  const mine = state.history.filter(
    (h) =>
      h.userId === state.activeUser &&
      (h.bucketId || DEFAULT_BUCKET_ID) === state.activeBucket,
  );
  const { reversedIds, reverserIds } = computeReversals(state.history);

  if (mine.length === 0) {
    $historyList.innerHTML = `<li class="history-empty">No activity in ${esc(
      bucketName(state.activeBucket),
    )} yet.</li>`;
    return;
  }

  $historyList.innerHTML = mine
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
      return `
        <li class="${cls}" data-id="${esc(h.id)}">
          <span class="history-label">${esc(labelFor(h))}${
            when ? `<span class="history-meta">${esc(when)}</span>` : ""
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
    return a.name.localeCompare(b.name);
  });

  if (sorted.length === 0) {
    $manageList.innerHTML = "";
    return;
  }

  $manageList.innerHTML = sorted
    .map(
      (c) => `
        <li class="manage-row ${c.archived ? "archived" : ""}" data-id="${esc(
          c.id,
        )}">
          <input type="text" data-field="name" value="${esc(c.name)}" aria-label="Name" />
          <input type="number" min="0" step="0.01" inputmode="decimal" data-field="amount" value="${
            Number(c.amount) || 0
          }" aria-label="Amount" />
          <button class="archive-btn" data-action="toggle-archive" data-id="${esc(
            c.id,
          )}">${c.archived ? "Restore" : "Archive"}</button>
        </li>`,
    )
    .join("");
}

function renderManageBuckets() {
  const sorted = [...state.buckets].sort((a, b) => {
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
      return `
        <li class="manage-row bucket ${
          b.archived ? "archived" : ""
        }" data-id="${esc(b.id)}">
          <input type="text" data-field="name" value="${esc(b.name)}" aria-label="Bucket name" />
          <button class="archive-btn" data-action="toggle-bucket-archive" data-id="${esc(
            b.id,
          )}" ${isDefault ? "disabled" : ""}>${archiveLabel}</button>
        </li>`;
    })
    .join("");
}

// ---------- Actions ----------
async function addHistory(entry) {
  try {
    await addDoc(collection(db, "history"), {
      ...entry,
      bucketId: entry.bucketId || state.activeBucket,
      amount: Number(entry.amount),
      createdAt: serverTimestamp(),
    });
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
    });
    $newBucketName.value = "";
    toast("Bucket added");
  } catch (err) {
    console.error(err);
    toast("Couldn't add bucket", "error");
  }
}

async function renameBucket(bucketId, value) {
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

async function toggleBucketArchive(bucketId) {
  if (bucketId === DEFAULT_BUCKET_ID) return;
  const bucket = state.buckets.find((b) => b.id === bucketId);
  if (!bucket) return;
  try {
    await updateDoc(doc(db, "buckets", bucketId), {
      archived: !bucket.archived,
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

// ---------- Wiring ----------
$userBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.activeUser = btn.dataset.user;
    localStorage.setItem("activeUser", state.activeUser);
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
$spendForm.addEventListener("submit", submitSpend);

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
  const input = e.target.closest("input[data-field]");
  if (!input) return;
  const row = input.closest(".manage-row");
  if (!row) return;
  updateChoreField(row.dataset.id, input.dataset.field, input.value);
});

$bucketForm.addEventListener("submit", submitNewBucket);

$manageBuckets.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='toggle-bucket-archive']");
  if (!btn || btn.disabled) return;
  toggleBucketArchive(btn.dataset.id);
});

$manageBuckets.addEventListener("change", (e) => {
  const input = e.target.closest("input[data-field='name']");
  if (!input) return;
  const row = input.closest(".manage-row");
  if (!row) return;
  renameBucket(row.dataset.id, input.value);
});

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

onSnapshot(
  query(collection(db, "history"), orderBy("createdAt", "desc"), limit(200)),
  (snap) => {
    state.history = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  },
);

render();
