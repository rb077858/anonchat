// ============================================================
// Firebase project configuration.
// Replace every value below with the config from your own
// Firebase project (Project settings -> General -> Your apps -> SDK setup).
// This file is safe to be public — these are client identifiers,
// not secrets. Actual protection comes from your Realtime Database
// security rules (see firebase-rules.json) and from your admin
// account's real password (see ADMIN_UID below and the README).
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
// The Firebase Auth UID of the ONE admin account you create for
// yourself (Authentication -> Users -> Add user, in the Firebase
// console). Paste that user's UID here.
//
// This value is NOT a secret — knowing it grants nothing without
// the matching password. The real gate is in firebase-rules.json,
// which must contain this exact same UID. See README.md, step 3.
// ============================================================
const ADMIN_UID = "q5nzb7TJ3eNw8TXFdidlHb3lwNQ2";
