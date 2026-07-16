import { auth } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const form = document.getElementById("login-form");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const errorMsg = document.getElementById("error-msg");
const submitBtn = document.getElementById("submit-btn");
const toggleBtn = document.getElementById("toggle-mode");

let isSignup = false;

// すでにログイン済みならダッシュボードへ
onAuthStateChanged(auth, (user) => {
  if (user) {
    window.location.href = "app.html";
  }
});

toggleBtn.addEventListener("click", () => {
  isSignup = !isSignup;
  submitBtn.textContent = isSignup ? "新規登録する" : "ログイン";
  toggleBtn.textContent = isSignup
    ? "すでにアカウントをお持ちの方はこちら(ログイン)"
    : "アカウントを持っていない方はこちら(新規登録)";
  errorMsg.style.display = "none";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorMsg.style.display = "none";
  submitBtn.disabled = true;

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  try {
    if (isSignup) {
      await createUserWithEmailAndPassword(auth, email, password);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
    window.location.href = "app.html";
  } catch (err) {
    errorMsg.textContent = translateError(err.code);
    errorMsg.style.display = "block";
  } finally {
    submitBtn.disabled = false;
  }
});

function translateError(code) {
  const map = {
    "auth/invalid-email": "メールアドレスの形式が正しくありません",
    "auth/user-not-found": "アカウントが見つかりません",
    "auth/wrong-password": "パスワードが間違っています",
    "auth/invalid-credential": "メールアドレスまたはパスワードが間違っています",
    "auth/email-already-in-use": "このメールアドレスは既に登録されています",
    "auth/weak-password": "パスワードは6文字以上にしてください"
  };
  return map[code] || "エラーが発生しました。もう一度お試しください";
}
