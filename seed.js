import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  addDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const DEFAULT_BUCKET_ID = "month-money";

// [name, amount] -- amounts in dollars.
const CHORES = [
  ["Vacuum (per floor)", 4],
  ["Dusting", 4],
  ["Bathtub", 3],
  ["Toilet", 5],
  ["Laundry load", 2],
  ["Folding laundry", 1],
  ["Putting clothes away (per person)", 1],
  ["Garbage", 1],
  ["Bathroom sink", 3],
  ["Bathroom mirror", 1],
  ["Bathroom floor", 2],
  ["Load of dishes", 1],
  ["Hand drying", 2],
  ["Kitchen counters, table and stove", 3],
  ["Kitchen sweep", 1],
  ["Kitchen mop", 2],
  ["Clean sink", 1],
  ["Dinner", 2],
  ["Fancy dinner / meal prepping", 5],
  ["Sides / desserts", 1],
  ["Indexing", 1],
  ["Cleaning ice / snow off car", 1],
  ["Check mail", 1],
  ["Make bed", 1],
  ["Clean appliance", 1],
  ["Ironing", 1],
  ["Oven", 3],
  ["Oven racks", 2],
  ["Stovetop / under", 2],
  ["Fill up Britta", 1],
  ["Fill up humidifier", 1],
  ["Swearing / burping", 1],
  ["Fill up handsoap / dishsoap / ice tray / etc.", 1],
  ["Water the plants", 1],
  ["Shine shoes", 1],
  ["Brush 2x", 2],
  ["Floss", 1],
  ["Water floss", 1],
  ["Violin or dance 30 min/day", 1],
  ["Sewing", 3],
  ["Put away 20 things", 1],
  ["Pills", 1],
];

// [bucketName, davidStartingBalance] -- David-owned personal buckets.
const DAVID_BUCKETS = [
  ["California Trip", 55],
  ["Lego Millennium Falcon", 0],
  ["WoT Leather", 0],
  ["PC SSD", 0],
  ["Valheim Board Game", 0],
  ["One Piece Baseball GBA", 35],
  ["Game Boy SP", 0],
];

// Starting balances in the default Month Money bucket.
const MONTH_MONEY_START = [
  { userId: "david", amount: 3 },
  { userId: "acacia", amount: -26 },
];

const $status = document.getElementById("status");
const $btn = document.getElementById("seed-btn");
const $log = document.getElementById("log");

function log(line) {
  $log.hidden = false;
  $log.textContent += line + "\n";
  $log.scrollTop = $log.scrollHeight;
}

async function readState() {
  const [choresSnap, bucketsSnap, historySnap] = await Promise.all([
    getDocs(collection(db, "chores")),
    getDocs(collection(db, "buckets")),
    getDocs(collection(db, "history")),
  ]);
  const nonDefaultBuckets = bucketsSnap.docs.filter(
    (d) => d.id !== DEFAULT_BUCKET_ID,
  );
  return {
    chores: choresSnap.size,
    buckets: bucketsSnap.size,
    nonDefaultBuckets: nonDefaultBuckets.length,
    history: historySnap.size,
  };
}

function describe(state) {
  return `Chores: ${state.chores}
Buckets: ${state.buckets} (${state.nonDefaultBuckets} besides Month Money)
History entries: ${state.history}`;
}

async function refresh() {
  $status.textContent = "Checking current data…";
  $btn.disabled = true;
  try {
    const s = await readState();
    const blocked = s.chores > 0 || s.nonDefaultBuckets > 0 || s.history > 0;
    $status.innerHTML = `<pre style="margin:0;font-family:inherit">${describe(
      s,
    )}</pre>${
      blocked
        ? `<div class="seed-warn">Data already exists. Seeding is disabled to prevent duplicates. If you want to start over, delete documents in the Firestore console first.</div>`
        : ""
    }`;
    $btn.disabled = blocked;
  } catch (err) {
    console.error(err);
    $status.innerHTML = `<div class="seed-warn">Couldn't read Firestore: ${err.message}. Check that firebase-config.js is correct and rules are published.</div>`;
  }
}

async function seedAll() {
  $btn.disabled = true;
  $log.textContent = "";
  try {
    log("Ensuring default Month Money bucket…");
    await setDoc(
      doc(db, "buckets", DEFAULT_BUCKET_ID),
      { name: "Month Money", archived: false, isDefault: true },
      { merge: true },
    );

    log("Creating David's personal buckets…");
    const bucketRefs = {};
    for (const [name, startingForDavid] of DAVID_BUCKETS) {
      const ref = await addDoc(collection(db, "buckets"), {
        name,
        archived: false,
        owner: "david",
      });
      bucketRefs[name] = ref.id;
      log(`  + ${name} (owner: david)`);
      if (startingForDavid > 0) {
        await addDoc(collection(db, "history"), {
          userId: "david",
          type: "starting",
          amount: startingForDavid,
          bucketId: ref.id,
          createdAt: serverTimestamp(),
        });
        log(`    starting balance for David: +$${startingForDavid}`);
      }
    }

    log("Seeding starting balances in Month Money…");
    for (const { userId, amount } of MONTH_MONEY_START) {
      if (amount === 0) continue;
      await addDoc(collection(db, "history"), {
        userId,
        type: "starting",
        amount,
        bucketId: DEFAULT_BUCKET_ID,
        createdAt: serverTimestamp(),
      });
      log(`  ${userId}: ${amount >= 0 ? "+" : ""}$${amount}`);
    }

    log("Adding chores…");
    for (const [name, amount] of CHORES) {
      await addDoc(collection(db, "chores"), {
        name,
        amount,
        archived: false,
      });
      log(`  + ${name} ($${amount})`);
    }

    log("\nDone. Open the app and tap your name to start.");
    $status.innerHTML = `<div class="seed-warn">Seeded successfully. You can close this page.</div>`;
  } catch (err) {
    console.error(err);
    log(`\nERROR: ${err.message}`);
    $status.innerHTML = `<div class="seed-warn">Seeding failed mid-way. Check Firestore console; some entries may have been written.</div>`;
  }
}

$btn.addEventListener("click", seedAll);
refresh();
