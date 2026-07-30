# NUMBERS — anonymous real-time chat

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

**What these rules do (and don't do):** since this app has no login system,
the rules can't check "who" is writing — only "does the shape of the data
look valid". They enforce:
- IDs must be exactly 6 digits.
- Messages must be short (≤2000 chars) and have the right fields.
- A user can only write invites addressed to someone else, not to themself.
- Random/junk fields are rejected.

They do **not** prevent someone from writing crafted API calls directly
against your database (e.g. spamming messages into a room they know the ID
of, or flooding presence data). That's an inherent limitation of a fully
anonymous, login-free app. If you outgrow this, add Firebase Anonymous Auth
(still no visible login screen to the user) and tighten rules to
`auth != null`, or add Cloud Functions to rate-limit writes.

## 4. Test locally (optional but recommended)

Any static file server works, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open the page in two different browsers (or one normal + one incognito
window, since the ID is stored in `localStorage` per browser profile) to
simulate two devices talking to each other.

## 5. Deploy to GitHub Pages

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

## How it works (data model)

```
/users/{id}
    online:   boolean         (presence, backed by onDisconnect)
    lastSeen: timestamp
    status:   "idle" | "searching" | "chatting"
    invites/{roomId}: { from, timestamp }   (a pending direct-connect call)

/matchmaking/waiting
    { id, roomId } | null      (single shared slot used to pair two
                                random searchers via a Firebase transaction)

/rooms/{roomId}
    participants/{id}: true
    messages/{pushId}: { sender, text, timestamp }
    typing/{id}: boolean
    declined: boolean          (set when a direct call is declined)
```

**Random matching** uses one shared node (`matchmaking/waiting`) and a
Firebase transaction so two people who click "find a random signal" at
the same moment get atomically paired without a server — whoever arrives
second claims the first person's room.

**Connect by ID** looks up `/users/{id}/online`, creates a room named from
both IDs, and drops an "invite" in the target's own node; the target's
device is always listening on its own invites and pops up an Accept /
Ignore toast.

Rooms are deleted once both participants have left, so no message history
survives after a chat ends.

## Known limitations

- Anyone with your database URL can, in principle, write directly to it
  within what the rules allow (see the rules note above) — there's no way
  around this without adding some form of auth.
- IDs are stored in `localStorage`, so clearing site data or switching
  browsers gives a device a new ID.
- No push notifications — matching and invites only work while the tab is
  open.
