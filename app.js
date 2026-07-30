/* ============================================================
   צ'אט אנונימי — Anonymous Chat
   All app logic: device identity, presence, random matchmaking,
   connect-by-ID, the chat room, abuse reporting (with automatic
   dual ID rotation), device-level blocking, the blocked-user
   support channel, and the admin dashboard.
   ============================================================ */

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

const ID_LENGTH = 6;
const ID_REGEX = /^[0-9]{6}$/;
const ADMIN_TRIGGER_CODE = '137925'; // opens the admin sign-in box — see README

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
function getOrCreateDeviceId() {
  let id = localStorage.getItem('numbers_device_id');
  if (id) return id;
  id = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  localStorage.setItem('numbers_device_id', id);
  return id;
}

function randomSixDigitId() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function idIsTaken(id) {
  const snap = await db.ref('users/' + id).once('value');
  return snap.exists();
}

async function generateFreshId() {
  let candidate = randomSixDigitId();
  let attempts = 0;
  while (await idIsTaken(candidate) && attempts < 6) {
    candidate = randomSixDigitId();
    attempts++;
  }
  return candidate;
}

async function getOrCreateMyId() {
  const stored = localStorage.getItem('numbers_my_id');
  if (stored && ID_REGEX.test(stored)) return stored;
  const fresh = await generateFreshId();
  localStorage.setItem('numbers_my_id', fresh);
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
        : 'נחסמת משיחה עם משתמשים אחרים בעקבות דיווח.';
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
// 5. CONNECT BY ID (direct call) — also doubles as the admin
//    sign-in trigger when the code matches ADMIN_TRIGGER_CODE
// ============================================================
formConnect.addEventListener('submit', async (e) => {
  e.preventDefault();
  const targetId = inputPartner.value.trim();

  if (targetId === ADMIN_TRIGGER_CODE) {
    inputPartner.value = '';
    setHomeStatus('');
    if (auth.currentUser && auth.currentUser.uid === ADMIN_UID) {
      // already signed in from earlier in this session — just re-enter
      enterAdminDashboard();
    } else {
      openAdminLoginOverlay();
    }
    return;
  }

  if (!ID_REGEX.test(targetId)) {
    setHomeStatus('הזן/י מספר תקין בן 6 ספרות', 'error');
    return;
  }
  if (targetId === myId) {
    setHomeStatus("זה האות שלך", 'error');
    return;
  }

  setHomeStatus('בודק/ת אות…');
  const snap = await db.ref('users/' + targetId + '/online').once('value');
  if (snap.val() !== true) {
    setHomeStatus('האות הזה לא מחובר', 'error');
    return;
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
    setHomeStatus('לא ניתן להתחבר כרגע', 'error');
    return;
  }

  setHomeStatus('');
  inputPartner.value = '';
  joinChatRoom(roomId, targetId, { calling: true });
});

inputPartner.addEventListener('input', () => {
  inputPartner.value = inputPartner.value.replace(/\D/g, '').slice(0, ID_LENGTH);
});

// ============================================================
// 6. RANDOM MATCHMAKING
// ============================================================
btnRandom.addEventListener('click', startRandomSearch);
btnCancel.addEventListener('click', () => cancelRandomSearch());

let myWaitingRoomId = null;

function startRandomSearch() {
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
      setHomeStatus('לא הצלחנו להתחבר, נסה/י שוב', 'error');
      showScreen('home');
      setMyStatus('idle');
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
        const participantsRef = db.ref('rooms/' + myWaitingRoomId + '/participants');
        const onPartner = (snap) => {
          const participants = snap.val() || {};
          const otherId = Object.keys(participants).find((id) => id !== myId);
          if (otherId) {
            participantsRef.off('value', onPartner);
            clearTimeout(searchTimeoutHandle);
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
    setHomeStatus('שגיאת התחברות, נסה/י שוב', 'error');
    showScreen('home');
    setMyStatus('idle');
  });
}

function cancelRandomSearch(message) {
  clearTimeout(searchTimeoutHandle);
  clearAllListeners();

  db.ref('matchmaking/waiting').transaction((current) => {
    if (current && current.id === myId) return null;
    return current;
  });

  if (myWaitingRoomId) {
    db.ref('rooms/' + myWaitingRoomId).remove();
    myWaitingRoomId = null;
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

  messagesEl.innerHTML = '';
  peerIdEl.textContent = formatId(peerId);
  peerStatusEl.classList.remove('offline');
  showScreen('chat');

  appendMessage(
    opts.calling ? 'מתקשר/ת אל ' + formatId(peerId) + '…' : 'מחובר/ת אל ' + formatId(peerId),
    'system'
  );

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
    await db.ref('rooms/' + roomId + '/participants/' + myId).remove();
    db.ref('rooms/' + roomId + '/typing/' + myId).remove();
    const snap = await db.ref('rooms/' + roomId + '/participants').once('value');
    if (!snap.exists()) {
      db.ref('rooms/' + roomId).remove();
    }
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

btnReport.addEventListener('click', () => {
  if (!currentRoomId) return;
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
      await db.ref('rooms/' + roomId + '/participants/' + myId).remove();
      db.ref('rooms/' + roomId + '/typing/' + myId).remove();
      const snap = await db.ref('rooms/' + roomId + '/participants').once('value');
      if (!snap.exists()) db.ref('rooms/' + roomId).remove();
    } catch (e) { /* best effort cleanup */ }
  }

  localStorage.removeItem('numbers_my_id');
  myId = await generateFreshId();
  localStorage.setItem('numbers_my_id', myId);
  myIdEl.textContent = formatId(myId);
  applyPresence();
  listenForInvites();

  setMyStatus('idle');
  typingIndicator.hidden = true;
  showScreen('home');
  setHomeStatus('התקבל דיווח בשיחה — המספר שלך התחלף ל-' + formatId(myId), 'ok');
}

// ============================================================
// 9. SETTINGS / MANUAL RESET
// ============================================================
btnSettings.addEventListener('click', () => {
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

  const oldId = myId;
  try {
    await db.ref('users/' + oldId).remove();
  } catch (e) { /* fine, move on */ }

  localStorage.removeItem('numbers_my_id');
  myId = await generateFreshId();
  localStorage.setItem('numbers_my_id', myId);

  myIdEl.textContent = formatId(myId);
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
const adminOverlay = document.getElementById('admin-login-overlay');
const adminEmailInput = document.getElementById('admin-email');
const adminPasswordInput = document.getElementById('admin-password');
const adminLoginStatusEl = document.getElementById('admin-login-status');

function openAdminLoginOverlay() {
  adminEmailInput.value = '';
  adminPasswordInput.value = '';
  adminLoginStatusEl.textContent = '';
  adminLoginStatusEl.className = 'status-line';
  if (typeof ADMIN_UID !== 'string' || !ADMIN_UID || ADMIN_UID.indexOf('REPLACE_WITH') === 0) {
    adminLoginStatusEl.textContent = 'ADMIN_UID עדיין לא הוגדר ב-firebase-config.js';
    adminLoginStatusEl.className = 'status-line error';
  }
  adminOverlay.hidden = false;
}

document.getElementById('btn-admin-login-cancel').addEventListener('click', () => {
  adminOverlay.hidden = true;
});

document.getElementById('btn-admin-login-submit').addEventListener('click', async () => {
  const email = adminEmailInput.value.trim();
  const password = adminPasswordInput.value;
  if (!email || !password) {
    adminLoginStatusEl.textContent = 'מלא/י אימייל וסיסמה';
    adminLoginStatusEl.className = 'status-line error';
    return;
  }
  adminLoginStatusEl.textContent = 'מתחבר/ת…';
  adminLoginStatusEl.className = 'status-line';
  try {
    await auth.signInWithEmailAndPassword(email, password);
    // overlay stays open until onAuthStateChanged confirms this is the
    // admin account — see below, so a UID mismatch shows a clear error
    // here instead of silently bouncing back to the home screen.
  } catch (err) {
    adminLoginStatusEl.textContent = 'פרטי התחברות שגויים';
    adminLoginStatusEl.className = 'status-line error';
  }
});

// "back" just leaves the dashboard screen — it does NOT sign out, so
// re-entering with 137925 skips the password until the session actually
// expires (idle timeout) or the admin explicitly signs out.
document.getElementById('btn-admin-back').addEventListener('click', () => {
  showScreen('home');
});

document.getElementById('btn-admin-signout').addEventListener('click', async () => {
  await auth.signOut();
});

function enterAdminDashboard() {
  adminOverlay.hidden = true;
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
  adminIdleTimer = setTimeout(() => auth.signOut(), ADMIN_IDLE_LIMIT_MS);
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
        await auth.signOut();
        return;
      }
      enterAdminDashboard();
    } else if (user) {
      // signed in successfully, but this account's UID doesn't match
      // ADMIN_UID in firebase-config.js — almost always a setup mistake,
      // so surface it clearly instead of bouncing back to the home screen.
      console.warn('Signed in, but UID does not match ADMIN_UID:', user.uid);
      adminLoginStatusEl.textContent =
        'ההתחברות הצליחה אך זה אינו חשבון המנהל המוגדר (בדקו את ADMIN_UID ב-firebase-config.js)';
      adminLoginStatusEl.className = 'status-line error';
      await auth.signOut();
    } else {
      clearTimeout(adminIdleTimer);
      stopAdminDashboard();
      if (screens.admin.classList.contains('active')) showScreen('home');
    }
  } catch (err) {
    // whatever went wrong, never leave the login box stuck on "מתחבר/ת…"
    console.error('Admin auth-state handling failed:', err);
    adminLoginStatusEl.textContent = 'אירעה שגיאה, נסה/י שוב';
    adminLoginStatusEl.className = 'status-line error';
  }
});

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

  adminReportsRef = db.ref('reports').orderByChild('status').equalTo('pending');
  adminReportsCb = (snap) => renderReports(snap.val() || {});
  adminReportsRef.on('value', adminReportsCb);

  adminBlocklistRef = db.ref('blocklist');
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
    await db.ref('reports/' + reportId).update({
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
    alert('לא נמצא מזהה מכשיר לחסימה עבור דיווח זה');
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

  try {
    await Promise.all(targets.map(t => db.ref('blocklist/' + t.deviceId).set({
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
    const ref = db.ref('adminChats/' + id + '/messages').limitToLast(1);
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
      db.ref('blocklist/' + deviceId).update({ blocked: false });
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
      db.ref('blocklist/' + deviceId + '/canMessageAdmin').set(!canMsg);
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
  adminChatRef = db.ref('adminChats/' + deviceId + '/messages');
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
  db.ref('adminChats/' + adminChatDeviceId + '/messages').push({
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
  myDeviceId = getOrCreateDeviceId();
  myId = await getOrCreateMyId();
  myIdEl.textContent = formatId(myId);
  initPresence();
  listenForInvites();
  listenForBlockStatus();
})();
