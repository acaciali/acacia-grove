# Month Money

Mobile-first shared allowance tracker for two users. Tap a chore, see the
balance update in real time on the other phone. Vanilla HTML/CSS/JS +
Firebase Firestore, hosted on GitHub Pages. No build step.

## How it works

- Two hardcoded users: `acacia` and `david`. The top toggle picks who's active
  on this device; the choice is remembered in `localStorage`.
- **Buckets** are named pools of money, shared across both users — e.g.
  `Month Money`, `California Trip`, `Switch 2`. Each user has their own balance
  in each bucket. The active bucket is highlighted; tap any bucket card to
  switch. The active bucket is remembered per device.
- Tapping a chore writes a `history` entry into the active bucket for the
  active user.
- `+$25 month`, `+$10 holiday`, and `Spend` all act on the active bucket. To
  save chore money toward a trip, switch to that bucket first, then tap the
  chore.
- Undo writes a *reversing* history entry rather than editing/deleting the
  original — history is append-only.
- Balance for a user/bucket = sum of all `amount` fields where userId and
  bucketId match. Reversals cancel naturally (opposite sign).
- Negative balances are allowed and shown in red.
- The `Month Money` bucket is the default; it can be renamed but not archived.
  Custom buckets can be archived (soft-deleted) so their history still
  resolves to a name.

## First-time setup

### 1. Create a Firebase project

1. Go to <https://console.firebase.google.com> and create a new project.
2. In the project, open **Build → Firestore Database → Create database**.
   Pick **production mode** and any region.
3. Open **Firestore → Rules**, replace the contents with the rules from
   [`firestore.rules`](./firestore.rules), and click **Publish**.

### 2. Register a Web App and copy the config

1. In the Firebase console, click the gear icon → **Project settings**.
2. Under **Your apps**, click the `</>` (Web) icon. Name it anything.
3. Skip the hosting step (we use GitHub Pages).
4. Copy the `firebaseConfig` object and paste it into
   [`firebase-config.js`](./firebase-config.js), replacing the placeholders.
5. Commit and push.

The web config is a public project identifier — it's safe to commit. Access
control is enforced by the Firestore rules.

### 3. Enable GitHub Pages

1. In this repo: **Settings → Pages**.
2. Source: **Deploy from a branch**, Branch: `main`, Folder: `/ (root)`.
3. Save. Wait ~30 seconds, then open the URL GitHub shows.

### 4. Seed the chore list and (optionally) extra buckets

Open the published URL on a phone or desktop:

- Expand **Manage chores** and add each chore with its dollar amount.
- Expand **Manage buckets** to add savings buckets like `California Trip`.
  The `Month Money` bucket is created automatically on first launch.

Anyone with the URL can edit.

## Daily use

- Bookmark the URL on each phone, or "Add to Home Screen" on iOS for an
  app-like icon.
- Tap your name once on first open. The device remembers it.
- Tap the bucket you want money to go to (or come from) — the active bucket
  is outlined and its balance is the big number at the top.
- Tap chores as you do them. Tap **Spend** to record purchases. Tap
  **+$25 month** on the 1st and **+$10 holiday** on holidays. Everything
  affects the active bucket.
- Mis-tap? Hit **Undo** next to the entry in Recent.

## File map

- `index.html` — single-page UI
- `app.js` — all logic (Firebase listeners, render, actions)
- `style.css` — mobile-first styles
- `firebase-config.js` — your Firebase web config (replace placeholders)
- `firestore.rules` — paste into the Firebase console

## Notes

- History is fetched with `limit(200)`. If you outgrow that, add a "Load more"
  button — until then, two users on Firestore's free tier are nowhere near
  any quota.
- Firebase JS SDK is loaded from `gstatic.com` at a pinned version (`10.13.0`
  in `app.js`). Bump it intentionally if needed.
