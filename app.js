import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  writeBatch,
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
  itemCounts: {},
  search: "",
  defaultBucketEnsured: false,
};

const ITEM_GOAL = 20;
const itemCounterDocId = (userId) => `items-${userId}`;

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
const $holidayModal = document.getElementById("holiday-modal");
const $holidayTitle = document.getElementById("holiday-title");
const $holidayBody = document.getElementById("holiday-body");
const $holidayApply = document.getElementById("holiday-apply");
const $holidayDismiss = document.getElementById("holiday-dismiss");
const $transferBtn = document.getElementById("transfer-btn");
const $transferModal = document.getElementById("transfer-modal");
const $transferForm = document.getElementById("transfer-form");
const $transferFrom = document.getElementById("transfer-from");
const $transferTo = document.getElementById("transfer-to");
const $transferAmount = document.getElementById("transfer-amount");
const $transferCancel = document.getElementById("transfer-cancel");
const $itemCounterBtn = document.getElementById("item-counter-btn");
const $itemCounterCount = document.getElementById("item-counter-count");

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
  if (!bucket.owner) return true; // shared
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

  renderBuckets();
  renderItemCounter();
  renderChores();
  renderHistory();
  renderManage();
  renderManageBuckets();
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
      const goal = Number(b.goal) || 0;
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
  if (!owner) return "Shared";
  return userName(owner);
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
      const ownerBtn = isDefault
        ? ""
        : `<button class="owner-btn" data-action="cycle-owner" data-id="${esc(
            b.id,
          )}">${esc(ownerLabel(b.owner))}</button>`;
      const goalVal = Number(b.goal) > 0 ? Number(b.goal) : "";
      return `
        <li class="manage-row bucket ${
          b.archived ? "archived" : ""
        }" data-id="${esc(b.id)}">
          <input type="text" data-field="name" value="${esc(b.name)}" aria-label="Bucket name" />
          <input class="bucket-goal-input" type="number" min="0" step="0.01" inputmode="decimal" data-field="goal" value="${goalVal}" placeholder="Goal $" aria-label="Goal amount" />
          ${ownerBtn}
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

async function tapItemCounter() {
  const userId = state.activeUser;
  const current = Number(state.itemCounts[userId]) || 0;
  const next = current + 1;
  if (next >= ITEM_GOAL) {
    try {
      await setDoc(
        doc(db, "counters", itemCounterDocId(userId)),
        { count: 0 },
        { merge: true },
      );
      await addHistory({
        userId,
        type: "items",
        amount: 1,
      });
      toast(`${ITEM_GOAL} items put away — +$1 → ${bucketName(state.activeBucket)}`);
    } catch (err) {
      console.error(err);
      toast("Couldn't save count", "error");
    }
    return;
  }
  try {
    await setDoc(
      doc(db, "counters", itemCounterDocId(userId)),
      { count: next },
      { merge: true },
    );
  } catch (err) {
    console.error(err);
    toast("Couldn't save count", "error");
  }
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

async function tapCustom() {
  const raw = window.prompt(
    `Add to ${bucketName(state.activeBucket)} for ${userName(
      state.activeUser,
    )}:`,
  );
  if (raw === null) return;
  const amount = parseFloat(raw);
  if (!isFinite(amount) || amount <= 0) {
    toast("Enter an amount above 0", "error");
    return;
  }
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
      batch.set(doc(collection(db, "history")), {
        userId: original.userId,
        type: "transfer",
        amount: -(Number(original.amount) || 0),
        bucketId: original.bucketId || DEFAULT_BUCKET_ID,
        otherBucketId: original.otherBucketId ?? null,
        transferId: original.transferId,
        reversesId: original.id,
        createdAt: serverTimestamp(),
      });
      if (paired) {
        batch.set(doc(collection(db, "history")), {
          userId: paired.userId,
          type: "transfer",
          amount: -(Number(paired.amount) || 0),
          bucketId: paired.bucketId || DEFAULT_BUCKET_ID,
          otherBucketId: paired.otherBucketId ?? null,
          transferId: paired.transferId,
          reversesId: paired.id,
          createdAt: serverTimestamp(),
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

async function updateBucketGoal(bucketId, value) {
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
  try {
    await updateDoc(doc(db, "buckets", bucketId), {
      archived: !bucket.archived,
    });
  } catch (err) {
    console.error(err);
    toast("Couldn't update bucket", "error");
  }
}

const OWNER_CYCLE = [undefined, "acacia", "david"];
async function cycleBucketOwner(bucketId) {
  if (bucketId === DEFAULT_BUCKET_ID) return;
  const bucket = state.buckets.find((b) => b.id === bucketId);
  if (!bucket) return;
  const idx = OWNER_CYCLE.indexOf(bucket.owner ?? undefined);
  const next = OWNER_CYCLE[(idx + 1) % OWNER_CYCLE.length];
  try {
    await updateDoc(doc(db, "buckets", bucketId), {
      owner: next ?? null,
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
    batch.set(doc(collection(db, "history")), {
      userId: state.activeUser,
      type: "transfer",
      amount: -Math.abs(amount),
      bucketId: fromId,
      otherBucketId: toId,
      transferId,
      createdAt: serverTimestamp(),
    });
    batch.set(doc(collection(db, "history")), {
      userId: state.activeUser,
      type: "transfer",
      amount: Math.abs(amount),
      bucketId: toId,
      otherBucketId: fromId,
      transferId,
      createdAt: serverTimestamp(),
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
    showHolidayPrompt();
  });
});

$bucketList.addEventListener("click", (e) => {
  const card = e.target.closest("[data-action='pick-bucket']");
  if (!card) return;
  pickBucket(card.dataset.id);
});

$monthBtn.addEventListener("click", tapMonth);
$holidayBtn.addEventListener("click", tapHoliday);
$customBtn.addEventListener("click", tapCustom);
$spendForm.addEventListener("submit", submitSpend);

document.querySelectorAll(".quick-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    tapQuick(parseFloat(btn.dataset.quick));
  });
});

$itemCounterBtn.addEventListener("click", tapItemCounter);
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

function getHolidayToday(now = new Date()) {
  const year = now.getFullYear();
  const md = `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const fixed = [
    { id: "valentines", name: "Valentine's Day", md: "02-14" },
    { id: "july-4", name: "Independence Day", md: "07-04" },
    { id: "halloween", name: "Halloween", md: "10-31" },
    { id: "christmas", name: "Christmas", md: "12-25" },
  ];
  for (const h of fixed) {
    if (h.md === md) return { ...h, amount: 10 };
  }
  if (EASTER[year] === md) return { id: "easter", name: "Easter", amount: 10 };
  if (CHINESE_NEW_YEAR[year] === md) {
    return { id: "chinese-new-year", name: "Chinese New Year", amount: 10 };
  }
  if (now.getMonth() === 10 && pad2(now.getDate()) === fourthThursdayOfNov(year)) {
    return { id: "thanksgiving", name: "Thanksgiving", amount: 10 };
  }
  return null;
}

function todayKey(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function holidayDismissKey(holidayId, userId, now = new Date()) {
  return `holidayDismissed:${todayKey(now)}:${holidayId}:${userId}`;
}

let currentHoliday = null;

function showHolidayPrompt() {
  const h = getHolidayToday();
  if (!h) {
    currentHoliday = null;
    $holidayModal.hidden = true;
    return;
  }
  const key = holidayDismissKey(h.id, state.activeUser);
  if (localStorage.getItem(key)) {
    currentHoliday = null;
    $holidayModal.hidden = true;
    return;
  }
  currentHoliday = h;
  $holidayTitle.textContent = `Today is ${h.name}!`;
  $holidayBody.textContent = `Add $${h.amount} to ${bucketName(
    state.activeBucket,
  )} for ${userName(state.activeUser)}?`;
  $holidayApply.textContent = `Add $${h.amount}`;
  $holidayModal.hidden = false;
}

function dismissHoliday() {
  if (!currentHoliday) return;
  localStorage.setItem(
    holidayDismissKey(currentHoliday.id, state.activeUser),
    "1",
  );
  currentHoliday = null;
  $holidayModal.hidden = true;
}

async function applyHoliday() {
  if (!currentHoliday) return;
  const h = currentHoliday;
  await addHistory({
    userId: state.activeUser,
    type: "holiday",
    amount: h.amount,
    holidayName: h.name,
  });
  toast(`${h.name} +$${h.amount} → ${bucketName(state.activeBucket)}`);
  dismissHoliday();
}

$holidayApply.addEventListener("click", applyHoliday);
$holidayDismiss.addEventListener("click", dismissHoliday);

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
showHolidayPrompt();
