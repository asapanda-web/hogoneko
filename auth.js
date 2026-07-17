import { auth, db } from "./firebase-config.js?v=1784218044";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ORG_NAME, APP_TITLE, ADMIN_EMAIL } from "./site-config.js?v=1784218044";

// 団体名・アプリ名を画面に反映
const titleText = ORG_NAME ? `${APP_TITLE}(${ORG_NAME})` : APP_TITLE;
document.getElementById("brand-title").textContent = `🐾 ${titleText}`;
document.getElementById("page-title").textContent = `ログイン | ${titleText}`;

const form = document.getElementById("login-form");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const errorMsg = document.getElementById("error-msg");
const submitBtn = document.getElementById("submit-btn");
const toggleBtn = document.getElementById("toggle-mode");
const passwordHint = document.getElementById("password-hint");
const inviteCodeWrap = document.getElementById("invite-code-wrap");

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
  document.getElementById("signup-reset-hint").style.display = isSignup ? "block" : "none";
  inviteCodeWrap.classList.toggle("hidden", !isSignup);
  errorMsg.style.display = "none";
});

// ---------- 招待リンク(QRコード)から開いた場合、招待コードを自動入力する ----------
(function applyInviteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const role = params.get("role");
  const code = params.get("code");
  if (!role || !code) return;

  // 新規登録モードに自動で切り替える
  isSignup = true;
  submitBtn.textContent = "新規登録する";
  toggleBtn.textContent = "すでにアカウントをお持ちの方はこちら(ログイン)";
  passwordHint.style.display = "block";
  document.getElementById("signup-reset-hint").style.display = "block";
  inviteCodeWrap.classList.remove("hidden");

  const inviteRoleSelect = document.getElementById("invite-role");
  const inviteCodeInput = document.getElementById("invite-code");
  if (role === "shelter") inviteRoleSelect.value = "シェルターメンバー";
  if (role === "foster") inviteRoleSelect.value = "預りメンバー";
  inviteCodeInput.value = code;
})();

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
      const cred = await createUserWithEmailAndPassword(auth, email, password);

      const inviteRole = document.getElementById("invite-role").value;
      const inviteCode = document.getElementById("invite-code").value.trim();

      if (inviteRole && inviteCode) {
        // 招待コード付きの登録を試みる。コードが正しければその役割ですぐ使えるようになる
        try {
          await setDoc(doc(db, "users", cred.user.uid), {
            username: rawInput,
            role: inviteRole,
            inviteCode: inviteCode,
            createdAt: serverTimestamp()
          });
        } catch (inviteErr) {
          // コードが間違っていた場合は、通常通り「未設定」で登録する
          await setDoc(doc(db, "users", cred.user.uid), {
            username: rawInput,
            role: "未設定",
            createdAt: serverTimestamp()
          });
          errorMsg.textContent = "招待コードが正しくなかったため、通常登録になりました。管理者による設定をお待ちください。";
          errorMsg.style.display = "block";
        }
      } else {
        // 役割は最初「未設定」。管理者がFirebaseコンソールで役割を割り当てるまでは
        // データが見えない状態になる(Firestoreのルールで制御)
        await setDoc(doc(db, "users", cred.user.uid), {
          username: rawInput,
          role: "未設定",
          createdAt: serverTimestamp()
        });
      }
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

// ---------- パスワードを忘れた方向けの再設定 ----------
const showResetBtn = document.getElementById("show-reset-btn");
const resetPanel = document.getElementById("reset-panel");
const resetEmailInput = document.getElementById("reset-email");
const resetSubmitBtn = document.getElementById("reset-submit-btn");
const resetStatus = document.getElementById("reset-status");

showResetBtn.addEventListener("click", () => {
  resetPanel.classList.toggle("hidden");
});

resetSubmitBtn.addEventListener("click", async () => {
  const input = resetEmailInput.value.trim();
  resetStatus.textContent = "";

  if (!input) {
    resetStatus.textContent = "ユーザー名またはメールアドレスを入力してください。";
    return;
  }

  if (!input.includes("@")) {
    // ユーザー名だけで登録した人は、自分では再設定できない
    resetStatus.textContent = "ユーザー名だけで登録した方は、自分でパスワードを再設定できません。下の依頼文をコピーして管理者に送ってください。";
    return;
  }

  resetSubmitBtn.disabled = true;
  resetStatus.textContent = "送信しています...";
  try {
    await sendPasswordResetEmail(auth, input);
    resetStatus.textContent = "再設定メールを送信しました。メールボックスをご確認ください(迷惑メールフォルダも念のためご確認ください)。";
  } catch (err) {
    resetStatus.textContent = "送信できませんでした。メールアドレスが正しいかご確認ください。";
  } finally {
    resetSubmitBtn.disabled = false;
  }
});

// ---------- アカウント削除依頼の依頼文(ユーザー名だけで登録した方向け) ----------
const reissueRequestText = document.getElementById("reissue-request-text");
const reissueCopyBtn = document.getElementById("reissue-copy-btn");
const reissueCopyStatus = document.getElementById("reissue-copy-status");

function updateReissueRequestText() {
  const username = resetEmailInput.value.trim() || "(ここにユーザー名を入力してください)";
  reissueRequestText.value =
    `【アカウント削除のお願い】\nユーザー名: ${username}\nパスワードを忘れてしまったため、既存アカウントの削除をお願いします。削除後、同じユーザー名で登録し直します。`;
}

resetEmailInput.addEventListener("input", updateReissueRequestText);
showResetBtn.addEventListener("click", updateReissueRequestText);

reissueCopyBtn.addEventListener("click", async () => {
  updateReissueRequestText();
  try {
    await navigator.clipboard.writeText(reissueRequestText.value);
    reissueCopyStatus.textContent = "コピーしました。管理者に送ってください。";
  } catch (err) {
    reissueRequestText.select();
    reissueCopyStatus.textContent = "自動コピーできなかったため、文章を選択状態にしました。手動でコピーしてください。";
  }
});

document.getElementById("reissue-mail-btn").addEventListener("click", () => {
  updateReissueRequestText();
  const subject = encodeURIComponent("アカウント削除のお願い");
  const body = encodeURIComponent(reissueRequestText.value);
  window.location.href = `mailto:${ADMIN_EMAIL}?subject=${subject}&body=${body}`;
});
