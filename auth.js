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
const passwordHint = document.getElementById("password-hint");

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
  passwordHint.style.display = isSignup ? "block" : "none";
  errorMsg.style.display = "none";
});

// 入力が「@」を含んでいれば本物のメールアドレスとしてそのまま使い、
// 含んでいなければユーザー名とみなして内部的な擬似メール形式に変換する
const FAKE_EMAIL_DOMAIN = "hogoneko-app.local";
function resolveEmail(input) {
  if (input.includes("@")) {
    return input; // メールアドレスとしてそのまま使う
  }
  return `${input.toLowerCase()}@${FAKE_EMAIL_DOMAIN}`; // ユーザー名 → 擬似メール
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorMsg.style.display = "none";
  submitBtn.disabled = true;

  const rawInput = emailInput.value.trim();
  const password = passwordInput.value;

  if (!rawInput.includes("@") && !/^[A-Za-z0-9_]+$/.test(rawInput)) {
    errorMsg.textContent = "ユーザー名は半角英数字とアンダースコアのみ使えます";
    errorMsg.style.display = "block";
    submitBtn.disabled = false;
    return;
  }

  const email = resolveEmail(rawInput);

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
    "auth/invalid-email": "ユーザー名またはメールアドレスの形式が正しくありません",
    "auth/user-not-found": "アカウントが見つかりません",
    "auth/wrong-password": "パスワードが間違っています",
    "auth/invalid-credential": "ユーザー名(メールアドレス)またはパスワードが間違っています",
    "auth/email-already-in-use": "このユーザー名(メールアドレス)は既に使われています",
    "auth/weak-password": "パスワードは6文字以上にしてください"
  };
  return map[code] || "エラーが発生しました。もう一度お試しください";
}
