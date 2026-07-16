import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, addDoc, deleteDoc, doc, getDoc, getDocs, onSnapshot,
  query, where, orderBy, serverTimestamp, updateDoc, writeBatch, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ORG_NAME, APP_TITLE, FACILITY_LABEL, FOSTER_LABEL } from "./site-config.js";

// 団体名・アプリ名を画面に反映
const titleText = ORG_NAME ? `${APP_TITLE}(${ORG_NAME})` : APP_TITLE;
document.getElementById("brand-title").textContent = `🐾 ${titleText}`;
document.getElementById("page-title").textContent = titleText;

// 保護場所の呼び方を画面に反映
document.getElementById("filter-btn-facility").textContent = FACILITY_LABEL;
document.getElementById("filter-btn-foster").textContent = FOSTER_LABEL;
document.getElementById("option-facility").textContent = FACILITY_LABEL;
document.getElementById("option-foster").textContent = FOSTER_LABEL;

let currentRole = null; // "管理者" | "責任者" | "施設メンバー" | "預り先" | "未設定"
let currentUid = null;

function isFullAdmin() {
  return currentRole === "管理者" || currentRole === "責任者";
}
function isShelterMember() {
  return currentRole === "施設メンバー";
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
  const userData = userDocSnap.exists() ? userDocSnap.data() : {};
  applyWallpaper(userData.wallpaper || "photo-common", userData.customWallpaperData);

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
  // 犬猫の新規登録は 管理者・責任者・施設メンバー のみ
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
    ? `${FOSTER_LABEL}${catData.fosterName ? "(" + catData.fosterName + ")" : ""}`
    : FACILITY_LABEL;
  document.getElementById("detail-meta").textContent =
    [locationText, catData.status === "譲渡済み" ? "譲渡済み" : "", catData.sex, catData.age, catData.intake ? `保護開始: ${catData.intake}` : ""].filter(Boolean).join(" ・ ");

  // ステータス変更・完全削除ボタンの出し分け
  const canEditCat = isFullAdmin() || (isShelterMember() && catData.location === "施設");
  const actionsWrap = document.getElementById("detail-actions");
  const toggleStatusBtn = document.getElementById("toggle-status-btn");
  const deleteCatBtn = document.getElementById("delete-cat-btn");

  actionsWrap.classList.toggle("hidden", !canEditCat);
  if (canEditCat) {
    toggleStatusBtn.textContent = catData.status === "譲渡済み" ? "保護中に戻す" : "譲渡済みにする";
    toggleStatusBtn.onclick = async () => {
      const newStatus = catData.status === "譲渡済み" ? "保護中" : "譲渡済み";
      if (confirm(`ステータスを「${newStatus}」に変更しますか？`)) {
        await updateDoc(doc(db, "cats", catId), { status: newStatus });
        catData.status = newStatus; // 画面上の表示を即時反映
        showDetail(catId, catData);
      }
    };
  }

  deleteCatBtn.classList.toggle("hidden", !isFullAdmin());
  if (isFullAdmin()) {
    deleteCatBtn.onclick = async () => {
      const sure = confirm(`「${catData.name}」のデータを完全に削除します。日々の記録・医療記録もすべて消えます。この操作は取り消せません。本当によろしいですか？`);
      if (!sure) return;
      const sureAgain = confirm("本当に本当に削除してよろしいですか？(最終確認です)");
      if (!sureAgain) return;
      await deleteCatCompletely(catId);
      showDashboard();
    };
  }

  listenDailyLogs(catId);
  listenMedicalRecords(catId);
}

async function deleteCatCompletely(catId) {
  const dailySnap = await getDocs(collection(db, "cats", catId, "dailyLogs"));
  const medicalSnap = await getDocs(collection(db, "cats", catId, "medicalRecords"));
  const batch = writeBatch(db);
  dailySnap.forEach((d) => batch.delete(d.ref));
  medicalSnap.forEach((d) => batch.delete(d.ref));
  batch.delete(doc(db, "cats", catId));
  await batch.commit();
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

// ---------- メンバー管理(管理者・責任者のみ) ----------
const membersBtn = document.getElementById("members-btn");

membersBtn.addEventListener("click", () => {
  document.getElementById("modal-members").classList.add("open");
  loadMembersList();
});

async function loadMembersList() {
  const listEl = document.getElementById("members-list");
  const statusEl = document.getElementById("members-status");
  listEl.innerHTML = "読み込み中...";
  statusEl.textContent = "";

  const snap = await getDocs(collection(db, "users"));
  listEl.innerHTML = "";

  if (snap.empty) {
    listEl.innerHTML = `<p class="hint-text">メンバーがまだいません。</p>`;
    return;
  }

  snap.forEach((docSnap) => {
    const member = docSnap.data();
    const uid = docSnap.id;
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `
      <span class="member-name">${escapeHtml(member.username || uid)}</span>
      <select data-uid="${uid}">
        <option value="未設定">未設定</option>
        <option value="管理者">管理者</option>
        <option value="責任者">責任者</option>
        <option value="施設メンバー">施設メンバー</option>
        <option value="預り先">預り先</option>
      </select>
    `;
    row.querySelector("select").value = member.role || "未設定";
    row.querySelector("select").addEventListener("change", async (e) => {
      const newRole = e.target.value;
      statusEl.textContent = "保存しています...";
      try {
        await updateDoc(doc(db, "users", uid), { role: newRole });
        statusEl.textContent = `${member.username || uid} の役割を「${newRole}」に変更しました。`;
      } catch (err) {
        statusEl.textContent = "保存に失敗しました。もう一度お試しください。";
      }
    });
    listEl.appendChild(row);
  });
}

// ---------- 壁紙 ----------
const ALL_WALLPAPER_CLASSES = ["wallpaper-paws", "wallpaper-photo-pet", "wallpaper-photo-common"];

function applyWallpaper(wallpaper, customData) {
  document.body.classList.remove(...ALL_WALLPAPER_CLASSES);
  document.body.style.backgroundImage = ""; // カスタム写真用のインラインスタイルをリセット

  if (wallpaper === "paws") document.body.classList.add("wallpaper-paws");
  else if (wallpaper === "photo-pet") document.body.classList.add("wallpaper-photo-pet");
  else if (wallpaper === "photo-common") document.body.classList.add("wallpaper-photo-common");
  else if (wallpaper === "custom" && customData) {
    document.body.style.backgroundImage = `linear-gradient(rgba(250,247,242,0.88), rgba(250,247,242,0.88)), url("${customData}")`;
    document.body.style.backgroundSize = "cover";
    document.body.style.backgroundPosition = "center";
    document.body.style.backgroundAttachment = "fixed";
  }

  document.querySelectorAll(".wallpaper-option").forEach((el) => {
    el.classList.toggle("selected", el.dataset.wallpaper === (wallpaper || "photo-common"));
  });

  if (customData) {
    document.getElementById("custom-wallpaper-preview").src = customData;
    document.getElementById("custom-wallpaper-preview").classList.remove("hidden");
    document.getElementById("custom-wallpaper-preview-icon").classList.add("hidden");
  }
}

document.getElementById("wallpaper-btn").addEventListener("click", () => {
  document.getElementById("modal-wallpaper").classList.add("open");
});

document.querySelectorAll(".wallpaper-option").forEach((el) => {
  el.addEventListener("click", async () => {
    const choice = el.dataset.wallpaper;
    if (choice === "custom") {
      document.getElementById("wallpaper-upload-input").click();
      return;
    }
    applyWallpaper(choice);
    await setDoc(doc(db, "users", currentUid), { wallpaper: choice }, { merge: true });
  });
});

document.getElementById("wallpaper-upload-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("wallpaper-upload-status");
  statusEl.textContent = "画像を処理しています...";
  try {
    const compressed = await compressImageToDataUrl(file, 900, 0.7);
    if (compressed.length > 700000) {
      statusEl.textContent = "画像が大きすぎます。別の写真を試すか、画質の粗い写真でお試しください。";
      return;
    }
    applyWallpaper("custom", compressed);
    await setDoc(doc(db, "users", currentUid), { wallpaper: "custom", customWallpaperData: compressed }, { merge: true });
    statusEl.textContent = "設定しました。";
  } catch (err) {
    statusEl.textContent = "画像の読み込みに失敗しました。別の写真でお試しください。";
  }
});

function compressImageToDataUrl(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxSize || h > maxSize) {
          if (w > h) { h = Math.round((h * maxSize) / w); w = maxSize; }
          else { w = Math.round((w * maxSize) / h); h = maxSize; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- 役割に応じた画面の出し分け ----------
function applyRoleUI() {
  // メンバー管理ボタンは管理者・責任者だけに表示
  membersBtn.classList.toggle("hidden", !isFullAdmin());

  // 絞り込みタブは管理者・責任者だけに表示(他の役割はもともと見える範囲が限定されるため)
  const filterTabs = document.querySelector(".filter-tabs");
  if (filterTabs) filterTabs.classList.toggle("hidden", !isFullAdmin());

  // 施設メンバーは「個人宅預かり」の登録はできない(施設側で割り当てるため選択肢を消す)
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

document.getElementById("show-adopted-toggle").addEventListener("change", renderCatList);

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

  const showAdopted = document.getElementById("show-adopted-toggle").checked;
  const docs = latestCatsSnapshot.docs.filter((docSnap) => {
    const cat = docSnap.data();
    if (!showAdopted && cat.status === "譲渡済み") return false;
    if (currentFilter === "すべて") return true;
    return cat.location === currentFilter;
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
      ? `${FOSTER_LABEL}${cat.fosterName ? "(" + escapeHtml(cat.fosterName) + ")" : ""}`
      : FACILITY_LABEL;
    const adoptedBadge = cat.status === "譲渡済み" ? `<span class="location-badge adopted-badge">譲渡済み</span>` : "";
    card.innerHTML = `
      <div class="cat-avatar">${cat.species === "犬" ? "🐕" : "🐱"}</div>
      <div style="flex:1">
        <div class="name">${escapeHtml(cat.name)}<span class="location-badge">${locationLabel}</span>${adoptedBadge}</div>
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
        ? `<div class="detail">${rec.medicationMethod ? escapeHtml(rec.medicationMethod) + " ／ " : ""}投薬タイミング: ${escapeHtml(rec.medicationTiming.join("・"))}${rec.dosage ? " ／ 分量: " + escapeHtml(rec.dosage) : ""}${rec.endDate ? " ／ 終了予定: " + escapeHtml(rec.endDate) : ""}</div>`
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
        <div style="display:flex; gap:14px; margin-top:6px;">
          <button class="btn btn-ghost btn-small" style="padding:0;" data-edit>編集</button>
          <button class="btn btn-ghost btn-small" style="padding:0;" data-del>削除</button>
        </div>
      `;
      card.querySelector("[data-edit]").addEventListener("click", (e) => {
        e.stopPropagation();
        openMedicalEditModal(docSnap.id, rec);
      });
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

// ---------- 医療記録の編集 ----------
let editingMedicalId = null;

function openMedicalEditModal(recordId, rec) {
  editingMedicalId = recordId;
  document.getElementById("medical-modal-title").textContent = "医療記録を編集";
  document.getElementById("medical-submit-btn").textContent = "更新する";

  document.getElementById("medical-type").value = rec.type || "ワクチン";
  document.getElementById("medical-date").value = rec.date || "";
  document.getElementById("medical-title").value = rec.title || "";
  document.getElementById("medical-detail").value = rec.detail || "";
  document.getElementById("medical-next").value = rec.next || "";

  const isMedication = rec.type === "投薬";
  medicationDetailWrap.classList.toggle("hidden", !isMedication);
  medicalTitleLabel.textContent = isMedication ? "薬の名前" : "件名";

  document.querySelectorAll(".medication-timing").forEach((cb) => {
    cb.checked = !!(rec.medicationTiming && rec.medicationTiming.includes(cb.value));
  });
  document.getElementById("medical-method").value = rec.medicationMethod || "飲み薬(内服)";
  document.getElementById("medical-dosage").value = rec.dosage || "";
  document.getElementById("medical-end-date").value = rec.endDate || "";

  modalMedical.classList.add("open");
}

function resetMedicalModalToAddMode() {
  editingMedicalId = null;
  document.getElementById("medical-modal-title").textContent = "医療記録を追加";
  document.getElementById("medical-submit-btn").textContent = "追加する";
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
    const methodText = rec.medicationMethod ? `[${rec.medicationMethod}] ` : "";
    const label = `${methodText}${rec.title}${rec.dosage ? "(" + rec.dosage + ")" : ""}`;
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
const medicalTitleLabel = document.getElementById("medical-title-label");
const medicalTitleInput = document.getElementById("medical-title");
medicalTypeEl.addEventListener("change", () => {
  const isMedication = medicalTypeEl.value === "投薬";
  medicationDetailWrap.classList.toggle("hidden", !isMedication);
  medicalTitleLabel.textContent = isMedication ? "薬の名前" : "件名";
  medicalTitleInput.placeholder = isMedication ? "例: メタカム / 下痢止め" : "例: 混合ワクチン1回目";
});

// ---------- モーダル制御 ----------
const modalCat = document.getElementById("modal-cat");
const modalDaily = document.getElementById("modal-daily");
const modalMedical = document.getElementById("modal-medical");

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const overlay = btn.closest(".modal-overlay");
    overlay.classList.remove("open");
    if (overlay.id === "modal-medical") resetMedicalModalToAddMode();
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
      document.getElementById("form-medical").reset();
      resetMedicalModalToAddMode();
      medicationDetailWrap.classList.add("hidden");
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
    status: "保護中",
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

  const data = {
    type,
    date: document.getElementById("medical-date").value,
    title: document.getElementById("medical-title").value.trim(),
    detail: document.getElementById("medical-detail").value.trim(),
    next: document.getElementById("medical-next").value,
    medicationTiming,
    medicationMethod: isMedication ? document.getElementById("medical-method").value : "",
    dosage: isMedication ? document.getElementById("medical-dosage").value.trim() : "",
    endDate: isMedication ? document.getElementById("medical-end-date").value : ""
  };

  if (editingMedicalId) {
    await updateDoc(doc(db, "cats", currentCatId, "medicalRecords", editingMedicalId), data);
  } else {
    await addDoc(collection(db, "cats", currentCatId, "medicalRecords"), {
      ...data,
      recordedBy: currentUsername,
      createdAt: serverTimestamp()
    });
  }
  e.target.reset();
  medicationDetailWrap.classList.add("hidden");
  resetMedicalModalToAddMode();
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
