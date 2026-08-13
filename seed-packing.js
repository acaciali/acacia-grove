import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  collection,
  getDocs,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Starter master packing list, [name, category]. Seeding skips any name that
// already exists (case-insensitive), so re-running never duplicates — and
// items you've deliberately deleted from the master list stay deleted unless
// you add them back by hand or re-run this page.
const STARTER_ITEMS = [
  // Clothes (everyday basics)
  ["Underwear", "Clothes"],
  ["Socks", "Clothes"],
  ["T-shirts", "Clothes"],
  ["Pants", "Clothes"],
  ["Jeans", "Clothes"],
  ["Bras", "Clothes"],
  ["Pajamas", "Clothes"],
  ["Belt", "Clothes"],
  ["Dressy outfit", "Clothes"],
  ["Workout clothes", "Clothes"],

  // Warm Clothes
  ["Long sleeve shirts", "Warm Clothes"],
  ["Sweater", "Warm Clothes"],
  ["Jacket", "Warm Clothes"],
  ["Winter coat", "Warm Clothes"],
  ["Beanie", "Warm Clothes"],
  ["Gloves", "Warm Clothes"],
  ["Scarf", "Warm Clothes"],
  ["Thermal underlayer", "Warm Clothes"],
  ["Wool socks", "Warm Clothes"],

  // Summer Clothes
  ["Swimsuit", "Summer Clothes"],
  ["Shorts", "Summer Clothes"],
  ["Sundress", "Summer Clothes"],
  ["Sun hat", "Summer Clothes"],
  ["Beach cover-up", "Summer Clothes"],
  ["Rash guard", "Summer Clothes"],

  // Shoes
  ["Sneakers", "Shoes"],
  ["Sandals", "Shoes"],
  ["Flip flops", "Shoes"],
  ["Dress shoes", "Shoes"],
  ["Hiking boots", "Shoes"],

  // Toiletries
  ["Toothbrush", "Toiletries"],
  ["Toothpaste", "Toiletries"],
  ["Floss", "Toiletries"],
  ["Deodorant", "Toiletries"],
  ["Shampoo", "Toiletries"],
  ["Conditioner", "Toiletries"],
  ["Body wash", "Toiletries"],
  ["Razor", "Toiletries"],
  ["Hairbrush", "Toiletries"],
  ["Hair ties", "Toiletries"],
  ["Moisturizer", "Toiletries"],
  ["Sunscreen", "Toiletries"],
  ["Lip balm", "Toiletries"],
  ["Makeup", "Toiletries"],
  ["Makeup remover", "Toiletries"],
  ["Contacts & solution", "Toiletries"],
  ["Glasses", "Toiletries"],
  ["Nail clippers", "Toiletries"],
  ["Tweezers", "Toiletries"],
  ["Q-tips", "Toiletries"],
  ["Feminine products", "Toiletries"],
  ["Perfume / cologne", "Toiletries"],

  // Health & First Aid
  ["Prescription meds", "Health & First Aid"],
  ["Pain relievers", "Health & First Aid"],
  ["Band-aids", "Health & First Aid"],
  ["Allergy meds", "Health & First Aid"],
  ["Motion sickness pills", "Health & First Aid"],
  ["Vitamins", "Health & First Aid"],
  ["Hand sanitizer", "Health & First Aid"],
  ["Insect repellent", "Health & First Aid"],

  // Electronics
  ["Phone charger", "Electronics"],
  ["Portable battery", "Electronics"],
  ["Headphones", "Electronics"],
  ["Laptop / tablet", "Electronics"],
  ["Laptop / tablet charger", "Electronics"],
  ["Camera", "Electronics"],
  ["Travel adapter", "Electronics"],
  ["E-reader", "Electronics"],

  // Documents & Money
  ["Passport", "Documents & Money"],
  ["Driver's license / ID", "Documents & Money"],
  ["Credit / debit cards", "Documents & Money"],
  ["Cash", "Documents & Money"],
  ["Boarding passes", "Documents & Money"],
  ["Itinerary & reservations", "Documents & Money"],
  ["Travel insurance info", "Documents & Money"],
  ["Copies of documents", "Documents & Money"],

  // Accessories
  ["Sunglasses", "Accessories"],
  ["Umbrella", "Accessories"],
  ["Travel pillow", "Accessories"],
  ["Eye mask", "Accessories"],
  ["Earplugs", "Accessories"],
  ["Water bottle", "Accessories"],
  ["Day bag / tote", "Accessories"],
  ["Packing cubes", "Accessories"],
  ["Laundry bag", "Accessories"],
  ["Luggage tags", "Accessories"],
  ["Luggage locks", "Accessories"],

  // Miscellaneous
  ["Snacks", "Miscellaneous"],
  ["Book", "Miscellaneous"],
  ["Travel journal & pen", "Miscellaneous"],
  ["Playing cards", "Miscellaneous"],
  ["Ziplock bags", "Miscellaneous"],
  ["Tissues", "Miscellaneous"],
  ["Gum", "Miscellaneous"],
];

const $status = document.getElementById("status");
const $btn = document.getElementById("seed-btn");
const $log = document.getElementById("log");

function log(line) {
  $log.hidden = false;
  $log.textContent += line + "\n";
  $log.scrollTop = $log.scrollHeight;
}

async function existingNames() {
  const snap = await getDocs(collection(db, "packingItems"));
  return new Set(
    snap.docs.map((d) => String(d.data().name || "").trim().toLowerCase()),
  );
}

async function refresh() {
  $status.textContent = "Checking current master list…";
  $btn.disabled = true;
  try {
    const names = await existingNames();
    const missing = STARTER_ITEMS.filter(
      ([name]) => !names.has(name.trim().toLowerCase()),
    );
    $status.textContent = `Master list has ${names.size} item${
      names.size === 1 ? "" : "s"
    }. ${missing.length} of the ${STARTER_ITEMS.length} starter items are not in it yet.`;
    $btn.disabled = missing.length === 0;
    $btn.textContent =
      missing.length === 0
        ? "All starter items already added"
        : `Add ${missing.length} starter item${missing.length === 1 ? "" : "s"}`;
  } catch (err) {
    console.error(err);
    $status.innerHTML = `<div class="seed-warn">Couldn't read Firestore: ${err.message}. Check that firebase-config.js is correct and rules are published.</div>`;
  }
}

async function seed() {
  $btn.disabled = true;
  $log.textContent = "";
  try {
    const names = await existingNames();
    let added = 0;
    let skipped = 0;
    for (const [name, category] of STARTER_ITEMS) {
      if (names.has(name.trim().toLowerCase())) {
        skipped++;
        continue;
      }
      await addDoc(collection(db, "packingItems"), {
        name,
        category,
        createdAt: serverTimestamp(),
      });
      log(`  + ${name} (${category})`);
      added++;
    }
    log(`\nDone. Added ${added}, skipped ${skipped} already present.`);
  } catch (err) {
    console.error(err);
    log(`\nERROR: ${err.message}`);
  }
  refresh();
}

$btn.addEventListener("click", seed);
refresh();
