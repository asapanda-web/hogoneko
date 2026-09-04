import { auth, db } from "./firebase-config.js?v=1784218044";
import {
  onAuthStateChanged, signOut,
  EmailAuthProvider, reauthenticateWithCredential, updateEmail, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, addDoc, deleteDoc, doc, getDoc, getDocs, onSnapshot,
  query, where, orderBy, serverTimestamp, updateDoc, writeBatch, setDoc, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ORG_NAME, APP_TITLE, FACILITY_LABEL, FOSTER_LABEL } from "./site-config.js?v=1784218044";

// 団体名・アプリ名を画面に反映
const titleText = ORG_NAME ? `${APP_TITLE}(${ORG_NAME})` : APP_TITLE;
document.getElementById("brand-title").textContent = `🐾 ${titleText}`;
document.getElementById("page-title").textContent = titleText;

// 保護場所の呼び方を画面に反映
document.getElementById("filter-btn-facility").textContent = FACILITY_LABEL;
document.getElementById("filter-btn-foster").textContent = FOSTER_LABEL;
document.getElementById("option-facility").textContent = FACILITY_LABEL;
document.getElementById("option-foster").textContent = FOSTER_LABEL;

let currentRole = null; // "管理者" | "責任者" | "シェルターメンバー" | "預りメンバー" | "未設定"
let currentUid = null;
let storedCustomWallpaperData = null; // 既にアップロード済みの写真データ(あれば)

function isFullAdmin() {
  return currentRole === "管理者" || currentRole === "責任者";
}
function isShelterMember() {
  return currentRole === "シェルターメンバー";
}

let currentUser = null;
let currentUsername = null;
let currentLoginUsername = null;
let currentCatId = null;
let unsubCats = null;
let unsubDaily = null;
let latestDailySnapshot = null;
let unsubMedical = null;

// ---------- 認証チェック ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  currentUid = user.uid;

  const userDocSnap = await getDoc(doc(db, "users", user.uid));
  currentRole = userDocSnap.exists() ? userDocSnap.data().role : "未設定";
  const userData = userDocSnap.exists() ? userDocSnap.data() : {};
  const loginUsername = userData.username || (user.email || "").split("@")[0];
  currentUsername = userData.displayName || loginUsername; // 表示名があればそちらを優先(無ければログイン用の名前)
  currentLoginUsername = loginUsername;
  storedCustomWallpaperData = userData.customWallpaperData || null;
  applyWallpaper(userData.wallpaper || "photo-common", userData.customWallpaperData);

  if (currentRole === "未設定") {
    document.getElementById("pending-username").textContent = loginUsername;
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

document.getElementById("print-cat-btn").addEventListener("click", () => {
  document.body.classList.remove("print-mode-profile");
  document.body.classList.remove("print-mode-qr");
  buildPrintDailySummary();
  window.print();
});

document.getElementById("print-profile-btn").addEventListener("click", () => {
  document.body.classList.remove("print-mode-qr");
  document.body.classList.add("print-mode-profile");
  window.print();
});

window.addEventListener("afterprint", () => {
  document.body.classList.remove("print-mode-qr");
});

// ---------- 印刷用: 体重の推移グラフ ----------
let printWeightChartInstance = null;
function buildPrintWeightChart() {
  const wrapEl = document.getElementById("print-weight-chart-wrap");
  const canvasEl = document.getElementById("print-weight-chart");

  if (printWeightChartInstance) {
    printWeightChartInstance.destroy();
    printWeightChartInstance = null;
  }

  if (!latestDailySnapshot) {
    wrapEl.classList.add("hidden");
    return;
  }

  const timeOfDayRank = { "早朝": 0, "朝": 1, "昼": 2, "夕方": 3, "夜": 4, "深夜": 5 };
  const points = latestDailySnapshot.docs
    .map((docSnap) => docSnap.data())
    .filter((log) => log.weight !== undefined && log.weight !== null && log.weight !== "")
    .map((log) => ({ date: log.date, timeOfDay: log.timeOfDay, weight: parseFloat(log.weight) }))
    .filter((p) => !isNaN(p.weight))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (timeOfDayRank[a.timeOfDay] ?? 9) - (timeOfDayRank[b.timeOfDay] ?? 9);
    });

  if (points.length === 0) {
    wrapEl.classList.add("hidden");
    return;
  }
  wrapEl.classList.remove("hidden");

  printWeightChartInstance = new Chart(canvasEl.getContext("2d"), {
    type: "line",
    data: {
      labels: points.map((p) => p.date.slice(5)), // 月/日だけにして印刷でも読みやすく
      datasets: [{
        label: "体重(kg)",
        data: points.map((p) => p.weight),
        borderColor: "#e08a3c",
        backgroundColor: "rgba(224,138,60,0.15)",
        tension: 0.25,
        fill: true,
        pointRadius: 1.5,
        borderWidth: 1.5
      }]
    },
    options: {
      responsive: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 7 }, maxRotation: 0 } },
        y: { ticks: { font: { size: 7 } }, title: { display: true, text: "kg", font: { size: 7 } } }
      }
    }
  });
}

// ---------- 印刷用: 日々の記録を1日1行にまとめる ----------
function buildPrintDailySummary() {
  buildPrintWeightChart();
  const contentEl = document.getElementById("print-daily-summary-content");
  if (!latestDailySnapshot || latestDailySnapshot.empty) {
    contentEl.innerHTML = `<p class="print-summary-empty">まだ記録がありません。</p>`;
    return;
  }

  const timeOfDayRank = { "早朝": 0, "朝": 1, "昼": 2, "夕方": 3, "夜": 4, "深夜": 5 };
  const groups = {};
  latestDailySnapshot.docs.forEach((docSnap) => {
    const log = docSnap.data();
    if (!groups[log.date]) groups[log.date] = [];
    groups[log.date].push(log);
  });

  const dates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  const appetiteShort = (appetite) => {
    if (!appetite) return "-";
    if (typeof appetite === "string") return appetite;
    if (appetite.status === "子猫用(%)") return `${appetite.eatenPercent || "?"}%`;
    const map = { "完食": "完食", "一部残した": "一部残す", "ほとんど食べていない": "少量", "食べていない": "食べず" };
    return map[appetite.status] || appetite.status || "-";
  };

  let html = "";
  dates.forEach((date) => {
    const logs = groups[date].sort((a, b) => (timeOfDayRank[a.timeOfDay] ?? 9) - (timeOfDayRank[b.timeOfDay] ?? 9));
    const times = logs.map((l) => l.timeOfDay).filter(Boolean).join("・") || "-";
    const appetiteText = logs.map((l) => appetiteShort(l.appetite)).join("・");
    const urineHappened = logs.some((l) => l.urine && l.urine.status && l.urine.status !== "無し");
    const stoolHappened = logs.some((l) => l.stool && l.stool.status && l.stool.status !== "無し");
    const meds = [...new Set(logs.flatMap((l) => (l.medications || []).filter((m) => m.given).map((m) => m.label)))];
    const memos = logs.map((l) => l.memo).filter(Boolean);

    html += `
      <div class="print-summary-day">
        <div class="print-summary-date">${escapeHtml(date)}</div>
        <div>世話: ${escapeHtml(times)}</div>
        <div>食事: ${escapeHtml(appetiteText || "-")}</div>
        <div>排泄: 尿${urineHappened ? "○" : "-"}／便${stoolHappened ? "○" : "-"}</div>
        ${meds.length ? `<div>投薬: ${escapeHtml(meds.join("・"))}</div>` : ""}
        ${memos.length ? `<div class="print-summary-memo">${escapeHtml(memos.join(" ／ "))}</div>` : ""}
      </div>`;
  });

  contentEl.innerHTML = html;
}

// ---------- 団体の連絡先(種類をチェックして入力する、保存済みの組み合わせから選ぶこともできる) ----------
let contactPresets = []; // 各要素は contactItems と同じ形の配列(過去に保存した組み合わせ)
let contactPresetsLoaded = false;

function renderContactFields(checkedValues) {
  // checkedValuesが渡されればその値を使う({type: value} の形)。無ければ現在の入力値を維持する。
  const wrap = document.getElementById("contact-fields-wrap");
  const existingValues = {};
  wrap.querySelectorAll("input[data-contact-value]").forEach((input) => {
    existingValues[input.dataset.contactValue] = input.value;
  });
  wrap.innerHTML = "";
  document.querySelectorAll(".contact-type-cb:checked").forEach((cb) => {
    const type = cb.dataset.type;
    const value = checkedValues && checkedValues[type] !== undefined ? checkedValues[type] : (existingValues[type] || "");
    const row = document.createElement("div");
    row.style.marginTop = "6px";
    row.innerHTML = `
      <label style="margin:6px 0 4px;">${cb.dataset.icon} ${cb.dataset.label}</label>
      <input type="text" data-contact-value="${type}" placeholder="例: ${cb.dataset.label}のアカウント名や番号">
    `;
    wrap.appendChild(row);
    row.querySelector("input").value = value;
  });
}
document.querySelectorAll(".contact-type-cb").forEach((cb) => {
  cb.addEventListener("change", () => renderContactFields());
});

function getContactItemsFromForm() {
  const items = [];
  document.querySelectorAll(".contact-type-cb:checked").forEach((cb) => {
    const input = document.querySelector(`#contact-fields-wrap input[data-contact-value="${cb.dataset.type}"]`);
    const value = input ? input.value.trim() : "";
    if (value) {
      items.push({ type: cb.dataset.type, icon: cb.dataset.icon, label: cb.dataset.label, value });
    }
  });
  return items;
}

function setContactItemsToForm(items) {
  const list = items || [];
  const valueMap = {};
  document.querySelectorAll(".contact-type-cb").forEach((cb) => {
    const match = list.find((it) => it.type === cb.dataset.type);
    cb.checked = !!match;
    if (match) valueMap[cb.dataset.type] = match.value;
  });
  renderContactFields(valueMap);
}

async function loadContactPresets() {
  if (contactPresetsLoaded) return;
  try {
    const snap = await getDoc(doc(db, "config", "contactPresets"));
    contactPresets = snap.exists() ? (snap.data().list || []) : [];
  } catch (err) {
    contactPresets = [];
  }
  contactPresetsLoaded = true;
  populateContactPresetSelect();
}

function populateContactPresetSelect() {
  const selectEl = document.getElementById("cat-contact-preset");
  const currentValue = selectEl.value;
  selectEl.innerHTML = `
    <option value="">選択してください(保存済みの連絡先から選ぶ)</option>
    ${contactPresets.map((p, i) => `<option value="${i}">${escapeHtml((p.items || []).map((it) => it.label).join("・"))}</option>`).join("")}
    <option value="__new__">+ 新しく入力する</option>
  `;
  if ([...selectEl.options].some((o) => o.value === currentValue)) {
    selectEl.value = currentValue;
  }
}

document.getElementById("cat-contact-preset").addEventListener("change", (e) => {
  const val = e.target.value;
  if (val === "__new__" || val === "") return; // 新しく入力する場合は、そのまま自由に書いてもらう
  const preset = contactPresets[parseInt(val, 10)];
  if (preset) setContactItemsToForm(preset.items || []);
});

async function saveContactPresetIfNew(items) {
  if (!items || items.length === 0) return;
  const alreadyExists = contactPresets.some((p) => JSON.stringify(p.items) === JSON.stringify(items));
  if (alreadyExists) return;
  const presetEntry = { items }; // Firestoreは配列の中に配列を直接入れられないため、オブジェクトで包む
  try {
    await setDoc(doc(db, "config", "contactPresets"), { list: arrayUnion(presetEntry) }, { merge: true });
    contactPresets.push(presetEntry);
  } catch (err) {
    // 保存に失敗しても、この子自身の連絡先は保存されているので問題ない
  }
}

// ---------- 預かり者のSNS(団体の連絡先とは別。自分が保存したものだけプルダウンに出す) ----------
function renderFosterContactFields(checkedValues) {
  const wrap = document.getElementById("foster-contact-fields-wrap");
  const existingValues = {};
  wrap.querySelectorAll("input[data-contact-value]").forEach((input) => {
    existingValues[input.dataset.contactValue] = input.value;
  });
  wrap.innerHTML = "";
  document.querySelectorAll(".foster-contact-type-cb:checked").forEach((cb) => {
    const type = cb.dataset.type;
    const value = checkedValues && checkedValues[type] !== undefined ? checkedValues[type] : (existingValues[type] || "");
    const row = document.createElement("div");
    row.style.marginTop = "6px";
    row.innerHTML = `
      <label style="margin:6px 0 4px;">${cb.dataset.icon} ${cb.dataset.label}</label>
      <input type="text" data-contact-value="${type}" placeholder="例: ${cb.dataset.label}のアカウント名">
    `;
    wrap.appendChild(row);
    row.querySelector("input").value = value;
  });
}
document.querySelectorAll(".foster-contact-type-cb").forEach((cb) => {
  cb.addEventListener("change", () => renderFosterContactFields());
});

function getFosterContactItemsFromForm() {
  const items = [];
  document.querySelectorAll(".foster-contact-type-cb:checked").forEach((cb) => {
    const input = document.querySelector(`#foster-contact-fields-wrap input[data-contact-value="${cb.dataset.type}"]`);
    const value = input ? input.value.trim() : "";
    if (value) {
      items.push({ type: cb.dataset.type, icon: cb.dataset.icon, label: cb.dataset.label, value });
    }
  });
  return items;
}

function setFosterContactItemsToForm(items) {
  const list = items || [];
  const valueMap = {};
  document.querySelectorAll(".foster-contact-type-cb").forEach((cb) => {
    const match = list.find((it) => it.type === cb.dataset.type);
    cb.checked = !!match;
    if (match) valueMap[cb.dataset.type] = match.value;
  });
  renderFosterContactFields(valueMap);
}

let fosterContactPresets = []; // {items} 自分(currentUid)が保存したものだけ
let fosterContactPresetsLoaded = false;
async function loadFosterContactPresets() {
  if (fosterContactPresetsLoaded) return;
  try {
    const snap = await getDoc(doc(db, "config", "fosterContactPresets"));
    fosterContactPresets = snap.exists() ? (snap.data().list || []) : [];
  } catch (err) {
    fosterContactPresets = [];
  }
  fosterContactPresetsLoaded = true;
  populateFosterContactPresetSelect();
}

function populateFosterContactPresetSelect() {
  const selectEl = document.getElementById("foster-contact-preset");
  const myPresets = fosterContactPresets.filter((p) => p.createdByUid === currentUid);
  selectEl.innerHTML = `
    <option value="">選択してください(自分が保存したものから選ぶ)</option>
    ${myPresets.map((p) => `<option value="${fosterContactPresets.indexOf(p)}">${escapeHtml((p.items || []).map((it) => it.label).join("・"))}</option>`).join("")}
    <option value="__new__">+ 新しく入力する</option>
  `;
}

document.getElementById("foster-contact-preset").addEventListener("change", (e) => {
  const val = e.target.value;
  if (val === "__new__" || val === "") return;
  const preset = fosterContactPresets[parseInt(val, 10)];
  if (preset) setFosterContactItemsToForm(preset.items || []);
});

async function saveFosterContactPresetIfNew(items) {
  if (!items || items.length === 0) return;
  const myPresets = fosterContactPresets.filter((p) => p.createdByUid === currentUid);
  const alreadyExists = myPresets.some((p) => JSON.stringify(p.items) === JSON.stringify(items));
  if (alreadyExists) return;
  const presetEntry = { items, createdByUid: currentUid, createdByName: currentUsername || "" };
  try {
    await setDoc(doc(db, "config", "fosterContactPresets"), { list: arrayUnion(presetEntry) }, { merge: true });
    fosterContactPresets.push(presetEntry);
  } catch (err) {
    // 保存に失敗しても、この子自身の連絡先は保存されているので問題ない
  }
}

// ---------- 名前の由来(全体共通)を保存済みの文章から選べるようにする(自分が保存したものだけ表示) ----------
let nameOriginSharedPresets = []; // 全員分のデータ({text, createdByUid, createdByName})を保持
let nameOriginSharedPresetsLoaded = false;
async function loadNameOriginSharedPresets() {
  if (nameOriginSharedPresetsLoaded) return;
  try {
    const snap = await getDoc(doc(db, "config", "nameOriginSharedPresets"));
    nameOriginSharedPresets = snap.exists() ? (snap.data().list || []) : [];
  } catch (err) {
    nameOriginSharedPresets = [];
  }
  nameOriginSharedPresetsLoaded = true;
  populateNameOriginSharedPresetSelect();
}

function populateNameOriginSharedPresetSelect() {
  const selectEl = document.getElementById("name-origin-shared-preset");
  const currentValue = selectEl.value;
  const myPresets = nameOriginSharedPresets.filter((p) => p.createdByUid === currentUid);
  selectEl.innerHTML = `
    <option value="">選択してください(自分が保存した文章から選ぶ)</option>
    ${myPresets.map((p) => `<option value="${nameOriginSharedPresets.indexOf(p)}">${escapeHtml(p.text.length > 30 ? p.text.slice(0, 30) + "…" : p.text)}</option>`).join("")}
    <option value="__new__">+ 新しく入力する</option>
  `;
  if ([...selectEl.options].some((o) => o.value === currentValue)) {
    selectEl.value = currentValue;
  }
}

document.getElementById("name-origin-shared-preset").addEventListener("change", (e) => {
  const val = e.target.value;
  if (val === "__new__" || val === "") return;
  const preset = nameOriginSharedPresets[parseInt(val, 10)];
  if (preset !== undefined) document.getElementById("cat-name-origin-shared").value = preset.text;
});

async function saveNameOriginSharedPresetIfNew(text) {
  if (!text) return;
  const myPresets = nameOriginSharedPresets.filter((p) => p.createdByUid === currentUid);
  if (myPresets.some((p) => p.text === text)) return;
  const presetEntry = { text, createdByUid: currentUid, createdByName: currentUsername || "" };
  try {
    await setDoc(doc(db, "config", "nameOriginSharedPresets"), { list: arrayUnion(presetEntry) }, { merge: true });
    nameOriginSharedPresets.push(presetEntry);
  } catch (err) {
    // 保存に失敗しても、この子自身の由来は保存されているので問題ない
  }
}

document.getElementById("name-origin-shared-delete-btn").addEventListener("click", async () => {
  const selectEl = document.getElementById("name-origin-shared-preset");
  const val = selectEl.value;
  if (val === "" || val === "__new__") {
    alert("削除したい文章を、まずプルダウンから選んでください。");
    return;
  }
  const preset = nameOriginSharedPresets[parseInt(val, 10)];
  if (!preset) return;
  if (!confirm("この保存済みの文章を削除しますか？(すでにこの文章を使っている子の内容は変わりません)")) return;
  try {
    await updateDoc(doc(db, "config", "nameOriginSharedPresets"), { list: arrayRemove(preset) });
    nameOriginSharedPresets = nameOriginSharedPresets.filter((p) => p !== preset);
    populateNameOriginSharedPresetSelect();
  } catch (err) {
    alert("削除に失敗しました。もう一度お試しください。");
  }
});

// ---------- ご飯の写真(保存済みの写真から選ぶ、または新しくアップロード) ----------
let foodPhotoPresets = []; // {id, photoData, label}
let foodPhotoPresetsLoaded = false;

async function loadFoodPhotoPresets() {
  if (foodPhotoPresetsLoaded) return;
  try {
    const snap = await getDocs(collection(db, "config", "foodPhotoPresets", "items"));
    foodPhotoPresets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    foodPhotoPresets = [];
  }
  foodPhotoPresetsLoaded = true;
  // すでに画面に出ている行のプルダウンも更新する
  document.querySelectorAll(".food-item-photo-preset").forEach((selectEl) => populateFoodPhotoPresetSelect(selectEl));
}

function populateFoodPhotoPresetSelect(selectEl) {
  const currentValue = selectEl.value;
  selectEl.innerHTML = `
    <option value="">選択してください(保存済みの写真から選ぶ)</option>
    ${foodPhotoPresets.map((p) => `<option value="${p.id}">${escapeHtml(p.label || "(名前なし)")}</option>`).join("")}
    <option value="__new__">+ 新しくアップロードする</option>
  `;
  if ([...selectEl.options].some((o) => o.value === currentValue)) {
    selectEl.value = currentValue;
  }
}

// 1つのご飯ブロック(row)に対して、写真欄のイベントを設定する
function setupFoodItemPhotoEvents(row) {
  const presetSelect = row.querySelector(".food-item-photo-preset");
  const newWrap = row.querySelector(".food-item-photo-new-wrap");
  const preview = row.querySelector(".food-item-photo-preview");
  const fileInput = row.querySelector(".food-item-photo-input");
  const statusEl = row.querySelector(".food-item-photo-status");

  populateFoodPhotoPresetSelect(presetSelect);

  presetSelect.addEventListener("change", () => {
    const val = presetSelect.value;
    if (val === "__new__" || val === "") {
      newWrap.classList.toggle("hidden", val !== "__new__");
      return;
    }
    newWrap.classList.add("hidden");
    const preset = foodPhotoPresets.find((p) => p.id === val);
    if (preset) {
      preview.src = preset.photoData;
      preview.classList.remove("hidden");
      statusEl.textContent = "";
    }
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    statusEl.textContent = "画像を処理しています...";
    try {
      const compressed = await compressImageToDataUrl(file, 700, 0.7);
      if (compressed.length > 700000) {
        statusEl.textContent = "画像が大きすぎます。別の写真でお試しください。";
        return;
      }
      preview.src = compressed;
      preview.classList.remove("hidden");
      statusEl.textContent = "設定しました。";
      // 新しくアップロードした場合は、名前を付けて保存できるようにする
      presetSelect.value = "__new__";
      newWrap.classList.remove("hidden");
    } catch (err) {
      statusEl.textContent = "画像の読み込みに失敗しました。別の写真でお試しください。";
    }
  });
}

// このご飯ブロックが「新しくアップロード」+名前入力されていれば、次回から選べるように保存する
async function saveFoodPhotoPresetIfNewForRow(row) {
  const presetSelect = row.querySelector(".food-item-photo-preset");
  const label = row.querySelector(".food-item-photo-new-label").value.trim();
  const preview = row.querySelector(".food-item-photo-preview");
  if (presetSelect.value !== "__new__") return;
  if (preview.classList.contains("hidden") || !label) return;
  const photoData = preview.src;
  try {
    const newDocRef = await addDoc(collection(db, "config", "foodPhotoPresets", "items"), {
      photoData,
      label,
      createdByUid: currentUid,
      createdByName: currentUsername || "",
      createdAt: serverTimestamp()
    });
    foodPhotoPresets.push({ id: newDocRef.id, photoData, label });
  } catch (err) {
    // 保存に失敗しても、この子自身のご飯の写真は保存されているので問題ない
  }
}

// ---------- 兄弟姉妹の選択欄 ----------
function populateSiblingCheckboxes(excludeCatId, selectedIds) {
  const wrap = document.getElementById("sibling-select-wrap");
  wrap.innerHTML = "";
  if (!latestCatsSnapshot) return;
  const others = latestCatsSnapshot.docs.filter((d) => d.id !== excludeCatId);
  if (others.length === 0) {
    wrap.innerHTML = `<p class="hint-text" style="margin:0;">他に登録されている子がいません。</p>`;
    return;
  }
  others.forEach((docSnap) => {
    const cat = docSnap.data();
    const label = document.createElement("label");
    label.className = "checkbox-item";
    const checked = selectedIds && selectedIds.includes(docSnap.id) ? "checked" : "";
    label.innerHTML = `<input type="checkbox" value="${docSnap.id}" class="sibling-cb" ${checked}> ${escapeHtml(cat.name)}`;
    wrap.appendChild(label);
  });
}

// ---------- 1日分のトータル食事量 ----------
let editingDailyTotalDate = null;
function openDailyTotalModal(date, currentNote) {
  editingDailyTotalDate = date;
  document.getElementById("daily-total-date-label").textContent = `${date}分`;
  document.getElementById("daily-total-input").value = currentNote || "";
  document.getElementById("daily-total-status").textContent = "";
  document.getElementById("modal-daily-total").classList.add("open");
}

document.getElementById("daily-total-save-btn").addEventListener("click", async () => {
  if (!editingDailyTotalDate || !currentCatId) return;
  const statusEl = document.getElementById("daily-total-status");
  const note = document.getElementById("daily-total-input").value.trim();
  statusEl.textContent = "保存しています...";
  try {
    await setDoc(doc(db, "cats", currentCatId, "dailyTotals", editingDailyTotalDate), {
      foodTotalNote: note,
      updatedBy: currentUsername,
      updatedAt: serverTimestamp()
    }, { merge: true });
    document.getElementById("modal-daily-total").classList.remove("open");
  } catch (err) {
    statusEl.textContent = "保存に失敗しました。もう一度お試しください。";
  }
});

// ---------- トータル食事量をまとめて入力 ----------
document.getElementById("daily-total-bulk-btn").addEventListener("click", () => {
  const listEl = document.getElementById("daily-total-bulk-list");
  const statusEl = document.getElementById("daily-total-bulk-status");
  statusEl.textContent = "";
  listEl.innerHTML = "";

  if (!latestDailySnapshot || latestDailySnapshot.empty) {
    listEl.innerHTML = `<p class="hint-text">まだ日々の記録がありません。</p>`;
    document.getElementById("modal-daily-total-bulk").classList.add("open");
    return;
  }

  // よく使う言い回し(タップするだけで入力できるようにする)
  const quickPhrases = ["よく食べていた", "普段通り", "少し食欲が無かった", "あまり食べなかった", "完食していた", "ムラがあった"];

  // latestDailySnapshotから、記録がある日付を新しい順に重複なく取り出す
  const dates = [...new Set(latestDailySnapshot.docs.map((d) => d.data().date))].sort((a, b) => b.localeCompare(a));

  dates.forEach((date) => {
    const totalDoc = latestDailyTotalsSnapshot
      ? latestDailyTotalsSnapshot.docs.find((d) => d.id === date)
      : null;
    const currentNote = totalDoc ? (totalDoc.data().foodTotalNote || "") : "";

    const row = document.createElement("div");
    row.className = "detail-box";
    row.style.marginTop = "8px";
    row.innerHTML = `
      <label style="margin-top:0;">${escapeHtml(date)}</label>
      <div class="checkbox-group" style="margin-bottom:6px;">
        ${quickPhrases.map((p) => `<button type="button" class="btn btn-outline btn-small daily-total-quick-btn" data-phrase="${escapeHtml(p)}" style="padding:4px 10px; font-size:12px;">${escapeHtml(p)}</button>`).join("")}
      </div>
      <textarea class="daily-total-bulk-input" data-date="${date}" placeholder="例: 全体的によく食べていた。夕方だけ少なめ。"></textarea>
    `;
    const textareaEl = row.querySelector(".daily-total-bulk-input");
    textareaEl.value = currentNote;
    row.querySelectorAll(".daily-total-quick-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        // すでに文字が入っていれば「・」で区切って追加、空欄ならそのまま入れる
        textareaEl.value = textareaEl.value ? `${textareaEl.value}・${btn.dataset.phrase}` : btn.dataset.phrase;
      });
    });
    listEl.appendChild(row);
  });

  document.getElementById("modal-daily-total-bulk").classList.add("open");
});

document.getElementById("daily-total-bulk-save-btn").addEventListener("click", async () => {
  if (!currentCatId) return;
  const statusEl = document.getElementById("daily-total-bulk-status");
  const inputs = document.querySelectorAll(".daily-total-bulk-input");
  if (inputs.length === 0) return;

  statusEl.textContent = "保存しています...";
  try {
    for (const input of inputs) {
      const date = input.dataset.date;
      const note = input.value.trim();
      await setDoc(doc(db, "cats", currentCatId, "dailyTotals", date), {
        foodTotalNote: note,
        updatedBy: currentUsername,
        updatedAt: serverTimestamp()
      }, { merge: true });
    }
    statusEl.textContent = "";
    document.getElementById("modal-daily-total-bulk").classList.remove("open");
  } catch (err) {
    statusEl.textContent = "保存に失敗しました。もう一度お試しください。";
  }
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
  document.getElementById("sticky-cat-bar").classList.add("hidden");
  // 犬猫の新規登録は 管理者・責任者・シェルターメンバー のみ
  document.getElementById("fab-btn").classList.toggle("hidden", !(isFullAdmin() || isShelterMember()));
}

function showDetail(catId, catData) {
  currentCatId = catId;
  viewDashboard.classList.add("hidden");
  viewDetail.classList.remove("hidden");
  document.getElementById("fab-btn").classList.remove("hidden"); // 記録の追加は誰でも可能
  document.getElementById("detail-name").textContent = catData.name;
  const detailAvatarEl = document.getElementById("detail-avatar");
  detailAvatarEl.classList.toggle("avatar-dog", catData.species === "犬");
  detailAvatarEl.classList.toggle("avatar-cat", catData.species !== "犬");
  if (catData.photoData) {
    detailAvatarEl.style.overflow = "hidden";
    detailAvatarEl.innerHTML = `<img src="${catData.photoData}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`;
  } else {
    detailAvatarEl.style.overflow = "";
    detailAvatarEl.textContent = catData.species === "犬" ? "🐕" : "🐱";
  }

  // スクロール時に固定表示するミニバーの中身も更新
  document.getElementById("sticky-cat-name").textContent = catData.name;
  const stickyAvatarEl = document.getElementById("sticky-cat-avatar");
  if (catData.photoData) {
    stickyAvatarEl.innerHTML = `<img src="${catData.photoData}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`;
  } else {
    stickyAvatarEl.innerHTML = "";
    stickyAvatarEl.textContent = catData.species === "犬" ? "🐕" : "🐱";
  }
  const locationText = catData.location === "個人宅預かり"
    ? `${escapeHtml(FOSTER_LABEL)}${catData.fosterName ? `<span id="detail-foster-name">(${escapeHtml(catData.fosterName)})</span>` : ""}`
    : escapeHtml(FACILITY_LABEL);
  document.getElementById("detail-meta").innerHTML =
    [locationText, catData.status === "譲渡済み" ? "譲渡済み" : "", escapeHtml(catData.sex || ""), escapeHtml(catData.age || ""), catData.intake ? `保護開始: ${escapeHtml(catData.intake)}` : ""].filter(Boolean).join(" ・ ");

  // 印刷時の色分け(オス=水色系、メス=ピンク系)用のクラスをbodyに付与
  document.body.classList.remove("print-sex-male", "print-sex-female");
  if (catData.sex === "オス") document.body.classList.add("print-sex-male");
  if (catData.sex === "メス") document.body.classList.add("print-sex-female");

  // ステータス変更・完全削除ボタンの出し分け
  const canEditCat = isFullAdmin() || (isShelterMember() && catData.location === "施設");
  const actionsWrap = document.getElementById("detail-actions");
  const toggleStatusBtn = document.getElementById("toggle-status-btn");
  const startTrialBtn = document.getElementById("start-trial-btn");
  const endTrialBtn = document.getElementById("end-trial-btn");
  const cancelTrialBtn = document.getElementById("cancel-trial-btn");
  const deleteCatBtn = document.getElementById("delete-cat-btn");

  // トライアル中バッジの表示
  const trialInfoWrap = document.getElementById("trial-info-wrap");
  if (catData.status === "トライアル中") {
    trialInfoWrap.classList.remove("hidden");
    document.getElementById("trial-end-date-label").textContent = catData.trialEndDate ? `(終了予定: ${catData.trialEndDate})` : "";
    document.getElementById("trial-notes-btn").onclick = () => openTrialNotesModal(catId);

    const trialDetailQrBtn = document.getElementById("trial-detail-qr-btn");
    trialDetailQrBtn.classList.remove("hidden");
    trialDetailQrBtn.onclick = async () => {
      // 以前の仕様(合言葉なしトライアル)で始まっていた子は合言葉が無いので、その場合はここで新しく発行して保存する
      if (!catData.trialPasscode) {
        const newPasscode = generateRandomPasscode();
        try {
          await updateDoc(doc(db, "cats", catId), { trialPasscode: newPasscode });
          catData.trialPasscode = newPasscode;
          await syncPublicProfile(catId, catData);
        } catch (err) {
          alert("合言葉の発行に失敗しました。もう一度お試しください。");
          return;
        }
      }

      const trialUrl = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}profile.html?id=${catId}&pass=${encodeURIComponent(catData.trialPasscode)}`;
      const qrBox = document.getElementById("trial-qr-box");
      qrBox.innerHTML = "";
      new QRCode(qrBox, {
        text: trialUrl,
        width: 200,
        height: 200,
        colorDark: "#5a3a1e",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
      });
      document.getElementById("trial-qr-name").textContent = catData.name || "";
      document.getElementById("trial-qr-share-status").textContent = "";
      document.getElementById("modal-trial-qr").classList.add("open");

      document.getElementById("trial-qr-copy-btn").onclick = async () => {
        const shareStatusEl = document.getElementById("trial-qr-share-status");
        try {
          await navigator.clipboard.writeText(trialUrl);
          shareStatusEl.textContent = "リンクをコピーしました。";
        } catch (err) {
          shareStatusEl.textContent = "コピーできませんでした。";
        }
      };

      document.getElementById("trial-qr-share-btn").onclick = async () => {
        const shareStatusEl = document.getElementById("trial-qr-share-status");
        const shareData = {
          title: `${catData.name || ""}の詳しいページ(里親さん用)`,
          text: `${catData.name || "この子"}の詳しいページです。トライアル中の様子や餌・トイレの情報が見られます🐾`,
          url: trialUrl
        };
        if (navigator.share) {
          try {
            await navigator.share(shareData);
          } catch (err) {
            // 共有をキャンセルした場合などは何もしない
          }
        } else {
          try {
            await navigator.clipboard.writeText(trialUrl);
            shareStatusEl.textContent = "共有機能が使えない端末のため、リンクをコピーしました。";
          } catch (err) {
            shareStatusEl.textContent = "コピーできませんでした。上のリンクを長押しして手動でコピーしてください。";
          }
        }
      };
    };
  } else {
    trialInfoWrap.classList.add("hidden");
  }

  actionsWrap.classList.toggle("hidden", !canEditCat);
  const editCatBtn = document.getElementById("edit-cat-btn");
  editCatBtn.classList.toggle("hidden", !canEditCat);
  if (canEditCat) {
    editCatBtn.onclick = () => openCatEditModal(catId, catData);

    const isTrial = catData.status === "トライアル中";
    const isAdopted = catData.status === "譲渡済み";

    // 保護中: 「トライアル開始」+「譲渡済みにする(直接)」
    // トライアル中: 「トライアル終了(譲渡済みにする)」+「保護中に戻す(中止)」
    // 譲渡済み: 「保護中に戻す」
    startTrialBtn.classList.toggle("hidden", isTrial || isAdopted);
    endTrialBtn.classList.toggle("hidden", !isTrial);
    cancelTrialBtn.classList.toggle("hidden", !isTrial);
    toggleStatusBtn.classList.toggle("hidden", isTrial);
    toggleStatusBtn.textContent = isAdopted ? "保護中に戻す" : "譲渡済みにする";

    startTrialBtn.onclick = () => {
      document.getElementById("trial-passcode-input").value = generateRandomPasscode();
      document.getElementById("trial-end-date-input").value = "";
      document.getElementById("start-trial-status").textContent = "";
      document.getElementById("modal-start-trial").classList.add("open");
      // 保存ボタンにこの猫のIDを紐付けておく
      document.getElementById("start-trial-save-btn").dataset.catId = catId;
    };

    endTrialBtn.onclick = async () => {
      if (confirm("トライアルを終了して「譲渡済み」にしますか？")) {
        const newStatus = "譲渡済み";
        await updateDoc(doc(db, "cats", catId), { status: newStatus });
        await addHistoryEntry(catId, `ステータス: トライアル中 → ${newStatus}`);
        catData.status = newStatus;
        await syncPublicProfile(catId, catData);
        showDetail(catId, catData);
      }
    };

    cancelTrialBtn.onclick = async () => {
      if (confirm("トライアルを中止して「保護中」に戻しますか？(パスワードは使われなくなります)")) {
        const oldPasscode = catData.trialPasscode;
        const newStatus = "保護中";
        await updateDoc(doc(db, "cats", catId), { status: newStatus, trialPasscode: "", trialEndDate: "" });
        await addHistoryEntry(catId, `ステータス: トライアル中 → ${newStatus}(トライアル中止)`);
        catData.status = newStatus;
        catData.trialPasscode = "";
        catData.trialEndDate = "";
        catData.previousTrialPasscode = oldPasscode; // 古いパスワードのデータを消すために渡す
        await syncPublicProfile(catId, catData);
        showDetail(catId, catData);
      }
    };

    toggleStatusBtn.onclick = async () => {
      const newStatus = catData.status === "譲渡済み" ? "保護中" : "譲渡済み";
      if (confirm(`ステータスを「${newStatus}」に変更しますか？`)) {
        await updateDoc(doc(db, "cats", catId), { status: newStatus });
        await addHistoryEntry(catId, `ステータス: ${catData.status || "保護中"} → ${newStatus}`);
        catData.status = newStatus; // 画面上の表示を即時反映
        await syncPublicProfile(catId, catData); // 譲渡済みになったら公開ページも自動的に非公開にする
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
  listenHistory(catId);

  // 公開ページへのリンク表示切り替え
  const publicPageWrap = document.getElementById("public-page-wrap");
  const publicPageLink = document.getElementById("public-page-link");
  const publicPageDraftNote = document.getElementById("public-page-draft-note");
  if (catData.status !== "譲渡済み") {
    publicPageWrap.classList.remove("hidden");
    publicPageDraftNote.classList.toggle("hidden", !!catData.isPublished);
    const publicUrl = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}profile.html?id=${catId}`;
    publicPageLink.href = publicUrl;
    document.getElementById("public-page-qr-btn").onclick = () => {
      const qrBox = document.getElementById("public-qr-box");
      qrBox.innerHTML = "";
      new QRCode(qrBox, {
        text: publicUrl,
        width: 200,
        height: 200,
        colorDark: "#5a3a1e",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
      });
      document.getElementById("public-qr-name").textContent = catData.name || "";
      document.getElementById("public-qr-share-status").textContent = "";
      document.getElementById("modal-public-qr").classList.add("open");

      document.getElementById("public-qr-copy-btn").onclick = async () => {
        const shareStatusEl = document.getElementById("public-qr-share-status");
        try {
          await navigator.clipboard.writeText(publicUrl);
          shareStatusEl.textContent = "リンクをコピーしました。";
        } catch (err) {
          shareStatusEl.textContent = "コピーできませんでした。";
        }
      };

      document.getElementById("public-qr-share-btn").onclick = async () => {
        const shareStatusEl = document.getElementById("public-qr-share-status");
        const shareData = {
          title: `${catData.name || ""}の公開ページ`,
          text: `${catData.name || "この子"}の公開ページです。よかったら見てください🐾`,
          url: publicUrl
        };
        if (navigator.share) {
          try {
            await navigator.share(shareData);
          } catch (err) {
            // 共有をキャンセルした場合などは何もしない
          }
        } else {
          try {
            await navigator.clipboard.writeText(publicUrl);
            shareStatusEl.textContent = "共有機能が使えない端末のため、リンクをコピーしました。";
          } catch (err) {
            shareStatusEl.textContent = "コピーできませんでした。上のリンクを長押しして手動でコピーしてください。";
          }
        }
      };

      document.getElementById("public-qr-print-btn").onclick = () => {
        document.getElementById("print-qr-name").textContent = catData.name || "";
        const printWrap = document.getElementById("print-qr-canvas-wrap");
        printWrap.innerHTML = "";
        new QRCode(printWrap, {
          text: publicUrl,
          width: 240,
          height: 240,
          colorDark: "#5a3a1e",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.M
        });
        document.body.classList.add("print-mode-qr");
        window.print();
      };
    };
  } else {
    publicPageWrap.classList.add("hidden");
  }

  // 譲渡プロフィールシートへの反映(避妊去勢・ワクチン・ウイルス検査・駆虫は医療記録から自動計算)
  currentCatDataForProfile = catData;
  updateProfileDerivedFields();
}

let currentCatDataForProfile = null;
function updateProfileDerivedFields() {
  if (!currentCatDataForProfile) return;
  const catData = currentCatDataForProfile;

  const profilePhotoEl = document.getElementById("profile-photo");
  if (catData.photoData) {
    profilePhotoEl.src = catData.photoData;
    profilePhotoEl.classList.remove("hidden");
  } else {
    profilePhotoEl.classList.add("hidden");
  }
  document.getElementById("profile-name").textContent = catData.name || "";
  document.getElementById("profile-meta").textContent =
    [catData.species, catData.sex, catData.age].filter(Boolean).join(" ・ ");
  document.getElementById("profile-intro").textContent = catData.intro || "";
  const tagsEl = document.getElementById("profile-tags");
  const tags = [...(catData.personalityTags || [])];
  if (catData.personalityOther) tags.push(catData.personalityOther);
  tagsEl.innerHTML = tags.map((t) => `<span class="profile-tag-badge">${escapeHtml(t)}</span>`).join("");

  const candooTags = [...(catData.canDoTags || [])];
  if (catData.canDoOther) candooTags.push(catData.canDoOther);
  document.getElementById("profile-candoo-title").classList.toggle("hidden", candooTags.length === 0);
  document.getElementById("profile-candoo-tags").innerHTML =
    candooTags.map((t) => `<span class="profile-tag-badge">${escapeHtml(t)}</span>`).join("");

  const dislikeTags = [...(catData.canDislikeTags || [])];
  if (catData.canDislikeOther) dislikeTags.push(catData.canDislikeOther);
  document.getElementById("profile-dislike-title").classList.toggle("hidden", dislikeTags.length === 0);
  document.getElementById("profile-dislike-tags").innerHTML =
    dislikeTags.map((t) => `<span class="profile-tag-badge">${escapeHtml(t)}</span>`).join("");

  const playTags = [...(catData.playTags || [])];
  if (catData.playOther) playTags.push(catData.playOther);
  document.getElementById("profile-play-title").classList.toggle("hidden", playTags.length === 0);
  document.getElementById("profile-play-tags").innerHTML =
    playTags.map((t) => `<span class="profile-tag-badge">${escapeHtml(t)}</span>`).join("");

  document.getElementById("profile-food-title").classList.toggle("hidden", !catData.food);
  document.getElementById("profile-food").textContent = catData.food || "";

  document.getElementById("profile-memo-title").classList.toggle("hidden", !catData.detailMemo);
  document.getElementById("profile-memo").textContent = catData.detailMemo || "";

  const records = latestMedicalSnapshot ? latestMedicalSnapshot.docs.map((d) => d.data()) : [];
  const hasNeuter = records.some((r) => r.type === "避妊去勢");
  const vaccineCount = records.filter((r) => r.type === "ワクチン").length;
  const hasDeworm = records.some((r) => r.type === "駆虫");
  const latestVirusTest = records
    .filter((r) => r.type === "ウイルス検査")
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];

  document.getElementById("profile-neuter").textContent = hasNeuter ? "済" : "未";
  document.getElementById("profile-vaccine").textContent = vaccineCount > 0 ? `済(${vaccineCount}回)` : "未";
  document.getElementById("profile-fiv").textContent = latestVirusTest ? (latestVirusTest.fivResult || "未検査") : "未検査";
  document.getElementById("profile-felv").textContent = latestVirusTest ? (latestVirusTest.felvResult || "未検査") : "未検査";
  document.getElementById("profile-deworm").textContent = hasDeworm ? "済" : "未";
}

async function deleteCatCompletely(catId) {
  const dailySnap = await getDocs(collection(db, "cats", catId, "dailyLogs"));
  const medicalSnap = await getDocs(collection(db, "cats", catId, "medicalRecords"));
  const historySnap = await getDocs(collection(db, "cats", catId, "history"));
  const batch = writeBatch(db);
  dailySnap.forEach((d) => batch.delete(d.ref));
  medicalSnap.forEach((d) => batch.delete(d.ref));
  historySnap.forEach((d) => batch.delete(d.ref));
  batch.delete(doc(db, "cats", catId));
  await batch.commit();
  try {
    await deleteDoc(doc(db, "publicProfiles", catId));
  } catch (err) {
    // 公開ページ用データが元々無い場合は何もしなくてよい
  }
}

// ---------- 変更履歴 ----------
async function addHistoryEntry(catId, summary) {
  await addDoc(collection(db, "cats", catId, "history"), {
    summary,
    changedBy: currentUsername,
    changedAt: serverTimestamp()
  });
}

let unsubHistory = null;
function listenHistory(catId) {
  if (unsubHistory) unsubHistory();
  const q = query(collection(db, "cats", catId, "history"), orderBy("changedAt", "desc"));
  unsubHistory = onSnapshot(q, (snap) => {
    const listEl = document.getElementById("history-list");
    const emptyEl = document.getElementById("empty-history");
    listEl.innerHTML = "";
    if (snap.empty) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");
    snap.forEach((docSnap) => {
      const h = docSnap.data();
      const dateText = h.changedAt && h.changedAt.toDate
        ? h.changedAt.toDate().toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "";
      const card = document.createElement("div");
      card.className = "log-card";
      card.innerHTML = `
        <div class="row1">
          <span class="date mono">${escapeHtml(dateText)}</span>
        </div>
        <div class="detail">${escapeHtml(h.summary)}</div>
        <div class="detail" style="color:var(--ink-soft);">変更者: ${escapeHtml(h.changedBy || "-")}</div>
      `;
      listEl.appendChild(card);
    });
  });
}

document.getElementById("daily-load-more-btn").addEventListener("click", () => {
  dailyDisplayDayLimit += 7;
  renderDailyList();
});

// ---------- スクロール時に猫の名前を固定表示する ----------
const stickyCatBar = document.getElementById("sticky-cat-bar");
stickyCatBar.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});
const catHeaderEl = document.querySelector(".cat-header");
window.addEventListener("scroll", () => {
  if (viewDetail.classList.contains("hidden") || !catHeaderEl) {
    stickyCatBar.classList.add("hidden");
    return;
  }
  const headerBottom = catHeaderEl.getBoundingClientRect().bottom;
  stickyCatBar.classList.toggle("hidden", headerBottom > 0);
});

document.getElementById("back-to-list").addEventListener("click", showDashboard);

// ---------- タブ切り替え ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById("tab-daily").classList.toggle("hidden", tab !== "daily");
    document.getElementById("tab-medical").classList.toggle("hidden", tab !== "medical");
    document.getElementById("tab-history").classList.toggle("hidden", tab !== "history");
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
    const currentMemberRole = member.role || "未設定";
    const row = document.createElement("div");
    row.className = "member-row";
    const isEmailLogin = member.username && member.username.includes("@");
    const idDisplay = isEmailLogin ? "メールアドレス" : (member.username || uid);
    const nameLabel = member.displayName && member.displayName !== member.username
      ? `${member.displayName}(ID: ${idDisplay})`
      : idDisplay;

    // 管理者・責任者はこの画面からは変更不可(表示のみ)。誤操作や不用意な権限昇格を防ぐため、
    // Firebaseコンソールから直接設定する運用のままにしています。
    if (currentMemberRole === "管理者" || currentMemberRole === "責任者") {
      row.innerHTML = `
        <span class="member-name">${escapeHtml(nameLabel)}</span>
        <span class="hint-text" style="margin:0;">${escapeHtml(roleDisplayLabel(currentMemberRole))}(Firebaseコンソールから変更)</span>
      `;
      listEl.appendChild(row);
      return;
    }

    row.innerHTML = `
      <span class="member-name">${escapeHtml(nameLabel)}</span>
      <select data-uid="${uid}">
        <option value="未設定">未設定</option>
        <option value="シェルターメンバー">シェルターメンバー</option>
        <option value="預りメンバー">預りメンバー</option>
      </select>
    `;
    row.querySelector("select").value = currentMemberRole;
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
const ALL_WALLPAPER_CLASSES = ["wallpaper-paws"];

function applyWallpaper(wallpaper, customData) {
  document.body.classList.remove(...ALL_WALLPAPER_CLASSES);
  const imgEl = document.getElementById("wallpaper-img");
  imgEl.classList.add("hidden");
  imgEl.src = "";

  if (wallpaper === "paws") {
    document.body.classList.add("wallpaper-paws");
  } else if (wallpaper === "photo-pet") {
    imgEl.src = "assets/wallpaper-pet.jpg";
    imgEl.classList.remove("hidden");
  } else if (wallpaper === "photo-common") {
    imgEl.src = "assets/wallpaper-common.jpg";
    imgEl.classList.remove("hidden");
  } else if (wallpaper === "custom" && customData) {
    imgEl.src = customData;
    imgEl.classList.remove("hidden");
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
  document.getElementById("wallpaper-change-link-wrap").classList.toggle("hidden", !storedCustomWallpaperData);
});

document.querySelectorAll(".wallpaper-option").forEach((el) => {
  el.addEventListener("click", async () => {
    const choice = el.dataset.wallpaper;
    if (choice === "custom") {
      if (storedCustomWallpaperData) {
        // 既にアップロード済みの写真があれば、それをそのまま選択する
        applyWallpaper("custom", storedCustomWallpaperData);
        await setDoc(doc(db, "users", currentUid), { wallpaper: "custom" }, { merge: true });
      } else {
        // まだ写真が無ければ、アップロード画面を開く
        document.getElementById("wallpaper-upload-input").click();
      }
      return;
    }
    applyWallpaper(choice);
    await setDoc(doc(db, "users", currentUid), { wallpaper: choice }, { merge: true });
  });
});

document.getElementById("wallpaper-change-link").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("wallpaper-upload-input").click();
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
    storedCustomWallpaperData = compressed;
    applyWallpaper("custom", compressed);
    await setDoc(doc(db, "users", currentUid), { wallpaper: "custom", customWallpaperData: compressed }, { merge: true });
    document.getElementById("wallpaper-change-link-wrap").classList.remove("hidden");
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

  // まとめて排泄記録は、犬猫の記録を書き込める役割の人だけに表示
  document.getElementById("group-toilet-btn").classList.toggle("hidden", !(isFullAdmin() || isShelterMember()));
  document.getElementById("group-medical-btn").classList.toggle("hidden", !(isFullAdmin() || isShelterMember()));
  document.getElementById("group-qr-btn").classList.toggle("hidden", !(isFullAdmin() || isShelterMember()));
  document.getElementById("event-history-btn").classList.toggle("hidden", !(isFullAdmin() || isShelterMember()));

  // シェルターメンバーは「個人宅預かり」の登録はできない(施設側で割り当てるため選択肢を消す)
  if (isShelterMember()) {
    const option = document.querySelector('#cat-location option[value="個人宅預かり"]');
    if (option) option.remove();
  }
}

let fosterListLoaded = false;
// 役割の表示用ラベル(「管理者」は団体の役職と紛らわしいので、アプリ内の権限だと分かるようにする)
function roleDisplayLabel(role) {
  if (role === "管理者") return "アプリ管理者";
  return role;
}

async function populateFosterDropdown() {
  if (fosterListLoaded) return;
  const selectEl = document.getElementById("cat-foster-user");
  const snap = await getDocs(collection(db, "users"));
  selectEl.innerHTML = "";
  if (snap.empty) {
    selectEl.innerHTML = `<option value="">(まだ登録された人がいません)</option>`;
    return;
  }
  snap.forEach((docSnap) => {
    const u = docSnap.data();
    if (!u.role || u.role === "未設定") return; // 未設定の人は選択肢に出さない
    const opt = document.createElement("option");
    opt.value = docSnap.id; // uid
    opt.textContent = `${u.displayName || u.username || docSnap.id}(${roleDisplayLabel(u.role)})`;
    selectEl.appendChild(opt);
  });
  if (!selectEl.options.length) {
    selectEl.innerHTML = `<option value="">(選べる人がまだいません)</option>`;
  }
  fosterListLoaded = true;
}

// ---------- 猫の一覧 ----------
let currentFilter = "すべて";
let currentFosterFilter = "";
let latestCatsSnapshot = null;

document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    document.getElementById("foster-filter-wrap").classList.toggle("hidden", currentFilter !== "個人宅預かり");
    if (currentFilter !== "個人宅預かり") currentFosterFilter = "";
    renderCatList();
  });
});

document.getElementById("foster-filter-select").addEventListener("change", (e) => {
  currentFosterFilter = e.target.value;
  renderCatList();
});

document.getElementById("show-adopted-toggle").addEventListener("change", renderCatList);

function listenCats() {
  const q = query(collection(db, "cats"), orderBy("createdAt", "desc"));
  unsubCats = onSnapshot(q, (snap) => {
    latestCatsSnapshot = snap;
    updateFosterFilterOptions();
    renderCatList();
  });
}

function updateFosterFilterOptions() {
  const selectEl = document.getElementById("foster-filter-select");
  const previousValue = selectEl.value;
  const fosterMap = new Map(); // uid -> 表示名
  latestCatsSnapshot.docs.forEach((docSnap) => {
    const cat = docSnap.data();
    if (cat.location === "個人宅預かり" && cat.assignedFosterUids && cat.assignedFosterUids[0]) {
      fosterMap.set(cat.assignedFosterUids[0], cat.fosterName || cat.assignedFosterUids[0]);
    }
  });
  selectEl.innerHTML = `<option value="">預かり担当者ですべて表示</option>`;
  Array.from(fosterMap.entries())
    .sort((a, b) => a[1].localeCompare(b[1], "ja"))
    .forEach(([uid, name]) => {
      const opt = document.createElement("option");
      opt.value = uid;
      opt.textContent = name;
      selectEl.appendChild(opt);
    });
  if (Array.from(selectEl.options).some((o) => o.value === previousValue)) {
    selectEl.value = previousValue;
  }
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
    if (currentFilter !== "すべて" && cat.location !== currentFilter) return false;
    if (currentFosterFilter && !(cat.assignedFosterUids && cat.assignedFosterUids[0] === currentFosterFilter)) return false;
    return true;
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
    const avatarInner = cat.photoData
      ? `<img src="${cat.photoData}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
      : (cat.species === "犬" ? "🐕" : "🐱");
    card.innerHTML = `
      <div class="cat-avatar ${cat.species === "犬" ? "avatar-dog" : "avatar-cat"}"${cat.photoData ? ' style="overflow:hidden;"' : ""}>${avatarInner}</div>
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
let dailyDisplayDayLimit = 7; // 最初に表示する日数(「もっと見る」で増える)
let latestDailyTotalsSnapshot = null;
let unsubDailyTotals = null;

function listenDailyLogs(catId) {
  if (unsubDaily) unsubDaily();
  if (unsubDailyTotals) unsubDailyTotals();
  dailyDisplayDayLimit = 7; // 猫を開き直すたびに表示件数をリセット
  const q = query(collection(db, "cats", catId, "dailyLogs"), orderBy("date", "desc"));
  unsubDaily = onSnapshot(q, (snap) => {
    latestDailySnapshot = snap;
    renderDailyList();
  });
  unsubDailyTotals = onSnapshot(collection(db, "cats", catId, "dailyTotals"), (snap) => {
    latestDailyTotalsSnapshot = snap;
    renderDailyList();
  });
}

function renderDailyList() {
  const snap = latestDailySnapshot;
  const listEl = document.getElementById("daily-list");
  const emptyEl = document.getElementById("empty-daily");
  const loadMoreWrap = document.getElementById("daily-load-more-wrap");
  listEl.innerHTML = "";
  if (!snap || snap.empty) {
    emptyEl.classList.remove("hidden");
    loadMoreWrap.classList.add("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  const timeOfDayRank = { "早朝": 0, "朝": 1, "昼": 2, "夕方": 3, "夜": 4, "深夜": 5 };
  const docsArray = snap.docs.map((docSnap) => ({ id: docSnap.id, log: docSnap.data() }));

  // 同じ日付ごとにグループ化し、グループ内は時間帯の早い順に並べる
  const groups = [];
  docsArray.forEach((item) => {
    let group = groups.find((g) => g.date === item.log.date);
    if (!group) {
      group = { date: item.log.date, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  });
  groups.forEach((g) => {
    g.items.sort((a, b) => (timeOfDayRank[a.log.timeOfDay] ?? 9) - (timeOfDayRank[b.log.timeOfDay] ?? 9));
  });

  // groups は日付の新しい順に並んでいるので、直近◯日分だけに絞る
  const visibleGroups = groups.slice(0, dailyDisplayDayLimit);
  const remainingDays = groups.length - visibleGroups.length;

  visibleGroups.forEach((group) => {
    const dateHeader = document.createElement("div");
    dateHeader.className = "daily-date-header";
    dateHeader.textContent = group.date;
    listEl.appendChild(dateHeader);

    const totalDoc = latestDailyTotalsSnapshot
      ? latestDailyTotalsSnapshot.docs.find((d) => d.id === group.date)
      : null;
    const totalNote = totalDoc ? (totalDoc.data().foodTotalNote || "") : "";
    const totalRow = document.createElement("div");
    totalRow.className = "daily-total-row";
    totalRow.innerHTML = totalNote
      ? `<span>🍽 その日のトータル食事量: ${escapeHtml(totalNote)}</span><button type="button" class="btn btn-ghost btn-small" style="padding:0;" data-edit-total>編集</button>`
      : `<button type="button" class="btn btn-ghost btn-small" style="padding:0;" data-edit-total>🍽 その日のトータル食事量を入力する</button>`;
    totalRow.querySelector("[data-edit-total]").addEventListener("click", () => openDailyTotalModal(group.date, totalNote));
    listEl.appendChild(totalRow);

    group.items.forEach(({ id, log }) => {
      const card = document.createElement("div");
      card.className = "log-card";
      const timeLabel = [log.timeOfDay, log.careTime].filter(Boolean).join(" ");
      card.innerHTML = `
        <div class="row1">
          <span class="date mono">${escapeHtml(timeLabel || "-")}</span>
          <span class="weight mono">${log.weight ? log.weight + " kg" : "体重未測定"}</span>
        </div>
        <div class="detail">${formatAppetite(log.appetite)}</div>
        <div class="detail">${formatUrine(log.urine)}</div>
        <div class="detail">${formatStool(log.stool)}</div>
        ${formatMedications(log.medications)}
        ${log.memo ? `<div class="detail">${escapeHtml(log.memo)}</div>` : ""}
        <div style="display:flex; gap:14px; margin-top:6px;">
          <button class="btn btn-ghost btn-small" style="padding:0;" data-edit>編集</button>
          <button class="btn btn-ghost btn-small" style="padding:0;" data-del>削除</button>
        </div>
      `;
      card.querySelector("[data-edit]").addEventListener("click", (e) => {
        e.stopPropagation();
        openDailyEditModal(id, log);
      });
      card.querySelector("[data-del]").addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm("この記録を削除しますか？")) {
          deleteDoc(doc(db, "cats", currentCatId, "dailyLogs", id)).then(() => {
            syncPublicWeightHistory(currentCatId);
          });
        }
      });
      listEl.appendChild(card);
    });
  });

  if (remainingDays > 0) {
    loadMoreWrap.classList.remove("hidden");
    document.getElementById("daily-load-more-btn").textContent = `もっと見る(残り${remainingDays}日分)`;
  } else {
    loadMoreWrap.classList.add("hidden");
  }
}

function formatAppetite(appetite) {
  if (!appetite) return "食欲: -";
  if (typeof appetite === "string") return `食欲: ${escapeHtml(appetite)}`; // 旧形式との互換
  let text = `食欲: ${escapeHtml(appetite.status || "-")}`;
  if (appetite.status === "一部残した" && appetite.remainGrams) {
    text += `(${escapeHtml(appetite.remainGrams)}g残す)`;
  }
  if (appetite.status === "子猫用(%)" && appetite.eatenPercent !== undefined && appetite.eatenPercent !== "") {
    text += `(${escapeHtml(appetite.eatenPercent)}%食べた)`;
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
  const givenItems = medications.filter((m) => m.given);
  if (givenItems.length === 0) return "";
  const items = givenItems.map((m) => escapeHtml(m.label));
  return `<div class="detail">投薬済み: ${items.join(" ／ ")}</div>`;
}

// ---------- 医療記録 ----------
let latestMedicalSnapshot = null;
const tagClass = {
  "ワクチン": "tag-vaccine",
  "通院": "tag-hospital",
  "投薬": "tag-medication",
  "手術": "tag-hospital",
  "怪我": "tag-hospital",
  "嘔吐": "tag-other",
  "その他": "tag-other"
};

function listenMedicalRecords(catId) {
  if (unsubMedical) unsubMedical();
  const q = query(collection(db, "cats", catId, "medicalRecords"), orderBy("date", "desc"));
  unsubMedical = onSnapshot(q, (snap) => {
    latestMedicalSnapshot = snap;
    updateProfileDerivedFields();
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
      const medicationInfo = rec.type === "投薬"
        ? (rec.singleDose
            ? `<div class="detail">単発の服薬${rec.singleDoseTime ? "(" + escapeHtml(rec.singleDoseTime) + ")" : ""}${rec.medicationMethod ? " ／ " + escapeHtml(rec.medicationMethod) : ""}${rec.dosage ? " ／ 分量: " + escapeHtml(rec.dosage) : ""}</div>`
            : rec.flexibleTiming
              ? `<div class="detail">${rec.medicationMethod ? escapeHtml(rec.medicationMethod) + " ／ " : ""}時間帯を問わず 1日${rec.dailyLimit || 1}回まで${rec.dosage ? " ／ 分量: " + escapeHtml(rec.dosage) : ""}${rec.endDate ? " ／ 終了予定: " + escapeHtml(rec.endDate) : ""}</div>`
              : (rec.medicationTiming && rec.medicationTiming.length
                  ? `<div class="detail">${rec.medicationMethod ? escapeHtml(rec.medicationMethod) + " ／ " : ""}1日${rec.medicationTiming.length}回(${escapeHtml(rec.medicationTiming.join("・"))})${rec.dosage ? " ／ 分量: " + escapeHtml(rec.dosage) : ""}${rec.endDate ? " ／ 終了予定: " + escapeHtml(rec.endDate) : ""}</div>`
                  : ""))
        : "";
      const photoHtml = rec.photoData
        ? `<img src="${rec.photoData}" alt="" style="width:100%;max-width:220px;border-radius:10px;margin-top:8px;display:block;">`
        : "";
      card.innerHTML = `
        <div class="row1">
          <span class="date mono">${rec.date}</span>
          <span class="tag ${tagClass[rec.type] || "tag-other"}">${escapeHtml(rec.type)}</span>
        </div>
        <div class="detail" style="font-weight:500;color:var(--ink);margin-top:6px;">${escapeHtml(rec.title)}</div>
        ${rec.detail ? `<div class="detail">${escapeHtml(rec.detail)}</div>` : ""}
        ${medicationInfo}
        ${photoHtml}
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

  // 編集時は、ワクチンの種類選択ではなく件名を直接編集できるようにする
  vaccineSelectWrap.classList.add("hidden");
  medicalTitleWrap.classList.remove("hidden");
  nextDateWrap.classList.toggle("hidden", rec.type === "避妊去勢");

  document.querySelectorAll(".medication-timing").forEach((cb) => {
    cb.checked = !!(rec.medicationTiming && rec.medicationTiming.includes(cb.value));
  });
  medicationFrequencyPreset.value = "";

  flexibleTimingCheckbox.checked = !!rec.flexibleTiming;
  flexibleTimingDetail.classList.toggle("hidden", !flexibleTimingCheckbox.checked);
  fixedTimingDetail.classList.toggle("hidden", flexibleTimingCheckbox.checked);
  document.getElementById("medical-daily-limit").value = rec.dailyLimit || 1;
  document.getElementById("medical-method").value = rec.medicationMethod || "飲み薬(内服)";
  document.getElementById("medical-dosage").value = rec.dosage || "";
  document.getElementById("medical-end-date").value = rec.endDate || "";

  singleDoseCheckbox.checked = !!rec.singleDose;
  medicationTimingWrap.classList.toggle("hidden", singleDoseCheckbox.checked);
  medicationEnddateWrap.classList.toggle("hidden", singleDoseCheckbox.checked);
  singleDoseTimeWrap.classList.toggle("hidden", !singleDoseCheckbox.checked);
  document.getElementById("medical-single-dose-time").value = rec.singleDoseTime || "";

  currentMedicalPhotoData = rec.photoData || null;
  const medicalPhotoPreview = document.getElementById("medical-photo-preview");
  if (currentMedicalPhotoData) {
    medicalPhotoPreview.src = currentMedicalPhotoData;
    medicalPhotoPreview.classList.remove("hidden");
  } else {
    medicalPhotoPreview.classList.add("hidden");
  }
  document.getElementById("medical-photo-input").value = "";
  document.getElementById("medical-photo-status").textContent = "";

  modalMedical.classList.add("open");
}

function resetMedicalModalToAddMode() {
  editingMedicalId = null;
  document.getElementById("medical-modal-title").textContent = "医療記録を追加";
  document.getElementById("medical-submit-btn").textContent = "追加する";
  currentMedicalPhotoData = null;
  document.getElementById("medical-photo-preview").classList.add("hidden");
  document.getElementById("medical-photo-input").value = "";
  document.getElementById("medical-photo-status").textContent = "";
  singleDoseCheckbox.checked = false;
  medicationTimingWrap.classList.remove("hidden");
  medicationEnddateWrap.classList.remove("hidden");
  singleDoseTimeWrap.classList.add("hidden");
  document.getElementById("medical-single-dose-time").value = "";
  medicationFrequencyPreset.value = "";
  flexibleTimingCheckbox.checked = false;
  flexibleTimingDetail.classList.add("hidden");
  fixedTimingDetail.classList.remove("hidden");
  document.getElementById("medical-daily-limit").value = "1";
}

let currentMedicalPhotoData = null;
document.getElementById("medical-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("medical-photo-status");
  statusEl.textContent = "画像を処理しています...";
  try {
    const compressed = await compressImageToDataUrl(file, 700, 0.7);
    if (compressed.length > 700000) {
      statusEl.textContent = "画像が大きすぎます。別の写真でお試しください。";
      return;
    }
    currentMedicalPhotoData = compressed;
    const preview = document.getElementById("medical-photo-preview");
    preview.src = compressed;
    preview.classList.remove("hidden");
    statusEl.textContent = "設定しました。";
  } catch (err) {
    statusEl.textContent = "画像の読み込みに失敗しました。別の写真でお試しください。";
  }
});


// ---------- 日々の記録フォーム: 投薬チェックリストの生成 ----------
const timeOfDayEl = document.getElementById("daily-time-of-day");
const medChecklistWrap = document.getElementById("medication-checklist-wrap");
const medChecklistEl = document.getElementById("medication-checklist");

function countGivenToday(recordId, dateStr) {
  if (!latestDailySnapshot) return 0;
  let count = 0;
  latestDailySnapshot.docs.forEach((docSnap) => {
    const log = docSnap.data();
    if (log.date !== dateStr) return;
    (log.medications || []).forEach((m) => {
      if (m.recordId === recordId && m.given) count++;
    });
  });
  return count;
}

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
    if (rec.endDate && rec.endDate < today) return false; // 終了予定日を過ぎたものは出さない
    if (rec.flexibleTiming) {
      const limit = rec.dailyLimit || 1;
      return countGivenToday(docSnap.id, today) < limit; // その日の回数がまだ上限に達していなければ表示
    }
    if (!rec.medicationTiming || !rec.medicationTiming.includes(timeOfDay)) return false;
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
    const flexibleNote = rec.flexibleTiming ? "[時間帯問わず] " : "";
    const label = `${flexibleNote}${methodText}${rec.title}${rec.dosage ? "(" + rec.dosage + ")" : ""}`;
    const row = document.createElement("label");
    row.className = "med-check-item";
    row.innerHTML = `
      <input type="checkbox" class="med-given" data-record-id="${docSnap.id}" data-label="${escapeHtml(label)}" checked>
      <span class="med-label">${escapeHtml(label)}</span>
    `;
    medChecklistEl.appendChild(row);
  });
}

// 編集時: その記録を追加した時点で実際にチェックされていた投薬内容をそのまま再現する
// (現在の投薬予定と食い違っていても、記録した当時の内容を優先する)
function renderMedicationChecklistFromLog(medications) {
  medChecklistEl.innerHTML = "";
  if (!medications || medications.length === 0) {
    medChecklistWrap.classList.add("hidden");
    return;
  }
  medChecklistWrap.classList.remove("hidden");
  medications.forEach((m) => {
    const row = document.createElement("label");
    row.className = "med-check-item";
    row.innerHTML = `
      <input type="checkbox" class="med-given" data-record-id="${m.recordId || ""}" data-label="${escapeHtml(m.label)}" ${m.given ? "checked" : ""}>
      <span class="med-label">${escapeHtml(m.label)}</span>
    `;
    medChecklistEl.appendChild(row);
  });
}

timeOfDayEl.addEventListener("change", renderMedicationChecklist);
document.getElementById("daily-date").addEventListener("change", renderMedicationChecklist);

// ---------- 犬猫の登録フォーム: 種類に応じたタグの表示切り替え ----------
const catSpeciesEl = document.getElementById("cat-species");
function updateSpeciesTagVisibility() {
  const speciesKey = catSpeciesEl.value === "犬" ? "dog" : "cat";
  document.querySelectorAll(".checkbox-group .checkbox-item").forEach((item) => {
    const target = item.dataset.species;
    const show = !target || target === speciesKey;
    item.classList.toggle("hidden", !show);
    if (!show) {
      const input = item.querySelector("input[type=checkbox]");
      if (input) input.checked = false;
    }
  });
  document.getElementById("litter-section-wrap").classList.toggle("hidden", speciesKey !== "cat");
}
catSpeciesEl.addEventListener("change", updateSpeciesTagVisibility);

// ---------- 猫の登録フォーム: ご飯の入力方法(自由記述/項目)の切り替え ----------
const foodInputModeEl = document.getElementById("food-input-mode");
const foodFreeWrap = document.getElementById("food-free-wrap");
const foodItemizedWrap = document.getElementById("food-itemized-wrap");
foodInputModeEl.addEventListener("change", () => {
  const isItemized = foodInputModeEl.value === "itemized";
  foodFreeWrap.classList.toggle("hidden", isItemized);
  foodItemizedWrap.classList.toggle("hidden", !isItemized);
});

// ---------- ご飯の項目(複数追加できる) ----------
let foodItemRowSeq = 0;
function createFoodItemRow(item) {
  foodItemRowSeq++;
  const rowId = `food-item-${foodItemRowSeq}`;
  const row = document.createElement("div");
  row.className = "detail-box food-item-row";
  row.style.marginTop = "10px";
  row.dataset.rowId = rowId;
  row.innerHTML = `
    <label>フード名(ブランド)</label>
    <input type="text" class="food-item-brand" placeholder="例: ロイヤルカナン 成長前期">
    <label>種類</label>
    <select class="food-item-type">
      <option value="">選択してください</option>
      <option value="ドライ(カリカリ)">ドライ(カリカリ)</option>
      <option value="ウェット(パウチ)">ウェット(パウチ)</option>
      <option value="半生(セミモイスト)">半生(セミモイスト)</option>
      <option value="フリーズドライ">フリーズドライ</option>
      <option value="補助食・スープ">補助食・スープ</option>
      <option value="おやつ">おやつ</option>
      <option value="その他">その他</option>
    </select>
    <label>与え方(複数選択可)</label>
    <div class="checkbox-group">
      <label class="checkbox-item"><input type="checkbox" value="そのまま" class="food-item-feeding"> そのまま</label>
      <label class="checkbox-item"><input type="checkbox" value="ふやかして" class="food-item-feeding"> ふやかして</label>
      <label class="checkbox-item"><input type="checkbox" value="他のフードと混ぜて" class="food-item-feeding"> 他のフードと混ぜて</label>
      <label class="checkbox-item"><input type="checkbox" value="シリンジで給餌" class="food-item-feeding"> シリンジで給餌</label>
    </div>
    <label>量(任意)</label>
    <textarea class="food-item-amount" placeholder="例: 1回20g。全給餌時は0.3缶。他のご飯半分食べた際は0.15缶。" style="min-height:70px;"></textarea>
    <label>回数</label>
    <select class="food-item-frequency">
      <option value="">選択してください</option>
      <option value="1日1回">1日1回</option>
      <option value="1日2回">1日2回</option>
      <option value="1日3回">1日3回</option>
      <option value="1日4回">1日4回</option>
      <option value="1日5回以上">1日5回以上</option>
      <option value="欲しがる時にあげている">欲しがる時にあげている</option>
    </select>
    <label>写真(任意・公開ページに表示されます)</label>
    <select class="food-item-photo-preset">
      <option value="">選択してください(保存済みの写真から選ぶ)</option>
      <option value="__new__">+ 新しくアップロードする</option>
    </select>
    <div class="food-item-photo-new-wrap hidden" style="margin-top:8px;">
      <input type="text" class="food-item-photo-new-label" placeholder="この写真の名前(選ぶ時の目印、例: ピュリナワン子猫用カリカリ)">
    </div>
    <div style="display:flex; align-items:center; gap:12px; margin-top:8px;">
      <img class="food-item-photo-preview hidden" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:2px solid var(--border);">
      <input type="file" class="food-item-photo-input" accept="image/*">
    </div>
    <p class="hint-text food-item-photo-status"></p>
    <label>給餌量の目安表(任意・袋に書かれている表などの写真)</label>
    <div style="display:flex; align-items:center; gap:12px;">
      <img class="food-item-guide-preview hidden" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:2px solid var(--border);">
      <input type="file" class="food-item-guide-input" accept="image/*">
    </div>
    <p class="hint-text food-item-guide-status"></p>
    <button type="button" class="btn btn-ghost btn-small food-item-remove-btn" style="padding:0; margin-top:8px;">🗑 このご飯を削除</button>
  `;
  if (item) {
    row.querySelector(".food-item-brand").value = item.brand || "";
    row.querySelector(".food-item-type").value = item.type || "";
    row.querySelectorAll(".food-item-feeding").forEach((cb) => {
      cb.checked = !!(item.feedingTags && item.feedingTags.includes(cb.value));
    });
    row.querySelector(".food-item-amount").value = item.amount || "";
    row.querySelector(".food-item-frequency").value = item.frequency || "";
    if (item.photoData) {
      const preview = row.querySelector(".food-item-photo-preview");
      preview.src = item.photoData;
      preview.classList.remove("hidden");
    }
    if (item.guidePhotoData) {
      const guidePreview = row.querySelector(".food-item-guide-preview");
      guidePreview.src = item.guidePhotoData;
      guidePreview.classList.remove("hidden");
    }
  }
  setupFoodItemPhotoEvents(row);

  // 給餌量の目安表の写真(こちらは使い回しプリセットは無く、シンプルなアップロードのみ)
  row.querySelector(".food-item-guide-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const guideStatusEl = row.querySelector(".food-item-guide-status");
    const guidePreview = row.querySelector(".food-item-guide-preview");
    guideStatusEl.textContent = "画像を処理しています...";
    try {
      const compressed = await compressImageToDataUrl(file, 700, 0.7);
      if (compressed.length > 700000) {
        guideStatusEl.textContent = "画像が大きすぎます。別の写真でお試しください。";
        return;
      }
      guidePreview.src = compressed;
      guidePreview.classList.remove("hidden");
      guideStatusEl.textContent = "設定しました。";
    } catch (err) {
      guideStatusEl.textContent = "画像の読み込みに失敗しました。別の写真でお試しください。";
    }
  });

  row.querySelector(".food-item-remove-btn").addEventListener("click", () => {
    row.remove();
    // 全部消えてしまったら、入力しやすいように1つ空欄を戻しておく
    if (document.getElementById("food-items-list").children.length === 0) {
      addFoodItemRow();
    }
  });
  return row;
}

function addFoodItemRow(item) {
  document.getElementById("food-items-list").appendChild(createFoodItemRow(item));
}

document.getElementById("food-item-add-btn").addEventListener("click", () => addFoodItemRow());

function getFoodItemsFromForm() {
  const items = [];
  document.querySelectorAll("#food-items-list .food-item-row").forEach((row) => {
    const brand = row.querySelector(".food-item-brand").value.trim();
    const type = row.querySelector(".food-item-type").value;
    const feedingTags = Array.from(row.querySelectorAll(".food-item-feeding:checked")).map((cb) => cb.value);
    const amount = row.querySelector(".food-item-amount").value.trim();
    const frequency = row.querySelector(".food-item-frequency").value;
    const photoPreview = row.querySelector(".food-item-photo-preview");
    const photoData = photoPreview.classList.contains("hidden") ? "" : photoPreview.src;
    const guidePreview = row.querySelector(".food-item-guide-preview");
    const guidePhotoData = guidePreview.classList.contains("hidden") ? "" : guidePreview.src;
    // 何かしら入力がある行だけ保存する(完全に空の行は無視)
    if (brand || type || feedingTags.length || amount || frequency || photoData || guidePhotoData) {
      items.push({ brand, type, feedingTags, amount, frequency, photoData, guidePhotoData });
    }
  });
  return items;
}

function setFoodItemsToForm(items) {
  const listEl = document.getElementById("food-items-list");
  listEl.innerHTML = "";
  if (items && items.length > 0) {
    items.forEach((item) => addFoodItemRow(item));
  } else {
    addFoodItemRow(); // 最低1行は入力しやすいように出しておく
  }
}

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
const appetitePercentWrap = document.getElementById("appetite-percent-wrap");
appetiteStatusEl.addEventListener("change", () => {
  appetiteRemainWrap.classList.toggle("hidden", appetiteStatusEl.value !== "一部残した");
  appetitePercentWrap.classList.toggle("hidden", appetiteStatusEl.value !== "子猫用(%)");
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
  appetitePercentWrap.classList.add("hidden");
  urineDetailWrap.classList.add("hidden");
  stoolDetailWrap.classList.add("hidden");
  document.querySelectorAll(".stool-type").forEach((cb) => (cb.checked = false));
}

// ---------- 日々の記録の編集 ----------
let editingDailyId = null;

function openDailyEditModal(logId, log) {
  editingDailyId = logId;
  document.getElementById("daily-modal-title").textContent = "日々の記録を編集";
  document.getElementById("daily-submit-btn").textContent = "更新する";

  document.getElementById("daily-date").value = log.date || "";
  document.getElementById("daily-time-of-day").value = log.timeOfDay || "朝";
  document.getElementById("daily-care-time").value = log.careTime || "";
  document.getElementById("daily-weight").value = log.weight || "";

  const appetite = typeof log.appetite === "object" && log.appetite ? log.appetite : { status: log.appetite || "完食" };
  appetiteStatusEl.value = appetite.status || "完食";
  appetiteRemainWrap.classList.toggle("hidden", appetiteStatusEl.value !== "一部残した");
  appetitePercentWrap.classList.toggle("hidden", appetiteStatusEl.value !== "子猫用(%)");
  document.getElementById("daily-appetite-remain").value = appetite.remainGrams || "";
  document.getElementById("daily-appetite-percent").value = appetite.eatenPercent || "";

  const urine = typeof log.urine === "object" && log.urine ? log.urine : { status: log.urine || "正常" };
  urineStatusEl.value = urine.status || "正常";
  urineDetailWrap.classList.toggle("hidden", urineStatusEl.value !== "異常");
  document.getElementById("daily-urine-blood").value = urine.blood || "なし";
  document.getElementById("daily-urine-volume").value = urine.volume || "普通";
  document.getElementById("daily-urine-color").value = urine.color || "普通(淡い黄色)";

  const stool = typeof log.stool === "object" && log.stool ? log.stool : { status: log.stool || "正常" };
  stoolStatusEl.value = stool.status || "正常";
  stoolDetailWrap.classList.toggle("hidden", stoolStatusEl.value !== "異常");
  document.querySelectorAll(".stool-type").forEach((cb) => {
    cb.checked = !!(stool.types && stool.types.includes(cb.value));
  });
  document.getElementById("daily-stool-volume").value = stool.volume || "普通";
  document.getElementById("daily-stool-color").value = stool.color || "普通(茶色)";

  document.getElementById("daily-memo").value = log.memo || "";

  renderMedicationChecklistFromLog(log.medications);

  modalDaily.classList.add("open");
}

function resetDailyModalToAddMode() {
  editingDailyId = null;
  document.getElementById("daily-modal-title").textContent = "日々の記録を追加";
  document.getElementById("daily-submit-btn").textContent = "追加する";
}

// ---------- 医療記録フォーム: 投薬詳細欄の表示切り替え ----------
const medicalTypeEl = document.getElementById("medical-type");
const medicationDetailWrap = document.getElementById("medication-detail-wrap");
const medicalTitleLabel = document.getElementById("medical-title-label");
const medicalTitleInput = document.getElementById("medical-title");
const virusTestDetailWrap = document.getElementById("virus-test-detail-wrap");
const nextDateWrap = document.getElementById("next-date-wrap");
const vaccineSelectWrap = document.getElementById("vaccine-select-wrap");
const medicalTitleWrap = document.getElementById("medical-title-wrap");
const vaccineKindSelect = document.getElementById("vaccine-kind-select");
const vaccineCountSelect = document.getElementById("vaccine-count-select");

function updateVaccineTitleFromSelects() {
  const kind = vaccineKindSelect.value;
  const count = vaccineCountSelect.value;
  if (kind === "その他") {
    // 「その他」の場合は件名欄を表示して手入力してもらう
    medicalTitleWrap.classList.remove("hidden");
    medicalTitleInput.value = "";
  } else {
    medicalTitleWrap.classList.add("hidden");
    medicalTitleInput.value = `${kind} ${count}`;
  }
}
vaccineKindSelect.addEventListener("change", updateVaccineTitleFromSelects);
vaccineCountSelect.addEventListener("change", updateVaccineTitleFromSelects);

const medicationFrequencyPreset = document.getElementById("medication-frequency-preset");
medicationFrequencyPreset.addEventListener("change", () => {
  if (!medicationFrequencyPreset.value) return;
  const selectedTimings = medicationFrequencyPreset.value.split(",");
  document.querySelectorAll(".medication-timing").forEach((cb) => {
    cb.checked = selectedTimings.includes(cb.value);
  });
});

const flexibleTimingCheckbox = document.getElementById("medical-flexible-timing");
const flexibleTimingDetail = document.getElementById("flexible-timing-detail");
const fixedTimingDetail = document.getElementById("fixed-timing-detail");
flexibleTimingCheckbox.addEventListener("change", () => {
  flexibleTimingDetail.classList.toggle("hidden", !flexibleTimingCheckbox.checked);
  fixedTimingDetail.classList.toggle("hidden", flexibleTimingCheckbox.checked);
  if (flexibleTimingCheckbox.checked) {
    document.querySelectorAll(".medication-timing").forEach((cb) => (cb.checked = false));
    medicationFrequencyPreset.value = "";
  }
});

const medicationTimingWrap = document.getElementById("medication-timing-wrap");
const medicationEnddateWrap = document.getElementById("medication-enddate-wrap");
const singleDoseTimeWrap = document.getElementById("single-dose-time-wrap");
const singleDoseCheckbox = document.getElementById("medical-single-dose");
singleDoseCheckbox.addEventListener("change", () => {
  medicationTimingWrap.classList.toggle("hidden", singleDoseCheckbox.checked);
  medicationEnddateWrap.classList.toggle("hidden", singleDoseCheckbox.checked);
  singleDoseTimeWrap.classList.toggle("hidden", !singleDoseCheckbox.checked);
  if (singleDoseCheckbox.checked) {
    document.querySelectorAll(".medication-timing").forEach((cb) => (cb.checked = false));
    document.getElementById("medical-end-date").value = "";
  } else {
    document.getElementById("medical-single-dose-time").value = "";
  }
});

function updateMedicalTypeUI() {
  const isMedication = medicalTypeEl.value === "投薬";
  const isVirusTest = medicalTypeEl.value === "ウイルス検査";
  const isVaccine = medicalTypeEl.value === "ワクチン";
  const isNeuter = medicalTypeEl.value === "避妊去勢";
  medicationDetailWrap.classList.toggle("hidden", !isMedication);
  virusTestDetailWrap.classList.toggle("hidden", !isVirusTest);
  vaccineSelectWrap.classList.toggle("hidden", !isVaccine);
  nextDateWrap.classList.toggle("hidden", isNeuter);
  medicalTitleLabel.textContent = isMedication ? "薬の名前" : "件名";
  medicalTitleInput.placeholder = isMedication ? "例: メタカム / 下痢止め" : "例: 混合ワクチン1回目";
  if (isVaccine) {
    updateVaccineTitleFromSelects();
  } else {
    medicalTitleWrap.classList.remove("hidden");
  }
}
medicalTypeEl.addEventListener("change", updateMedicalTypeUI);

// ---------- モーダル制御 ----------
const modalCat = document.getElementById("modal-cat");
const modalDaily = document.getElementById("modal-daily");
const modalMedical = document.getElementById("modal-medical");

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const overlay = btn.closest(".modal-overlay");
    overlay.classList.remove("open");
    if (overlay.id === "modal-medical") resetMedicalModalToAddMode();
    if (overlay.id === "modal-daily") resetDailyModalToAddMode();
    if (overlay.id === "modal-cat") {
      resetCatModalToAddMode();
      fosterNameWrap.classList.add("hidden");
    }
  });
});

document.getElementById("fab-btn").addEventListener("click", () => {
  if (viewDashboard.classList.contains("hidden")) {
    // 詳細画面 → 表示中のタブに応じてモーダルを出し分け
    const activeTab = document.querySelector(".tab-btn.active").dataset.tab;
    if (activeTab === "daily") {
      document.getElementById("form-daily").reset();
      resetDailyModalToAddMode();
      document.getElementById("daily-date").valueAsDate = new Date();
      document.getElementById("daily-time-of-day").value = "朝";
      resetDailyFormExtras();
      renderMedicationChecklist();
      modalDaily.classList.add("open");
    } else if (activeTab === "medical") {
      document.getElementById("form-medical").reset();
      resetMedicalModalToAddMode();
      updateMedicalTypeUI();
      document.getElementById("medical-date").valueAsDate = new Date();
      modalMedical.classList.add("open");
    }
    // 変更履歴タブでは何もしない(手動追加の対象ではないため)
  } else {
    resetCatModalToAddMode();
    fosterNameWrap.classList.add("hidden");
    loadContactPresets();
    loadNameOriginSharedPresets();
    loadFoodPhotoPresets();
    loadFosterContactPresets();
    populateSiblingCheckboxes(null, []);
    modalCat.classList.add("open");
  }
});

// ---------- 猫の編集 ----------
let editingCatId = null;
let editingCatOriginal = null;

async function openCatEditModal(catId, catData) {
  editingCatId = catId;
  editingCatOriginal = catData;
  document.getElementById("cat-modal-title").textContent = "犬猫を編集";
  document.getElementById("cat-submit-btn").textContent = "更新する";

  document.getElementById("cat-species").value = catData.species || "猫";
  updateSpeciesTagVisibility();
  document.getElementById("cat-name").value = catData.name || "";
  document.getElementById("cat-sex").value = catData.sex || "不明";
  document.getElementById("cat-age").value = catData.age || "";
  document.getElementById("cat-intake").value = catData.intake || "";
  document.getElementById("cat-memo").value = catData.memo || "";
  document.getElementById("cat-intro").value = catData.intro || "";
  document.getElementById("cat-personality-other").value = catData.personalityOther || "";
  document.getElementById("cat-candoo-other").value = catData.canDoOther || "";
  document.getElementById("cat-dislike-other").value = catData.canDislikeOther || "";
  document.getElementById("cat-play-other").value = catData.playOther || "";
  document.getElementById("cat-food").value = catData.food || "";
  document.getElementById("cat-detail-memo").value = catData.detailMemo || "";
  document.querySelectorAll(".personality-tag").forEach((cb) => {
    cb.checked = !!(catData.personalityTags && catData.personalityTags.includes(cb.value));
  });
  document.querySelectorAll(".can-do-tag").forEach((cb) => {
    cb.checked = !!(catData.canDoTags && catData.canDoTags.includes(cb.value));
  });
  document.querySelectorAll(".can-dislike-tag").forEach((cb) => {
    cb.checked = !!(catData.canDislikeTags && catData.canDislikeTags.includes(cb.value));
  });
  document.querySelectorAll(".play-tag").forEach((cb) => {
    cb.checked = !!(catData.playTags && catData.playTags.includes(cb.value));
  });
  currentCatPhotoData = catData.photoData || null;
  const photoPreview = document.getElementById("cat-photo-preview");
  if (currentCatPhotoData) {
    photoPreview.src = currentCatPhotoData;
    photoPreview.classList.remove("hidden");
  } else {
    photoPreview.classList.add("hidden");
  }

  // ご飯(自由記述 or 項目)
  const foodMode = catData.foodMode === "itemized" ? "itemized" : "free";
  document.getElementById("food-input-mode").value = foodMode;
  foodFreeWrap.classList.toggle("hidden", foodMode === "itemized");
  foodItemizedWrap.classList.toggle("hidden", foodMode !== "itemized");
  setFoodItemsToForm(catData.foods && catData.foods.length ? catData.foods : (catData.foodBrand || catData.foodType ? [{
    brand: catData.foodBrand || "",
    type: catData.foodType || "",
    feedingTags: catData.foodFeedingTags || [],
    amount: catData.foodAmount || "",
    frequency: catData.foodFrequency || "",
    photoData: catData.foodPhotoData || ""
  }] : []));
  document.getElementById("food-comment").value = catData.foodComment || "";

  // トイレ環境
  document.querySelectorAll(".litter-box-tag").forEach((cb) => {
    cb.checked = !!(catData.litterBoxTags && catData.litterBoxTags.includes(cb.value));
  });
  document.querySelectorAll(".litter-sand-tag").forEach((cb) => {
    cb.checked = !!(catData.litterSandTags && catData.litterSandTags.includes(cb.value));
  });
  document.getElementById("litter-sand-other").value = catData.litterSandOther || "";
  document.getElementById("litter-granularity").value = catData.litterGranularity || "";
  document.getElementById("litter-cleaning").value = catData.litterCleaning || "";
  document.getElementById("litter-memo").value = catData.litterMemo || "";

  document.getElementById("name-origin-shared-preset").value = "";
  document.getElementById("cat-name-origin-shared").value = catData.nameOriginShared || "";
  document.getElementById("cat-name-origin").value = catData.nameOrigin || "";
  document.getElementById("cat-video-url").value = catData.videoUrl || "";
  document.getElementById("cat-video-coming-soon").checked = !!catData.videoComingSoon;
  document.getElementById("cat-is-published").checked = !!catData.isPublished;

  currentCatPublicPhotoData = catData.publicPhotoData || null;
  const publicPhotoPreview = document.getElementById("cat-public-photo-preview");
  if (currentCatPublicPhotoData) {
    publicPhotoPreview.src = currentCatPublicPhotoData;
    publicPhotoPreview.classList.remove("hidden");
  } else {
    publicPhotoPreview.classList.add("hidden");
  }

  const locationSelect = document.getElementById("cat-location");
  locationSelect.value = catData.location || "施設";
  const isFoster = locationSelect.value === "個人宅預かり";
  fosterNameWrap.classList.toggle("hidden", !isFoster);

  if (isFoster) {
    await populateFosterDropdown();
    const fosterSelect = document.getElementById("cat-foster-user");
    const currentFosterUid = catData.assignedFosterUids && catData.assignedFosterUids[0];
    if (currentFosterUid) fosterSelect.value = currentFosterUid;
  }

  await loadContactPresets();
  await loadNameOriginSharedPresets();
  await loadFoodPhotoPresets();
  await loadFosterContactPresets();
  document.getElementById("cat-contact-preset").value = "";
  setContactItemsToForm(catData.contactItems);
  document.getElementById("foster-contact-preset").value = "";
  setFosterContactItemsToForm(catData.fosterContactItems);
  document.getElementById("foster-contact-coming-soon").checked = !!catData.fosterContactComingSoon;
  populateSiblingCheckboxes(catId, catData.siblingIds || []);

  modalCat.classList.add("open");
}

function resetCatModalToAddMode() {
  editingCatId = null;
  editingCatOriginal = null;
  currentCatPhotoData = null;
  document.getElementById("cat-photo-preview").classList.add("hidden");
  document.getElementById("cat-photo-input").value = "";
  document.getElementById("cat-photo-status").textContent = "";
  currentCatPublicPhotoData = null;
  document.getElementById("cat-public-photo-preview").classList.add("hidden");
  document.getElementById("cat-public-photo-input").value = "";
  document.getElementById("cat-public-photo-status").textContent = "";
  document.getElementById("food-input-mode").value = "free";
  foodFreeWrap.classList.remove("hidden");
  foodItemizedWrap.classList.add("hidden");
  setFoodItemsToForm([]);
  document.getElementById("cat-is-published").checked = false;
  document.getElementById("cat-video-coming-soon").checked = false;
  document.getElementById("cat-contact-preset").value = "";
  setContactItemsToForm([]);
  document.getElementById("foster-contact-preset").value = "";
  setFosterContactItemsToForm([]);
  document.getElementById("foster-contact-coming-soon").checked = false;
  document.getElementById("name-origin-shared-preset").value = "";
  document.getElementById("cat-modal-title").textContent = "犬猫を登録";
  document.getElementById("cat-submit-btn").textContent = "登録する";
  updateSpeciesTagVisibility();
}

let currentCatPhotoData = null;
document.getElementById("cat-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("cat-photo-status");
  statusEl.textContent = "画像を処理しています...";
  try {
    const compressed = await compressImageToDataUrl(file, 700, 0.7);
    if (compressed.length > 700000) {
      statusEl.textContent = "画像が大きすぎます。別の写真でお試しください。";
      return;
    }
    currentCatPhotoData = compressed;
    const preview = document.getElementById("cat-photo-preview");
    preview.src = compressed;
    preview.classList.remove("hidden");
    statusEl.textContent = "設定しました。";
  } catch (err) {
    statusEl.textContent = "画像の読み込みに失敗しました。別の写真でお試しください。";
  }
});

let currentCatPublicPhotoData = null;
document.getElementById("cat-public-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("cat-public-photo-status");
  statusEl.textContent = "画像を処理しています...";
  try {
    const compressed = await compressImageToDataUrl(file, 900, 0.75);
    if (compressed.length > 700000) {
      statusEl.textContent = "画像が大きすぎます。別の写真でお試しください。";
      return;
    }
    currentCatPublicPhotoData = compressed;
    const preview = document.getElementById("cat-public-photo-preview");
    preview.src = compressed;
    preview.classList.remove("hidden");
    statusEl.textContent = "設定しました。";
  } catch (err) {
    statusEl.textContent = "画像の読み込みに失敗しました。別の写真でお試しください。";
  }
});

// ---------- フォーム送信 ----------
// ---------- 公開ページ用データの同期 ----------
// cats本体とは別のコレクション(publicProfiles)に、公開して良い項目だけをミラーする。
// これにより、ログイン不要で読めるようにしても、保護場所・預かり担当者名・内部メモなどは外部から見えない。
async function syncPublicProfile(catId, data) {
  if (data.status === "譲渡済み") {
    // ページの中身自体は完全に非公開にするが、兄弟姉妹欄では「里親さん決定」の案内付きで
    // 写真と名前だけ引き続き見られるように、ドキュメント自体は残す(詳しい内容は消す)
    await setDoc(doc(db, "publicProfiles", catId), {
      adopted: true,
      draft: false,
      trialMode: false,
      name: data.name,
      photoData: data.publicPhotoData || data.photoData || "",
      updatedAt: serverTimestamp()
    }, { merge: false });
    // トライアル中だった場合のデータも消しておく(古い合言葉を分かっていても読めないようにする)
    if (data.trialPasscode) {
      try {
        await deleteDoc(doc(db, "trialProfiles", `${catId}-${data.trialPasscode}`));
      } catch (err) {
        // 元々存在しない場合は何もしなくてよい
      }
    }
    return;
  }

  if (!data.isPublished) {
    // まだ「公開する」がオンになっていない場合。QRコード自体は先に発行できるように、
    // publicProfilesのドキュメント(＝QRコードの行き先)は用意しておくが、中身は「準備中」の案内だけにする。
    // これで、団体への配布用にQRコードだけ先に作っておき、公開のタイミングは自分で決められる。
    await setDoc(doc(db, "publicProfiles", catId), {
      draft: true,
      trialMode: false,
      name: data.name,
      photoData: data.publicPhotoData || data.photoData || "",
      updatedAt: serverTimestamp()
    }, { merge: false });
    // 下書き中は、トライアル専用の詳しいページも見られないようにしておく
    if (data.trialPasscode) {
      try {
        await deleteDoc(doc(db, "trialProfiles", `${catId}-${data.trialPasscode}`));
      } catch (err) {
        // 元々存在しない場合は何もしなくてよい
      }
    }
    return;
  }

  const records = latestMedicalSnapshot ? latestMedicalSnapshot.docs.map((d) => d.data()) : [];
  const hasNeuter = records.some((r) => r.type === "避妊去勢");
  const vaccineCount = records.filter((r) => r.type === "ワクチン").length;
  const hasDeworm = records.some((r) => r.type === "駆虫");
  const latestVirusTest = records
    .filter((r) => r.type === "ウイルス検査")
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];

  // トライアルの様子メモも一緒に持っていく(公開ページ側で表示するため)
  let trialNotes = [];
  if (data.status === "トライアル中") {
    try {
      const notesSnap = await getDocs(collection(db, "cats", catId, "trialNotes"));
      trialNotes = notesSnap.docs
        .map((d) => ({ date: d.id, note: d.data().note || "" }))
        .filter((n) => n.note)
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch (err) {
      trialNotes = [];
    }
  }

  // trialProfiles(里親さん用の詳しいQRコード)に置く、全項目入りのデータ
  const fullProfileData = {
    trialMode: false, // トライアル解除後、古い「トライアル中」フラグがpublicProfilesに残らないようにするため明示的にfalseを入れる
    name: data.name,
    species: data.species,
    sex: data.sex,
    age: data.age,
    nameOriginShared: data.nameOriginShared,
    nameOrigin: data.nameOrigin,
    siblingIds: data.siblingIds || [],
    intro: data.intro,
    detailMemo: data.detailMemo,
    personalityTags: data.personalityTags,
    personalityOther: data.personalityOther,
    canDoTags: data.canDoTags,
    canDoOther: data.canDoOther,
    canDislikeTags: data.canDislikeTags,
    canDislikeOther: data.canDislikeOther,
    playTags: data.playTags,
    playOther: data.playOther,
    food: data.food,
    foodMode: data.foodMode,
    foods: data.foods || [],
    foodComment: data.foodComment,
    litterBoxTags: data.litterBoxTags,
    litterSandTags: data.litterSandTags,
    litterSandOther: data.litterSandOther,
    litterGranularity: data.litterGranularity,
    litterCleaning: data.litterCleaning,
    litterMemo: data.litterMemo,
    videoUrl: data.videoUrl,
    videoComingSoon: data.videoComingSoon,
    contactItems: data.contactItems || [],
    fosterContactItems: data.fosterContactItems || [],
    fosterContactComingSoon: data.fosterContactComingSoon,
    photoData: data.publicPhotoData || data.photoData || "",
    neuterStatus: hasNeuter ? "済" : "未",
    vaccineStatus: vaccineCount > 0 ? `済(${vaccineCount}回)` : "未",
    fivResult: latestVirusTest ? (latestVirusTest.fivResult || "未検査") : "未検査",
    felvResult: latestVirusTest ? (latestVirusTest.felvResult || "未検査") : "未検査",
    dewormStatus: hasDeworm ? "済" : "未",
    trialEndDate: data.status === "トライアル中" ? (data.trialEndDate || "") : "",
    trialActive: data.status === "トライアル中",
    trialNotes,
    updatedAt: serverTimestamp()
  };

  // publicProfiles(通常の公開QRコード)に置く、簡単な項目だけのデータ。
  // 餌・トイレの詳細・詳しい様子・預かり者のSNSなどは含めない(里親さん用の詳しいQRコードでのみ見せる)
  const simpleProfileData = {
    trialMode: false,
    name: data.name,
    species: data.species,
    sex: data.sex,
    age: data.age,
    nameOriginShared: data.nameOriginShared,
    nameOrigin: data.nameOrigin,
    siblingIds: data.siblingIds || [],
    intro: data.intro,
    personalityTags: data.personalityTags,
    personalityOther: data.personalityOther,
    canDoTags: data.canDoTags,
    canDoOther: data.canDoOther,
    canDislikeTags: data.canDislikeTags,
    canDislikeOther: data.canDislikeOther,
    playTags: data.playTags,
    playOther: data.playOther,
    videoUrl: data.videoUrl,
    videoComingSoon: data.videoComingSoon,
    contactItems: data.contactItems || [],
    photoData: data.publicPhotoData || data.photoData || "",
    neuterStatus: hasNeuter ? "済" : "未",
    vaccineStatus: vaccineCount > 0 ? `済(${vaccineCount}回)` : "未",
    fivResult: latestVirusTest ? (latestVirusTest.fivResult || "未検査") : "未検査",
    felvResult: latestVirusTest ? (latestVirusTest.felvResult || "未検査") : "未検査",
    dewormStatus: hasDeworm ? "済" : "未",
    updatedAt: serverTimestamp()
  };

  if (data.status === "トライアル中" && data.trialPasscode) {
    // publicProfilesには「トライアル中です」という案内だけを置き、詳しい内容は
    // trialProfiles/{猫のID}-{合言葉} という、URLを知らないとたどり着けない場所に置く
    await setDoc(doc(db, "publicProfiles", catId), {
      trialMode: true,
      name: data.name,
      photoData: data.publicPhotoData || data.photoData || "",
      updatedAt: serverTimestamp()
    }, { merge: false });
    await setDoc(doc(db, "trialProfiles", `${catId}-${data.trialPasscode}`), fullProfileData, { merge: true });

    // 合言葉を変更・再設定した場合、古い合言葉のデータは読めないように消しておく
    if (data.previousTrialPasscode && data.previousTrialPasscode !== data.trialPasscode) {
      try {
        await deleteDoc(doc(db, "trialProfiles", `${catId}-${data.previousTrialPasscode}`));
      } catch (err) {
        // 元々存在しない場合は何もしなくてよい
      }
    }
  } else {
    // トライアル中でない場合は、簡単なプロフィールだけをpublicProfilesに置く
    // (merge:falseで、以前保存されていた餌・トイレなどの詳細項目が残らないようにする。
    //  体重の推移(weightHistory)は直後のsyncPublicWeightHistoryで改めて設定される)
    await setDoc(doc(db, "publicProfiles", catId), simpleProfileData, { merge: false });

    // 元々トライアル中だったのを解除した場合、trialProfiles側の古いデータも消しておく
    if (data.previousTrialPasscode) {
      try {
        await deleteDoc(doc(db, "trialProfiles", `${catId}-${data.previousTrialPasscode}`));
      } catch (err) {
        // 元々存在しない場合は何もしなくてよい
      }
    }
  }

  await syncPublicWeightHistory(catId);
}

// ---------- 公開ページ用: 体重の推移を同期する(日々の記録が変わるたびに呼び出す) ----------
async function syncPublicWeightHistory(catId) {
  try {
    const profileSnap = await getDoc(doc(db, "publicProfiles", catId));
    if (!profileSnap.exists()) return; // 公開されていない子は何もしない

    const logsSnap = await getDocs(collection(db, "cats", catId, "dailyLogs"));
    const points = logsSnap.docs
      .map((d) => d.data())
      .filter((log) => log.weight !== undefined && log.weight !== null && log.weight !== "")
      .map((log) => ({ date: log.date, weight: parseFloat(log.weight) }))
      .filter((p) => !isNaN(p.weight))
      .sort((a, b) => a.date.localeCompare(b.date));

    await updateDoc(doc(db, "publicProfiles", catId), {
      weightHistory: points,
      currentWeight: points.length ? points[points.length - 1].weight : null
    });
  } catch (err) {
    // 公開されていない、権限が無いなどの場合は失敗しても問題ない
  }
}

let isCatFormSubmitting = false;
document.getElementById("form-cat").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isCatFormSubmitting) return; // 二重送信防止(通信中に連打しても2件登録されないようにする)
  isCatFormSubmitting = true;

  const catFormStatus = document.getElementById("cat-form-status");
  const catSubmitBtn = document.getElementById("cat-submit-btn");
  catFormStatus.textContent = "";

  const name = document.getElementById("cat-name").value.trim();
  if (!name) {
    catFormStatus.textContent = "名前を入力してください。";
    isCatFormSubmitting = false;
    return;
  }

  const location = document.getElementById("cat-location").value;
  const isFoster = location === "個人宅預かり";
  const fosterSelect = document.getElementById("cat-foster-user");
  const fosterUid = isFoster ? fosterSelect.value : "";
  const fosterUsername = isFoster && fosterSelect.selectedIndex >= 0
    ? fosterSelect.options[fosterSelect.selectedIndex].textContent
    : "";

  const foodMode = document.getElementById("food-input-mode").value;

  const data = {
    species: document.getElementById("cat-species").value,
    location,
    assignedFosterUids: isFoster && fosterUid ? [fosterUid] : [],
    fosterName: fosterUsername,
    name,
    sex: document.getElementById("cat-sex").value,
    age: document.getElementById("cat-age").value.trim(),
    intake: document.getElementById("cat-intake").value,
    memo: document.getElementById("cat-memo").value.trim(),
    intro: document.getElementById("cat-intro").value.trim(),
    personalityTags: [...new Set(Array.from(document.querySelectorAll(".personality-tag:checked")).map((cb) => cb.value))],
    personalityOther: document.getElementById("cat-personality-other").value.trim(),
    canDoTags: [...new Set(Array.from(document.querySelectorAll(".can-do-tag:checked")).map((cb) => cb.value))],
    canDoOther: document.getElementById("cat-candoo-other").value.trim(),
    canDislikeTags: [...new Set(Array.from(document.querySelectorAll(".can-dislike-tag:checked")).map((cb) => cb.value))],
    canDislikeOther: document.getElementById("cat-dislike-other").value.trim(),
    playTags: [...new Set(Array.from(document.querySelectorAll(".play-tag:checked")).map((cb) => cb.value))],
    playOther: document.getElementById("cat-play-other").value.trim(),
    food: document.getElementById("cat-food").value.trim(),
    foodMode,
    foods: foodMode === "itemized" ? getFoodItemsFromForm() : [],
    foodComment: document.getElementById("food-comment").value.trim(),
    litterBoxTags: Array.from(document.querySelectorAll(".litter-box-tag:checked")).map((cb) => cb.value),
    litterSandTags: Array.from(document.querySelectorAll(".litter-sand-tag:checked")).map((cb) => cb.value),
    litterSandOther: document.getElementById("litter-sand-other").value.trim(),
    litterGranularity: document.getElementById("litter-granularity").value,
    litterCleaning: document.getElementById("litter-cleaning").value.trim(),
    litterMemo: document.getElementById("litter-memo").value.trim(),
    nameOriginShared: document.getElementById("cat-name-origin-shared").value.trim(),
    nameOrigin: document.getElementById("cat-name-origin").value.trim(),
    siblingIds: Array.from(document.querySelectorAll(".sibling-cb:checked")).map((cb) => cb.value),
    videoUrl: document.getElementById("cat-video-url").value.trim(),
    videoComingSoon: document.getElementById("cat-video-coming-soon").checked,
    publicPhotoData: currentCatPublicPhotoData || "",
    isPublished: document.getElementById("cat-is-published").checked,
    contactItems: getContactItemsFromForm(),
    fosterContactItems: getFosterContactItemsFromForm(),
    fosterContactComingSoon: document.getElementById("foster-contact-coming-soon").checked,
    detailMemo: document.getElementById("cat-detail-memo").value.trim(),
    photoData: currentCatPhotoData || ""
  };

  catSubmitBtn.disabled = true;
  catFormStatus.textContent = editingCatId ? "更新しています..." : "登録しています...";

  try {
    if (editingCatId) {
      const before = editingCatOriginal || {};
      const changes = [];
      const beforeLocationText = before.location === "個人宅預かり"
        ? `${FOSTER_LABEL}${before.fosterName ? "(" + before.fosterName + ")" : ""}`
        : FACILITY_LABEL;
      const afterLocationText = data.location === "個人宅預かり"
        ? `${FOSTER_LABEL}${data.fosterName ? "(" + data.fosterName + ")" : ""}`
        : FACILITY_LABEL;
      if (beforeLocationText !== afterLocationText) {
        changes.push(`保護場所: ${beforeLocationText} → ${afterLocationText}`);
      }
      if ((before.name || "") !== data.name) changes.push(`名前: ${before.name || "-"} → ${data.name}`);
      if ((before.species || "") !== data.species) changes.push(`種類: ${before.species || "-"} → ${data.species}`);

      await updateDoc(doc(db, "cats", editingCatId), data);
      if (changes.length) await addHistoryEntry(editingCatId, changes.join(" ／ "));
      await saveContactPresetIfNew(data.contactItems);
      await saveFosterContactPresetIfNew(data.fosterContactItems);
      await saveNameOriginSharedPresetIfNew(data.nameOriginShared);
      for (const row of document.querySelectorAll("#food-items-list .food-item-row")) { await saveFoodPhotoPresetIfNewForRow(row); }

      const updatedCatData = { ...before, ...data };
      await syncPublicProfile(editingCatId, updatedCatData);
      catFormStatus.textContent = "更新しました。";
      e.target.reset();
      fosterNameWrap.classList.add("hidden");
      resetCatModalToAddMode();
      modalCat.classList.remove("open");
      showDetail(editingCatId, updatedCatData);
    } else {
      const newCatRef = await addDoc(collection(db, "cats"), {
        ...data,
        status: "保護中",
        createdBy: currentUsername,
        createdAt: serverTimestamp()
      });
      await saveContactPresetIfNew(data.contactItems);
      await saveFosterContactPresetIfNew(data.fosterContactItems);
      await saveNameOriginSharedPresetIfNew(data.nameOriginShared);
      for (const row of document.querySelectorAll("#food-items-list .food-item-row")) { await saveFoodPhotoPresetIfNewForRow(row); }
      await syncPublicProfile(newCatRef.id, { ...data, status: "保護中" });
      catFormStatus.textContent = "登録しました。";
      e.target.reset();
      fosterNameWrap.classList.add("hidden");
      modalCat.classList.remove("open");
    }
  } catch (err) {
    catFormStatus.textContent = `保存に失敗しました(${err.code || err.message || "不明なエラー"})。権限設定を確認するか、もう一度お試しください。`;
  } finally {
    catSubmitBtn.disabled = false;
    isCatFormSubmitting = false;
  }
});

document.getElementById("form-daily").addEventListener("submit", async (e) => {
  e.preventDefault();

  const medications = Array.from(document.querySelectorAll(".med-given")).map((cb) => ({
    recordId: cb.dataset.recordId,
    label: cb.dataset.label,
    given: cb.checked
  }));

  const appetiteStatusValue = document.getElementById("daily-appetite-status").value;
  const appetite = {
    status: appetiteStatusValue,
    remainGrams: appetiteStatusValue === "一部残した"
      ? document.getElementById("daily-appetite-remain").value
      : "",
    eatenPercent: appetiteStatusValue === "子猫用(%)"
      ? document.getElementById("daily-appetite-percent").value
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

  const dailyData = {
    date: document.getElementById("daily-date").value,
    timeOfDay: document.getElementById("daily-time-of-day").value,
    careTime: document.getElementById("daily-care-time").value,
    weight: document.getElementById("daily-weight").value,
    appetite,
    urine,
    stool,
    medications,
    memo: document.getElementById("daily-memo").value.trim()
  };

  if (editingDailyId) {
    await updateDoc(doc(db, "cats", currentCatId, "dailyLogs", editingDailyId), dailyData);
  } else {
    await addDoc(collection(db, "cats", currentCatId, "dailyLogs"), {
      ...dailyData,
      recordedBy: currentUsername,
      createdAt: serverTimestamp()
    });
  }
  await syncPublicWeightHistory(currentCatId);
  resetDailyModalToAddMode();
  e.target.reset();
  resetDailyFormExtras();
  modalDaily.classList.remove("open");
});

document.getElementById("form-medical").addEventListener("submit", async (e) => {
  e.preventDefault();
  const type = document.getElementById("medical-type").value;
  const isMedication = type === "投薬";
  const isVirusTest = type === "ウイルス検査";
  const isSingleDose = isMedication && singleDoseCheckbox.checked;
  const isFlexibleTiming = isMedication && !isSingleDose && flexibleTimingCheckbox.checked;
  const medicationTiming = isMedication && !isSingleDose && !isFlexibleTiming
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
    endDate: isMedication && !isSingleDose ? document.getElementById("medical-end-date").value : "",
    singleDose: isSingleDose,
    singleDoseTime: isSingleDose ? document.getElementById("medical-single-dose-time").value : "",
    flexibleTiming: isFlexibleTiming,
    dailyLimit: isFlexibleTiming ? parseInt(document.getElementById("medical-daily-limit").value, 10) || 1 : null,
    fivResult: isVirusTest ? document.getElementById("medical-fiv").value : "",
    felvResult: isVirusTest ? document.getElementById("medical-felv").value : "",
    photoData: currentMedicalPhotoData || ""
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
  updateMedicalTypeUI();
  resetMedicalModalToAddMode();
  modalMedical.classList.remove("open");
});

// ---------- 譲渡会の会場(保存済みの会場から選ぶ、または新規入力) ----------
let eventLocationPresets = []; // {name, address}
let eventLocationPresetsLoaded = false;
async function loadEventLocationPresets() {
  if (eventLocationPresetsLoaded) return;
  try {
    const snap = await getDoc(doc(db, "config", "eventLocationPresets"));
    eventLocationPresets = snap.exists() ? (snap.data().list || []) : [];
  } catch (err) {
    eventLocationPresets = [];
  }
  eventLocationPresetsLoaded = true;
  populateEventLocationPresetSelect();
}

function populateEventLocationPresetSelect() {
  const selectEl = document.getElementById("group-qr-location-preset");
  selectEl.innerHTML = `
    <option value="">選択してください(保存済みの会場から選ぶ)</option>
    ${eventLocationPresets.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join("")}
    <option value="__new__">+ 新しく入力する</option>
  `;
}

document.getElementById("group-qr-location-preset").addEventListener("change", (e) => {
  const val = e.target.value;
  if (val === "__new__" || val === "") return;
  const preset = eventLocationPresets[parseInt(val, 10)];
  if (preset) {
    document.getElementById("group-qr-location-name").value = preset.name || "";
    document.getElementById("group-qr-location-address").value = preset.address || "";
  }
});

async function saveEventLocationPresetIfNew(name, address) {
  if (!name) return;
  const alreadyExists = eventLocationPresets.some((p) => p.name === name);
  if (alreadyExists) return;
  const entry = { name, address: address || "" };
  try {
    await setDoc(doc(db, "config", "eventLocationPresets"), { list: arrayUnion(entry) }, { merge: true });
    eventLocationPresets.push(entry);
  } catch (err) {
    // 保存に失敗しても、今回のページ作成自体は問題ない
  }
}

// ---------- まとめてQRページ作成 ----------
const modalGroupQr = document.getElementById("modal-group-qr");

document.getElementById("group-qr-btn").addEventListener("click", () => {
  document.getElementById("group-qr-status").textContent = "";
  renderGroupQrCatList();
  loadEventLocationPresets();
  modalGroupQr.classList.add("open");
});

function renderGroupQrCatList() {
  const listEl = document.getElementById("group-qr-cat-list");
  listEl.innerHTML = "";
  if (!latestCatsSnapshot) return;
  const targetCats = latestCatsSnapshot.docs.filter((docSnap) => {
    const cat = docSnap.data();
    return cat.status !== "譲渡済み";
  });
  if (targetCats.length === 0) {
    listEl.innerHTML = `<p class="hint-text">対象の子がいません。</p>`;
    return;
  }
  targetCats.forEach((docSnap) => {
    const cat = docSnap.data();
    const label = document.createElement("label");
    label.className = "checkbox-item";
    label.innerHTML = `<input type="checkbox" value="${docSnap.id}" class="group-qr-cat"> ${escapeHtml(cat.name)}${cat.isPublished ? "" : "<span class=\"hint-text\">(下書き中)</span>"}`;
    listEl.appendChild(label);
  });
}

document.getElementById("group-qr-open-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("group-qr-status");
  const catIds = Array.from(document.querySelectorAll(".group-qr-cat:checked")).map((cb) => cb.value);
  if (catIds.length === 0) {
    statusEl.textContent = "対象の猫を1匹以上選んでください。";
    return;
  }
  const eventDate = document.getElementById("group-qr-date").value;
  const locName = document.getElementById("group-qr-location-name").value.trim();
  const locAddress = document.getElementById("group-qr-location-address").value.trim();
  const notice = document.getElementById("group-qr-notice").value.trim();
  const catNames = Array.from(document.querySelectorAll(".group-qr-cat:checked")).map(
    (cb) => cb.closest("label").textContent.trim()
  );

  if (locName) await saveEventLocationPresetIfNew(locName, locAddress);

  const params = new URLSearchParams();
  params.set("ids", catIds.join(","));
  if (eventDate) params.set("date", eventDate);
  if (locName) params.set("locName", locName);
  if (locAddress) params.set("locAddress", locAddress);
  if (notice) params.set("notice", notice);
  const groupUrl = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}group.html?${params.toString()}`;

  try {
    await addDoc(collection(db, "eventGroups"), {
      catIds,
      catNames,
      eventDate,
      locName,
      locAddress,
      notice,
      createdByUid: currentUid,
      createdByName: currentUsername || "",
      createdAt: serverTimestamp()
    });
  } catch (err) {
    // 履歴の保存に失敗しても、ページ自体は開けるので問題ない
  }

  window.open(groupUrl, "_blank");
  modalGroupQr.classList.remove("open");
});

// ---------- 譲渡会の履歴 ----------
document.getElementById("event-history-btn").addEventListener("click", async () => {
  const listEl = document.getElementById("event-history-list");
  listEl.innerHTML = `<p class="hint-text">読み込んでいます...</p>`;
  document.getElementById("modal-event-history").classList.add("open");

  let snap;
  try {
    snap = await getDocs(query(collection(db, "eventGroups"), orderBy("createdAt", "desc")));
  } catch (err) {
    listEl.innerHTML = `<p class="hint-text">読み込みに失敗しました。</p>`;
    return;
  }

  if (snap.empty) {
    listEl.innerHTML = `<p class="hint-text">まだ履歴がありません。</p>`;
    return;
  }

  listEl.innerHTML = "";
  snap.forEach((docSnap) => {
    const ev = docSnap.data();
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
    let dateText = "";
    if (ev.eventDate) {
      const d = new Date(ev.eventDate + "T00:00:00");
      if (!isNaN(d.getTime())) dateText = `${d.getMonth() + 1}月${d.getDate()}日(${weekdays[d.getDay()]}) `;
    }
    const catNamesText = (ev.catNames || []).join("・");

    const row = document.createElement("div");
    row.className = "detail-box";
    row.style.marginTop = "8px";
    row.innerHTML = `
      <div style="font-weight:700;">${escapeHtml(dateText)}${escapeHtml(ev.locName || "(会場未設定)")}</div>
      <div class="hint-text" style="margin-top:2px;">${escapeHtml(catNamesText)}</div>
      <div style="display:flex; gap:10px; margin-top:8px;">
        <button type="button" class="btn btn-ghost btn-small" style="padding:0;" data-open>開く</button>
        <button type="button" class="btn btn-ghost btn-small" style="padding:0;" data-delete>削除</button>
      </div>
    `;
    row.querySelector("[data-open]").addEventListener("click", () => {
      const params = new URLSearchParams();
      params.set("ids", (ev.catIds || []).join(","));
      if (ev.eventDate) params.set("date", ev.eventDate);
      if (ev.locName) params.set("locName", ev.locName);
      if (ev.locAddress) params.set("locAddress", ev.locAddress);
      if (ev.notice) params.set("notice", ev.notice);
      const groupUrl = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}group.html?${params.toString()}`;
      window.open(groupUrl, "_blank");
    });
    row.querySelector("[data-delete]").addEventListener("click", async () => {
      if (confirm("この履歴を削除しますか？(公開ページ自体には影響ありません)")) {
        await deleteDoc(doc(db, "eventGroups", docSnap.id));
        row.remove();
      }
    });
    listEl.appendChild(row);
  });
});

// ---------- 入力もれチェック ----------
document.getElementById("missing-check-btn").addEventListener("click", () => {
  document.getElementById("missing-check-date").valueAsDate = new Date();
  document.getElementById("missing-check-result").innerHTML = "";
  document.getElementById("modal-missing-check").classList.add("open");
});

document.getElementById("missing-check-run-btn").addEventListener("click", async () => {
  const resultEl = document.getElementById("missing-check-result");
  const targetDate = document.getElementById("missing-check-date").value;
  const targetField = document.getElementById("missing-check-field").value;
  const fieldLabels = { appetite: "食事(食欲)", weight: "体重", urine: "尿", stool: "便", any: "記録そのもの" };

  if (!targetDate) {
    resultEl.innerHTML = `<p class="hint-text">日付を選んでください。</p>`;
    return;
  }
  if (!latestCatsSnapshot) {
    resultEl.innerHTML = `<p class="hint-text">猫の一覧を読み込み中です。もう一度お試しください。</p>`;
    return;
  }
  resultEl.innerHTML = `<p class="hint-text">確認しています...</p>`;

  // その記録の中で、選んだ項目が実際に入力されているかを判定する
  function isFieldFilled(log) {
    if (targetField === "any") return true; // 記録があること自体がOK
    if (targetField === "appetite") {
      const a = log.appetite;
      const status = typeof a === "object" && a ? a.status : a;
      return !!status;
    }
    if (targetField === "weight") return !!log.weight;
    if (targetField === "urine") return !!(log.urine && log.urine.status);
    if (targetField === "stool") return !!(log.stool && log.stool.status);
    return true;
  }

  // 譲渡済みの子は対象外にする(日々の記録をつける対象ではなくなっているため)
  const targetCats = latestCatsSnapshot.docs.filter((d) => d.data().status !== "譲渡済み");

  const results = [];
  for (const docSnap of targetCats) {
    const catData = docSnap.data();
    let hasLog = false;
    try {
      const q = query(collection(db, "cats", docSnap.id, "dailyLogs"), where("date", "==", targetDate));
      const snap = await getDocs(q);
      hasLog = snap.docs.some((d) => isFieldFilled(d.data()));
    } catch (err) {
      hasLog = null; // 確認できなかった(権限が無いなど)
    }
    results.push({ name: catData.name, hasLog });
  }

  if (results.length === 0) {
    resultEl.innerHTML = `<p class="hint-text">確認できる子がいません。</p>`;
    return;
  }

  const missing = results.filter((r) => r.hasLog === false);
  const ok = results.filter((r) => r.hasLog === true);
  const unknown = results.filter((r) => r.hasLog === null);

  let html = "";
  if (missing.length > 0) {
    html += `<div class="detail-box" style="border-color:#e08a8a;">
      <div style="font-weight:700; color:#c0392b;">❌ 「${escapeHtml(fieldLabels[targetField])}」が未入力の子(${missing.length}匹)</div>
      <div style="margin-top:4px;">${missing.map((r) => escapeHtml(r.name)).join("・")}</div>
    </div>`;
  } else {
    html += `<div class="detail-box" style="border-color:#7c9473;"><div style="font-weight:700; color:#4a7a3a;">✅ 全員分、「${escapeHtml(fieldLabels[targetField])}」が入力されていました!</div></div>`;
  }
  if (ok.length > 0) {
    html += `<p class="hint-text" style="margin-top:10px;">入力あり: ${ok.map((r) => escapeHtml(r.name)).join("・")}</p>`;
  }
  if (unknown.length > 0) {
    html += `<p class="hint-text">確認できなかった子: ${unknown.map((r) => escapeHtml(r.name)).join("・")}</p>`;
  }
  resultEl.innerHTML = html;
});

// ---------- まとめて排泄記録 ----------
const modalGroupToilet = document.getElementById("modal-group-toilet");

document.getElementById("group-toilet-btn").addEventListener("click", () => {
  document.getElementById("form-group-toilet").reset();
  document.getElementById("group-toilet-date").valueAsDate = new Date();
  document.getElementById("group-toilet-time").value = "朝";
  document.getElementById("group-toilet-status").textContent = "";
  renderGroupToiletCatList();
  modalGroupToilet.classList.add("open");
});

function renderGroupToiletCatList() {
  const listEl = document.getElementById("group-toilet-cat-list");
  listEl.innerHTML = "";
  if (!latestCatsSnapshot) return;
  latestCatsSnapshot.docs.forEach((docSnap) => {
    const cat = docSnap.data();
    if (cat.status === "譲渡済み") return; // 譲渡済みの子は対象から外す
    const label = document.createElement("label");
    label.className = "checkbox-item";
    label.innerHTML = `<input type="checkbox" value="${docSnap.id}" class="group-toilet-cat"> ${escapeHtml(cat.name)}`;
    listEl.appendChild(label);
  });
}

document.getElementById("form-group-toilet").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("group-toilet-status");
  const submitBtn = document.getElementById("group-toilet-submit-btn");

  const catIds = Array.from(document.querySelectorAll(".group-toilet-cat:checked")).map((cb) => cb.value);
  if (catIds.length === 0) {
    statusEl.textContent = "対象の猫を1匹以上選んでください。";
    return;
  }

  const date = document.getElementById("group-toilet-date").value;
  const timeOfDay = document.getElementById("group-toilet-time").value;
  const urineChoice = document.getElementById("group-toilet-urine").value;
  const stoolChoice = document.getElementById("group-toilet-stool").value;
  const memo = document.getElementById("group-toilet-memo").value.trim();

  const urine = urineChoice === "skip" ? { status: "" } : { status: urineChoice === "あり" ? "共同のため不明(あり)" : "無し" };
  const stool = stoolChoice === "skip" ? { status: "" } : { status: stoolChoice === "あり" ? "共同のため不明(あり)" : "無し" };

  submitBtn.disabled = true;
  statusEl.textContent = "記録しています...";
  try {
    await Promise.all(catIds.map((catId) =>
      addDoc(collection(db, "cats", catId, "dailyLogs"), {
        date,
        timeOfDay,
        careTime: "",
        weight: "",
        appetite: { status: "" },
        urine,
        stool,
        medications: [],
        memo,
        recordedBy: currentUsername,
        createdAt: serverTimestamp()
      })
    ));
    statusEl.textContent = "";
    modalGroupToilet.classList.remove("open");
  } catch (err) {
    statusEl.textContent = `保存に失敗しました(${err.code || err.message || "不明なエラー"})。`;
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- まとめて医療記録 ----------
const modalGroupMedical = document.getElementById("modal-group-medical");

document.getElementById("group-medical-btn").addEventListener("click", () => {
  document.getElementById("form-group-medical").reset();
  document.getElementById("group-medical-date").valueAsDate = new Date();
  document.getElementById("group-medical-status").textContent = "";
  updateGroupMedicalTypeUI();
  updateGroupVaccineTitle();
  renderGroupMedicalCatList();
  modalGroupMedical.classList.add("open");
});

function updateGroupMedicalTypeUI() {
  const isVaccine = document.getElementById("group-medical-type").value === "ワクチン";
  document.getElementById("group-vaccine-select-wrap").classList.toggle("hidden", !isVaccine);
}
document.getElementById("group-medical-type").addEventListener("change", updateGroupMedicalTypeUI);

function updateGroupVaccineTitle() {
  const isVaccine = document.getElementById("group-medical-type").value === "ワクチン";
  if (!isVaccine) return;
  const kind = document.getElementById("group-vaccine-kind-select").value;
  const count = document.getElementById("group-vaccine-count-select").value;
  if (kind !== "その他") {
    document.getElementById("group-medical-title").value = `${kind}${count}`;
  }
}
document.getElementById("group-vaccine-kind-select").addEventListener("change", updateGroupVaccineTitle);
document.getElementById("group-vaccine-count-select").addEventListener("change", updateGroupVaccineTitle);

function renderGroupMedicalCatList() {
  const listEl = document.getElementById("group-medical-cat-list");
  listEl.innerHTML = "";
  if (!latestCatsSnapshot) return;
  latestCatsSnapshot.docs.forEach((docSnap) => {
    const cat = docSnap.data();
    if (cat.status === "譲渡済み") return; // 譲渡済みの子は対象から外す
    const label = document.createElement("label");
    label.className = "checkbox-item";
    label.innerHTML = `<input type="checkbox" value="${docSnap.id}" class="group-medical-cat"> ${escapeHtml(cat.name)}`;
    listEl.appendChild(label);
  });
}

document.getElementById("form-group-medical").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("group-medical-status");
  const submitBtn = document.getElementById("group-medical-submit-btn");

  const catIds = Array.from(document.querySelectorAll(".group-medical-cat:checked")).map((cb) => cb.value);
  if (catIds.length === 0) {
    statusEl.textContent = "対象の猫を1匹以上選んでください。";
    return;
  }

  const type = document.getElementById("group-medical-type").value;
  const date = document.getElementById("group-medical-date").value;
  const title = document.getElementById("group-medical-title").value.trim();
  const detail = document.getElementById("group-medical-detail").value.trim();
  const next = document.getElementById("group-medical-next").value;

  submitBtn.disabled = true;
  statusEl.textContent = "記録しています...";
  try {
    await Promise.all(catIds.map((catId) =>
      addDoc(collection(db, "cats", catId, "medicalRecords"), {
        type,
        date,
        title,
        detail,
        next,
        medicationTiming: [],
        medicationMethod: "",
        dosage: "",
        endDate: "",
        singleDose: false,
        singleDoseTime: "",
        flexibleTiming: false,
        dailyLimit: null,
        fivResult: "",
        felvResult: "",
        photoData: "",
        recordedBy: currentUsername,
        createdAt: serverTimestamp()
      })
    ));
    statusEl.textContent = "";
    modalGroupMedical.classList.remove("open");
  } catch (err) {
    statusEl.textContent = `保存に失敗しました(${err.code || err.message || "不明なエラー"})。`;
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- 体重グラフ ----------
const modalWeightChart = document.getElementById("modal-weight-chart");
let weightChartInstance = null;

document.getElementById("weight-chart-btn").addEventListener("click", () => {
  renderWeightChart();
  modalWeightChart.classList.add("open");
});

function renderWeightChart() {
  const emptyEl = document.getElementById("weight-chart-empty");
  const canvasEl = document.getElementById("weight-chart-canvas");

  if (weightChartInstance) {
    weightChartInstance.destroy();
    weightChartInstance = null;
  }

  if (!latestDailySnapshot) {
    emptyEl.classList.remove("hidden");
    canvasEl.classList.add("hidden");
    return;
  }

  const timeOfDayRank = { "早朝": 0, "朝": 1, "昼": 2, "夕方": 3, "夜": 4, "深夜": 5 };
  const points = latestDailySnapshot.docs
    .map((docSnap) => docSnap.data())
    .filter((log) => log.weight !== undefined && log.weight !== null && log.weight !== "")
    .map((log) => ({
      date: log.date,
      timeOfDay: log.timeOfDay,
      weight: parseFloat(log.weight)
    }))
    .filter((p) => !isNaN(p.weight))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (timeOfDayRank[a.timeOfDay] ?? 9) - (timeOfDayRank[b.timeOfDay] ?? 9);
    });

  if (points.length === 0) {
    emptyEl.classList.remove("hidden");
    canvasEl.classList.add("hidden");
    return;
  }
  emptyEl.classList.add("hidden");
  canvasEl.classList.remove("hidden");

  weightChartInstance = new Chart(canvasEl.getContext("2d"), {
    type: "line",
    data: {
      labels: points.map((p) => `${p.date}${p.timeOfDay ? " " + p.timeOfDay : ""}`),
      datasets: [{
        label: "体重(kg)",
        data: points.map((p) => p.weight),
        borderColor: "#e08a3c",
        backgroundColor: "rgba(224,138,60,0.15)",
        tension: 0.25,
        fill: true,
        pointRadius: 3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { title: { display: true, text: "kg" } }
      }
    }
  });
}


// ---------- アカウント設定 ----------
const modalAccountSettings = document.getElementById("modal-account-settings");

document.getElementById("account-settings-btn").addEventListener("click", () => {
  document.getElementById("account-display-name").value = currentUsername || "";
  document.getElementById("account-new-id").value = "";
  document.getElementById("account-id-current-password").value = "";
  document.getElementById("account-display-name-status").textContent = "";
  document.getElementById("account-id-status").textContent = "";
  document.getElementById("account-delete-password").value = "";
  document.getElementById("account-delete-status").textContent = "";
  modalAccountSettings.classList.add("open");
});

// 表示名の変更(パスワード不要)
document.getElementById("account-display-name-save-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("account-display-name-status");
  const newName = document.getElementById("account-display-name").value.trim();
  if (!newName) {
    statusEl.textContent = "表示名を入力してください。";
    return;
  }
  statusEl.textContent = "保存しています...";
  try {
    await updateDoc(doc(db, "users", currentUid), { displayName: newName });
    currentUsername = newName;
    statusEl.textContent = "表示名を変更しました。次の記録から反映されます。";
  } catch (err) {
    statusEl.textContent = "保存に失敗しました。もう一度お試しください。";
  }
});

// ログインID(ユーザー名/メールアドレス)の変更(本人確認のためパスワードが必要)
document.getElementById("account-id-save-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("account-id-status");
  const newIdRaw = document.getElementById("account-new-id").value.trim();
  const currentPassword = document.getElementById("account-id-current-password").value;

  if (!newIdRaw) {
    statusEl.textContent = "新しいユーザー名またはメールアドレスを入力してください。";
    return;
  }
  if (!newIdRaw.includes("@") && !/^[A-Za-z0-9_]+$/.test(newIdRaw)) {
    statusEl.textContent = "ユーザー名は半角英数字とアンダースコアのみ使えます。";
    return;
  }
  if (!currentPassword) {
    statusEl.textContent = "確認のため、現在のパスワードを入力してください。";
    return;
  }

  const newEmail = newIdRaw.includes("@") ? newIdRaw : `${newIdRaw.toLowerCase()}@hogoneko-app.local`;
  statusEl.textContent = "変更しています...";
  try {
    const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
    await reauthenticateWithCredential(currentUser, credential);
    await updateEmail(currentUser, newEmail);
    await updateDoc(doc(db, "users", currentUid), { username: newIdRaw });
    currentLoginUsername = newIdRaw;
    statusEl.textContent = "ログインIDを変更しました。次回から新しいIDでログインしてください。";
    document.getElementById("account-id-current-password").value = "";
  } catch (err) {
    statusEl.textContent = "変更できませんでした(パスワードが違うか、既に使われているIDの可能性があります)。";
  }
});

// 退会(アカウント削除、本人確認のためパスワードが必要)
document.getElementById("account-delete-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("account-delete-status");
  const currentPassword = document.getElementById("account-delete-password").value;

  if (!currentPassword) {
    statusEl.textContent = "確認のため、現在のパスワードを入力してください。";
    return;
  }
  const sure = confirm("本当にアカウントを削除して退会しますか？\nこの操作は取り消せません(このIDでは二度とログインできなくなります)。\n※これまでの記録は削除されず、そのまま残ります。");
  if (!sure) return;

  statusEl.textContent = "削除しています...";
  try {
    const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
    await reauthenticateWithCredential(currentUser, credential);
    await deleteDoc(doc(db, "users", currentUid));
    await deleteUser(currentUser);
    window.location.href = "index.html";
  } catch (err) {
    statusEl.textContent = "削除できませんでした。パスワードをご確認ください。";
  }
});

// ---------- ユーティリティ ----------
// ---------- トライアルの様子メモ ----------
async function openTrialNotesModal(catId) {
  document.getElementById("trial-note-date-input").valueAsDate = new Date();
  document.getElementById("trial-note-text-input").value = "";
  document.getElementById("trial-note-status").textContent = "";
  document.getElementById("trial-note-save-btn").dataset.catId = catId;
  document.getElementById("modal-trial-notes").classList.add("open");
  await renderTrialNotesList(catId);
}

async function renderTrialNotesList(catId) {
  const listEl = document.getElementById("trial-notes-list");
  listEl.innerHTML = `<p class="hint-text">読み込んでいます...</p>`;
  try {
    const snap = await getDocs(collection(db, "cats", catId, "trialNotes"));
    const notes = snap.docs.map((d) => ({ date: d.id, ...d.data() })).sort((a, b) => b.date.localeCompare(a.date));
    if (notes.length === 0) {
      listEl.innerHTML = `<p class="hint-text">まだ記録がありません。</p>`;
      return;
    }
    listEl.innerHTML = "";
    notes.forEach((n) => {
      const row = document.createElement("div");
      row.className = "detail-box";
      row.style.marginTop = "8px";
      row.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="font-weight:700;">${escapeHtml(n.date)}</div>
          <button type="button" class="btn btn-ghost btn-small" style="padding:0;" data-edit-note>編集</button>
        </div>
        <div style="margin-top:4px; white-space:pre-wrap;">${escapeHtml(n.note || "")}</div>
      `;
      row.querySelector("[data-edit-note]").addEventListener("click", () => {
        document.getElementById("trial-note-date-input").value = n.date;
        document.getElementById("trial-note-text-input").value = n.note || "";
        document.getElementById("trial-note-status").textContent = "";
        document.getElementById("trial-note-text-input").scrollIntoView({ behavior: "smooth", block: "center" });
      });
      listEl.appendChild(row);
    });
  } catch (err) {
    listEl.innerHTML = `<p class="hint-text">読み込みに失敗しました。</p>`;
  }
}

document.getElementById("trial-note-save-btn").addEventListener("click", async () => {
  const catId = document.getElementById("trial-note-save-btn").dataset.catId;
  const date = document.getElementById("trial-note-date-input").value;
  const note = document.getElementById("trial-note-text-input").value.trim();
  const statusEl = document.getElementById("trial-note-status");
  if (!catId || !date) {
    statusEl.textContent = "日付を選んでください。";
    return;
  }
  statusEl.textContent = "保存しています...";
  try {
    await setDoc(doc(db, "cats", catId, "trialNotes", date), {
      note,
      updatedBy: currentUsername,
      updatedAt: serverTimestamp()
    }, { merge: true });
    document.getElementById("trial-note-text-input").value = "";
    statusEl.textContent = "保存しました。";
    await renderTrialNotesList(catId);
    await syncTrialNotesToPublic(catId);
  } catch (err) {
    statusEl.textContent = "保存に失敗しました。もう一度お試しください。";
  }
});

// 公開ページ(トライアル中の子)に、トライアルの様子メモを同期する
async function syncTrialNotesToPublic(catId) {
  try {
    const catSnap = await getDoc(doc(db, "cats", catId));
    const catData = catSnap.data();
    if (!catData || catData.status !== "トライアル中" || !catData.isPublished) return;

    const notesSnap = await getDocs(collection(db, "cats", catId, "trialNotes"));
    const trialNotes = notesSnap.docs
      .map((d) => ({ date: d.id, note: d.data().note || "" }))
      .filter((n) => n.note)
      .sort((a, b) => a.date.localeCompare(b.date));

    const targetPath = catData.trialPasscode
      ? doc(db, "trialProfiles", `${catId}-${catData.trialPasscode}`)
      : doc(db, "publicProfiles", catId);
    await updateDoc(targetPath, { trialNotes });
  } catch (err) {
    // 公開されていない場合などは失敗しても問題ない
  }
}

// ---------- トライアル開始 ----------
function generateRandomPasscode() {
  let code = "";
  for (let i = 0; i < 6; i++) code += Math.floor(Math.random() * 10);
  return code;
}

// 全角の数字を半角に直す(パスワードの打ち間違い・入力間違いを防ぐため)
function normalizePasscode(str) {
  return (str || "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .trim();
}

document.getElementById("start-trial-save-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("start-trial-status");
  const catId = document.getElementById("start-trial-save-btn").dataset.catId;
  const passcode = normalizePasscode(document.getElementById("trial-passcode-input").value);
  const trialEndDate = document.getElementById("trial-end-date-input").value;

  if (!catId) return;
  if (!passcode) {
    statusEl.textContent = "合言葉(数字)を入力してください。";
    return;
  }

  statusEl.textContent = "設定しています...";
  try {
    const catSnap = await getDoc(doc(db, "cats", catId));
    const catData = catSnap.data();

    await updateDoc(doc(db, "cats", catId), {
      status: "トライアル中",
      trialPasscode: passcode,
      trialEndDate
    });
    await addHistoryEntry(catId, `ステータス: ${catData.status || "保護中"} → トライアル中`);

    const updatedCatData = { ...catData, status: "トライアル中", trialPasscode: passcode, trialEndDate, previousTrialPasscode: catData.trialPasscode || "" };
    await syncPublicProfile(catId, updatedCatData);

    document.getElementById("modal-start-trial").classList.remove("open");
    showDetail(catId, updatedCatData);
  } catch (err) {
    statusEl.textContent = "設定に失敗しました。もう一度お試しください。";
  }
});

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
