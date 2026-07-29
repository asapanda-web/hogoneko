import { auth, db } from "./firebase-config.js?v=1784218044";
import {
  onAuthStateChanged, signOut,
  EmailAuthProvider, reauthenticateWithCredential, updateEmail, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, addDoc, deleteDoc, doc, getDoc, getDocs, onSnapshot,
  query, where, orderBy, serverTimestamp, updateDoc, writeBatch, setDoc
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
  window.print();
});

document.getElementById("print-profile-btn").addEventListener("click", () => {
  document.body.classList.add("print-mode-profile");
  window.print();
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
    ? `${FOSTER_LABEL}${catData.fosterName ? "(" + catData.fosterName + ")" : ""}`
    : FACILITY_LABEL;
  document.getElementById("detail-meta").textContent =
    [locationText, catData.status === "譲渡済み" ? "譲渡済み" : "", catData.sex, catData.age, catData.intake ? `保護開始: ${catData.intake}` : ""].filter(Boolean).join(" ・ ");

  // 印刷時の色分け(オス=水色系、メス=ピンク系)用のクラスをbodyに付与
  document.body.classList.remove("print-sex-male", "print-sex-female");
  if (catData.sex === "オス") document.body.classList.add("print-sex-male");
  if (catData.sex === "メス") document.body.classList.add("print-sex-female");

  // ステータス変更・完全削除ボタンの出し分け
  const canEditCat = isFullAdmin() || (isShelterMember() && catData.location === "施設");
  const actionsWrap = document.getElementById("detail-actions");
  const toggleStatusBtn = document.getElementById("toggle-status-btn");
  const deleteCatBtn = document.getElementById("delete-cat-btn");

  actionsWrap.classList.toggle("hidden", !canEditCat);
  const editCatBtn = document.getElementById("edit-cat-btn");
  editCatBtn.classList.toggle("hidden", !canEditCat);
  if (canEditCat) {
    editCatBtn.onclick = () => openCatEditModal(catId, catData);

    toggleStatusBtn.textContent = catData.status === "譲渡済み" ? "保護中に戻す" : "譲渡済みにする";
    toggleStatusBtn.onclick = async () => {
      const newStatus = catData.status === "譲渡済み" ? "保護中" : "譲渡済み";
      if (confirm(`ステータスを「${newStatus}」に変更しますか？`)) {
        await updateDoc(doc(db, "cats", catId), { status: newStatus });
        await addHistoryEntry(catId, `ステータス: ${catData.status || "保護中"} → ${newStatus}`);
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
  listenHistory(catId);

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

function listenDailyLogs(catId) {
  if (unsubDaily) unsubDaily();
  dailyDisplayDayLimit = 7; // 猫を開き直すたびに表示件数をリセット
  const q = query(collection(db, "cats", catId, "dailyLogs"), orderBy("date", "desc"));
  unsubDaily = onSnapshot(q, (snap) => {
    latestDailySnapshot = snap;
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
          deleteDoc(doc(db, "cats", currentCatId, "dailyLogs", id));
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
}
catSpeciesEl.addEventListener("change", updateSpeciesTagVisibility);

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

  modalCat.classList.add("open");
}

function resetCatModalToAddMode() {
  editingCatId = null;
  editingCatOriginal = null;
  currentCatPhotoData = null;
  document.getElementById("cat-photo-preview").classList.add("hidden");
  document.getElementById("cat-photo-input").value = "";
  document.getElementById("cat-photo-status").textContent = "";
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

// ---------- フォーム送信 ----------
document.getElementById("form-cat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const catFormStatus = document.getElementById("cat-form-status");
  const catSubmitBtn = document.getElementById("cat-submit-btn");
  catFormStatus.textContent = "";

  const name = document.getElementById("cat-name").value.trim();
  if (!name) {
    catFormStatus.textContent = "名前を入力してください。";
    return;
  }

  const location = document.getElementById("cat-location").value;
  const isFoster = location === "個人宅預かり";
  const fosterSelect = document.getElementById("cat-foster-user");
  const fosterUid = isFoster ? fosterSelect.value : "";
  const fosterUsername = isFoster && fosterSelect.selectedIndex >= 0
    ? fosterSelect.options[fosterSelect.selectedIndex].textContent
    : "";

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
    personalityTags: Array.from(document.querySelectorAll(".personality-tag:checked")).map((cb) => cb.value),
    personalityOther: document.getElementById("cat-personality-other").value.trim(),
    canDoTags: Array.from(document.querySelectorAll(".can-do-tag:checked")).map((cb) => cb.value),
    canDoOther: document.getElementById("cat-candoo-other").value.trim(),
    canDislikeTags: Array.from(document.querySelectorAll(".can-dislike-tag:checked")).map((cb) => cb.value),
    canDislikeOther: document.getElementById("cat-dislike-other").value.trim(),
    playTags: Array.from(document.querySelectorAll(".play-tag:checked")).map((cb) => cb.value),
    playOther: document.getElementById("cat-play-other").value.trim(),
    food: document.getElementById("cat-food").value.trim(),
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

      const updatedCatData = { ...before, ...data };
      catFormStatus.textContent = "更新しました。";
      e.target.reset();
      fosterNameWrap.classList.add("hidden");
      resetCatModalToAddMode();
      modalCat.classList.remove("open");
      showDetail(editingCatId, updatedCatData);
    } else {
      await addDoc(collection(db, "cats"), {
        ...data,
        status: "保護中",
        createdBy: currentUsername,
        createdAt: serverTimestamp()
      });
      catFormStatus.textContent = "登録しました。";
      e.target.reset();
      fosterNameWrap.classList.add("hidden");
      modalCat.classList.remove("open");
    }
  } catch (err) {
    catFormStatus.textContent = `保存に失敗しました(${err.code || err.message || "不明なエラー"})。権限設定を確認するか、もう一度お試しください。`;
  } finally {
    catSubmitBtn.disabled = false;
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
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
