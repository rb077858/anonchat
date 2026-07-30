/* ============================================================
   NUMBERS — anonymous chat
   All app logic lives here: device identity, presence, random
   matchmaking, connect-by-ID, and the realtime chat room itself.
   ============================================================ */

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ---------- DOM ----------
const screens = {
  home: document.getElementById('screen-home'),
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
// 1. DEVICE IDENTITY — a persisted random 7-digit numeric ID
// ============================================================
function randomSevenDigitId() {
  return String(Math.floor(1000000 + Math.random() * 9000000));
}

async function idIsTaken(id) {
  const snap = await db.ref('users/' + id).once('value');
  return snap.exists();
}

async function getOrCreateMyId() {
  const stored = localStorage.getItem('numbers_my_id');
  if (stored && /^[0-9]{7}$/.test(stored)) return stored;

  let candidate = randomSevenDigitId();
  let attempts = 0;
  while (await idIsTaken(candidate) && attempts < 6) {
    candidate = randomSevenDigitId();
    attempts++;
  }
  localStorage.setItem('numbers_my_id', candidate);
  return candidate;
}

function formatId(id) {
  return id.split('').join(' ');
}

// ============================================================
// 2. PRESENCE
// ============================================================
function initPresence() {
  const myRef = db.ref('users/' + myId);
  const connectedRef = db.ref('.info/connected');

  connectedRef.on('value', (snap) => {
    if (snap.val() === true) {
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
  });
}

function setMyStatus(status) {
  state = status;
  db.ref('users/' + myId).update({ status });
}

// ============================================================
// 3. INCOMING INVITES (connect-by-ID)
// ============================================================
function listenForInvites() {
  const invitesRef = db.ref('users/' + myId + '/invites');
  invitesRef.on('child_added', (snap) => {
    const invite = snap.val();
    const roomId = snap.key;
    if (!invite || !invite.from) return;

    if (state !== 'idle') {
      // already busy — politely ignore, remove so it doesn't pile up
      db.ref('users/' + myId + '/invites/' + roomId).remove();
      return;
    }

    pendingInviteRoomId = roomId;
    inviteFromEl.textContent = formatId(invite.from);
    inviteToast.hidden = false;

    // if the caller cancels before we respond, hide the toast
    db.ref('rooms/' + roomId + '/canceled').on('value', (s) => {
      if (s.val() === true && pendingInviteRoomId === roomId) {
        inviteToast.hidden = true;
        pendingInviteRoomId = null;
      }
    });
  });
}

btnAccept.addEventListener('click', async () => {
  if (!pendingInviteRoomId) return;
  const roomId = pendingInviteRoomId;
  const snap = await db.ref('users/' + myId + '/invites/' + roomId).once('value');
  const invite = snap.val();
  inviteToast.hidden = true;
  pendingInviteRoomId = null;
  if (!invite) return; // invite was withdrawn

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

  if (!/^[0-9]{7}$/.test(targetId)) {
    setHomeStatus('enter a valid 7-digit ID', 'error');
    return;
  }
  if (targetId === myId) {
    setHomeStatus("that's your own signal", 'error');
    return;
  }

  setHomeStatus('checking signal…');
  const snap = await db.ref('users/' + targetId + '/online').once('value');
  if (snap.val() !== true) {
    setHomeStatus('that signal is offline', 'error');
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
  inputPartner.value = inputPartner.value.replace(/\D/g, '').slice(0, 7);
});

// ============================================================
// 5. RANDOM MATCHMAKING
// ============================================================
btnRandom.addEventListener('click', startRandomSearch);
btnCancel.addEventListener('click', cancelRandomSearch);

let myWaitingRoomId = null;

function startRandomSearch() {
  setMyStatus('searching');
  showScreen('search');
  searchIdCenter.textContent = formatId(myId);
  scanText.textContent = 'scanning frequencies…';

  const waitingRef = db.ref('matchmaking/waiting');
  let matchedWaiter = null;

  waitingRef.transaction((current) => {
    matchedWaiter = null;
    if (current === null) {
      // nobody waiting — I become the waiter
      myWaitingRoomId = myId + '_' + Date.now();
      return { id: myId, roomId: myWaitingRoomId };
    }
    if (current.id === myId) {
      // already registered as waiter (retry safety)
      return current;
    }
    // someone else is waiting — that's my match, claim it
    matchedWaiter = current;
    return null;
  }).then(async ({ committed }) => {
    if (!committed) {
      setHomeStatus('could not reach the signal, try again', 'error');
      showScreen('home');
      setMyStatus('idle');
      return;
    }

    if (matchedWaiter) {
      // I matched with someone already waiting
      const roomId = matchedWaiter.roomId;
      await db.ref('rooms/' + roomId + '/participants/' + myId).set(true);
      joinChatRoom(roomId, matchedWaiter.id);
    } else {
      // I'm now the one waiting — listen for a partner to join my room
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

      // give up after 45s of no match
      searchTimeoutHandle = setTimeout(() => {
        participantsRef.off('value', onPartner);
        cancelRandomSearch('no one answered — try again');
      }, 45000);
    }
  }).catch(() => {
    setHomeStatus('connection error, try again', 'error');
    showScreen('home');
    setMyStatus('idle');
  });
}

function cancelRandomSearch(message) {
  clearTimeout(searchTimeoutHandle);
  clearAllListeners();

  // release the shared waiting slot only if it's still ours
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
    opts.calling ? 'calling ' + peerId + '…' : 'connected to ' + peerId,
    'system'
  );

  // incoming messages
  const messagesRef = db.ref('rooms/' + roomId + '/messages');
  track(messagesRef, 'child_added', (snap) => {
    const m = snap.val();
    if (!m) return;
    appendMessage(m.text, m.sender === myId ? 'me' : 'them');
  });

  // peer online/offline dot
  const peerOnlineRef = db.ref('users/' + peerId + '/online');
  track(peerOnlineRef, 'value', (snap) => {
    peerStatusEl.classList.toggle('offline', snap.val() !== true);
  });

  // peer accepted a call I placed
  if (opts.calling) {
    const partnerJoinedRef = db.ref('rooms/' + roomId + '/participants/' + peerId);
    track(partnerJoinedRef, 'value', (snap) => {
      if (snap.val() === true) {
        appendMessage(peerId + ' answered', 'system');
      }
    });
    const declinedRef = db.ref('rooms/' + roomId + '/declined');
    track(declinedRef, 'value', (snap) => {
      if (snap.val() === true) {
        appendMessage(peerId + ' declined the call', 'system');
        setTimeout(() => leaveChat(), 1500);
      }
    });
  }

  // typing indicator from peer
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
// 7. BOOT
// ============================================================
(async function init() {
  myId = await getOrCreateMyId();
  myIdEl.textContent = formatId(myId);
  initPresence();
  listenForInvites();
})();
