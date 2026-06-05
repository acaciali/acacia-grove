import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
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

const state = { items: [] };

const $form = document.getElementById("add-form");
const $input = document.getElementById("new-item");
const $list = document.getElementById("grocery-list");
const $clear = document.getElementById("clear-checked");
const $status = document.getElementById("status");

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

function render() {
  if (state.items.length === 0) {
    $list.innerHTML = `<li class="grocery-empty">Nothing on the list. Add the first item.</li>`;
    $clear.hidden = true;
    return;
  }

  const unchecked = state.items.filter((i) => !i.checked);
  const checked = state.items.filter((i) => i.checked);
  const ordered = [...unchecked, ...checked];

  $list.innerHTML = ordered
    .map(
      (item) => `
        <li class="grocery-row ${item.checked ? "checked" : ""}" data-id="${esc(
          item.id,
        )}">
          <button class="grocery-toggle" data-action="toggle" data-id="${esc(
            item.id,
          )}" aria-label="${item.checked ? "Uncheck" : "Check"} ${esc(item.name)}">
            <span class="grocery-box" aria-hidden="true"></span>
            <span class="grocery-name">${esc(item.name)}</span>
          </button>
          <button class="grocery-delete" data-action="delete" data-id="${esc(
            item.id,
          )}" aria-label="Delete ${esc(item.name)}">×</button>
        </li>`,
    )
    .join("");

  $clear.hidden = checked.length === 0;
}

async function addItem(e) {
  e.preventDefault();
  const name = $input.value.trim();
  if (!name) return;
  $input.value = "";
  try {
    await addDoc(collection(db, "groceries"), {
      name,
      checked: false,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.error(err);
    toast("Couldn't add", "error");
  }
}

async function toggleItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  try {
    await updateDoc(doc(db, "groceries", id), { checked: !item.checked });
  } catch (err) {
    console.error(err);
    toast("Couldn't update", "error");
  }
}

async function deleteItem(id) {
  try {
    await deleteDoc(doc(db, "groceries", id));
  } catch (err) {
    console.error(err);
    toast("Couldn't delete", "error");
  }
}

async function clearChecked() {
  const checked = state.items.filter((i) => i.checked);
  if (checked.length === 0) return;
  try {
    const batch = writeBatch(db);
    for (const item of checked) {
      batch.delete(doc(db, "groceries", item.id));
    }
    await batch.commit();
    toast(`Cleared ${checked.length} item${checked.length === 1 ? "" : "s"}`);
  } catch (err) {
    console.error(err);
    toast("Couldn't clear", "error");
  }
}

$form.addEventListener("submit", addItem);
$clear.addEventListener("click", clearChecked);

$list.addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-action='toggle']");
  if (toggle) {
    toggleItem(toggle.dataset.id);
    return;
  }
  const del = e.target.closest("[data-action='delete']");
  if (del) {
    deleteItem(del.dataset.id);
  }
});

onSnapshot(
  query(collection(db, "groceries"), orderBy("createdAt", "desc")),
  (snap) => {
    state.items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  },
);

render();
