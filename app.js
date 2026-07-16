import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, addDoc, deleteDoc, doc, getDoc, getDocs, onSnapshot,
  query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let currentRole = null; // "管理者" | "責任者" | "シェルターメンバー" | "預り先" | "未設定"
let currentUid = null;

function isFullAdmin() {
  return currentRole === "管理者" || currentRole === "責任者";
}
function isShelterMember() {
  return currentRole === "シェルターメンバー";
}

let currentUser = null;
let currentUsername = null;
let currentCatId = null;
let unsubCats = null;
let unsubDaily = null;
let unsubMedical = null;

// ---------- 認証チェック ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  currentUid = user.uid;
  currentUsername = (user.email || "").split("@")[0];

  const userDocSnap = await getDoc(doc(db, "users", user.uid));
  currentRole = userDocSnap.exists() ? userDocSnap.data().role : "未設定";

  if (currentRole === "未設定") {
    document.getElementById("pending-username").textContent = currentUsername;
    document.getElementById("view-pending").classList.remove("hidden");
    document.getElementById("fab-btn").classList.add("hidden");
    return;
  }

  applyRoleUI();
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
  // 犬猫の新規登録は 管理者・責任者・シェルターメンバー のみ
  document.getElementById("fab-btn").classList.toggle("hidden", !(isFullAdmin() || isShelterMember()));
}

function showDetail(catId, catData) {
  currentCatId = catId;
  viewDashboard.classList.add("hidden");
  viewDetail.classList.remove("hidden");
  document.getElementById("fab-btn").classList.remove("hidden"); // 記録の追加は誰でも可能
  document.getElementById("detail-name").textContent = catData.name;
  document.getElementById("detail-avatar").textContent = catData.species === "犬" ? "🐕" : "🐱";
  const locationText = catData.location === "個人宅預かり"
    ? `個人宅預かり${catData.fosterName ? "(" + catData.fosterName + ")" : ""}`
    : "シェルター";
  document.getElementById("detail-meta").textContent =
    [locationText, catData.sex, catData.age, catData.intake ? `保護開始: ${catData.intake}` : ""].filter(Boolean).join(" ・ ");
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

// ---------- 役割に応じた画面の出し分け ----------
function applyRoleUI() {
  // 絞り込みタブは管理者・責任者だけに表示(他の役割はもともと見える範囲が限定されるため)
  const filterTabs = document.querySelector(".filter-tabs");
  if (filterTabs) filterTabs.classList.toggle("hidden", !isFullAdmin());

  // シェルターメンバーは「個人宅預かり」の登録はできない(施設側で割り当てるため選択肢を消す)
  if (isShelterMember()) {
    const option = document.querySelector('#cat-location option[value="個人宅預かり"]');
    if (option) option.remove();
  }
}

let fosterListLoaded = false;
async function populateFosterDropdown() {
  if (fosterListLoaded) return;
  const selectEl = document.getElementById("cat-foster-user");
  const q = query(collection(db, "users"), where("role", "==", "預り先"));
  const snap = await getDocs(q);
  selectEl.innerHTML = "";
  if (snap.empty) {
    selectEl.innerHTML = `<option value="">(まだ「預り先」として登録された人がいません)</option>`;
    return;
  }
  snap.forEach((docSnap) => {
    const u = docSnap.data();
    const opt = document.createElement("option");
    opt.value = docSnap.id; // uid
    opt.textContent = u.username || docSnap.id;
    selectEl.appendChild(opt);
  });
  fosterListLoaded = true;
}

// ---------- 猫の一覧 ----------
let currentFilter = "すべて";
let latestCatsSnapshot = null;

document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    renderCatList();
  });
});

function listenCats() {
  const q = query(collection(db, "cats"), orderBy("createdAt", "desc"));
  unsubCats = onSnapshot(q, (snap) => {
    latestCatsSnapshot = snap;
    renderCatList();
  });
}

function renderCatList() {
  if (!latestCatsSnapshot) return;
  const listEl = document.getElementById("cat-list");
  const emptyEl = document.getElementById("empty-cats");
  listEl.innerHTML = "";

  const docs = latestCatsSnapshot.docs.filter((docSnap) => {
    if (currentFilter === "すべて") return true;
    return docSnap.data().location === currentFilter;
  });

  if (docs.length === 0) {
    emptyEl.classList.remove("hidden");
    emptyEl.textContent = latestCatsSnapshot.empty
      ? "まだ登録されている犬猫がいません。右下の+から登録しましょう。"
      : "この絞り込み条件に当てはまる犬猫がいません。";
    return;
  }
  emptyEl.classList.add("hidden");

  docs.forEach((docSnap) => {
    const cat = docSnap.data();
    const card = document.createElement("div");
    card.className = "cat-card";
    const locationLabel = cat.location === "個人宅預かり"
      ? `個人宅預かり${cat.fosterName ? "(" + escapeHtml(cat.fosterName) + ")" : ""}`
      : "シェルター";
    card.innerHTML = `
      <div class="cat-avatar">${cat.species === "犬" ? "🐕" : "🐱"}</div>
      <div style="flex:1">
        <div class="name">${escapeHtml(cat.name)}<span class="location-badge">${locationLabel}</span></div>
        <div class="meta">${[cat.sex, cat.age].filter(Boolean).map(escapeHtml).join(" ・ ")}</div>
      </div>
    `;
    card.addEventListener("click", () => showDetail(docSnap.id, cat));
    listEl.appendChild(card);
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
      const timeLabel = [log.timeOfDay, log.careTime].filter(Boolean).join(" ");
      card.innerHTML = `
        <div class="row1">
          <span class="date mono">${log.date}${timeLabel ? " ／ " + escapeHtml(timeLabel) : ""}</span>
          <span class="weight mono">${log.weight ? log.weight + " kg" : "体重未測定"}</span>
        </div>
        <div class="detail">${formatAppetite(log.appetite)}</div>
        <div class="detail">${formatUrine(log.urine)}</div>
        <div class="detail">${formatStool(log.stool)}</div>
        ${formatMedications(log.medications)}
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

function formatAppetite(appetite) {
  if (!appetite) return "食欲: -";
  if (typeof appetite === "string") return `食欲: ${escapeHtml(appetite)}`; // 旧形式との互換
  let text = `食欲: ${escapeHtml(appetite.status || "-")}`;
  if (appetite.status === "一部残した" && appetite.remainGrams) {
    text += `(${escapeHtml(appetite.remainGrams)}g残す)`;
  }
  return text;
}

function formatUrine(urine) {
  if (!urine) return "尿: -";
  if (typeof urine === "string") return `尿: ${escapeHtml(urine)}`; // 旧形式との互換
  let text = `尿: ${escapeHtml(urine.status || "-")}`;
  if (urine.status === "異常") {
    const details = [
      urine.blood === "あり" ? "血尿あり" : "",
      urine.volume ? `量: ${urine.volume}` : "",
      urine.color ? `色: ${urine.color}` : ""
    ].filter(Boolean).join(" ／ ");
    if (details) text += `(${escapeHtml(details)})`;
  }
  return text;
}

function formatStool(stool) {
  if (!stool) return "便: -";
  if (typeof stool === "string") return `便: ${escapeHtml(stool)}`; // 旧形式との互換
  let text = `便: ${escapeHtml(stool.status || "-")}`;
  if (stool.status === "異常") {
    const details = [
      stool.types && stool.types.length ? stool.types.join("・") : "",
      stool.volume ? `量: ${stool.volume}` : "",
      stool.color ? `色: ${stool.color}` : ""
    ].filter(Boolean).join(" ／ ");
    if (details) text += `(${escapeHtml(details)})`;
  }
  return text;
}

function formatMedications(medications) {
  if (!medications || medications.length === 0) return "";
  const items = medications.map((m) => `${escapeHtml(m.label)}: ${m.given ? "投与済み" : "投与できず"}`);
  return `<div class="detail">投薬: ${items.join(" ／ ")}</div>`;
}

// ---------- 医療記録 ----------
let latestMedicalSnapshot = null;
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
    latestMedicalSnapshot = snap;
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
      const medicationInfo = rec.type === "投薬" && rec.medicationTiming && rec.medicationTiming.length
        ? `<div class="detail">投薬タイミング: ${escapeHtml(rec.medicationTiming.join("・"))}${rec.dosage ? " ／ 分量: " + escapeHtml(rec.dosage) : ""}${rec.endDate ? " ／ 終了予定: " + escapeHtml(rec.endDate) : ""}</div>`
        : "";
      card.innerHTML = `
        <div class="row1">
          <span class="date mono">${rec.date}</span>
          <span class="tag ${tagClass[rec.type] || "tag-other"}">${escapeHtml(rec.type)}</span>
        </div>
        <div class="detail" style="font-weight:500;color:var(--ink);margin-top:6px;">${escapeHtml(rec.title)}</div>
        ${rec.detail ? `<div class="detail">${escapeHtml(rec.detail)}</div>` : ""}
        ${medicationInfo}
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

// ---------- 日々の記録フォーム: 投薬チェックリストの生成 ----------
const timeOfDayEl = document.getElementById("daily-time-of-day");
const medChecklistWrap = document.getElementById("medication-checklist-wrap");
const medChecklistEl = document.getElementById("medication-checklist");

function renderMedicationChecklist() {
  medChecklistEl.innerHTML = "";
  if (!latestMedicalSnapshot) {
    medChecklistWrap.classList.add("hidden");
    return;
  }
  const timeOfDay = timeOfDayEl.value;
  const today = document.getElementById("daily-date").value || new Date().toISOString().slice(0, 10);

  const activeMeds = latestMedicalSnapshot.docs.filter((docSnap) => {
    const rec = docSnap.data();
    if (rec.type !== "投薬") return false;
    if (!rec.medicationTiming || !rec.medicationTiming.includes(timeOfDay)) return false;
    if (rec.endDate && rec.endDate < today) return false; // 終了予定日を過ぎたものは出さない
    return true;
  });

  if (activeMeds.length === 0) {
    medChecklistWrap.classList.add("hidden");
    return;
  }
  medChecklistWrap.classList.remove("hidden");

  activeMeds.forEach((docSnap) => {
    const rec = docSnap.data();
    const label = `${rec.title}${rec.dosage ? "(" + rec.dosage + ")" : ""}`;
    const row = document.createElement("label");
    row.className = "med-check-item";
    row.innerHTML = `
      <input type="checkbox" class="med-given" data-record-id="${docSnap.id}" data-label="${escapeHtml(label)}" checked>
      <span class="med-label">${escapeHtml(label)}</span>
    `;
    medChecklistEl.appendChild(row);
  });
}

timeOfDayEl.addEventListener("change", renderMedicationChecklist);
document.getElementById("daily-date").addEventListener("change", renderMedicationChecklist);

// ---------- 猫の登録フォーム: 預かり担当者名の表示切り替え ----------
const catLocationEl = document.getElementById("cat-location");
const fosterNameWrap = document.getElementById("foster-name-wrap");
catLocationEl.addEventListener("change", () => {
  const isFoster = catLocationEl.value === "個人宅預かり";
  fosterNameWrap.classList.toggle("hidden", !isFoster);
  if (isFoster) populateFosterDropdown();
});

// ---------- 日々の記録フォーム: 詳細欄の表示切り替え ----------
const appetiteStatusEl = document.getElementById("daily-appetite-status");
const appetiteRemainWrap = document.getElementById("appetite-remain-wrap");
appetiteStatusEl.addEventListener("change", () => {
  appetiteRemainWrap.classList.toggle("hidden", appetiteStatusEl.value !== "一部残した");
});

const urineStatusEl = document.getElementById("daily-urine-status");
const urineDetailWrap = document.getElementById("urine-detail-wrap");
urineStatusEl.addEventListener("change", () => {
  urineDetailWrap.classList.toggle("hidden", urineStatusEl.value !== "異常");
});

const stoolStatusEl = document.getElementById("daily-stool-status");
const stoolDetailWrap = document.getElementById("stool-detail-wrap");
stoolStatusEl.addEventListener("change", () => {
  stoolDetailWrap.classList.toggle("hidden", stoolStatusEl.value !== "異常");
});

function resetDailyFormExtras() {
  appetiteRemainWrap.classList.add("hidden");
  urineDetailWrap.classList.add("hidden");
  stoolDetailWrap.classList.add("hidden");
  document.querySelectorAll(".stool-type").forEach((cb) => (cb.checked = false));
}

// ---------- 医療記録フォーム: 投薬詳細欄の表示切り替え ----------
const medicalTypeEl = document.getElementById("medical-type");
const medicationDetailWrap = document.getElementById("medication-detail-wrap");
medicalTypeEl.addEventListener("change", () => {
  medicationDetailWrap.classList.toggle("hidden", medicalTypeEl.value !== "投薬");
});

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
      document.getElementById("form-daily").reset();
      document.getElementById("daily-date").valueAsDate = new Date();
      document.getElementById("daily-time-of-day").value = "朝";
      resetDailyFormExtras();
      renderMedicationChecklist();
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
  const location = document.getElementById("cat-location").value;
  const isFoster = location === "個人宅預かり";
  const fosterSelect = document.getElementById("cat-foster-user");
  const fosterUid = isFoster ? fosterSelect.value : "";
  const fosterUsername = isFoster && fosterSelect.selectedIndex >= 0
    ? fosterSelect.options[fosterSelect.selectedIndex].textContent
    : "";

  await addDoc(collection(db, "cats"), {
    species: document.getElementById("cat-species").value,
    location,
    assignedFosterUids: isFoster && fosterUid ? [fosterUid] : [],
    fosterName: fosterUsername,
    name: document.getElementById("cat-name").value.trim(),
    sex: document.getElementById("cat-sex").value,
    age: document.getElementById("cat-age").value.trim(),
    intake: document.getElementById("cat-intake").value,
    memo: document.getElementById("cat-memo").value.trim(),
    createdBy: currentUsername,
    createdAt: serverTimestamp()
  });
  e.target.reset();
  fosterNameWrap.classList.add("hidden");
  modalCat.classList.remove("open");
});

document.getElementById("form-daily").addEventListener("submit", async (e) => {
  e.preventDefault();

  const medications = Array.from(document.querySelectorAll(".med-given")).map((cb) => ({
    recordId: cb.dataset.recordId,
    label: cb.dataset.label,
    given: cb.checked
  }));

  const appetite = {
    status: document.getElementById("daily-appetite-status").value,
    remainGrams: document.getElementById("daily-appetite-status").value === "一部残した"
      ? document.getElementById("daily-appetite-remain").value
      : ""
  };

  const urineStatus = document.getElementById("daily-urine-status").value;
  const urine = {
    status: urineStatus,
    blood: urineStatus === "異常" ? document.getElementById("daily-urine-blood").value : "",
    volume: urineStatus === "異常" ? document.getElementById("daily-urine-volume").value : "",
    color: urineStatus === "異常" ? document.getElementById("daily-urine-color").value : ""
  };

  const stoolStatus = document.getElementById("daily-stool-status").value;
  const stoolTypes = Array.from(document.querySelectorAll(".stool-type:checked")).map((cb) => cb.value);
  const stool = {
    status: stoolStatus,
    types: stoolStatus === "異常" ? stoolTypes : [],
    volume: stoolStatus === "異常" ? document.getElementById("daily-stool-volume").value : "",
    color: stoolStatus === "異常" ? document.getElementById("daily-stool-color").value : ""
  };

  await addDoc(collection(db, "cats", currentCatId, "dailyLogs"), {
    date: document.getElementById("daily-date").value,
    timeOfDay: document.getElementById("daily-time-of-day").value,
    careTime: document.getElementById("daily-care-time").value,
    weight: document.getElementById("daily-weight").value,
    appetite,
    urine,
    stool,
    medications,
    memo: document.getElementById("daily-memo").value.trim(),
    recordedBy: currentUsername,
    createdAt: serverTimestamp()
  });
  e.target.reset();
  resetDailyFormExtras();
  modalDaily.classList.remove("open");
});

document.getElementById("form-medical").addEventListener("submit", async (e) => {
  e.preventDefault();
  const type = document.getElementById("medical-type").value;
  const isMedication = type === "投薬";
  const medicationTiming = isMedication
    ? Array.from(document.querySelectorAll(".medication-timing:checked")).map((cb) => cb.value)
    : [];

  await addDoc(collection(db, "cats", currentCatId, "medicalRecords"), {
    type,
    date: document.getElementById("medical-date").value,
    title: document.getElementById("medical-title").value.trim(),
    detail: document.getElementById("medical-detail").value.trim(),
    next: document.getElementById("medical-next").value,
    medicationTiming,
    dosage: isMedication ? document.getElementById("medical-dosage").value.trim() : "",
    endDate: isMedication ? document.getElementById("medical-end-date").value : "",
    recordedBy: currentUsername,
    createdAt: serverTimestamp()
  });
  e.target.reset();
  medicationDetailWrap.classList.add("hidden");
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
