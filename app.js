import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, addDoc, deleteDoc, doc, onSnapshot,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let currentUser = null;
let currentCatId = null;
let unsubCats = null;
let unsubDaily = null;
let unsubMedical = null;

// ---------- 認証チェック ----------
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  listenCats();
});

document.getElementById("logout-btn").addEventListener("click", () => {
  signOut(auth);
});

// ---------- 画面切り替え ----------
const viewDashboard = document.getElementById("view-dashboard");
const viewDetail = document.getElementById("view-detail");

function showDashboard() {
  currentCatId = null;
  if (unsubDaily) unsubDaily();
  if (unsubMedical) unsubMedical();
  viewDetail.classList.add("hidden");
  viewDashboard.classList.remove("hidden");
}

function showDetail(catId, catData) {
  currentCatId = catId;
  viewDashboard.classList.add("hidden");
  viewDetail.classList.remove("hidden");
  document.getElementById("detail-name").textContent = catData.name;
  document.getElementById("detail-meta").textContent =
    [catData.sex, catData.age, catData.intake ? `保護開始: ${catData.intake}` : ""].filter(Boolean).join(" ・ ");
  listenDailyLogs(catId);
  listenMedicalRecords(catId);
}

document.getElementById("back-to-list").addEventListener("click", showDashboard);

// ---------- タブ切り替え ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById("tab-daily").classList.toggle("hidden", tab !== "daily");
    document.getElementById("tab-medical").classList.toggle("hidden", tab !== "medical");
  });
});

// ---------- 猫の一覧 ----------
function listenCats() {
  const q = query(collection(db, "cats"), orderBy("createdAt", "desc"));
  unsubCats = onSnapshot(q, (snap) => {
    const listEl = document.getElementById("cat-list");
    const emptyEl = document.getElementById("empty-cats");
    listEl.innerHTML = "";
    if (snap.empty) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");
    snap.forEach((docSnap) => {
      const cat = docSnap.data();
      const card = document.createElement("div");
      card.className = "cat-card";
      card.innerHTML = `
        <div class="cat-avatar">🐱</div>
        <div style="flex:1">
          <div class="name">${escapeHtml(cat.name)}</div>
          <div class="meta">${[cat.sex, cat.age].filter(Boolean).map(escapeHtml).join(" ・ ")}</div>
        </div>
      `;
      card.addEventListener("click", () => showDetail(docSnap.id, cat));
      listEl.appendChild(card);
    });
  });
}

// ---------- 日々の記録 ----------
function listenDailyLogs(catId) {
  if (unsubDaily) unsubDaily();
  const q = query(collection(db, "cats", catId, "dailyLogs"), orderBy("date", "desc"));
  unsubDaily = onSnapshot(q, (snap) => {
    const listEl = document.getElementById("daily-list");
    const emptyEl = document.getElementById("empty-daily");
    listEl.innerHTML = "";
    if (snap.empty) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");
    snap.forEach((docSnap) => {
      const log = docSnap.data();
      const card = document.createElement("div");
      card.className = "log-card";
      card.innerHTML = `
        <div class="row1">
          <span class="date mono">${log.date}</span>
          <span class="weight mono">${log.weight ? log.weight + " kg" : ""}</span>
        </div>
        <div class="detail">食欲: ${escapeHtml(log.appetite || "-")} ／ 排泄: ${escapeHtml(log.excretion || "-")}</div>
        ${log.memo ? `<div class="detail">${escapeHtml(log.memo)}</div>` : ""}
        <button class="btn btn-ghost btn-small" style="margin-top:6px;padding:0;" data-del>削除</button>
      `;
      card.querySelector("[data-del]").addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm("この記録を削除しますか？")) {
          deleteDoc(doc(db, "cats", catId, "dailyLogs", docSnap.id));
        }
      });
      listEl.appendChild(card);
    });
  });
}

// ---------- 医療記録 ----------
const tagClass = {
  "ワクチン": "tag-vaccine",
  "通院": "tag-hospital",
  "投薬": "tag-medication",
  "手術": "tag-hospital",
  "その他": "tag-other"
};

function listenMedicalRecords(catId) {
  if (unsubMedical) unsubMedical();
  const q = query(collection(db, "cats", catId, "medicalRecords"), orderBy("date", "desc"));
  unsubMedical = onSnapshot(q, (snap) => {
    const listEl = document.getElementById("medical-list");
    const emptyEl = document.getElementById("empty-medical");
    listEl.innerHTML = "";
    if (snap.empty) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");
    snap.forEach((docSnap) => {
      const rec = docSnap.data();
      const card = document.createElement("div");
      card.className = "log-card";
      card.innerHTML = `
        <div class="row1">
          <span class="date mono">${rec.date}</span>
          <span class="tag ${tagClass[rec.type] || "tag-other"}">${escapeHtml(rec.type)}</span>
        </div>
        <div class="detail" style="font-weight:500;color:var(--ink);margin-top:6px;">${escapeHtml(rec.title)}</div>
        ${rec.detail ? `<div class="detail">${escapeHtml(rec.detail)}</div>` : ""}
        ${rec.next ? `<div class="detail">次回予定: ${escapeHtml(rec.next)}</div>` : ""}
        <button class="btn btn-ghost btn-small" style="margin-top:6px;padding:0;" data-del>削除</button>
      `;
      card.querySelector("[data-del]").addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm("この記録を削除しますか？")) {
          deleteDoc(doc(db, "cats", catId, "medicalRecords", docSnap.id));
        }
      });
      listEl.appendChild(card);
    });
  });
}

// ---------- モーダル制御 ----------
const modalCat = document.getElementById("modal-cat");
const modalDaily = document.getElementById("modal-daily");
const modalMedical = document.getElementById("modal-medical");

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    btn.closest(".modal-overlay").classList.remove("open");
  });
});

document.getElementById("fab-btn").addEventListener("click", () => {
  if (viewDashboard.classList.contains("hidden")) {
    // 詳細画面 → 表示中のタブに応じてモーダルを出し分け
    const activeTab = document.querySelector(".tab-btn.active").dataset.tab;
    if (activeTab === "daily") {
      document.getElementById("daily-date").valueAsDate = new Date();
      modalDaily.classList.add("open");
    } else {
      document.getElementById("medical-date").valueAsDate = new Date();
      modalMedical.classList.add("open");
    }
  } else {
    modalCat.classList.add("open");
  }
});

// ---------- フォーム送信 ----------
document.getElementById("form-cat").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addDoc(collection(db, "cats"), {
    name: document.getElementById("cat-name").value.trim(),
    sex: document.getElementById("cat-sex").value,
    age: document.getElementById("cat-age").value.trim(),
    intake: document.getElementById("cat-intake").value,
    memo: document.getElementById("cat-memo").value.trim(),
    createdBy: currentUser.email,
    createdAt: serverTimestamp()
  });
  e.target.reset();
  modalCat.classList.remove("open");
});

document.getElementById("form-daily").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addDoc(collection(db, "cats", currentCatId, "dailyLogs"), {
    date: document.getElementById("daily-date").value,
    weight: document.getElementById("daily-weight").value,
    appetite: document.getElementById("daily-appetite").value,
    excretion: document.getElementById("daily-excretion").value,
    memo: document.getElementById("daily-memo").value.trim(),
    recordedBy: currentUser.email,
    createdAt: serverTimestamp()
  });
  e.target.reset();
  modalDaily.classList.remove("open");
});

document.getElementById("form-medical").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addDoc(collection(db, "cats", currentCatId, "medicalRecords"), {
    type: document.getElementById("medical-type").value,
    date: document.getElementById("medical-date").value,
    title: document.getElementById("medical-title").value.trim(),
    detail: document.getElementById("medical-detail").value.trim(),
    next: document.getElementById("medical-next").value,
    recordedBy: currentUser.email,
    createdAt: serverTimestamp()
  });
  e.target.reset();
  modalMedical.classList.remove("open");
});

// ---------- ユーティリティ ----------
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
