/* ============================================================
   Admin sign-in page (open the site's address with /admin at
   the end). Sign-in goes through the reem.bi account system
   (login.reembir.com, loaded as window.ReemAuth):

     1. the admin signs in to reem.bi (the SDK handles the whole
        redirect / PKCE flow and comes back to this page);
     2. if the account is ADMIN_EMAIL, this page asks login.reembir.com
        for a Firebase custom token and signs the 'admin' Firebase app
        in with it — the token carries sso_email / sso_site claims,
        which is exactly what firebase-rules.json checks;
     3. the browser goes back to the main app with #admin, which opens
        the dashboard.

   ?logout (sent by the main app's sign-out button and idle timeout)
   signs out of both Firebase and reem.bi, then returns home.
   ============================================================ */

const adminApp = firebase.initializeApp(firebaseConfig, 'admin');
const fbAuth = adminApp.auth();

const DASHBOARD_URL = '../#admin';
const HOME_URL = '../';
const ADMIN_IDLE_LIMIT_MS = 30 * 60 * 1000;
const ADMIN_ACTIVITY_KEY = 'numbers_admin_last_activity';

const checkingEl = document.getElementById('admin-login-checking');
const panelSignedOut = document.getElementById('panel-signed-out');
const panelAccount = document.getElementById('panel-account');
const loginBtn = document.getElementById('btn-sso-login');
const logoutBtn = document.getElementById('btn-sso-logout');
const accountLink = document.getElementById('sso-account-link');
const avatarImg = document.getElementById('sso-avatar');
const initialEl = document.getElementById('sso-initial');
const nameEl = document.getElementById('sso-name');
const emailEl = document.getElementById('sso-email');
const statusEl = document.getElementById('admin-login-status');

function setStatus(msg, kind) {
  statusEl.textContent = msg || '';
  statusEl.className = 'status-line' + (kind ? ' ' + kind : '');
}

// 'checking' | 'signed-out' | 'account'
function showPanel(name) {
  checkingEl.hidden = name !== 'checking';
  panelSignedOut.hidden = name !== 'signed-out';
  panelAccount.hidden = name !== 'account';
}

function showAccount(user) {
  const name = (user.name || '').trim();
  nameEl.textContent = name || user.email || '';
  emailEl.textContent = name ? (user.email || '') : '';
  emailEl.hidden = !name;
  initialEl.textContent = (name || user.email || '?').trim().charAt(0).toUpperCase();
  if (user.avatar) {
    avatarImg.src = user.avatar;
    avatarImg.hidden = false;
    initialEl.hidden = true;
  } else {
    avatarImg.hidden = true;
    initialEl.hidden = false;
  }
  showPanel('account');
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

function isAdminEmail(email) {
  return typeof email === 'string' && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

async function firebaseUserIsAdmin(user) {
  try {
    const { claims } = await user.getIdTokenResult();
    return claims.sso_site === SSO_CLIENT_ID && isAdminEmail(claims.sso_email);
  } catch (e) {
    return false;
  }
}

const params = new URLSearchParams(location.search);
const sso = window.ReemAuth ? ReemAuth.init({ clientId: SSO_CLIENT_ID }) : null;

if (sso) accountLink.href = sso.accountUrl();

// ---------- ?logout: sign out of everything, then go home ----------
async function logoutEverywhere() {
  clearActivity();
  try { await fbAuth.signOut(); } catch (e) { /* ignore */ }
  if (sso) {
    try { await sso.ready; } catch (e) { /* ignore */ }
    try { await sso.logout(); } catch (e) { /* ignore */ }
  }
}

if (params.has('logout')) {
  showPanel('checking');
  checkingEl.textContent = 'מתנתק/ת…';
  logoutEverywhere().then(() => location.replace(HOME_URL));
} else if (!sso) {
  // login.reembir.com is unreachable — the rest of the site keeps working,
  // only admin sign-in is unavailable for now
  showPanel('signed-out');
  loginBtn.disabled = true;
  setStatus('שרת ההתחברות לא זמין כרגע — נסו שוב מאוחר יותר', 'error');
} else {
  startSignInFlow();
}

function startSignInFlow() {
  let firebaseUser; // undefined until Firebase restored its session
  let busy = false;
  let again = false; // a state change arrived while busy — re-check after
  let gaveUp = false; // minting failed once — don't retry on its own (no loops)

  fbAuth.onAuthStateChanged((u) => {
    firebaseUser = u;
    decide();
  });
  sso.onChange(() => decide());

  async function decide() {
    if (busy) { again = true; return; }
    const ssoUser = sso.user;
    if (firebaseUser === undefined || ssoUser === undefined) {
      showPanel('checking');
      return;
    }
    busy = true;
    try {
      if (!ssoUser) {
        // signed out of reem.bi (or it was revoked) — don't leave a
        // Firebase admin session behind without it
        if (firebaseUser) await fbAuth.signOut();
        showPanel('signed-out');
        if (sso.error === 'no_access') setStatus('לחשבון הזה אין גישה לאתר', 'error');
        else if (sso.error) setStatus('ההתחברות לא הושלמה, נסו שוב', 'error');
        return;
      }

      if (!isAdminEmail(ssoUser.email)) {
        if (firebaseUser) await fbAuth.signOut();
        showAccount(ssoUser);
        setStatus('החשבון הזה אינו חשבון המנהל', 'error');
        return;
      }

      // the admin is signed in to reem.bi
      if (firebaseUser && await firebaseUserIsAdmin(firebaseUser)) {
        if (sessionExpired()) {
          // a remembered session that sat idle for more than 30 minutes
          await logoutEverywhere();
          firebaseUser = null;
          showPanel('signed-out');
          setStatus('החיבור פג אחרי 30 דקות ללא פעילות — התחברו שוב');
          return;
        }
        markActivity();
        location.replace(DASHBOARD_URL);
        return;
      }

      if (gaveUp) return; // keep the error on screen; a reload retries
      showPanel('checking');
      checkingEl.textContent = 'מתחבר/ת…';
      setStatus('');
      const token = await sso.getFirebaseToken();
      // a fresh sign-in counts as activity, so an old timestamp can't
      // make the idle check reject it
      markActivity();
      const cred = await fbAuth.signInWithCustomToken(token);
      if (!await firebaseUserIsAdmin(cred.user)) {
        gaveUp = true;
        // the token's claims don't match ADMIN_EMAIL / SSO_CLIENT_ID —
        // the database would refuse every admin action anyway
        await fbAuth.signOut();
        showAccount(ssoUser);
        setStatus('ההרשאות שהתקבלו אינן של חשבון המנהל', 'error');
        return;
      }
      location.replace(DASHBOARD_URL);
    } catch (err) {
      console.error('Admin sign-in failed:', err);
      gaveUp = true;
      showAccount(sso.user || {});
      if (err && err.code === 'not_configured') {
        setStatus('ההתחברות למסד הנתונים עוד לא הוגדרה בשרת ההתחברות (חסר הסוד FIREBASE_SA_ANONCHAT)', 'error');
      } else if (err && err.code === 'no_access') {
        setStatus('לחשבון הזה אין גישה לאתר', 'error');
      } else {
        setStatus('לא הצלחנו להשלים את הכניסה — רעננו את הדף ונסו שוב', 'error');
      }
    } finally {
      busy = false;
      if (again) {
        again = false;
        decide();
      }
    }
  }
}

loginBtn.addEventListener('click', () => {
  if (!sso) return;
  loginBtn.disabled = true;
  setStatus('');
  sso.login().catch(() => {
    loginBtn.disabled = false;
    setStatus('לא הצלחנו לפתוח את דף ההתחברות', 'error');
  });
});

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true;
  await logoutEverywhere();
  logoutBtn.disabled = false;
  setStatus('');
  showPanel('signed-out');
});
