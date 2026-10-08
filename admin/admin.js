/* ============================================================
   Admin sign-in page (open the site's address with /admin at
   the end). On success it sends the browser back to the main
   app with #admin in the address, which opens the dashboard.

   Uses the same named 'admin' Firebase app as app.js, so the
   session it creates is the one the main app picks up, and the
   same last-activity key for the 30-minute idle timeout.
   ============================================================ */

const adminApp = firebase.initializeApp(firebaseConfig, 'admin');
const auth = adminApp.auth();

const DASHBOARD_URL = '../#admin';
const ADMIN_IDLE_LIMIT_MS = 30 * 60 * 1000;
const ADMIN_ACTIVITY_KEY = 'numbers_admin_last_activity';
const LOGIN_TIMEOUT_MS = 15000;

const formEl = document.getElementById('admin-login-form');
const checkingEl = document.getElementById('admin-login-checking');
const emailInput = document.getElementById('admin-email');
const passwordInput = document.getElementById('admin-password');
const submitBtn = document.getElementById('btn-admin-login-submit');
const statusEl = document.getElementById('admin-login-status');
const togglePasswordBtn = document.getElementById('btn-toggle-password');

let signingIn = false;

function setStatus(msg, kind) {
  statusEl.textContent = msg || '';
  statusEl.className = 'status-line' + (kind ? ' ' + kind : '');
}

function showForm() {
  checkingEl.hidden = true;
  formEl.hidden = false;
  if (!emailInput.value) emailInput.focus();
}

function markActivity() {
  try { localStorage.setItem(ADMIN_ACTIVITY_KEY, String(Date.now())); } catch (e) { /* ignore */ }
}
function clearActivity() {
  try { localStorage.removeItem(ADMIN_ACTIVITY_KEY); } catch (e) { /* ignore */ }
}
function sessionExpired() {
  try {
    const last = parseInt(localStorage.getItem(ADMIN_ACTIVITY_KEY), 10);
    if (!last) return false;
    return Date.now() - last > ADMIN_IDLE_LIMIT_MS;
  } catch (e) {
    return false;
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

if (typeof ADMIN_UID !== 'string' || !ADMIN_UID || ADMIN_UID.indexOf('REPLACE_WITH') === 0) {
  showForm();
  setStatus('ADMIN_UID עדיין לא הוגדר ב-firebase-config.js', 'error');
}

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    showForm();
    return;
  }
  if (user.uid !== ADMIN_UID) {
    // signed in fine, but not with the account set as ADMIN_UID —
    // almost always a setup mistake, so say so clearly
    console.warn('Signed in, but UID does not match ADMIN_UID:', user.uid);
    await auth.signOut();
    showForm();
    setStatus('ההתחברות הצליחה אך זה אינו חשבון המנהל המוגדר (בדקו את ADMIN_UID ב-firebase-config.js)', 'error');
    return;
  }
  if (!signingIn && sessionExpired()) {
    // a remembered session that sat idle for more than 30 minutes
    clearActivity();
    await auth.signOut();
    showForm();
    return;
  }
  markActivity();
  location.replace(DASHBOARD_URL);
});

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (signingIn) return;
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) {
    setStatus('מלא/י אימייל וסיסמה', 'error');
    return;
  }
  signingIn = true;
  submitBtn.disabled = true;
  setStatus('מתחבר/ת…');
  // a fresh sign-in counts as activity — otherwise a timestamp left over
  // from an old session would make the idle check reject this login
  markActivity();
  try {
    await withTimeout(auth.signInWithEmailAndPassword(email, password), LOGIN_TIMEOUT_MS);
    // onAuthStateChanged above takes it from here
  } catch (err) {
    signingIn = false;
    submitBtn.disabled = false;
    if (err && err.message === 'timeout') {
      setStatus('אין תגובה מהשרת — בדקו את החיבור ונסו שוב', 'error');
    } else if (err && err.code === 'auth/too-many-requests') {
      setStatus('יותר מדי ניסיונות — נסו שוב בעוד כמה דקות', 'error');
    } else if (err && err.code === 'auth/network-request-failed') {
      setStatus('בעיית רשת — נסו שוב', 'error');
    } else {
      setStatus('אימייל או סיסמה שגויים', 'error');
    }
    passwordInput.select();
  }
});

togglePasswordBtn.addEventListener('click', () => {
  const show = passwordInput.type === 'password';
  passwordInput.type = show ? 'text' : 'password';
  togglePasswordBtn.setAttribute('aria-pressed', String(show));
  togglePasswordBtn.setAttribute('aria-label', show ? 'הסתרת הסיסמה' : 'הצגת הסיסמה');
});
