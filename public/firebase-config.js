import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js";
import { getAI, GoogleAIBackend } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-ai.js";

const firebaseConfig = {
  apiKey: "AIzaSyDfs-qGvrIy86HKPr17Wi2vEsop0Yzq68U",
  authDomain: "yonsei-yongjun-biz-prototype.firebaseapp.com",
  projectId: "yonsei-yongjun-biz-prototype",
  storageBucket: "yonsei-yongjun-biz-prototype.firebasestorage.app",
  messagingSenderId: "664398287606",
  appId: "1:664398287606:web:f450937b8c625b0c3592d7",
  measurementId: "G-5FYCG6W624",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
// Firebase AI Logic (Gemini) — 콘솔에서 AI Logic을 활성화해야 실제 호출이 성공합니다.
export const ai = getAI(app, { backend: new GoogleAIBackend() });
