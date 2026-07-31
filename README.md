# צ'אט אנונימי — anonymous real-time chat

A static, login-free chat app with a Hebrew (RTL) interface. Every device
gets a random 6-digit ID the moment it first opens the site. Find a random
stranger or dial someone's number directly — everything after that happens
in real time over Firebase.

If someone keeps bothering a person on their current number, the gear icon
on the home screen opens **הגדרות** (Settings), where **אפס מספר** (reset
number) deletes the old ID from the database and issues a brand new one —
the old number stops working immediately, so whoever was messaging that ID
can no longer reach the device.

Files:
```
index.html          the three screens (home / searching / chat)
style.css            mobile-first styling
app.js                all app logic
firebase-config.js    YOUR Firebase project keys go here
firebase-rules.json   Realtime Database security rules
```

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com → **Add project** → follow the
   wizard (you can disable Google Analytics, it's not needed).
2. In the left sidebar, go to **Build → Realtime Database → Create Database**.
   - Pick a region.
   - Start in **locked mode** (we'll paste real rules in a moment).
3. Go to **Project settings → General**, scroll to "Your apps", click the
   **`</>`** (web) icon, register the app (no need for Firebase Hosting).
4. Firebase will show you a `firebaseConfig` object — copy it.

## 2. Add your config

Open `firebase-config.js` and replace the placeholder values with the real
config object from step 1:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

This file is safe to publish. It only identifies your Firebase project —
it does not grant access by itself. Actual access control comes from the
database rules in the next step.

## 3. Apply the security rules

1. In the Firebase console, go to **Realtime Database → Rules**.
2. Delete everything in the editor and paste in the contents of
   `firebase-rules.json` from this repo.
3. Click **Publish**.

**What these rules do (and don't do):** since this app has no login system
for regular users, the rules can't check "who" is writing — only "does the
shape of the data look valid". They enforce:
- IDs must be exactly 6 digits.
- Messages must be short (≤2000 chars) and have the right fields.
- A user can only write invites addressed to someone else, not to themself.
- A blocked device (see below) cannot join a room, register for random
  matching, send an invite, or send a message — enforced server-side, not
  just hidden in the UI.
- Random/junk fields are rejected.

They do **not** prevent someone from writing crafted API calls directly
against your database (e.g. spamming messages into a room they know the ID
of). That's an inherent limitation of a login-free app for regular users.

## 4. Set up your admin account (for reports & blocking)

The moderation panel (reviewing reports, blocking abusive devices, messaging
blocked users) is protected by a **real Firebase account that only you
control** — not by the "137925" code alone. That code just opens the
sign-in box in the app; the password is what actually protects the panel.

1. In the Firebase console, go to **Build → Authentication → Get started**,
   then enable the **Email/Password** sign-in provider.
2. Go to the **Users** tab → **Add user** → enter an email and password
   you'll remember (this does not need to be a real inbox — it's just your
   admin login, e.g. `admin@yourdomain.example`).
3. Click on the new user and copy their **User UID** (a long string like
   `a1B2c3D4e5F6...`).
4. Paste that UID into **`firebase-config.js`**, replacing
   `REPLACE_WITH_YOUR_ADMIN_UID`.
5. Open **`firebase-rules.json`** and replace **every** occurrence of
   `REPLACE_WITH_YOUR_ADMIN_UID` (there are 7) with that same UID, then
   re-paste the whole file into the Rules editor in the console and
   **Publish** again.

To open the admin panel in the app: on the home screen, type **137925**
into the "connect by ID" field and press Connect. A sign-in box appears —
enter the email/password from step 2. If they match your admin UID, you'll
see the dashboard; anyone else who happens to type that number just gets a
normal "invalid login" error, because they don't have your password.

**Being upfront about the limits here:** without a backend server, this is
the strongest access control a static site can offer — genuine password
protection enforced by Firebase's servers, not just hidden client code. It
is not, however, hardened against a determined, technical attacker (e.g.
password guessing against your one account has no built-in lockout on the
free tier). Use a strong, unique password for the admin account.

## How reporting & blocking work

- Inside any chat, a small 🚩 icon in the header lets either person report
  the conversation (tap once to arm it, tap again to confirm — prevents
  accidental taps).
- The moment a report is filed, **both** people are immediately removed
  from the chat and **both** get a brand-new 6-digit number — the app tells
  each of them their number changed. This happens regardless of who was at
  fault; it's an instant safety measure, not a verdict.
- The report itself (including a copy of the last ~50 messages) is queued
  for you to review in the admin panel.
- In the panel, each report lets you either mark it **handled** (no action)
  or **block** one of the two people involved, optionally leaving a note
  explaining why.
- Blocking is tied to the **device**, not the number — so even if a blocked
  person resets their number (or it gets rotated by another report), they
  stay blocked. A blocked device can no longer start random chats, connect
  by ID, or be reached by invites.
- A blocked person still sees a **"contact admin"** option on their home
  screen, opening a private one-on-one channel with you. You can reply from
  the **"משתמשים חסומים"** (Blocked users) tab in the panel, and you can
  also mute that channel per-person if needed. Unblocking restores full
  access at any time.

## Acting as a user (undercover mode)

At the top of the admin dashboard, a fixed panel lets you drop into a live
chat exactly the way a regular user would — **מצא אות אקראי** (find a
random signal) or **חיוג ישירות** (dial directly):

- Each time you use either one, you get a **fresh, throwaway 6-digit
  number** — never your own, never reused, and never saved to the
  browser's storage. A peer who notes it down can't dial it again later to
  reach you.
- Inside that chat the 🚩 report icon is replaced with a **⛔ block icon**:
  it blocks the person you're talking to immediately (still with an
  optional reason field), no report step needed. The moment you confirm,
  they're kicked out of the chat and shown that they were blocked, and
  you're returned straight to the dashboard.
- By default, the other person has **no way of knowing** they're talking
  to the admin. If you want them to know, either check **"לסמן מראש..."**
  before dialing/searching, or hit the 🛡 button in the chat header at any
  point during the conversation — it shows them a "מנהל" badge from then
  on. Revealing is one-way; there's no way to hide it again once shown.

## 5. Test locally (optional but recommended)

Any static file server works, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open the page in two different browsers (or one normal + one incognito
window, since the ID is stored in `localStorage` per browser profile) to
simulate two devices talking to each other.

## 6. Deploy to GitHub Pages

1. Create a new GitHub repository and push these files to it:
   ```bash
   git init
   git add .
   git commit -m "Anonymous chat app"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
2. On GitHub, open **Settings → Pages**.
3. Under "Build and deployment", set **Source** to **Deploy from a branch**,
   branch `main`, folder `/ (root)`. Save.
4. GitHub gives you a URL like
   `https://YOUR_USERNAME.github.io/YOUR_REPO/` — that's your live app.

No build step is needed — it's plain HTML/CSS/JS loading Firebase from a
CDN, so GitHub Pages can serve it as-is.

## If changes don't show up after you redeploy (caching)

GitHub Pages is served through a CDN (Fastly), which caches `style.css` and
`app.js` for a while independent of your browser. On mobile this is worse:
"clear cache" in Android's app settings often clears Chrome's *image/media*
cache but not what's serving the page, so old files can keep showing up
even after that.

The fix already built into `index.html`: the stylesheet and script tags are
loaded with a version marker —

```html
<link rel="stylesheet" href="style.css?v=3">
...
<script src="app.js?v=3"></script>
```

To a browser/CDN, `style.css?v=3` and `style.css?v=4` are two completely
different URLs, so a stale cached copy can never be served for the new
version. **Every time you edit `style.css` or `app.js` and push the
change, bump the `v=` number** in `index.html` (both the `<link>` and the
`<script>` tag). That alone forces every device to fetch the fresh files,
no manual cache-clearing needed on your end or the user's.

Two more things worth knowing:
- After a `git push`, GitHub Pages can take a minute or two to actually
  rebuild — check the **Actions** tab in your repo for a green checkmark
  before assuming a change didn't work.
- A quick way to confirm what a phone is actually loading: open
  `https://YOUR_USERNAME.github.io/YOUR_REPO/app.js` directly in the phone's
  browser and check the number in the URL bar / page matches what you
  expect, or search the page source for a string you know is only in the
  new version.

## How it works (data model)

```
/users/{id}
    online:   boolean         (presence, backed by onDisconnect)
    lastSeen: timestamp
    status:   "idle" | "searching" | "chatting"
    invites/{roomId}: { from, fromDevice, timestamp }  (pending direct-connect call)

/matchmaking/waiting
    { id, roomId, deviceId } | null   (single shared slot used to pair two
                                       random searchers via a transaction)

/rooms/{roomId}
    participants/{id}: { deviceId, joinedAt }
    messages/{pushId}: { sender, senderDevice, text, timestamp }
    typing/{id}: boolean
    declined: boolean          (set when a direct call is declined)
    reported: boolean          (set the instant either side files a report —
                                 both clients react to this and auto-rotate)
    adminRevealed: boolean     (admin-only write — shows the peer a "מנהל"
                                 badge; set during undercover mode, see above)
    adminBlockedPeer: boolean  (admin-only write — set when the admin
                                 directly blocks the other side of an
                                 undercover chat; kicks them out immediately)

/reports/{reportId}                          (admin-read only)
    roomId, reporterId, reporterDevice, reportedId, reportedDevice
    timestamp, status: "pending" | "handled" | "actioned"
    messages: [ {sender, text, timestamp}, ... ]   (snapshot taken at report time)
    resolution: { action, note, blockedDeviceId, at }

/blocklist/{deviceId}                        (list is admin-read only;
                                               each entry is self-checkable)
    blocked: boolean
    reason: string
    blockedAt: timestamp
    canMessageAdmin: boolean

/adminChats/{deviceId}/messages/{pushId}
    { sender: "user" | "admin", text, timestamp }
```

**Random matching** uses one shared node (`matchmaking/waiting`) and a
Firebase transaction so two people who click "find a random signal" at
the same moment get atomically paired without a server — whoever arrives
second claims the first person's room.

**Connect by ID** looks up `/users/{id}/online`, creates a room named from
both IDs, and drops an "invite" in the target's own node; the target's
device is always listening on its own invites and pops up an Accept /
Ignore toast.

**Reporting** copies a snapshot of the room's messages into `/reports`,
then flips `rooms/{roomId}/reported` to `true`. Both participants' clients
are already listening on that flag (it's part of joining any chat), so
both react independently and simultaneously: leave the room, wipe their
old number, generate a fresh one, and land back on the home screen with a
notice.

**Direct blocking from undercover mode** works the same way but simpler:
confirming the block writes to `/blocklist` and flips
`rooms/{roomId}/adminBlockedPeer` to `true`, which the blocked side's
already-listening client reacts to by leaving immediately and showing a
notice — no ID rotation, since blocking is keyed to the device, not the
number.

Rooms are deleted once both participants have left, so no message history
survives after a chat ends (aside from the snapshot copied into a report,
if one was filed).

## Known limitations

- Anyone with your database URL can, in principle, write directly to it
  within what the rules allow (see the rules note above) — there's no way
  around this for regular (login-free) users without changing the app's
  core "no login" design.
- IDs are stored in `localStorage`, so clearing site data or switching
  browsers gives a device a new ID *and* a new device fingerprint — a
  clever way around a block, though it does cost the ability to be found
  by a previously-shared number.
- No push notifications — matching, invites, and admin messages only
  arrive while the tab is open.
- The admin password has no built-in lockout after repeated failed
  attempts (a Firebase free-tier constraint) — use a strong, unique
  password for that one account.
