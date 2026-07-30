/* ============================================================
   צ'אט אנונימי — Anonymous Chat
   All app logic lives here: device identity, presence, random
   matchmaking, connect-by-ID, the chat room, and the settings /
   reset flow.
   ============================================================ */

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const ID_LENGTH = 6;
const ID_REGEX = /^[0-9]{6}$/;

// ---------- DOM ----------
const screens = {
  home: document.getElementById('screen-home'),
  settings: document.getElementById('screen-settings'),
  search: document.getElementById('screen-search'),
  chat: document.getElementById('screen-chat'),
};
const myIdEl        = document.getElementById('my-id');
const homeStatusEl  = document.getElementById('home-status');
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
const peerIdEl      = document.getElementById('peer-id');
const peerStatusEl  = document.getElementById('peer-status');
const messagesEl    = document.getElementById('messages');
const typingIndicator = document.getElementById('typing-indicator');
const formMessage   = document.getElementById('form-message');
const inputMessage  = document.getElementById('input-message');

// ---------- app state ----------
let myId = null;
let state = 'idle'; // idle | searching | chatting
let currentRoomId = null;
let currentPeerId = null;
let pendingInviteRoomId = null; // invite currently shown in toast
let searchTimeoutHandle = null;
let typingClearHandle = null;

// active listener refs so we can detach cleanly
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

// ============================================================
// 1. DEVICE IDENTITY — a persisted random 6-digit numeric ID
// ============================================================
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

function formatId(id) {
  return id.split('').join(' ');
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
// 3. INCOMING INVITES (connect-by-ID)
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
      // כבר בשיחה — מתעלמים בשקט כדי שלא ייערמו הזמנות
      db.ref('users/' + myId + '/invites/' + roomId).remove();
      return;
    }

    pendingInviteRoomId = roomId;
    inviteFromEl.textContent = formatId(invite.from);
    inviteToast.hidden = false;

    // אם המתקשר מבטל לפני שעונים, נסתיר את ההתראה
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
  if (!invite) return; // ההזמנה בוטלה בינתיים

  await db.ref('rooms/' + roomId + '/participants/' + myId).set(true);
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
// 4. CONNECT BY ID (direct call)
// ============================================================
formConnect.addEventListener('submit', async (e) => {
  e.preventDefault();
  const targetId = inputPartner.value.trim();

  if (!ID_REGEX.test(targetId)) {
    setHomeStatus('הזן/י מספר תקין בן 6 ספרות', 'error');
    return;
  }
  if (targetId === myId) {
    setHomeStatus('זה האות שלך', 'error');
    return;
  }

  setHomeStatus('בודק/ת אות…');
  const snap = await db.ref('users/' + targetId + '/online').once('value');
  if (snap.val() !== true) {
    setHomeStatus('האות הזה לא מחובר', 'error');
    return;
  }

  const roomId = [myId, targetId].sort().join('_') + '_' + Date.now();
  await db.ref('rooms/' + roomId + '/participants/' + myId).set(true);
  await db.ref('users/' + targetId + '/invites/' + roomId).set({
    from: myId,
    timestamp: firebase.database.ServerValue.TIMESTAMP,
  });

  setHomeStatus('');
  inputPartner.value = '';
  joinChatRoom(roomId, targetId, { calling: true });
});

inputPartner.addEventListener('input', () => {
  inputPartner.value = inputPartner.value.replace(/\D/g, '').slice(0, ID_LENGTH);
});

// ============================================================
// 5. RANDOM MATCHMAKING
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
      // אף אחד לא ממתין — אני הופך/ת לממתין/ה
      myWaitingRoomId = myId + '_' + Date.now();
      return { id: myId, roomId: myWaitingRoomId };
    }
    if (current.id === myId) {
      return current;
    }
    // מישהו כבר ממתין — זו ההתאמה שלי
    matchedWaiter = current;
    return null;
  }).then(async ({ committed }) => {
    if (!committed) {
      setHomeStatus('לא הצלחנו להתחבר, נסה/י שוב', 'error');
      showScreen('home');
      setMyStatus('idle');
      return;
    }

    if (matchedWaiter) {
      const roomId = matchedWaiter.roomId;
      await db.ref('rooms/' + roomId + '/participants/' + myId).set(true);
      joinChatRoom(roomId, matchedWaiter.id);
    } else {
      await db.ref('rooms/' + myWaitingRoomId + '/participants/' + myId).set(true);
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
// 6. CHAT ROOM
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

  if (opts.calling) {
    const partnerJoinedRef = db.ref('rooms/' + roomId + '/participants/' + peerId);
    track(partnerJoinedRef, 'value', (snap) => {
      if (snap.val() === true) {
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
    text,
    timestamp: firebase.database.ServerValue.TIMESTAMP,
  });
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
// 7. SETTINGS / RESET
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

  // אם באמצע שיחה או חיפוש, יוצאים ממנו קודם
  if (currentRoomId) await leaveChat();
  if (state === 'searching') cancelRandomSearch();
  clearAllListeners();

  const oldId = myId;
  try {
    await db.ref('users/' + oldId).remove();
  } catch (e) {
    // אם לא הצלחנו למחוק את הרשומה הישנה זה בסדר, פשוט נזוז הלאה
  }

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
// 8. BOOT
// ============================================================
(async function init() {
  myId = await getOrCreateMyId();
  myIdEl.textContent = formatId(myId);
  initPresence();
  listenForInvites();
})();
