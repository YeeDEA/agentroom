import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js";

const authSection = document.getElementById("auth-section");
const appSection = document.getElementById("app-section");
const userEmailEl = document.getElementById("user-email");
const statusEl = document.getElementById("status");

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");

document.getElementById("signup-btn").addEventListener("click", async () => {
  await handleAuthAction(async () => {
    const credential = await createUserWithEmailAndPassword(auth, emailInput.value, passwordInput.value);
    await setDoc(doc(db, "users", credential.user.uid), {
      uid: credential.user.uid,
      email: credential.user.email,
      createdAt: serverTimestamp(),
    });
  });
});

document.getElementById("login-btn").addEventListener("click", async () => {
  await handleAuthAction(() => signInWithEmailAndPassword(auth, emailInput.value, passwordInput.value));
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await signOut(auth);
});

async function handleAuthAction(action) {
  statusEl.textContent = "";
  try {
    await action();
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    authSection.hidden = true;
    appSection.hidden = false;
    userEmailEl.textContent = user.email;
  } else {
    authSection.hidden = false;
    appSection.hidden = true;
  }
});
