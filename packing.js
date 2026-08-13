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
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Where a packed item can live. Fixed list — these cover the whole spectrum
// from tiny to checked luggage.
const BAGS = ["Fanny Pack", "Backpack", "Carry-On", "Checked Bag"];

// Data model:
//   packingItems — the master list of everything that could ever be packed
//                  ({ name, category }). Shared across all trips.
//   trips        — one doc per trip ({ name }).
//   tripItems    — which master items are in a trip and their packed state
//                  ({ tripId, itemId, packed, bag }). Doc ID is
//                  `${tripId}__${itemId}` so adding the same item twice from
//                  two devices just merges instead of duplicating.
const tripItemDocId = (tripId, itemId) => `${tripId}__${itemId}`;

const state = {
  masterItems: [],
  trips: [],
  tripItems: [],
  activeTrip: localStorage.getItem("activePackingTrip") || null,
};

// ---------- DOM refs ----------
const $tripSelect = document.getElementById("trip-select");
const $newTripBtn = document.getElementById("new-trip-btn");
const $packProgress = document.getElementById("pack-progress");
const $tripView = document.getElementById("trip-view");
const $noTrip = document.getElementById("no-trip");
const $unpackedList = document.getElementById("unpacked-list");
const $packedList = document.getElementById("packed-list");
const $resetPacking = document.getElementById("reset-packing");
const $addItemsList = document.getElementById("add-items-list");
const $masterForm = document.getElementById("master-form");
const $masterName = document.getElementById("master-name");
const $masterCategory = document.getElementById("master-category");
const $packCategories = document.getElementById("pack-categories");
const $masterList = document.getElementById("master-list");
const $deleteTripBtn = document.getElementById("delete-trip-btn");
const $status = document.getElementById("status");
const $bagModal = document.getElementById("bag-modal");
const $bagBody = document.getElementById("bag-body");
const $bagPicker = document.getElementById("bag-picker");
const $bagCancel = document.getElementById("bag-cancel");

// ---------- Helpers ----------
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
  }, 2000);
}

function masterItem(itemId) {
  return state.masterItems.find((i) => i.id === itemId);
}

function activeTripDoc() {
  return state.trips.find((t) => t.id === state.activeTrip);
}

// tripItems for the active trip, joined against the master list. Entries
// whose master item was deleted are dropped (deleting a master item also
// deletes its tripItems, but a lagging snapshot can briefly disagree).
function activeTripItems() {
  if (!state.activeTrip) return [];
  return state.tripItems
    .filter((ti) => ti.tripId === state.activeTrip)
    .map((ti) => {
      const item = masterItem(ti.itemId);
      return item
        ? { ...ti, name: item.name, category: item.category || "Other" }
        : null;
    })
    .filter(Boolean);
}

// A trip created locally is selected before its snapshot arrives; the pending
// guard keeps a render in that window from falling back to an older trip.
let pendingTripId = null;

function ensureActiveTripValid() {
  if (state.trips.find((t) => t.id === pendingTripId)) pendingTripId = null;
  if (state.activeTrip && state.activeTrip === pendingTripId) return;
  if (state.trips.length === 0) {
    state.activeTrip = null;
    return;
  }
  if (!state.trips.find((t) => t.id === state.activeTrip)) {
    state.activeTrip = state.trips[0].id;
    localStorage.setItem("activePackingTrip", state.activeTrip);
  }
}

// Group a list of joined trip items by a key, with groups and items sorted
// alphabetically (bags keep their fixed BAGS order instead).
function groupBy(items, keyFn) {
  const groups = new Map();
  for (const it of items) {
    const key = keyFn(it);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups;
}

// ---------- Render ----------
function render() {
  ensureActiveTripValid();
  renderTripBar();
  renderCategoryOptions();
  renderMasterList();

  const hasTrip = Boolean(state.activeTrip);
  $tripView.hidden = !hasTrip;
  $noTrip.hidden = hasTrip;
  $deleteTripBtn.hidden = !hasTrip;
  if (!hasTrip) {
    $packProgress.textContent = "";
    return;
  }

  const items = activeTripItems();
  const packed = items.filter((i) => i.packed);
  $packProgress.textContent = items.length
    ? `${packed.length} of ${items.length} packed`
    : "Nothing in this trip yet — add items below.";

  renderUnpacked(items.filter((i) => !i.packed));
  renderPacked(packed);
  renderAddItems(items);
  $resetPacking.hidden = packed.length === 0;
}

function renderTripBar() {
  const trips = [...state.trips].sort((a, b) => {
    const at = a.createdAt?.toMillis?.() ?? 0;
    const bt = b.createdAt?.toMillis?.() ?? 0;
    return bt - at;
  });
  $tripSelect.innerHTML = trips.length
    ? trips
        .map(
          (t) =>
            `<option value="${esc(t.id)}" ${
              t.id === state.activeTrip ? "selected" : ""
            }>${esc(t.name)}</option>`,
        )
        .join("")
    : `<option value="">No trips yet</option>`;
  $tripSelect.disabled = trips.length === 0;
}

function itemRow(it, { action, checked, meta = "", removable = true }) {
  return `
    <li class="todo-row ${checked ? "checked" : ""}" data-id="${esc(it.itemId)}">
      <button class="todo-toggle" data-action="${action}" data-id="${esc(
        it.itemId,
      )}" aria-label="${checked ? "Unpack" : "Pack"} ${esc(it.name)}">
        <span class="todo-box" aria-hidden="true"></span>
        <span class="todo-body">
          <span class="todo-name">${esc(it.name)}</span>
          ${meta}
        </span>
      </button>
      ${
        removable
          ? `<button class="todo-delete" data-action="remove-from-trip" data-id="${esc(
              it.itemId,
            )}" aria-label="Remove ${esc(it.name)} from trip">×</button>`
          : "<span></span>"
      }
    </li>`;
}

function renderUnpacked(unpacked) {
  if (unpacked.length === 0) {
    $unpackedList.innerHTML = `<li class="pack-empty">Nothing left to pack.</li>`;
    return;
  }
  const groups = groupBy(unpacked, (i) => i.category);
  const cats = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  let html = "";
  for (const cat of cats) {
    html += `<li class="pack-cat-header">${esc(cat)}</li>`;
    html += groups
      .get(cat)
      .map((it) => itemRow(it, { action: "pack", checked: false }))
      .join("");
  }
  $unpackedList.innerHTML = html;
}

function renderPacked(packed) {
  if (packed.length === 0) {
    $packedList.innerHTML = `<li class="pack-empty">Nothing packed yet.</li>`;
    return;
  }
  const groups = groupBy(packed, (i) => i.bag || "Somewhere");
  const bags = [...groups.keys()].sort((a, b) => {
    const ai = BAGS.indexOf(a);
    const bi = BAGS.indexOf(b);
    return (ai === -1 ? BAGS.length : ai) - (bi === -1 ? BAGS.length : bi);
  });
  let html = "";
  for (const bag of bags) {
    const list = groups.get(bag);
    html += `<li class="pack-cat-header">${esc(bag)} · ${list.length}</li>`;
    html += list
      .map((it) =>
        itemRow(it, {
          action: "unpack",
          checked: true,
          meta: `<span class="todo-meta"><span class="todo-cat">${esc(
            it.category,
          )}</span></span>`,
        }),
      )
      .join("");
  }
  $packedList.innerHTML = html;
}

// Master items not yet in the active trip, grouped by category, each with a
// "+" to pull it into the trip.
function renderAddItems(tripItems) {
  const inTrip = new Set(tripItems.map((i) => i.itemId));
  const candidates = state.masterItems.filter((i) => !inTrip.has(i.id));
  if (candidates.length === 0) {
    $addItemsList.innerHTML = `<li class="pack-empty">${
      state.masterItems.length === 0
        ? "The master list is empty — add items to it below."
        : "Everything on the master list is already in this trip."
    }</li>`;
    return;
  }
  const groups = groupBy(
    candidates.map((i) => ({ ...i, itemId: i.id, category: i.category || "Other" })),
    (i) => i.category,
  );
  const cats = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  let html = "";
  for (const cat of cats) {
    html += `<li class="pack-cat-header">${esc(cat)}</li>`;
    html += groups
      .get(cat)
      .map(
        (it) => `
        <li class="pack-add-row" data-id="${esc(it.id)}">
          <span class="todo-name">${esc(it.name)}</span>
          <button class="pack-plus-btn" data-action="add-to-trip" data-id="${esc(
            it.id,
          )}" aria-label="Add ${esc(it.name)} to trip">+</button>
        </li>`,
      )
      .join("");
  }
  $addItemsList.innerHTML = html;
}

function renderCategoryOptions() {
  const seen = new Set();
  for (const item of state.masterItems) {
    const c = (item.category || "").trim();
    if (c) seen.add(c);
  }
  $packCategories.innerHTML = [...seen]
    .sort((a, b) => a.localeCompare(b))
    .map((c) => `<option value="${esc(c)}"></option>`)
    .join("");
}

function renderMasterList() {
  if (state.masterItems.length === 0) {
    $masterList.innerHTML = `<li class="pack-empty">Nothing yet — add everything you could ever pack.</li>`;
    return;
  }
  const groups = groupBy(
    state.masterItems.map((i) => ({ ...i, category: i.category || "Other" })),
    (i) => i.category,
  );
  const cats = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  let html = "";
  for (const cat of cats) {
    html += `<li class="pack-cat-header">${esc(cat)}</li>`;
    html += groups
      .get(cat)
      .map(
        (it) => `
        <li class="pack-add-row" data-id="${esc(it.id)}">
          <span class="todo-name">${esc(it.name)}</span>
          <button class="todo-delete" data-action="delete-master" data-id="${esc(
            it.id,
          )}" aria-label="Delete ${esc(it.name)} from master list">×</button>
        </li>`,
      )
      .join("");
  }
  $masterList.innerHTML = html;
}

// ---------- Trips ----------
async function newTrip() {
  const name = (window.prompt("Name for the new trip?") || "").trim();
  if (!name) return;
  const ref = doc(collection(db, "trips"));
  pendingTripId = ref.id;
  state.activeTrip = ref.id;
  localStorage.setItem("activePackingTrip", ref.id);
  try {
    await setDoc(ref, {
      name,
      createdAt: serverTimestamp(),
    });
    toast(`Trip "${name}" created`);
  } catch (err) {
    console.error(err);
    pendingTripId = null;
    toast("Couldn't create trip", "error");
    render();
  }
}

async function deleteTrip() {
  const trip = activeTripDoc();
  if (!trip) return;
  if (
    !window.confirm(
      `Delete "${trip.name}"? Its packing progress will be lost (the master list is untouched).`,
    )
  ) {
    return;
  }
  try {
    const batch = writeBatch(db);
    for (const ti of state.tripItems.filter((t) => t.tripId === trip.id)) {
      batch.delete(doc(db, "tripItems", ti.id));
    }
    batch.delete(doc(db, "trips", trip.id));
    await batch.commit();
    toast(`Deleted ${trip.name}`);
  } catch (err) {
    console.error(err);
    toast("Couldn't delete trip", "error");
  }
}

// ---------- Trip items ----------
async function addToTrip(itemId) {
  if (!state.activeTrip) return;
  const item = masterItem(itemId);
  if (!item) return;
  try {
    await setDoc(doc(db, "tripItems", tripItemDocId(state.activeTrip, itemId)), {
      tripId: state.activeTrip,
      itemId,
      packed: false,
      bag: null,
    });
  } catch (err) {
    console.error(err);
    toast("Couldn't add item", "error");
  }
}

async function removeFromTrip(itemId) {
  if (!state.activeTrip) return;
  try {
    await deleteDoc(
      doc(db, "tripItems", tripItemDocId(state.activeTrip, itemId)),
    );
  } catch (err) {
    console.error(err);
    toast("Couldn't remove item", "error");
  }
}

async function packItem(itemId, bag) {
  if (!state.activeTrip) return;
  try {
    await updateDoc(
      doc(db, "tripItems", tripItemDocId(state.activeTrip, itemId)),
      { packed: true, bag },
    );
  } catch (err) {
    console.error(err);
    toast("Couldn't pack item", "error");
  }
}

async function unpackItem(itemId) {
  if (!state.activeTrip) return;
  try {
    await updateDoc(
      doc(db, "tripItems", tripItemDocId(state.activeTrip, itemId)),
      { packed: false, bag: null },
    );
  } catch (err) {
    console.error(err);
    toast("Couldn't unpack item", "error");
  }
}

// Clear the trip for re-use: everything back to unpacked, items stay in.
async function resetPacking() {
  const packed = state.tripItems.filter(
    (ti) => ti.tripId === state.activeTrip && ti.packed,
  );
  if (packed.length === 0) return;
  try {
    const batch = writeBatch(db);
    for (const ti of packed) {
      batch.update(doc(db, "tripItems", ti.id), { packed: false, bag: null });
    }
    await batch.commit();
    toast("Everything unpacked");
  } catch (err) {
    console.error(err);
    toast("Couldn't reset", "error");
  }
}

// ---------- Master list ----------
async function submitMasterItem(e) {
  e.preventDefault();
  const name = $masterName.value.trim();
  const category = $masterCategory.value.trim();
  if (!name || !category) return;
  try {
    await addDoc(collection(db, "packingItems"), {
      name,
      category,
      createdAt: serverTimestamp(),
    });
    $masterName.value = "";
    $masterName.focus();
    toast(`Added ${name} to ${category}`);
  } catch (err) {
    console.error(err);
    toast("Couldn't add item", "error");
  }
}

async function deleteMasterItem(itemId) {
  const item = masterItem(itemId);
  if (!item) return;
  const references = state.tripItems.filter((ti) => ti.itemId === itemId);
  if (
    !window.confirm(
      `Delete "${item.name}" from the master list?${
        references.length ? " It will also be removed from every trip." : ""
      }`,
    )
  ) {
    return;
  }
  try {
    const batch = writeBatch(db);
    for (const ti of references) {
      batch.delete(doc(db, "tripItems", ti.id));
    }
    batch.delete(doc(db, "packingItems", itemId));
    await batch.commit();
    toast(`Deleted ${item.name}`);
  } catch (err) {
    console.error(err);
    toast("Couldn't delete item", "error");
  }
}

// ---------- Bag picker modal ----------
let pendingItemId = null;

function openBagModal(itemId) {
  const item = masterItem(itemId);
  if (!item) return;
  pendingItemId = itemId;
  $bagBody.textContent = `Where did ${item.name} go?`;
  $bagPicker.innerHTML = BAGS.map(
    (b) => `<button type="button" data-bag="${esc(b)}">${esc(b)}</button>`,
  ).join("");
  $bagModal.hidden = false;
}

function closeBagModal() {
  $bagModal.hidden = true;
  pendingItemId = null;
}

$bagPicker.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-bag]");
  if (!btn || !pendingItemId) return;
  const itemId = pendingItemId;
  closeBagModal();
  packItem(itemId, btn.dataset.bag);
});
$bagCancel.addEventListener("click", closeBagModal);

// ---------- Wiring ----------
$tripSelect.addEventListener("change", () => {
  if (!$tripSelect.value) return;
  state.activeTrip = $tripSelect.value;
  localStorage.setItem("activePackingTrip", state.activeTrip);
  render();
});

$newTripBtn.addEventListener("click", newTrip);
$deleteTripBtn.addEventListener("click", deleteTrip);
$resetPacking.addEventListener("click", resetPacking);
$masterForm.addEventListener("submit", submitMasterItem);

$unpackedList.addEventListener("click", (e) => {
  const pack = e.target.closest("[data-action='pack']");
  if (pack) {
    openBagModal(pack.dataset.id);
    return;
  }
  const remove = e.target.closest("[data-action='remove-from-trip']");
  if (remove) removeFromTrip(remove.dataset.id);
});

$packedList.addEventListener("click", (e) => {
  const unpack = e.target.closest("[data-action='unpack']");
  if (unpack) {
    unpackItem(unpack.dataset.id);
    return;
  }
  const remove = e.target.closest("[data-action='remove-from-trip']");
  if (remove) removeFromTrip(remove.dataset.id);
});

$addItemsList.addEventListener("click", (e) => {
  const add = e.target.closest("[data-action='add-to-trip']");
  if (add) addToTrip(add.dataset.id);
});

$masterList.addEventListener("click", (e) => {
  const del = e.target.closest("[data-action='delete-master']");
  if (del) deleteMasterItem(del.dataset.id);
});

// ---------- Listeners ----------
onSnapshot(
  query(collection(db, "packingItems"), orderBy("createdAt", "desc")),
  (snap) => {
    state.masterItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  },
);

onSnapshot(
  query(collection(db, "trips"), orderBy("createdAt", "desc")),
  (snap) => {
    state.trips = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  },
);

onSnapshot(collection(db, "tripItems"), (snap) => {
  state.tripItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
});

render();
