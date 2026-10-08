/* ============================================================
   צ'אט אנונימי — Anonymous Chat
   All app logic: device identity, presence, random matchmaking,
   connect-by-ID, the chat room, abuse reporting (with automatic
   dual ID rotation), device-level blocking, the blocked-user
   support channel, and the admin dashboard.
   ============================================================ */

// Two separate Firebase app instances, each with its own auth session and
// its own database connection:
//   - the default app signs every visitor in anonymously. That anonymous
//     account is what OWNS a number on the server (see /ids and /owners in
//     firebase-rules.json), so a number can't be claimed twice and can't be
//     swapped by editing localStorage or variables in devtools.
//   - the 'admin' app holds only the admin's email/password session, so
//     signing in/out as admin never touches the visitor's anonymous identity.
const userApp  = firebase.initializeApp(firebaseConfig);
const adminApp = firebase.initializeApp(firebaseConfig, 'admin');
const userDb   = userApp.database();
const adminDb  = adminApp.database();
const userAuth = userApp.auth();
const auth     = adminApp.auth();

// the connection every "regular user" action goes through. Points at the
// admin connection only while the admin is undercover (section 11b), since
// the throwaway number used there is owned by the admin account.
let db = userDb;

const ID_LENGTH = 6;
const ID_REGEX = /^[0-9]{6}$/;

// ---------- DOM: core screens ----------
const screens = {
  home: document.getElementById('screen-home'),
  settings: document.getElementById('screen-settings'),
  search: document.getElementById('screen-search'),
  chat: document.getElementById('screen-chat'),
  support: document.getElementById('screen-support'),
  admin: document.getElementById('screen-admin'),
};
const myIdEl        = document.getElementById('my-id');
const btnCopyId     = document.getElementById('btn-copy-id');
const homeStatusEl  = document.getElementById('home-status');
const homeActionsEl = document.getElementById('home-actions');
const blockedNoticeEl = document.getElementById('blocked-notice');
const blockedReasonTextEl = document.getElementById('blocked-reason-text');
const btnRandom     = document.getElementById('btn-random');
const formConnect   = document.getElementById('form-connect');
const inputPartner  = document.getElementById('input-partner-id');
const btnCancel     = document.getElementById('btn-cancel-search');
const searchIdCenter= document.getElementById('search-id-center');
const scanText      = document.getElementById('scan-text');

const btnSettings     = document.getElementById('btn-settings');
const btnSettingsBack = document.getElementById('btn-settings-back');
const settingsIdEl    = document.getElementById('settings-id');
const btnResetId      = document.getElementById('btn-reset-id');
const settingsStatusEl= document.getElementById('settings-status');

const inviteToast   = document.getElementById('invite-toast');
const inviteFromEl  = document.getElementById('invite-from');
const btnAccept     = document.getElementById('btn-accept');
const btnDecline    = document.getElementById('btn-decline');

const btnLeave      = document.getElementById('btn-leave');
const btnReport     = document.getElementById('btn-report');
const btnAdminReveal = document.getElementById('btn-admin-reveal');
const peerAdminBadgeEl = document.getElementById('peer-admin-badge');
const peerIdEl      = document.getElementById('peer-id');
const peerStatusEl  = document.getElementById('peer-status');
const messagesEl    = document.getElementById('messages');
const typingIndicator = document.getElementById('typing-indicator');
const formMessage   = document.getElementById('form-message');
const inputMessage  = document.getElementById('input-message');

const btnOpenSupport = document.getElementById('btn-open-support');
const btnSupportBack = document.getElementById('btn-support-back');
const supportMessagesEl = document.getElementById('support-messages');
const supportMutedNoteEl = document.getElementById('support-muted-note');
const formSupportMessage = document.getElementById('form-support-message');
const inputSupportMessage = document.getElementById('input-support-message');

// ---------- app state ----------
let myId = null;
let myDeviceId = null;
let state = 'idle'; // idle | searching | chatting
let currentRoomId = null;
let currentPeerId = null;
let pendingInviteRoomId = null;
let searchTimeoutHandle = null;
let typingClearHandle = null;
let blockInfo = null; // { blocked, reason, canMessageAdmin }

// admin "act as a regular user" undercover session — see section 11b
let adminActingAsUser = false;
let adminRealId = null;
let adminRealDeviceId = null;
let adminRevealPreMarked = false;

const activeListeners = [];
function track(ref, event, cb) {
  ref.on(event, cb);
  activeListeners.push({ ref, event, cb });
}
function clearAllListeners() {
  activeListeners.forEach(({ ref, event, cb }) => ref.off(event, cb));
  activeListeners.length = 0;
}

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function setHomeStatus(msg, kind) {
  homeStatusEl.textContent = msg || '';
  homeStatusEl.className = 'status-line' + (kind ? ' ' + kind : '');
}

function renderMyId() {
  myIdEl.textContent = formatId(myId);
  myIdEl.classList.remove('loading');
  btnCopyId.hidden = false;
}

btnCopyId.addEventListener('click', async () => {
  if (!myId) return;
  const label = btnCopyId.querySelector('span');
  try {
    await navigator.clipboard.writeText(myId);
    label.textContent = 'הועתק!';
    btnCopyId.classList.add('done');
  } catch (e) {
    label.textContent = 'לא ניתן להעתיק';
  }
  setTimeout(() => {
    label.textContent = 'העתקת המספר';
    btnCopyId.classList.remove('done');
  }, 1600);
});

function formatId(id) {
  if (!id) return '';
  // \u2066 / \u2069 = Unicode LRI/PDI isolate marks. Without them, a
  // space-separated digit sequence embedded inside Hebrew (RTL) text can
  // get visually reordered by the browser's bidi algorithm — wrapping it
  // in an isolate keeps the digits in the correct left-to-right order
  // no matter what Hebrew text surrounds it.
  return '\u2066' + id.split('').join(' ') + '\u2069';
}

// ============================================================
// 1. DEVICE IDENTITY
//    myId    — the visible 6-digit number, rotates freely
//    deviceId — a hidden, persistent id used only for blocking
// ============================================================
function localDeviceIdCandidate() {
  let id = null;
  try { id = localStorage.getItem('numbers_device_id'); } catch (e) { /* ignore */ }
  if (id && id.length <= 64) return id;
  id = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  try { localStorage.setItem('numbers_device_id', id); } catch (e) { /* ignore */ }
  return id;
}

// resolves with the visitor's anonymous Firebase account, signing in if
// needed. A leftover non-anonymous session on the default app (from older
// versions, where the admin signed in there) is signed out first.
function ensureUserAccount() {
  return new Promise((resolve, reject) => {
    const unsub = userAuth.onAuthStateChanged(async (user) => {
      if (user && user.isAnonymous) {
        unsub();
        resolve(user);
        return;
      }
      try {
        if (user) await userAuth.signOut();
        else await userAuth.signInAnonymously();
      } catch (err) {
        unsub();
        reject(err);
      }
    });
  });
}

// the device id is bound to the anonymous account on the server the first
// time it's seen, and can never be changed afterwards (see the rules) —
// the copy in localStorage is only used as the initial value, so existing
// devices keep their id (and any block on it)
async function loadOrBindDeviceId(uid) {
  const ref = userDb.ref('owners/' + uid + '/deviceId');
  const snap = await ref.once('value');
  if (snap.exists()) return snap.val();
  const candidate = localDeviceIdCandidate();
  await ref.set(candidate);
  return candidate;
}

function randomSixDigitId() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

// Claims a brand-new number for the signed-in account in ONE atomic write:
// the number's /ids entry, the account's /owners pointer, and (when
// replacing) the release of the previous number. The rules only accept the
// claim if /ids/{number} is still empty, so if two devices race for the
// same number the server lets exactly one through and the other simply
// retries with a different candidate — two people can never end up with
// the same number. The number itself is never trusted from the client
// afterwards: it's read back from /owners on every load.
async function claimFreshId(conn, uid, opts = {}) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = randomSixDigitId();
    if (candidate === opts.previousId) continue;
    const pre = await conn.ref('ids/' + candidate).once('value');
    if (pre.exists()) continue;

    const updates = {};
    updates['ids/' + candidate] = uid;
    if (opts.bindOwner) {
      updates['owners/' + uid + '/id'] = candidate;
      if (opts.previousId && opts.ownsPrevious) updates['ids/' + opts.previousId] = null;
    }
    try {
      await conn.ref().update(updates);
      return candidate;
    } catch (err) {
      // someone else claimed it between the check and the write — try another
    }
  }
  throw new Error('could not allocate a number');
}

async function idOwnedBy(conn, id, uid) {
  if (!id) return false;
  const snap = await conn.ref('ids/' + id).once('value');
  return snap.val() === uid;
}

async function loadOrClaimMyId(uid) {
  const snap = await userDb.ref('owners/' + uid + '/id').once('value');
  const current = snap.val();
  if (current && ID_REGEX.test(current) && await idOwnedBy(userDb, current, uid)) return current;
  const fresh = await claimFreshId(userDb, uid, { bindOwner: true, previousId: current, ownsPrevious: false });
  // a recycled number may still carry stale data from a previous owner
  try { await userDb.ref('users/' + fresh).remove(); } catch (e) { /* ignore */ }
  return fresh;
}

// gives the current account a new number and releases the old one
async function rotateMyId() {
  const uid = userAuth.currentUser.uid;
  const oldId = myId;
  try { await userDb.ref('users/' + oldId).onDisconnect().cancel(); } catch (e) { /* ignore */ }
  try { await userDb.ref('users/' + oldId).remove(); } catch (e) { /* ignore */ }
  const fresh = await claimFreshId(userDb, uid, { bindOwner: true, previousId: oldId, ownsPrevious: true });
  try { await userDb.ref('users/' + fresh).remove(); } catch (e) { /* ignore */ }
  try { localStorage.removeItem('numbers_my_id'); } catch (e) { /* legacy key, unused now */ }
  return fresh;
}

// ============================================================
// 2. PRESENCE
// ============================================================
function applyPresence() {
  const myRef = db.ref('users/' + myId);
  myRef.onDisconnect().update({
    online: false,
    lastSeen: firebase.database.ServerValue.TIMESTAMP,
  });
  myRef.update({
    online: true,
    lastSeen: firebase.database.ServerValue.TIMESTAMP,
    status: state,
  });
}

function initPresence() {
  db.ref('.info/connected').on('value', (snap) => {
    if (snap.val() === true) applyPresence();
  });
}

function setMyStatus(status) {
  state = status;
  db.ref('users/' + myId).update({ status });
}

// ============================================================
// 3. BLOCK STATUS (device-level)
// ============================================================
function listenForBlockStatus() {
  db.ref('blocklist/' + myDeviceId).on('value', (snap) => {
    blockInfo = snap.val();
    applyBlockedUI();
  });
}

function applyBlockedUI() {
  const isBlocked = !!(blockInfo && blockInfo.blocked);
  homeActionsEl.hidden = isBlocked;
  blockedNoticeEl.hidden = !isBlocked;
  if (isBlocked) {
    blockedReasonTextEl.textContent =
      (blockInfo.reason && blockInfo.reason.trim())
        ? blockInfo.reason
        : 'נחסמת מהאפשרות לשוחח עם משתמשים אחרים.';
  }
}

// ============================================================
// 4. INCOMING INVITES (connect-by-ID)
// ============================================================
let invitesRef = null;
let invitesCb = null;

function listenForInvites() {
  if (invitesRef && invitesCb) invitesRef.off('child_added', invitesCb);

  invitesRef = db.ref('users/' + myId + '/invites');
  invitesCb = (snap) => {
    const invite = snap.val();
    const roomId = snap.key;
    if (!invite || !invite.from) return;

    if (state !== 'idle') {
      db.ref('users/' + myId + '/invites/' + roomId).remove();
      return;
    }

    pendingInviteRoomId = roomId;
    inviteFromEl.textContent = formatId(invite.from);
    inviteToast.hidden = false;

    db.ref('rooms/' + roomId + '/canceled').on('value', (s) => {
      if (s.val() === true && pendingInviteRoomId === roomId) {
        inviteToast.hidden = true;
        pendingInviteRoomId = null;
      }
    });
  };
  invitesRef.on('child_added', invitesCb);
}

btnAccept.addEventListener('click', async () => {
  if (!pendingInviteRoomId) return;
  const roomId = pendingInviteRoomId;
  const snap = await db.ref('users/' + myId + '/invites/' + roomId).once('value');
  const invite = snap.val();
  inviteToast.hidden = true;
  pendingInviteRoomId = null;
  if (!invite) return;

  try {
    await db.ref('rooms/' + roomId + '/participants/' + myId).set({
      deviceId: myDeviceId,
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
    });
  } catch (e) {
    setHomeStatus('לא ניתן להתחבר כרגע', 'error');
    return;
  }
  db.ref('users/' + myId + '/invites/' + roomId).remove();
  joinChatRoom(roomId, invite.from);
});

btnDecline.addEventListener('click', () => {
  if (!pendingInviteRoomId) return;
  const roomId = pendingInviteRoomId;
  db.ref('rooms/' + roomId + '/declined').set(true);
  db.ref('users/' + myId + '/invites/' + roomId).remove();
  inviteToast.hidden = true;
  pendingInviteRoomId = null;
});

// ============================================================
// 5. CONNECT BY ID (direct call)
// ============================================================
formConnect.addEventListener('submit', async (e) => {
  e.preventDefault();
  const targetId = inputPartner.value.trim();
  const ok = await attemptDirectCall(targetId, setHomeStatus);
  if (ok) inputPartner.value = '';
});

inputPartner.addEventListener('input', () => {
  inputPartner.value = inputPartner.value.replace(/\D/g, '').slice(0, ID_LENGTH);
});

// shared by the home-screen dial form and the admin undercover dial form
async function attemptDirectCall(targetId, setStatus) {
  if (!myId) {
    setStatus('עדיין מתחבר/ת, נסו שוב בעוד רגע', 'error');
    return false;
  }
  if (!ID_REGEX.test(targetId)) {
    setStatus('הזן/י מספר תקין בן 6 ספרות', 'error');
    return false;
  }
  if (targetId === myId) {
    setStatus('זה האות שלך', 'error');
    return false;
  }

  setStatus('בודק/ת אות…');
  const snap = await db.ref('users/' + targetId + '/online').once('value');
  if (snap.val() !== true) {
    setStatus('האות הזה לא מחובר', 'error');
    return false;
  }

  const roomId = [myId, targetId].sort().join('_') + '_' + Date.now();
  try {
    await db.ref('rooms/' + roomId + '/participants/' + myId).set({
      deviceId: myDeviceId,
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    await db.ref('users/' + targetId + '/invites/' + roomId).set({
      from: myId,
      fromDevice: myDeviceId,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    });
  } catch (err) {
    setStatus('לא ניתן להתחבר כרגע', 'error');
    return false;
  }

  setStatus('');
  joinChatRoom(roomId, targetId, { calling: true });
  return true;
}

// ============================================================
// 6. RANDOM MATCHMAKING
// ============================================================
btnRandom.addEventListener('click', startRandomSearch);
btnCancel.addEventListener('click', () => cancelRandomSearch());

let myWaitingRoomId = null;

function startRandomSearch() {
  if (!myId) return; // still connecting
  setMyStatus('searching');
  showScreen('search');
  searchIdCenter.textContent = formatId(myId);
  scanText.textContent = 'סורק תדרים…';

  const waitingRef = db.ref('matchmaking/waiting');
  let matchedWaiter = null;

  waitingRef.transaction((current) => {
    matchedWaiter = null;
    if (current === null) {
      myWaitingRoomId = myId + '_' + Date.now();
      return { id: myId, roomId: myWaitingRoomId, deviceId: myDeviceId };
    }
    if (current.id === myId) {
      return current;
    }
    matchedWaiter = current;
    return null;
  }).then(async ({ committed }) => {
    if (!committed) {
      abortSearch('לא הצלחנו להתחבר, נסה/י שוב');
      return;
    }

    try {
      if (matchedWaiter) {
        const roomId = matchedWaiter.roomId;
        await db.ref('rooms/' + roomId + '/participants/' + myId).set({
          deviceId: myDeviceId,
          joinedAt: firebase.database.ServerValue.TIMESTAMP,
        });
        joinChatRoom(roomId, matchedWaiter.id);
      } else {
        await db.ref('rooms/' + myWaitingRoomId + '/participants/' + myId).set({
          deviceId: myDeviceId,
          joinedAt: firebase.database.ServerValue.TIMESTAMP,
        });

        // if this tab vanishes (closed, crashed, network drop) while still
        // waiting, the server cleans these up on its own instead of leaving
        // a ghost entry that a later search would "match" against — the
        // exact bug that made it look like you were reconnecting to your
        // own earlier throwaway number
        db.ref('matchmaking/waiting').onDisconnect().remove();
        db.ref('rooms/' + myWaitingRoomId + '/participants/' + myId).onDisconnect().remove();

        const participantsRef = db.ref('rooms/' + myWaitingRoomId + '/participants');
        const onPartner = (snap) => {
          const participants = snap.val() || {};
          const otherId = Object.keys(participants).find((id) => id !== myId);
          if (otherId) {
            participantsRef.off('value', onPartner);
            clearTimeout(searchTimeoutHandle);
            // we're no longer just "waiting" — this room is now a real,
            // in-use chat, so cancel the disconnect-cleanup above before it
            // can wipe out the room (or a since-registered new waiter's
            // matchmaking/waiting entry) out from under the conversation
            db.ref('matchmaking/waiting').onDisconnect().cancel();
            db.ref('rooms/' + myWaitingRoomId + '/participants/' + myId).onDisconnect().cancel();
            joinChatRoom(myWaitingRoomId, otherId);
          }
        };
        participantsRef.on('value', onPartner);
        activeListeners.push({ ref: participantsRef, event: 'value', cb: onPartner });

        searchTimeoutHandle = setTimeout(() => {
          participantsRef.off('value', onPartner);
          cancelRandomSearch('אף אחד לא ענה — נסה/י שוב');
        }, 45000);
      }
    } catch (err) {
      cancelRandomSearch('לא ניתן להתחבר כרגע');
    }
  }).catch(() => {
    abortSearch('שגיאת התחברות, נסה/י שוב');
  });
}

function cancelRandomSearch(message) {
  clearTimeout(searchTimeoutHandle);
  clearAllListeners();

  // we're cleaning this up ourselves now, so the disconnect-triggered
  // cleanup registered while we were waiting (see startRandomSearch) is no
  // longer needed — harmless no-op if nothing was ever registered
  db.ref('matchmaking/waiting').onDisconnect().cancel();

  // captured now, not read live inside the transaction below: the actual
  // Firebase transaction callback runs asynchronously, and abortSearch()
  // a few lines down can reassign the shared myId (undercover teardown,
  // ID rotation) before that callback fires — comparing against a live
  // myId would then check the WRONG id and leave this waiting-room entry
  // stuck forever, so a later random search "matches" this stale, dead
  // entry instead of a real person
  const clearingId = myId;
  db.ref('matchmaking/waiting').transaction((current) => {
    if (current && current.id === clearingId) return null;
    return current;
  });

  if (myWaitingRoomId) {
    // the rules only allow deleting a room once nobody is in it, so drop our
    // own participant entry first
    const roomRef = db.ref('rooms/' + myWaitingRoomId);
    roomRef.child('participants/' + myId).onDisconnect().cancel();
    roomRef.child('participants/' + myId).remove()
      .then(() => roomRef.remove())
      .catch(() => {});
    myWaitingRoomId = null;
  }

  abortSearch(message);
}

// leaving/failing a search either goes back to the home screen (regular
// user) or back to the admin dashboard, discarding the temporary undercover
// identity (see section 11b) — never both at once
function abortSearch(message) {
  if (adminActingAsUser) {
    endAdminUndercover();
    showScreen('admin');
    setAdminUndercoverStatus(message || '', message ? 'error' : undefined);
    return;
  }
  setMyStatus('idle');
  showScreen('home');
  setHomeStatus(message || '', message ? 'error' : undefined);
}

// ============================================================
// 7. CHAT ROOM
// ============================================================
function appendMessage(text, kind) {
  const div = document.createElement('div');
  div.className = 'msg ' + kind;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function joinChatRoom(roomId, peerId, opts = {}) {
  clearAllListeners();
  clearTimeout(searchTimeoutHandle);

  currentRoomId = roomId;
  currentPeerId = peerId;
  setMyStatus('chatting');

  // if this tab vanishes mid-chat (closed, crashed, network drop) instead
  // of a normal leave, drop our own participant entry so the room doesn't
  // linger as an orphan forever
  db.ref('rooms/' + roomId + '/participants/' + myId).onDisconnect().remove();

  messagesEl.innerHTML = '';
  peerIdEl.textContent = formatId(peerId);
  peerAdminBadgeEl.hidden = true;
  peerStatusEl.classList.remove('offline');
  showScreen('chat');

  appendMessage(
    opts.calling ? 'מתקשר/ת אל ' + formatId(peerId) + '…' : 'מחובר/ת אל ' + formatId(peerId),
    'system'
  );

  applyChatHeaderForMode();
  if (adminActingAsUser) {
    appendMessage('פועל/ת כמשתמש/ת סמוי/ה · המספר הזמני שלך: ' + formatId(myId), 'system');
    if (adminRevealPreMarked) db.ref('rooms/' + roomId + '/adminRevealed').set(true);
  }

  const messagesRef = db.ref('rooms/' + roomId + '/messages');
  track(messagesRef, 'child_added', (snap) => {
    const m = snap.val();
    if (!m) return;
    appendMessage(m.text, m.sender === myId ? 'me' : 'them');
  });

  const peerOnlineRef = db.ref('users/' + peerId + '/online');
  track(peerOnlineRef, 'value', (snap) => {
    peerStatusEl.classList.toggle('offline', snap.val() !== true);
  });

  // a report against this room kicks both sides out and rotates both IDs
  const reportedRef = db.ref('rooms/' + roomId + '/reported');
  track(reportedRef, 'value', (snap) => {
    if (snap.val() === true) handleReportedKick();
  });

  // the admin directly blocked this room's other participant (undercover
  // mode, section 11b) — kicks that side out immediately, no ID rotation.
  // Never fires for the admin's own client, which leaves on its own.
  const adminBlockedRef = db.ref('rooms/' + roomId + '/adminBlockedPeer');
  track(adminBlockedRef, 'value', (snap) => {
    if (snap.val() === true && !adminActingAsUser) handleBlockedKick();
  });

  // shows the peer a clear "you're talking to the admin" badge — either
  // because the admin pre-marked it before dialing, or hit the reveal
  // button mid-conversation (see section 11b). Never shown to the admin's
  // own undercover client, only to the other side.
  let adminRevealedMessageShown = false;
  const adminRevealedRef = db.ref('rooms/' + roomId + '/adminRevealed');
  track(adminRevealedRef, 'value', (snap) => {
    if (adminActingAsUser) return;
    const revealed = snap.val() === true;
    peerAdminBadgeEl.hidden = !revealed;
    if (revealed && !adminRevealedMessageShown) {
      adminRevealedMessageShown = true;
      appendMessage('האות שאיתו את/ה משוחח/ת הוא חשבון המנהל', 'system');
    }
  });

  if (opts.calling) {
    const partnerJoinedRef = db.ref('rooms/' + roomId + '/participants/' + peerId);
    track(partnerJoinedRef, 'value', (snap) => {
      if (snap.val()) {
        appendMessage(formatId(peerId) + ' ענה/תה', 'system');
      }
    });
    const declinedRef = db.ref('rooms/' + roomId + '/declined');
    track(declinedRef, 'value', (snap) => {
      if (snap.val() === true) {
        appendMessage(formatId(peerId) + ' דחה/תה את השיחה', 'system');
        setTimeout(() => leaveChat(), 1500);
      }
    });
  }

  const typingRef = db.ref('rooms/' + roomId + '/typing/' + peerId);
  track(typingRef, 'value', (snap) => {
    typingIndicator.hidden = snap.val() !== true;
  });
}

formMessage.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputMessage.value.trim();
  if (!text || !currentRoomId) return;

  db.ref('rooms/' + currentRoomId + '/messages').push({
    sender: myId,
    senderDevice: myDeviceId,
    text,
    timestamp: firebase.database.ServerValue.TIMESTAMP,
  }).catch(() => appendMessage('ההודעה לא נשלחה', 'system'));

  db.ref('rooms/' + currentRoomId + '/typing/' + myId).set(false);
  inputMessage.value = '';
});

let lastTypingSent = 0;
inputMessage.addEventListener('input', () => {
  if (!currentRoomId) return;
  const now = Date.now();
  if (now - lastTypingSent > 1500) {
    db.ref('rooms/' + currentRoomId + '/typing/' + myId).set(true);
    lastTypingSent = now;
  }
  clearTimeout(typingClearHandle);
  typingClearHandle = setTimeout(() => {
    db.ref('rooms/' + currentRoomId + '/typing/' + myId).set(false);
  }, 2000);
});

btnLeave.addEventListener('click', leaveChat);

async function leaveChat() {
  clearAllListeners();
  const roomId = currentRoomId;
  currentRoomId = null;
  currentPeerId = null;

  if (roomId) {
    db.ref('rooms/' + roomId + '/participants/' + myId).onDisconnect().cancel();
    await db.ref('rooms/' + roomId + '/participants/' + myId).remove();
    db.ref('rooms/' + roomId + '/typing/' + myId).remove();
    const snap = await db.ref('rooms/' + roomId + '/participants').once('value');
    if (!snap.exists()) {
      db.ref('rooms/' + roomId).remove();
    }
  }

  if (adminActingAsUser) {
    endAdminUndercover();
    typingIndicator.hidden = true;
    showScreen('admin');
    return;
  }

  setMyStatus('idle');
  typingIndicator.hidden = true;
  showScreen('home');
}

// ============================================================
// 8. REPORTING — kicks both sides out immediately and rotates
//    both of their numbers, then queues the case for the admin
// ============================================================
const reportConfirmOverlay = document.getElementById('report-confirm-overlay');

// while undercover, the report button is repurposed into a direct-block
// button (no report step, no ID rotation) — see applyChatHeaderForMode()
// and section 11b
btnReport.addEventListener('click', () => {
  if (!currentRoomId) return;
  if (adminActingAsUser) {
    adminDirectBlockCurrentPeer();
    return;
  }
  reportConfirmOverlay.hidden = false;
});

document.getElementById('btn-report-cancel').addEventListener('click', () => {
  reportConfirmOverlay.hidden = true;
});

document.getElementById('btn-report-confirm').addEventListener('click', async () => {
  reportConfirmOverlay.hidden = true;
  await submitReport();
});

async function submitReport() {
  const roomId = currentRoomId;
  const peerId = currentPeerId;
  if (!roomId || !peerId) return;

  appendMessage('שולח/ת דיווח…', 'system');

  let peerDevice = 'unknown';
  try {
    const snap = await db.ref('rooms/' + roomId + '/participants/' + peerId + '/deviceId').once('value');
    if (snap.val()) peerDevice = snap.val();
  } catch (e) { /* keep 'unknown' */ }

  let messagesSnapshot = [];
  try {
    const msnap = await db.ref('rooms/' + roomId + '/messages').limitToLast(50).once('value');
    const val = msnap.val() || {};
    messagesSnapshot = Object.values(val).map(m => ({
      sender: m.sender, text: m.text, timestamp: m.timestamp || 0,
    }));
  } catch (e) { /* ok, ship without transcript */ }

  try {
    await db.ref('reports').push().set({
      roomId,
      reporterId: myId,
      reporterDevice: myDeviceId,
      reportedId: peerId,
      reportedDevice: peerDevice,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
      status: 'pending',
      messages: messagesSnapshot,
    });
  } catch (e) {
    appendMessage('לא הצלחנו לשלוח את הדיווח, נסה/י שוב', 'system');
    return;
  }

  // flags the room — both clients' listeners (mine included) react to this
  db.ref('rooms/' + roomId + '/reported').set(true);
}

async function handleReportedKick() {
  if (state !== 'chatting') return;
  clearAllListeners();
  const roomId = currentRoomId;
  currentRoomId = null;
  currentPeerId = null;

  if (roomId) {
    try {
      db.ref('rooms/' + roomId + '/participants/' + myId).onDisconnect().cancel();
      await db.ref('rooms/' + roomId + '/participants/' + myId).remove();
      db.ref('rooms/' + roomId + '/typing/' + myId).remove();
      const snap = await db.ref('rooms/' + roomId + '/participants').once('value');
      if (!snap.exists()) db.ref('rooms/' + roomId).remove();
    } catch (e) { /* best effort cleanup */ }
  }

  // the peer reported this room while the admin was undercover — bail out
  // to the dashboard instead of running the regular-user ID-rotation
  // below, which would otherwise overwrite the admin's own persisted id
  if (adminActingAsUser) {
    endAdminUndercover();
    typingIndicator.hidden = true;
    showScreen('admin');
    return;
  }

  try {
    myId = await rotateMyId();
  } catch (e) {
    showScreen('home');
    setHomeStatus('לא הצלחנו להקצות מספר חדש — רעננו את הדף', 'error');
    return;
  }
  renderMyId();
  applyPresence();
  listenForInvites();

  setMyStatus('idle');
  typingIndicator.hidden = true;
  showScreen('home');
  setHomeStatus('התקבל דיווח בשיחה — המספר שלך התחלף ל-' + formatId(myId), 'ok');
}

// only ever fires for the non-admin side of an undercover chat (see the
// adminBlockedPeer listener in joinChatRoom) — the admin's own client
// leaves on its own right after setting the flag, via leaveChat()
async function handleBlockedKick() {
  if (state !== 'chatting') return;
  clearAllListeners();
  const roomId = currentRoomId;
  currentRoomId = null;
  currentPeerId = null;

  if (roomId) {
    try {
      db.ref('rooms/' + roomId + '/participants/' + myId).onDisconnect().cancel();
      await db.ref('rooms/' + roomId + '/participants/' + myId).remove();
      db.ref('rooms/' + roomId + '/typing/' + myId).remove();
    } catch (e) { /* best effort cleanup */ }
  }

  setMyStatus('idle');
  typingIndicator.hidden = true;
  showScreen('home');
  // the blocked-notice section (with the admin's reason, if any) is driven
  // by the always-on listenForBlockStatus() listener and appears on its
  // own moments later — this is just the immediate confirmation
  setHomeStatus('נחסמת על ידי המנהל והוצאת מהשיחה', 'error');
}

// ============================================================
// 9. SETTINGS / MANUAL RESET
// ============================================================
btnSettings.addEventListener('click', () => {
  if (!myId) return;
  settingsIdEl.textContent = formatId(myId);
  setSettingsStatus('');
  disarmReset();
  showScreen('settings');
});

btnSettingsBack.addEventListener('click', () => showScreen('home'));

function setSettingsStatus(msg, kind) {
  settingsStatusEl.textContent = msg || '';
  settingsStatusEl.className = 'status-line' + (kind ? ' ' + kind : '');
}

let resetArmed = false;
let resetArmTimeout = null;

function disarmReset() {
  resetArmed = false;
  clearTimeout(resetArmTimeout);
  btnResetId.textContent = 'אפס מספר';
  btnResetId.classList.remove('armed');
}

btnResetId.addEventListener('click', async () => {
  if (!resetArmed) {
    resetArmed = true;
    btnResetId.textContent = 'לחצו שוב לאישור';
    btnResetId.classList.add('armed');
    resetArmTimeout = setTimeout(disarmReset, 4000);
    return;
  }
  disarmReset();
  await performReset();
});

async function performReset() {
  btnResetId.disabled = true;
  setSettingsStatus('מאפס…');

  if (currentRoomId) await leaveChat();
  if (state === 'searching') cancelRandomSearch();
  clearAllListeners();

  try {
    myId = await rotateMyId();
  } catch (e) {
    btnResetId.disabled = false;
    setSettingsStatus('האיפוס נכשל, נסו שוב', 'error');
    applyPresence();
    listenForInvites();
    return;
  }

  renderMyId();
  settingsIdEl.textContent = formatId(myId);
  applyPresence();
  listenForInvites();

  btnResetId.disabled = false;
  setSettingsStatus('המספר אופס בהצלחה', 'ok');
  setTimeout(() => showScreen('home'), 1200);
}

// ============================================================
// 10. SUPPORT CHAT (blocked device <-> admin)
// ============================================================
let supportMessagesRef = null;
let supportMessagesCb = null;

btnOpenSupport.addEventListener('click', openSupportChat);
btnSupportBack.addEventListener('click', () => {
  if (supportMessagesRef && supportMessagesCb) {
    supportMessagesRef.off('child_added', supportMessagesCb);
    supportMessagesRef = null;
    supportMessagesCb = null;
  }
  showScreen('home');
});

function openSupportChat() {
  supportMessagesEl.innerHTML = '';
  showScreen('support');

  const canMessage = !blockInfo || blockInfo.canMessageAdmin !== false;
  supportMutedNoteEl.hidden = canMessage;
  formSupportMessage.hidden = !canMessage;

  if (supportMessagesRef && supportMessagesCb) supportMessagesRef.off('child_added', supportMessagesCb);
  supportMessagesRef = db.ref('adminChats/' + myDeviceId + '/messages');
  supportMessagesCb = (snap) => {
    const m = snap.val();
    if (!m) return;
    const div = document.createElement('div');
    div.className = 'msg ' + (m.sender === 'user' ? 'me' : 'them');
    div.textContent = m.text;
    supportMessagesEl.appendChild(div);
    supportMessagesEl.scrollTop = supportMessagesEl.scrollHeight;
  };
  supportMessagesRef.on('child_added', supportMessagesCb);
}

formSupportMessage.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputSupportMessage.value.trim();
  if (!text) return;
  db.ref('adminChats/' + myDeviceId + '/messages').push({
    sender: 'user',
    text,
    timestamp: firebase.database.ServerValue.TIMESTAMP,
  });
  inputSupportMessage.value = '';
});

// ============================================================
// 11. ADMIN LOGIN
// ============================================================
// The sign-in form lives on its own page, admin/ (open the site's address
// with /admin at the end). After a successful sign-in it sends the browser
// back here with #admin in the address, which is what opens the dashboard.
// Both pages use the same named 'admin' Firebase app, so they share the
// persisted admin session.
const ADMIN_HASH = '#admin';
const ADMIN_LOGIN_PAGE = 'admin/';

function wantsAdminDashboard() {
  return location.hash === ADMIN_HASH;
}
function clearAdminHash() {
  if (wantsAdminDashboard()) history.replaceState(null, '', location.pathname + location.search);
}
function goToAdminLogin() {
  location.replace(ADMIN_LOGIN_PAGE);
}

// "back" just leaves the dashboard screen — it does NOT sign out, so
// opening /admin again skips the password until the session actually
// expires (idle timeout) or the admin explicitly signs out.
document.getElementById('btn-admin-back').addEventListener('click', () => {
  clearAdminHash();
  showScreen('home');
});

document.getElementById('btn-admin-signout').addEventListener('click', async () => {
  clearAdminHash(); // a deliberate sign-out lands on the home screen
  await adminSignOut();
});

async function adminSignOut() {
  clearAdminActivity();
  await auth.signOut();
}

function enterAdminDashboard() {
  showScreen('admin');
  if (!adminDashboardActive) startAdminDashboard();
  resetAdminIdleTimer();
}

// ---------- 30-minute idle auto sign-out ----------
const ADMIN_IDLE_LIMIT_MS = 30 * 60 * 1000;
const ADMIN_ACTIVITY_KEY = 'numbers_admin_last_activity';
let adminIdleTimer = null;

function isAdminSession() {
  return !!(auth.currentUser && auth.currentUser.uid === ADMIN_UID);
}
function markAdminActivity() {
  try { localStorage.setItem(ADMIN_ACTIVITY_KEY, String(Date.now())); } catch (e) { /* ignore */ }
}
function clearAdminActivity() {
  try { localStorage.removeItem(ADMIN_ACTIVITY_KEY); } catch (e) { /* ignore */ }
}
function adminIdleRemainingMs() {
  try {
    const raw = localStorage.getItem(ADMIN_ACTIVITY_KEY);
    if (!raw) return ADMIN_IDLE_LIMIT_MS; // no record yet — first login, not expired
    const last = parseInt(raw, 10);
    if (!last || isNaN(last)) return ADMIN_IDLE_LIMIT_MS;
    return ADMIN_IDLE_LIMIT_MS - (Date.now() - last);
  } catch (e) {
    return ADMIN_IDLE_LIMIT_MS;
  }
}
function resetAdminIdleTimer() {
  clearTimeout(adminIdleTimer);
  if (!isAdminSession()) return;
  markAdminActivity();
  adminIdleTimer = setTimeout(adminSignOut, ADMIN_IDLE_LIMIT_MS);
}
['click', 'keydown', 'touchstart'].forEach((evt) => {
  document.addEventListener(evt, () => {
    if (isAdminSession()) resetAdminIdleTimer();
  });
});

auth.onAuthStateChanged(async (user) => {
  try {
    if (user && typeof ADMIN_UID === 'string' && user.uid === ADMIN_UID) {
      if (adminIdleRemainingMs() <= 0) {
        // more than 30 idle minutes passed since the last recorded activity
        // (e.g. the tab was closed) — expire the session instead of letting
        // Firebase's own persisted login silently walk back in.
        await adminSignOut();
        return;
      }
      if (wantsAdminDashboard()) enterAdminDashboard();
      else resetAdminIdleTimer();
    } else if (user) {
      // not the admin account (the login page already reports this case)
      console.warn('Signed in, but UID does not match ADMIN_UID:', user.uid);
      await adminSignOut();
    } else {
      clearTimeout(adminIdleTimer);
      stopAdminDashboard();
      if (adminActingAsUser) {
        // session expired/signed out mid-undercover-chat — admin auth is
        // gone, so there's no dashboard to return to; abandon the
        // temporary identity and any live room listeners
        clearAllListeners();
        currentRoomId = null;
        currentPeerId = null;
        typingIndicator.hidden = true;
        endAdminUndercover();
        showScreen('home');
      } else if (screens.admin.classList.contains('active')) {
        showScreen('home');
      }
      // #admin in the address but no (valid) admin session, e.g. it just
      // expired — send the browser to the sign-in page
      if (wantsAdminDashboard()) goToAdminLogin();
    }
  } catch (err) {
    console.error('Admin auth-state handling failed:', err);
  }
});

// typing #admin into the address bar of an already-open page
window.addEventListener('hashchange', () => {
  if (!wantsAdminDashboard()) return;
  if (isAdminSession()) enterAdminDashboard();
  else goToAdminLogin();
});

// ============================================================
// 11b. ADMIN — ACT AS A USER (UNDERCOVER MODE)
//    Lets the admin behave exactly like a regular user (random match or
//    direct dial) using a fresh, throwaway 6-digit number that is never
//    persisted to localStorage — so a peer can't note it and redial it
//    later to reach the admin again. Inside that chat, the report button
//    is repurposed into a direct block (no report step needed), and the
//    admin can reveal to the peer that they're talking to the admin —
//    either up front (checkbox below) or at any point mid-conversation
//    via the reveal button in the chat header. Revealing is one-way:
//    once shown, it stays shown for the rest of that chat.
// ============================================================
const btnAdminRandom = document.getElementById('btn-admin-random');
const formAdminDirectCall = document.getElementById('form-admin-direct-call');
const inputAdminDirectId = document.getElementById('input-admin-direct-id');
const chkAdminPremark = document.getElementById('chk-admin-premark');
const adminUndercoverStatusEl = document.getElementById('admin-undercover-status');

function setAdminUndercoverStatus(msg, kind) {
  adminUndercoverStatusEl.textContent = msg || '';
  adminUndercoverStatusEl.className = 'status-line' + (kind ? ' ' + kind : '');
}

// the throwaway number is claimed through the same atomic /ids claim as a
// regular number (so it can't collide with anyone), but owned by the admin
// account and never pointed to from /owners — returns false if it failed
async function beginAdminUndercover() {
  let tempId;
  try {
    tempId = await claimFreshId(adminDb, ADMIN_UID);
  } catch (e) {
    setAdminUndercoverStatus('לא הצלחנו להקצות מספר זמני, נסו שוב', 'error');
    return false;
  }
  adminRealId = myId;
  adminRealDeviceId = myDeviceId;
  myId = tempId;
  myDeviceId = 'undercover-' + (window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now() + '-' + Math.random().toString(36).slice(2));
  db = adminDb;
  adminActingAsUser = true;
  try { await adminDb.ref('users/' + tempId).remove(); } catch (e) { /* ignore */ }
  applyPresence();
  return true;
}

function endAdminUndercover() {
  if (!adminActingAsUser) return;
  const tempId = myId;
  const tempRef = adminDb.ref('users/' + tempId);
  tempRef.onDisconnect().cancel();
  tempRef.remove()
    .catch(() => {})
    .then(() => adminDb.ref('ids/' + tempId).remove())
    .catch(() => {});
  db = userDb;
  myId = adminRealId;
  myDeviceId = adminRealDeviceId;
  adminActingAsUser = false;
  adminRevealPreMarked = false;
  adminRealId = null;
  adminRealDeviceId = null;
  chkAdminPremark.checked = false;
  applyChatHeaderForMode();
}

// swaps the chat header's report button into a block button, and shows/hides
// the mid-chat reveal button, depending on whether the admin is undercover
function applyChatHeaderForMode() {
  if (adminActingAsUser) {
    btnReport.textContent = '⛔';
    btnReport.setAttribute('aria-label', 'חסימת המשתמש');
    btnReport.title = 'חסימת המשתמש';
    btnAdminReveal.hidden = adminRevealPreMarked;
  } else {
    btnReport.textContent = '🚩';
    btnReport.setAttribute('aria-label', 'דיווח');
    btnReport.title = '';
    btnAdminReveal.hidden = true;
  }
}

btnAdminRandom.addEventListener('click', async () => {
  if (adminActingAsUser) return;
  setAdminUndercoverStatus('');
  if (!await beginAdminUndercover()) return;
  adminRevealPreMarked = chkAdminPremark.checked;
  startRandomSearch();
});

formAdminDirectCall.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (adminActingAsUser) return;
  const targetId = inputAdminDirectId.value.trim();
  if (!ID_REGEX.test(targetId)) {
    setAdminUndercoverStatus('הזן/י מספר תקין בן 6 ספרות', 'error');
    return;
  }
  if (!await beginAdminUndercover()) return;
  adminRevealPreMarked = chkAdminPremark.checked;
  const ok = await attemptDirectCall(targetId, setAdminUndercoverStatus);
  if (ok) {
    inputAdminDirectId.value = '';
  } else {
    endAdminUndercover();
  }
});

inputAdminDirectId.addEventListener('input', () => {
  inputAdminDirectId.value = inputAdminDirectId.value.replace(/\D/g, '').slice(0, ID_LENGTH);
});

btnAdminReveal.addEventListener('click', () => {
  if (!adminActingAsUser || !currentRoomId) return;
  adminDb.ref('rooms/' + currentRoomId + '/adminRevealed').set(true);
  btnAdminReveal.hidden = true;
  appendMessage('חשפת בפני האות השני שאת/ה המנהל', 'system');
});

async function adminDirectBlockCurrentPeer() {
  const roomId = currentRoomId;
  const peerId = currentPeerId;
  if (!roomId || !peerId) return;
  let peerDevice = 'unknown';
  try {
    const snap = await adminDb.ref('rooms/' + roomId + '/participants/' + peerId + '/deviceId').once('value');
    if (snap.val()) peerDevice = snap.val();
  } catch (e) { /* keep 'unknown' */ }
  openBlockModal(null, [{ deviceId: peerDevice, numericId: peerId }]);
}

// ============================================================
// 12. ADMIN DASHBOARD
// ============================================================
const tabReports = document.getElementById('tab-reports');
const tabBlocked = document.getElementById('tab-blocked');
const viewReports = document.getElementById('admin-reports-view');
const viewBlocked = document.getElementById('admin-blocked-view');
const viewChat = document.getElementById('admin-chat-view');
const reportsListEl = document.getElementById('reports-list');
const reportsEmptyEl = document.getElementById('reports-empty');
const reportsCountEl = document.getElementById('reports-count');
const blockedListEl = document.getElementById('blocked-list');
const blockedEmptyEl = document.getElementById('blocked-empty');

function showAdminTab(tab) {
  tabReports.classList.toggle('active', tab === 'reports');
  tabBlocked.classList.toggle('active', tab === 'blocked');
  viewReports.hidden = tab !== 'reports';
  viewBlocked.hidden = tab !== 'blocked';
  viewChat.hidden = true;
}
tabReports.addEventListener('click', () => showAdminTab('reports'));
tabBlocked.addEventListener('click', () => showAdminTab('blocked'));

let adminReportsRef = null, adminReportsCb = null;
let adminBlocklistRef = null, adminBlocklistCb = null;
let adminDashboardActive = false;
let currentBlocklistObj = {};

function startAdminDashboard() {
  adminDashboardActive = true;
  showAdminTab('reports');

  adminReportsRef = adminDb.ref('reports').orderByChild('status').equalTo('pending');
  adminReportsCb = (snap) => renderReports(snap.val() || {});
  adminReportsRef.on('value', adminReportsCb);

  adminBlocklistRef = adminDb.ref('blocklist');
  adminBlocklistCb = (snap) => {
    currentBlocklistObj = snap.val() || {};
    const blockedIds = Object.keys(currentBlocklistObj)
      .filter((id) => currentBlocklistObj[id] && currentBlocklistObj[id].blocked);
    syncUnreadListeners(blockedIds);
    renderBlocked(currentBlocklistObj);
  };
  adminBlocklistRef.on('value', adminBlocklistCb);
}

function stopAdminDashboard() {
  adminDashboardActive = false;
  if (adminReportsRef && adminReportsCb) adminReportsRef.off('value', adminReportsCb);
  if (adminBlocklistRef && adminBlocklistCb) adminBlocklistRef.off('value', adminBlocklistCb);
  adminReportsRef = null;
  adminBlocklistRef = null;
  syncUnreadListeners([]); // detach all
  closeAdminChatView();
}

function renderReports(reportsObj) {
  const entries = Object.entries(reportsObj).sort(
    (a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0)
  );

  reportsCountEl.hidden = entries.length === 0;
  reportsCountEl.textContent = String(entries.length);

  reportsListEl.innerHTML = '';
  reportsEmptyEl.hidden = entries.length > 0;

  entries.forEach(([reportId, report]) => {
    const card = document.createElement('div');
    card.className = 'report-card';

    const time = report.timestamp ? new Date(report.timestamp).toLocaleString('he-IL') : '';
    const row = document.createElement('div');
    row.className = 'card-row';
    row.innerHTML =
      '<span>דיווח מ-<span class="card-id" dir="ltr">' + formatId(report.reporterId) +
      '</span> על <span class="card-id" dir="ltr">' + formatId(report.reportedId) + '</span></span>' +
      '<span class="card-time">' + time + '</span>';
    card.appendChild(row);

    const msgsWrap = document.createElement('div');
    msgsWrap.className = 'report-messages';
    const msgs = report.messages || [];
    if (msgs.length === 0) {
      const p = document.createElement('p');
      p.className = 'settings-text';
      p.style.margin = '0';
      p.textContent = 'אין הודעות שמורות בשיחה זו.';
      msgsWrap.appendChild(p);
    } else {
      msgs.slice(-20).forEach((m) => {
        const d = document.createElement('div');
        d.className = 'msg ' + (m.sender === report.reporterId ? 'me' : 'them');
        d.textContent = formatId(m.sender) + ': ' + m.text;
        msgsWrap.appendChild(d);
      });
    }
    card.appendChild(msgsWrap);

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const btnBlockReporter = document.createElement('button');
    btnBlockReporter.className = 'btn btn-danger';
    btnBlockReporter.textContent = 'חסום את ' + formatId(report.reporterId);
    btnBlockReporter.addEventListener('click', () =>
      openBlockModal(reportId, [{ deviceId: report.reporterDevice, numericId: report.reporterId }]));

    const btnBlockReported = document.createElement('button');
    btnBlockReported.className = 'btn btn-danger';
    btnBlockReported.textContent = 'חסום את ' + formatId(report.reportedId);
    btnBlockReported.addEventListener('click', () =>
      openBlockModal(reportId, [{ deviceId: report.reportedDevice, numericId: report.reportedId }]));

    const btnBlockBoth = document.createElement('button');
    btnBlockBoth.className = 'btn btn-danger';
    btnBlockBoth.textContent = 'חסום את שניהם';
    btnBlockBoth.addEventListener('click', () =>
      openBlockModal(reportId, [
        { deviceId: report.reporterDevice, numericId: report.reporterId },
        { deviceId: report.reportedDevice, numericId: report.reportedId },
      ]));

    const btnHandled = document.createElement('button');
    btnHandled.className = 'btn btn-secondary';
    btnHandled.textContent = 'סמן כטופל';
    btnHandled.addEventListener('click', () =>
      resolveReport(reportId, { action: 'handled' }));

    actions.append(btnBlockReporter, btnBlockReported, btnBlockBoth, btnHandled);
    card.appendChild(actions);

    reportsListEl.appendChild(card);
  });
}

async function resolveReport(reportId, resolution) {
  try {
    await adminDb.ref('reports/' + reportId).update({
      status: resolution.action === 'handled' ? 'handled' : 'actioned',
      resolution: Object.assign({}, resolution, { at: firebase.database.ServerValue.TIMESTAMP }),
    });
  } catch (e) {
    alert('שגיאה בעדכון הדיווח');
  }
}

// ---------- block modal (single target or both) ----------
let pendingBlock = null;
const blockOverlay = document.getElementById('block-reason-overlay');
const blockTargetIdEl = document.getElementById('block-target-id');
const blockReasonTextEl = document.getElementById('block-reason-text');

function openBlockModal(reportId, targets) {
  const valid = targets.filter(t => t.deviceId && t.deviceId !== 'unknown');
  if (valid.length === 0) {
    alert('לא נמצא מזהה מכשיר לחסימה');
    return;
  }
  pendingBlock = { reportId, targets: valid };
  blockTargetIdEl.textContent = valid.map(t => formatId(t.numericId)).join(' + ');
  blockReasonTextEl.value = '';
  blockOverlay.hidden = false;
}

document.getElementById('btn-block-cancel').addEventListener('click', () => {
  blockOverlay.hidden = true;
  pendingBlock = null;
});

document.getElementById('btn-block-confirm').addEventListener('click', async () => {
  if (!pendingBlock) return;
  const { reportId, targets } = pendingBlock;
  const reason = blockReasonTextEl.value.trim();
  const wasUndercoverBlock = adminActingAsUser;
  const blockedRoomId = currentRoomId; // captured before leaveChat() clears it below

  try {
    await Promise.all(targets.map(t => adminDb.ref('blocklist/' + t.deviceId).set({
      blocked: true,
      reason,
      blockedAt: firebase.database.ServerValue.TIMESTAMP,
      canMessageAdmin: true,
    })));
    if (reportId) {
      await resolveReport(reportId, {
        action: 'blocked',
        blockedDeviceIds: targets.map(t => t.deviceId),
        blockedIds: targets.map(t => t.numericId),
        note: reason,
      });
    }
  } catch (e) {
    alert('שגיאה בחסימה');
  }
  blockOverlay.hidden = true;
  pendingBlock = null;

  // a direct block made from inside the undercover chat (no reportId) kicks
  // the now-blocked peer out of the room right away (see handleBlockedKick
  // and the adminBlockedPeer listener in joinChatRoom), then ends the
  // admin's own side of the chat and returns to the dashboard
  if (wasUndercoverBlock) {
    if (blockedRoomId) adminDb.ref('rooms/' + blockedRoomId + '/adminBlockedPeer').set(true);
    await leaveChat();
  }
});

// ---------- unread-message tracking for the blocked-users list ----------
const ADMIN_LASTSEEN_KEY = 'numbers_admin_chat_lastseen';
const unreadListeners = {}; // deviceId -> { ref, cb }
const hasUnread = {};       // deviceId -> boolean

function getAdminChatLastSeen(deviceId) {
  try {
    const map = JSON.parse(localStorage.getItem(ADMIN_LASTSEEN_KEY) || '{}');
    return map[deviceId] || 0;
  } catch (e) {
    return 0;
  }
}
function setAdminChatLastSeen(deviceId, ts) {
  try {
    const map = JSON.parse(localStorage.getItem(ADMIN_LASTSEEN_KEY) || '{}');
    map[deviceId] = ts;
    localStorage.setItem(ADMIN_LASTSEEN_KEY, JSON.stringify(map));
  } catch (e) { /* ignore */ }
}

function syncUnreadListeners(deviceIds) {
  Object.keys(unreadListeners).forEach((id) => {
    if (deviceIds.indexOf(id) === -1) {
      unreadListeners[id].ref.off('value', unreadListeners[id].cb);
      delete unreadListeners[id];
      delete hasUnread[id];
    }
  });

  deviceIds.forEach((id) => {
    if (unreadListeners[id]) return;
    const ref = adminDb.ref('adminChats/' + id + '/messages').limitToLast(1);
    const cb = (snap) => {
      const val = snap.val();
      let unread = false;
      if (val) {
        const msg = Object.values(val)[0];
        if (msg && msg.sender === 'user' && (msg.timestamp || 0) > getAdminChatLastSeen(id)) {
          unread = true;
        }
      }
      hasUnread[id] = unread;
      if (adminDashboardActive) renderBlocked(currentBlocklistObj);
    };
    ref.on('value', cb);
    unreadListeners[id] = { ref, cb };
  });
}

// ---------- blocked users list ----------
function renderBlocked(blocklistObj) {
  const entries = Object.entries(blocklistObj)
    .filter(([, v]) => v && v.blocked)
    .sort((a, b) => (b[1].blockedAt || 0) - (a[1].blockedAt || 0));

  blockedListEl.innerHTML = '';
  blockedEmptyEl.hidden = entries.length > 0;

  entries.forEach(([deviceId, info]) => {
    const card = document.createElement('div');
    card.className = 'blocked-card';

    const time = info.blockedAt ? new Date(info.blockedAt).toLocaleString('he-IL') : '';
    const shortId = deviceId.length > 14 ? deviceId.slice(0, 14) + '…' : deviceId;

    const row = document.createElement('div');
    row.className = 'card-row';
    row.innerHTML =
      '<span class="card-id" dir="ltr">' + shortId + '</span>' +
      '<span class="card-time">' + time + '</span>';
    card.appendChild(row);

    if (info.reason) {
      const tag = document.createElement('div');
      tag.className = 'blocked-reason-tag';
      tag.textContent = info.reason;
      card.appendChild(tag);
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const btnUnblock = document.createElement('button');
    btnUnblock.className = 'btn btn-secondary';
    btnUnblock.textContent = 'שחרור חסימה';
    btnUnblock.addEventListener('click', () => {
      adminDb.ref('blocklist/' + deviceId).update({ blocked: false });
    });

    const btnChat = document.createElement('button');
    btnChat.className = 'btn btn-primary';
    btnChat.textContent = 'פתח שיחה';
    if (hasUnread[deviceId]) {
      const dot = document.createElement('span');
      dot.className = 'unread-dot';
      dot.setAttribute('aria-label', 'הודעות חדשות');
      btnChat.appendChild(dot);
    }
    btnChat.addEventListener('click', () => openAdminChatView(deviceId));

    actions.append(btnUnblock, btnChat);
    card.appendChild(actions);

    const toggleRow = document.createElement('div');
    toggleRow.className = 'toggle-row';
    const canMsg = info.canMessageAdmin !== false;
    const label = document.createElement('span');
    label.textContent = 'יכול/ה לפנות למנהל';
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = canMsg ? 'מופעל' : 'כבוי';
    toggleBtn.className = canMsg ? 'on' : '';
    toggleBtn.addEventListener('click', () => {
      adminDb.ref('blocklist/' + deviceId + '/canMessageAdmin').set(!canMsg);
    });
    toggleRow.append(label, toggleBtn);
    card.appendChild(toggleRow);

    blockedListEl.appendChild(card);
  });
}

// ---------- admin <-> device chat ----------
let adminChatDeviceId = null;
let adminChatRef = null, adminChatCb = null;
const adminChatMessagesEl = document.getElementById('admin-chat-messages');
const adminChatTargetEl = document.getElementById('admin-chat-target');
const formAdminChatMessage = document.getElementById('form-admin-chat-message');
const inputAdminChatMessage = document.getElementById('input-admin-chat-message');

function openAdminChatView(deviceId) {
  adminChatDeviceId = deviceId;
  viewReports.hidden = true;
  viewBlocked.hidden = true;
  viewChat.hidden = false;

  adminChatTargetEl.textContent = deviceId;
  adminChatMessagesEl.innerHTML = '';

  // clear the unread dot immediately, and keep it cleared as new
  // messages arrive while this conversation is open
  setAdminChatLastSeen(deviceId, Date.now());
  hasUnread[deviceId] = false;

  if (adminChatRef && adminChatCb) adminChatRef.off('child_added', adminChatCb);
  adminChatRef = adminDb.ref('adminChats/' + deviceId + '/messages');
  adminChatCb = (snap) => {
    const m = snap.val();
    if (!m) return;
    const div = document.createElement('div');
    div.className = 'msg ' + (m.sender === 'admin' ? 'me' : 'them');
    div.textContent = m.text;
    adminChatMessagesEl.appendChild(div);
    adminChatMessagesEl.scrollTop = adminChatMessagesEl.scrollHeight;
    if (m.sender === 'user' && adminChatDeviceId === deviceId) {
      setAdminChatLastSeen(deviceId, m.timestamp || Date.now());
    }
  };
  adminChatRef.on('child_added', adminChatCb);
}

function closeAdminChatView() {
  if (adminChatRef && adminChatCb) {
    adminChatRef.off('child_added', adminChatCb);
    adminChatRef = null;
    adminChatCb = null;
  }
  adminChatDeviceId = null;
  viewChat.hidden = true;
}

document.getElementById('btn-admin-chat-back').addEventListener('click', () => {
  closeAdminChatView();
  showAdminTab('blocked');
});

formAdminChatMessage.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputAdminChatMessage.value.trim();
  if (!text || !adminChatDeviceId) return;
  adminDb.ref('adminChats/' + adminChatDeviceId + '/messages').push({
    sender: 'admin',
    text,
    timestamp: firebase.database.ServerValue.TIMESTAMP,
  });
  inputAdminChatMessage.value = '';
});

// ============================================================
// 13. BOOT
// ============================================================
(async function init() {
  try {
    const user = await ensureUserAccount();
    myDeviceId = await loadOrBindDeviceId(user.uid);
    myId = await loadOrClaimMyId(user.uid);
  } catch (err) {
    console.error('Could not set up this device\'s number:', err);
    setHomeStatus('לא הצלחנו להתחבר לשרת — רעננו את הדף', 'error');
    return;
  }
  try { localStorage.removeItem('numbers_my_id'); } catch (e) { /* legacy key, unused now */ }
  renderMyId();
  initPresence();
  listenForInvites();
  listenForBlockStatus();
})();
