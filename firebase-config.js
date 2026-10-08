// ============================================================
// Firebase project configuration.
// Replace every value below with the config from your own
// Firebase project (Project settings -> General -> Your apps -> SDK setup).
// This file is safe to be public — these are client identifiers,
// not secrets. Actual protection comes from your Realtime Database
// security rules (see firebase-rules.json) and from your admin
// reem.bi sign-in (see SSO_CLIENT_ID / ADMIN_EMAIL below and the README).
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyD0hbI667K1P2FNU1KqINm8MPL1JtdvE30",
  authDomain: "anonchat-91d21.firebaseapp.com",
  databaseURL: "https://anonchat-91d21-default-rtdb.firebaseio.com",
  projectId: "anonchat-91d21",
  storageBucket: "anonchat-91d21.firebasestorage.app",
  messagingSenderId: "617121252083",
  appId: "1:617121252083:web:cfcdf4f719f68d70cd2d86",
  measurementId: "G-MKME24SFNZ"
};

// ============================================================
// Admin sign-in goes through the reem.bi account system
// (login.reembir.com). Whoever signs in there with ADMIN_EMAIL on
// the site registered as SSO_CLIENT_ID gets the admin dashboard.
//
// Neither value is a secret. The real gate is in firebase-rules.json,
// which checks the same email and client id inside the Firebase token
// that login.reembir.com issues — keep them in sync. See README.md.
// ============================================================
const SSO_CLIENT_ID = "anonchat";
const ADMIN_EMAIL = "admin@reembir.com";
