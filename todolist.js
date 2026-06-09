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
const $title = document.getElementById("new-todo");
const $date = document.getElementById("new-todo-date");
const $cat = document.getElementById("new-todo-category");
const $cats = document.getElementById("todo-categories");
const $list = document.getElementById("todo-list");
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

// Local-date helpers. Due dates are stored as "YYYY-MM-DD" strings so they
// stay anchored to a calendar day regardless of timezone.
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDueLabel(due) {
  if (!due) return "";
  const today = todayStr();
  if (due === today) return "Today";
  const [y, m, d] = due.split("-").map(Number);
  const dueDate = new Date(y, m - 1, d);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diffDays = Math.round((dueDate - now) / 86400000);
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  const sameYear = dueDate.getFullYear() === now.getFullYear();
  const opts = sameYear
    ? { weekday: "short", month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return dueDate.toLocaleDateString(undefined, opts);
}

function isOverdue(due) {
  if (!due) return false;
  return due < todayStr();
}

function sortItems(items) {
  // Unchecked first, sorted by due date asc with no-date last; then checked.
  const unchecked = items.filter((i) => !i.checked);
  const checked = items.filter((i) => i.checked);
  unchecked.sort((a, b) => {
    const ad = a.dueDate || "";
    const bd = b.dueDate || "";
    if (ad && !bd) return -1;
    if (!ad && bd) return 1;
    if (ad !== bd) return ad < bd ? -1 : 1;
    // Tiebreak: newest first.
    const at = a.createdAt?.toMillis?.() ?? 0;
    const bt = b.createdAt?.toMillis?.() ?? 0;
    return bt - at;
  });
  checked.sort((a, b) => {
    const at = a.completedAt?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0;
    const bt = b.completedAt?.toMillis?.() ?? b.createdAt?.toMillis?.() ?? 0;
    return bt - at;
  });
  return [...unchecked, ...checked];
}

function refreshCategoryOptions() {
  const seen = new Set();
  for (const item of state.items) {
    const c = (item.category || "").trim();
    if (c) seen.add(c);
  }
  const opts = [...seen].sort((a, b) => a.localeCompare(b));
  $cats.innerHTML = opts.map((c) => `<option value="${esc(c)}"></option>`).join("");
}

function render() {
  refreshCategoryOptions();

  if (state.items.length === 0) {
    $list.innerHTML = `<li class="todo-empty">Nothing here yet. Add your first todo.</li>`;
    $clear.hidden = true;
    return;
  }

  const ordered = sortItems(state.items);
  const anyChecked = state.items.some((i) => i.checked);

  $list.innerHTML = ordered
    .map((item) => {
      const dueLabel = formatDueLabel(item.dueDate);
      const overdue = !item.checked && isOverdue(item.dueDate);
      const hasMeta = dueLabel || item.category;
      return `
        <li class="todo-row ${item.checked ? "checked" : ""}" data-id="${esc(item.id)}">
          <button class="todo-toggle" data-action="toggle" data-id="${esc(item.id)}" aria-label="${item.checked ? "Uncheck" : "Check"} ${esc(item.title)}">
            <span class="todo-box" aria-hidden="true"></span>
            <span class="todo-body">
              <span class="todo-name">${esc(item.title)}</span>
              ${
                hasMeta
                  ? `<span class="todo-meta">
                      ${dueLabel ? `<span class="todo-due ${overdue ? "overdue" : ""}">${esc(dueLabel)}</span>` : ""}
                      ${item.category ? `<span class="todo-cat">${esc(item.category)}</span>` : ""}
                    </span>`
                  : ""
              }
            </span>
          </button>
          <button class="todo-delete" data-action="delete" data-id="${esc(item.id)}" aria-label="Delete ${esc(item.title)}">×</button>
        </li>`;
    })
    .join("");

  $clear.hidden = !anyChecked;
}

async function addItem(e) {
  e.preventDefault();
  const title = $title.value.trim();
  if (!title) return;
  const dueDate = $date.value || null;
  const category = $cat.value.trim() || null;

  $title.value = "";
  $date.value = "";
  $cat.value = "";
  $title.focus();

  try {
    await addDoc(collection(db, "todos"), {
      title,
      dueDate,
      category,
      checked: false,
      createdAt: serverTimestamp(),
      completedAt: null,
    });
  } catch (err) {
    console.error(err);
    toast("Couldn't add", "error");
  }
}

async function toggleItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const willCheck = !item.checked;
  try {
    await updateDoc(doc(db, "todos", id), {
      checked: willCheck,
      completedAt: willCheck ? serverTimestamp() : null,
    });
  } catch (err) {
    console.error(err);
    toast("Couldn't update", "error");
  }
}

async function deleteItem(id) {
  try {
    await deleteDoc(doc(db, "todos", id));
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
      batch.delete(doc(db, "todos", item.id));
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
  query(collection(db, "todos"), orderBy("createdAt", "desc")),
  (snap) => {
    state.items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  },
);

render();
