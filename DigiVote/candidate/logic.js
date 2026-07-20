// 🔧 Replace with your Firebase project config
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

function generateVoterID() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let id = "";
  for (let i = 0; i < 3; i++) {
    id += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  const digits = Math.floor(10000 + Math.random() * 90000).toString().slice(0, 5);
  return id + digits;
}

function generateCandidateID() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  return "C" + digits;
}

function generateAdminID() {
  const digits = Math.floor(100 + Math.random() * 900);
  return "AD" + digits;
}

function formatDateDDMMYYYY(date) {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

function getISTDateString() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  const year = istTime.getUTCFullYear();
  const month = String(istTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(istTime.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function getUserDocWithRetry(uid, collectionName, retries = 5, delayMs = 500) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const docSnap = await db.collection(collectionName).doc(uid).get();
    if (docSnap.exists) {
      return docSnap;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function sha256Hash(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function obfuscatePassword(password) {
  return btoa(password);
}

function deobfuscatePassword(encoded) {
  try {
    return atob(encoded);
  } catch {
    return "";
  }
}

const VoterAuth = (() => {
  let confirmationResult = null;

  function initRecaptcha(containerId) {
    window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier(containerId, {
      size: "invisible",
    });
  }

  async function sendOTP(phoneNumber) {
    const appVerifier = window.recaptchaVerifier;
    confirmationResult = await auth.signInWithPhoneNumber(phoneNumber, appVerifier);
    return confirmationResult;
  }

  async function verifyOTP(otp) {
    if (!confirmationResult) throw new Error("No OTP request in progress");
    const result = await confirmationResult.confirm(otp);
    return result.user;
  }

  async function createVoterProfile(uid, phoneNumber, name) {
    const voterID = generateVoterID();
    const voterData = {
      voterID,
      phoneNumber,
      name,
      uid,
      registeredAt: firebase.firestore.FieldValue.serverTimestamp(),
      hasVoted: {},
    };
    await db.collection("voters").doc(uid).set(voterData);
    return voterData;
  }

  async function getVoterProfile(uid) {
    const docSnap = await getUserDocWithRetry(uid, "voters");
    return docSnap ? docSnap.data() : null;
  }

  function signOut() {
    return auth.signOut();
  }

  return {
    initRecaptcha,
    sendOTP,
    verifyOTP,
    createVoterProfile,
    getVoterProfile,
    signOut,
  };
})();

const VoterBooth = (() => {
  async function getActivePolls() {
    const today = getISTDateString();
    const snapshot = await db
      .collection("polls")
      .where("startDate", "<=", today)
      .where("endDate", ">=", today)
      .get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async function hasVoterVoted(voterID, pollID) {
    const docId = `${voterID}_${pollID}`;
    const docSnap = await db.collection("votes").doc(docId).get();
    return docSnap.exists;
  }

  async function castVote(voterID, pollID, candidateID) {
    const docId = `${voterID}_${pollID}`;
    const existing = await db.collection("votes").doc(docId).get();
    if (existing.exists) {
      return { success: false, message: "You have already voted in this poll." };
    }

    const batch = db.batch();
    const voteRef = db.collection("votes").doc(docId);
    batch.set(voteRef, {
      voterID,
      pollID,
      candidateID,
      castAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    const pollRef = db.collection("polls").doc(pollID);
    batch.update(pollRef, {
      [`voteCounts.${candidateID}`]: firebase.firestore.FieldValue.increment(1),
      totalVotes: firebase.firestore.FieldValue.increment(1),
    });

    await batch.commit();
    return { success: true, message: "Vote cast successfully." };
  }

  async function getPollResults(pollID) {
    const pollDoc = await db.collection("polls").doc(pollID).get();
    if (!pollDoc.exists) return null;
    const data = pollDoc.data();
    return {
      pollID,
      title: data.title,
      voteCounts: data.voteCounts || {},
      totalVotes: data.totalVotes || 0,
    };
  }

  return { getActivePolls, hasVoterVoted, castVote, getPollResults };
})();

const CandidateAuth = (() => {
  const SESSION_KEY = "dv_candidate";

  async function registerCandidate(name, email, password, party, constituency) {
    const candidateID = generateCandidateID();
    const hashedPassword = obfuscatePassword(password);
    const candidateData = {
      candidateID,
      name,
      email,
      password: hashedPassword,
      party,
      constituency,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      approved: false,
    };
    await db.collection("candidates").doc(candidateID).set(candidateData);
    return candidateData;
  }

  async function loginCandidate(email, password) {
    const snapshot = await db.collection("candidates").where("email", "==", email).get();
    if (snapshot.empty) {
      return { success: false, message: "No account found with this email." };
    }
    const doc = snapshot.docs[0];
    const data = doc.data();
    const decoded = deobfuscatePassword(data.password);
    if (decoded !== password) {
      return { success: false, message: "Incorrect password." };
    }
    if (!data.approved) {
      return { success: false, message: "Your account is pending admin approval." };
    }

    localStorage.setItem(SESSION_KEY, JSON.stringify({ candidateID: data.candidateID, name: data.name, email: data.email }));
    return { success: true, message: "Login successful.", candidate: data };
  }

  function getSession() {
    const raw = localStorage.getItem(SESSION_KEY);
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
  }

  function isLoggedIn() {
    return getSession() !== null;
  }

  return { registerCandidate, loginCandidate, getSession, logout, isLoggedIn };
})();

const CandidateDashboard = (() => {
  async function getMyPolls(candidateID) {
    const snapshot = await db.collection("polls").where("candidateIDs", "array-contains", candidateID).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async function getMyVoteCount(candidateID, pollID) {
    const pollDoc = await db.collection("polls").doc(pollID).get();
    if (!pollDoc.exists) return 0;
    const data = pollDoc.data();
    return (data.voteCounts && data.voteCounts[candidateID]) || 0;
  }

  async function updateManifesto(candidateID, manifestoText) {
    await db.collection("candidates").doc(candidateID).update({
      manifesto: manifestoText,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  return { getMyPolls, getMyVoteCount, updateManifesto };
})();

const AdminAuth = (() => {
  const SESSION_KEY = "dv_admin_session";
  const SUPERADMIN_KEY = "YO!ADMIN";

  async function registerAdmin(name, email, password, superadminKey) {
    if (superadminKey !== SUPERADMIN_KEY) {
      return { success: false, message: "Invalid superadmin key." };
    }
    const adminID = generateAdminID();
    const hashedPassword = await sha256Hash(password);
    const adminData = {
      adminID,
      name,
      email,
      password: hashedPassword,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection("admins").doc(adminID).set(adminData);
    return { success: true, admin: adminData };
  }

  async function loginAdmin(email, password) {
    const snapshot = await db.collection("admins").where("email", "==", email).get();
    if (snapshot.empty) {
      return { success: false, message: "Admin account not found." };
    }
    const doc = snapshot.docs[0];
    const data = doc.data();
    const hashedInput = await sha256Hash(password);
    if (hashedInput !== data.password) {
      return { success: false, message: "Incorrect password." };
    }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ adminID: data.adminID, name: data.name, email: data.email }));
    return { success: true, admin: data };
  }

  function getSession() {
    const raw = sessionStorage.getItem(SESSION_KEY);
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  function isLoggedIn() {
    return getSession() !== null;
  }

  return { registerAdmin, loginAdmin, getSession, logout, isLoggedIn };
})();

const AdminPanel = (() => {
  async function getAllVoters() {
    const snapshot = await db.collection("voters").get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async function getAllCandidates() {
    const snapshot = await db.collection("candidates").get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async function getAllPolls() {
    const snapshot = await db.collection("polls").get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async function approveCandidate(candidateID) {
    await db.collection("candidates").doc(candidateID).update({ approved: true });
  }

  async function rejectCandidate(candidateID) {
    await db.collection("candidates").doc(candidateID).update({ approved: false });
  }

  async function createPoll(title, description, startDate, endDate, candidateIDs) {
    const pollRef = db.collection("polls").doc();
    const voteCounts = {};
    candidateIDs.forEach((id) => (voteCounts[id] = 0));

    const pollData = {
      title,
      description,
      startDate,
      endDate,
      candidateIDs,
      voteCounts,
      totalVotes: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };

    await pollRef.set(pollData);
    return { id: pollRef.id, ...pollData };
  }

  async function deletePoll(pollID) {
    await db.collection("polls").doc(pollID).delete();
  }

  async function updatePollDates(pollID, startDate, endDate) {
    await db.collection("polls").doc(pollID).update({ startDate, endDate });
  }

  async function deleteVoter(voterID) {
    const snapshot = await db.collection("voters").where("voterID", "==", voterID).get();
    const batch = db.batch();
    snapshot.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  async function getPollAnalytics(pollID) {
    const pollDoc = await db.collection("polls").doc(pollID).get();
    if (!pollDoc.exists) return null;
    const data = pollDoc.data();
    const votesSnapshot = await db.collection("votes").where("pollID", "==", pollID).get();
    const timeline = {};
    votesSnapshot.forEach((doc) => {
      const voteData = doc.data();
      if (voteData.castAt) {
        const dateKey = formatDateDDMMYYYY(voteData.castAt.toDate());
        timeline[dateKey] = (timeline[dateKey] || 0) + 1;
      }
    });
    return {
      pollID,
      title: data.title,
      voteCounts: data.voteCounts,
      totalVotes: data.totalVotes,
      timeline,
    };
  }

  return {
    getAllVoters,
    getAllCandidates,
    getAllPolls,
    approveCandidate,
    rejectCandidate,
    createPoll,
    deletePoll,
    updatePollDates,
    deleteVoter,
    getPollAnalytics,
  };
})();

function renderVoterDashboard(voterData, containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  container.innerHTML = `
    <div class="voter-dashboard-card">
      <h3>${voterData.name}</h3>
      <p>Voter ID: ${voterData.voterID}</p>
      <p>Phone: ${voterData.phoneNumber}</p>
    </div>
  `;
}

function renderCandidateCard(candidate, voteCount) {
  return `
    <div class="candidate-card" data-candidate-id="${candidate.candidateID}">
      <h4>${candidate.name}</h4>
      <p>${candidate.party}</p>
      <p>${candidate.constituency}</p>
      <span class="vote-count">${voteCount} votes</span>
      <button class="vote-btn" data-id="${candidate.candidateID}">Vote</button>
    </div>
  `;
}

function renderPollList(polls, containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  container.innerHTML = polls
    .map(
      (poll) => `
      <div class="poll-item" data-poll-id="${poll.id}">
        <h4>${poll.title}</h4>
        <p>${poll.description}</p>
        <p>${formatDateDDMMYYYY(poll.startDate)} - ${formatDateDDMMYYYY(poll.endDate)}</p>
        <p>Total votes: ${poll.totalVotes}</p>
      </div>
    `
    )
    .join("");
}

function renderAdminVoterTable(voters, containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  const rows = voters
    .map(
      (voter) => `
      <tr>
        <td>${voter.voterID}</td>
        <td>${voter.name}</td>
        <td>${voter.phoneNumber}</td>
        <td><button class="delete-voter-btn" data-id="${voter.voterID}">Delete</button></td>
      </tr>
    `
    )
    .join("");
  container.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>Voter ID</th><th>Name</th><th>Phone</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderAdminCandidateTable(candidates, containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  const rows = candidates
    .map(
      (candidate) => `
      <tr>
        <td>${candidate.candidateID}</td>
        <td>${candidate.name}</td>
        <td>${candidate.party}</td>
        <td>${candidate.approved ? "Approved" : "Pending"}</td>
        <td>
          <button class="approve-btn" data-id="${candidate.candidateID}">Approve</button>
          <button class="reject-btn" data-id="${candidate.candidateID}">Reject</button>
        </td>
      </tr>
    `
    )
    .join("");
  container.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>ID</th><th>Name</th><th>Party</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function showVoteConfirmationModal(candidateName) {
  const modal = document.createElement("div");
  modal.className = "vote-confirm-modal";
  modal.innerHTML = `
    <div class="vote-confirm-box">
      <p>Confirm vote for ${candidateName}?</p>
      <button id="confirmVoteYes">Yes</button>
      <button id="confirmVoteNo">No</button>
    </div>
  `;
  document.body.appendChild(modal);
  return new Promise((resolve) => {
    modal.querySelector("#confirmVoteYes").addEventListener("click", () => {
      modal.remove();
      resolve(true);
    });
    modal.querySelector("#confirmVoteNo").addEventListener("click", () => {
      modal.remove();
      resolve(false);
    });
  });
}

function initRoleSelectionCards() {
  document.querySelectorAll("[data-role-card]").forEach((card) => {
    card.addEventListener("click", () => {
      const role = card.getAttribute("data-role-card");
      if (role === "voter") window.location.href = "voter/login.html";
      if (role === "candidate") window.location.href = "candidate/login.html";
      if (role === "admin") window.location.href = "admin/login.html";
    });
  });
}

function initSpinnerOnSubmit(formSelector, buttonSelector) {
  const form = document.querySelector(formSelector);
  const button = document.querySelector(buttonSelector);
  if (!form || !button) return;
  form.addEventListener("submit", () => {
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> Please wait...`;
  });
}

function initBackNavigation(selector, fallbackUrl) {
  const backLink = document.querySelector(selector);
  if (!backLink) return;
  backLink.addEventListener("click", (e) => {
    e.preventDefault();
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = fallbackUrl;
    }
  });
}

function validatePhoneNumber(phone) {
  return /^\+?[1-9]\d{9,14}$/.test(phone.trim());
}

function validateVoterID(voterID) {
  return /^[A-Z]{3}\d{5}$/.test(voterID.trim());
}

function validateCandidateID(candidateID) {
  return /^C\d{4}$/.test(candidateID.trim());
}

function validateAdminID(adminID) {
  return /^AD\d{3}$/.test(adminID.trim());
}

function calculateVoteShare(voteCounts, totalVotes) {
  const shares = {};
  Object.keys(voteCounts).forEach((candidateID) => {
    shares[candidateID] = totalVotes > 0 ? Math.round((voteCounts[candidateID] / totalVotes) * 1000) / 10 : 0;
  });
  return shares;
}

function determineWinner(voteCounts) {
  let winnerID = null;
  let maxVotes = -1;
  Object.entries(voteCounts).forEach(([candidateID, votes]) => {
    if (votes > maxVotes) {
      maxVotes = votes;
      winnerID = candidateID;
    }
  });
  return { winnerID, maxVotes };
}

function exportResultsAsCSV(pollTitle, voteCounts) {
  let csv = "Candidate ID,Votes\n";
  Object.entries(voteCounts).forEach(([candidateID, votes]) => {
    csv += `${candidateID},${votes}\n`;
  });
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${pollTitle.replace(/\s+/g, "_")}_results.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function initLivePollCountdown(pollEndDate, displaySelector) {
  const display = document.querySelector(displaySelector);
  if (!display) return;
  const intervalId = setInterval(() => {
    const now = new Date().getTime();
    const end = new Date(pollEndDate).getTime();
    const distance = end - now;
    if (distance <= 0) {
      display.textContent = "Poll closed";
      clearInterval(intervalId);
      return;
    }
    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);
    display.textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }, 1000);
  return intervalId;
}

function initDuplicateVoteGuard(voterID, pollID, buttonSelector) {
  const button = document.querySelector(buttonSelector);
  if (!button) return;
  VoterBooth.hasVoterVoted(voterID, pollID).then((voted) => {
    if (voted) {
      button.disabled = true;
      button.textContent = "Already Voted";
    }
  });
}

function bindCandidateVoteButtons(voterID, pollID) {
  document.querySelectorAll(".vote-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const candidateID = btn.getAttribute("data-id");
      const candidateName = btn.closest(".candidate-card")?.querySelector("h4")?.textContent || "candidate";
      const confirmed = await showVoteConfirmationModal(candidateName);
      if (!confirmed) return;
      const result = await VoterBooth.castVote(voterID, pollID, candidateID);
      if (result.success) {
        document.querySelectorAll(".vote-btn").forEach((b) => (b.disabled = true));
      }
      alert(result.message);
    });
  });
}

function bindAdminApprovalButtons() {
  document.querySelectorAll(".approve-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      await AdminPanel.approveCandidate(id);
      btn.closest("tr")?.remove();
    });
  });
  document.querySelectorAll(".reject-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      await AdminPanel.rejectCandidate(id);
      btn.closest("tr")?.remove();
    });
  });
}

function bindDeleteVoterButtons() {
  document.querySelectorAll(".delete-voter-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const voterID = btn.getAttribute("data-id");
      await AdminPanel.deleteVoter(voterID);
      btn.closest("tr")?.remove();
    });
  });
}

async function initCreatePollForm(formSelector) {
  const form = document.querySelector(formSelector);
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const candidateIDs = data.candidateIDs.split(",").map((s) => s.trim());
    await AdminPanel.createPoll(data.title, data.description, data.startDate, data.endDate, candidateIDs);
    form.reset();
    alert("Poll created successfully.");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initRoleSelectionCards();
  initSpinnerOnSubmit("#voterLoginForm", "#voterLoginBtn");
  initSpinnerOnSubmit("#candidateLoginForm", "#candidateLoginBtn");
  initSpinnerOnSubmit("#adminLoginForm", "#adminLoginBtn");
  initBackNavigation("[data-back-link]", "index.html");
});

"use strict";
const Cart = (() => {
  const STORAGE_KEY = "site_cart_items";
  function getItems() {
    const raw = localStorage.getItem(STORAGE_KEY);
    try {
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      console.error("Cart parse error:", err);
      return [];
    }
  }
  function saveItems(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    updateCartBadge();
  }
  function addItem(product, quantity = 1) {
    const items = getItems();
    const existing = items.find((item) => item.id === product.id);
    if (existing) {
      existing.quantity += quantity;
    } else {
      items.push({ ...product, quantity });
    }
    saveItems(items);
    return items;
  }
  function removeItem(productId) {
    const items = getItems().filter((item) => item.id !== productId);
    saveItems(items);
    return items;
  }
  function updateQuantity(productId, quantity) {
    const items = getItems();
    const item = items.find((i) => i.id === productId);
    if (item) {
      item.quantity = Math.max(1, Number(quantity));
    }
    saveItems(items);
    return items;
  }
  function clearCart() {
    saveItems([]);
  }
  function getTotal() {
    return getItems().reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
  function getItemCount() {
    return getItems().reduce((sum, item) => sum + item.quantity, 0);
  }
  function updateCartBadge() {
    const badge = document.querySelector("[data-cart-count]");
    if (badge) {
      badge.textContent = String(getItemCount());
    }
  }
  return {
    getItems,
    addItem,
    removeItem,
    updateQuantity,
    clearCart,
    getTotal,
    getItemCount,
    updateCartBadge,
  };
})();
function filterProducts(products, { category = "all", keyword = "" } = {}) {
  const normalizedKeyword = keyword.trim().toLowerCase();
  return products.filter((product) => {
    const matchesCategory =
      category === "all" || product.category.toLowerCase() === category.toLowerCase();
    const matchesKeyword =
      normalizedKeyword === "" || product.name.toLowerCase().includes(normalizedKeyword);
    return matchesCategory && matchesKeyword;
  });
}
function sortProducts(products, sortBy) {
  const sorted = [...products];
  switch (sortBy) {
    case "price-asc":
      return sorted.sort((a, b) => a.price - b.price);
    case "price-desc":
      return sorted.sort((a, b) => b.price - a.price);
    case "name-asc":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "name-desc":
      return sorted.sort((a, b) => b.name.localeCompare(a.name));
    default:
      return sorted;
  }
}
function renderProductGrid(products, containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  if (products.length === 0) {
    container.innerHTML = `<p class="text-center text-muted">No items found.</p>`;
    return;
  }
  container.innerHTML = products
    .map(
      (product) => `
      <div class="col-md-4 col-sm-6 mb-4 product-card" data-id="${product.id}">
        <div class="card h-100 shadow-sm">
          <img data-src="${product.image}" class="card-img-top lazy-img" alt="${product.name}">
          <div class="card-body">
            <h5 class="card-title">${product.name}</h5>
            <p class="card-text">₹${product.price.toFixed(2)}</p>
            <button class="btn btn-outline-danger btn-sm wishlist-btn" data-id="${product.id}">♥</button>
            <button class="btn btn-primary btn-sm add-to-cart-btn" data-id="${product.id}">
              Add to Cart
            </button>
          </div>
        </div>
      </div>`
    )
    .join("");
  initLazyLoad(".lazy-img");
}
const Validator = (() => {
  function isEmpty(value) {
    return !value || value.trim().length === 0;
  }
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
  function isValidPhone(phone) {
    return /^[0-9]{10}$/.test(phone.trim());
  }
  function isFutureDate(dateStr) {
    const inputDate = new Date(dateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return inputDate >= today;
  }
  function isPositiveInteger(value) {
    const num = Number(value);
    return Number.isInteger(num) && num > 0;
  }
  function validateBookingForm(formData) {
    const errors = {};
    if (isEmpty(formData.name)) errors.name = "Name is required.";
    if (!isValidEmail(formData.email)) errors.email = "Enter a valid email address.";
    if (!isValidPhone(formData.phone)) errors.phone = "Enter a valid 10-digit phone number.";
    if (isEmpty(formData.date) || !isFutureDate(formData.date)) {
      errors.date = "Please select a valid future date.";
    }
    if (!isPositiveInteger(formData.visitors)) {
      errors.visitors = "Number of visitors must be a positive number.";
    }
    return { isValid: Object.keys(errors).length === 0, errors };
  }
  function showErrors(errors) {
    document.querySelectorAll(".error-message").forEach((el) => (el.textContent = ""));
    Object.entries(errors).forEach(([field, message]) => {
      const el = document.querySelector(`[data-error-for="${field}"]`);
      if (el) el.textContent = message;
    });
  }
  return { validateBookingForm, showErrors, isValidEmail, isValidPhone, isFutureDate };
})();
function initVisitorCounter(counterSelector, pricePerTicket) {
  const container = document.querySelector(counterSelector);
  if (!container) return;
  const decrementBtn = container.querySelector("[data-action='decrement']");
  const incrementBtn = container.querySelector("[data-action='increment']");
  const countDisplay = container.querySelector("[data-visitor-count]");
  const totalDisplay = container.querySelector("[data-total-price]");
  let count = 1;
  function render() {
    if (countDisplay) countDisplay.textContent = String(count);
    if (totalDisplay) totalDisplay.textContent = `₹${(count * pricePerTicket).toFixed(2)}`;
  }
  decrementBtn?.addEventListener("click", () => {
    count = Math.max(1, count - 1);
    render();
  });
  incrementBtn?.addEventListener("click", () => {
    count += 1;
    render();
  });
  render();
}
function debounce(fn, delay = 300) {
  let timeoutId;
  return function debounced(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}
function throttle(fn, limit = 300) {
  let waiting = false;
  return function throttled(...args) {
    if (!waiting) {
      fn.apply(this, args);
      waiting = true;
      setTimeout(() => (waiting = false), limit);
    }
  };
}
function delegateEvent(parentSelector, eventType, childSelector, handler) {
  const parent = document.querySelector(parentSelector);
  if (!parent) return;
  parent.addEventListener(eventType, (event) => {
    const target = event.target.closest(childSelector);
    if (target && parent.contains(target)) {
      handler(event, target);
    }
  });
}
const Wishlist = (() => {
  const STORAGE_KEY = "site_wishlist_items";
  function getItems() {
    const raw = localStorage.getItem(STORAGE_KEY);
    try {
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function save(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    updateBadge();
  }
  function toggle(product) {
    const items = getItems();
    const index = items.findIndex((p) => p.id === product.id);
    let added;
    if (index >= 0) {
      items.splice(index, 1);
      added = false;
    } else {
      items.push(product);
      added = true;
    }
    save(items);
    return added;
  }
  function isWishlisted(productId) {
    return getItems().some((p) => p.id === productId);
  }
  function updateBadge() {
    const badge = document.querySelector("[data-wishlist-count]");
    if (badge) badge.textContent = String(getItems().length);
  }
  return { getItems, toggle, isWishlisted, updateBadge };
})();
class Paginator {
  constructor(items, pageSize = 6) {
    this.items = items;
    this.pageSize = pageSize;
    this.currentPage = 1;
  }
  get totalPages() {
    return Math.max(1, Math.ceil(this.items.length / this.pageSize));
  }
  getPage(page) {
    this.currentPage = Math.min(Math.max(1, page), this.totalPages);
    const start = (this.currentPage - 1) * this.pageSize;
    return this.items.slice(start, start + this.pageSize);
  }
  next() {
    return this.getPage(this.currentPage + 1);
  }
  prev() {
    return this.getPage(this.currentPage - 1);
  }
  getCurrentPage() {
    return this.currentPage;
  }
  updateItems(items) {
    this.items = items;
    this.currentPage = 1;
  }
  renderControls(containerSelector, onPageChange) {
    const container = document.querySelector(containerSelector);
    if (!container) return;
    const buttons = [];
    for (let i = 1; i <= this.totalPages; i++) {
      buttons.push(
        `<button class="btn btn-sm ${i === this.currentPage ? "btn-primary" : "btn-outline-secondary"} page-btn" data-page="${i}">${i}</button>`
      );
    }
    container.innerHTML = buttons.join(" ");
    container.querySelectorAll(".page-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const page = Number(btn.getAttribute("data-page"));
        onPageChange(page);
        this.renderControls(containerSelector, onPageChange);
      });
    });
  }
}
const Reviews = (() => {
  const STORAGE_KEY = "site_product_reviews";
  function getAll() {
    const raw = localStorage.getItem(STORAGE_KEY);
    try {
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function getForProduct(productId) {
    return getAll().filter((r) => r.productId === productId);
  }
  function addReview(review) {
    const newReview = {
      ...review,
      id: `rev_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      date: new Date().toISOString().split("T")[0],
    };
    const all = getAll();
    all.push(newReview);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    return newReview;
  }
  function getAverageRating(productId) {
    const reviews = getForProduct(productId);
    if (reviews.length === 0) return 0;
    const total = reviews.reduce((sum, r) => sum + r.rating, 0);
    return Math.round((total / reviews.length) * 10) / 10;
  }
  function renderStars(rating) {
    const fullStars = Math.floor(rating);
    const hasHalf = rating - fullStars >= 0.5;
    let html = "";
    for (let i = 0; i < fullStars; i++) html += "★";
    if (hasHalf) html += "☆";
    const empty = 5 - fullStars - (hasHalf ? 1 : 0);
    for (let i = 0; i < empty; i++) html += "✩";
    return html;
  }
  return { getAll, getForProduct, addReview, getAverageRating, renderStars };
})();
const CouponEngine = (() => {
  const AVAILABLE_COUPONS = [
    { code: "SAVE10", type: "percent", value: 10, minOrderValue: 500 },
    { code: "FLAT50", type: "flat", value: 50, minOrderValue: 300 },
    { code: "WELCOME20", type: "percent", value: 20, minOrderValue: 1000, expiry: "2026-12-31" },
  ];
  function isExpired(coupon) {
    if (!coupon.expiry) return false;
    return new Date(coupon.expiry) < new Date();
  }
  function applyCoupon(code, orderTotal) {
    const coupon = AVAILABLE_COUPONS.find((c) => c.code.toLowerCase() === code.trim().toLowerCase());
    if (!coupon) {
      return { valid: false, message: "Invalid coupon code.", discountAmount: 0 };
    }
    if (isExpired(coupon)) {
      return { valid: false, message: "This coupon has expired.", discountAmount: 0 };
    }
    if (coupon.minOrderValue && orderTotal < coupon.minOrderValue) {
      return {
        valid: false,
        message: `Minimum order value of ₹${coupon.minOrderValue} required.`,
        discountAmount: 0,
      };
    }
    const discountAmount =
      coupon.type === "percent" ? (orderTotal * coupon.value) / 100 : coupon.value;
    return {
      valid: true,
      message: `Coupon applied! You saved ₹${discountAmount.toFixed(2)}.`,
      discountAmount,
    };
  }
  return { applyCoupon, AVAILABLE_COUPONS };
})();
const Toast = (() => {
  let container = null;
  function ensureContainer() {
    if (container) return container;
    container = document.createElement("div");
    container.setAttribute("data-toast-container", "");
    container.style.position = "fixed";
    container.style.bottom = "20px";
    container.style.right = "20px";
    container.style.zIndex = "9999";
    document.body.appendChild(container);
    return container;
  }
  function colorFor(type) {
    switch (type) {
      case "success":
        return "#198754";
      case "error":
        return "#dc3545";
      case "warning":
        return "#ffc107";
      default:
        return "#0dcaf0";
    }
  }
  function show(message, type = "info", duration = 3000) {
    const root = ensureContainer();
    const toast = document.createElement("div");
    toast.textContent = message;
    toast.style.background = colorFor(type);
    toast.style.color = "#fff";
    toast.style.padding = "10px 16px";
    toast.style.marginTop = "8px";
    toast.style.borderRadius = "6px";
    toast.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s ease";
    root.appendChild(toast);
    requestAnimationFrame(() => (toast.style.opacity = "1"));
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
  return { show };
})();
const ModalManager = (() => {
  function open(modalSelector) {
    const modal = document.querySelector(modalSelector);
    if (!modal) return;
    modal.classList.add("show");
    modal.style.display = "block";
    document.body.classList.add("modal-open");
  }
  function close(modalSelector) {
    const modal = document.querySelector(modalSelector);
    if (!modal) return;
    modal.classList.remove("show");
    modal.style.display = "none";
    document.body.classList.remove("modal-open");
  }
  function bindCloseTriggers(modalSelector, closeTriggerSelector) {
    document.querySelectorAll(closeTriggerSelector).forEach((trigger) => {
      trigger.addEventListener("click", () => close(modalSelector));
    });
  }
  return { open, close, bindCloseTriggers };
})();
function initLazyLoad(imageSelector) {
  const images = document.querySelectorAll(imageSelector);
  if (images.length === 0) return;
  if (!("IntersectionObserver" in window)) {
    images.forEach((img) => {
      const src = img.getAttribute("data-src");
      if (src) img.src = src;
    });
    return;
  }
  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const img = entry.target;
          const src = img.getAttribute("data-src");
          if (src) img.src = src;
          img.classList.add("loaded");
          obs.unobserve(img);
        }
      });
    },
    { rootMargin: "50px" }
  );
  images.forEach((img) => observer.observe(img));
}
const Auth = (() => {
  const USERS_KEY = "site_users";
  const SESSION_KEY = "site_session";
  function simpleHash(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      hash = (hash << 5) - hash + value.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }
  function getUsers() {
    const raw = localStorage.getItem(USERS_KEY);
    try {
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function register(name, email, password) {
    const users = getUsers();
    if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
      return { success: false, message: "An account with this email already exists." };
    }
    users.push({ name, email, passwordHash: simpleHash(password) });
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
    return { success: true, message: "Registration successful. Please log in." };
  }
  function login(email, password) {
    const users = getUsers();
    const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (!user || user.passwordHash !== simpleHash(password)) {
      return { success: false, message: "Invalid email or password." };
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({ email: user.email, name: user.name }));
    return { success: true, message: `Welcome back, ${user.name}!` };
  }
  function logout() {
    localStorage.removeItem(SESSION_KEY);
  }
  function getCurrentUser() {
    const raw = localStorage.getItem(SESSION_KEY);
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function isLoggedIn() {
    return getCurrentUser() !== null;
  }
  return { register, login, logout, getCurrentUser, isLoggedIn };
})();
const OrderHistory = (() => {
  const STORAGE_KEY = "site_order_history";
  function getAll() {
    const raw = localStorage.getItem(STORAGE_KEY);
    try {
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function placeOrder(items) {
    const order = {
      id: `ORD${Date.now()}`,
      items,
      total: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
      placedAt: new Date().toISOString(),
      status: "pending",
    };
    const all = getAll();
    all.unshift(order);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    return order;
  }
  function updateStatus(orderId, status) {
    const all = getAll();
    const order = all.find((o) => o.id === orderId);
    if (order) order.status = status;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }
  function renderHistory(containerSelector) {
    const container = document.querySelector(containerSelector);
    if (!container) return;
    const orders = getAll();
    if (orders.length === 0) {
      container.innerHTML = `<p class="text-muted">No orders placed yet.</p>`;
      return;
    }
    container.innerHTML = orders
      .map(
        (order) => `
        <div class="card mb-3 p-3">
          <div class="d-flex justify-content-between">
            <strong>${order.id}</strong>
            <span class="badge bg-secondary">${order.status}</span>
          </div>
          <small class="text-muted">${new Date(order.placedAt).toLocaleString()}</small>
          <p class="mb-0">Total: ₹${order.total.toFixed(2)} • ${order.items.length} item(s)</p>
        </div>`
      )
      .join("");
  }
  return { getAll, placeOrder, updateStatus, renderHistory };
})();
document.addEventListener("DOMContentLoaded", () => {
  Cart.updateCartBadge();
  Wishlist.updateBadge();
  initLazyLoad(".lazy-img");
  const searchInput = document.querySelector("[data-search-input]");
  const categoryFilter = document.querySelector("[data-category-filter]");
  const sortSelect = document.querySelector("[data-sort-select]");
  function refreshGrid() {
    if (!window.PRODUCTS) return;
    let result = filterProducts(window.PRODUCTS, {
      keyword: searchInput?.value ?? "",
      category: categoryFilter?.value ?? "all",
    });
    if (sortSelect?.value) {
      result = sortProducts(result, sortSelect.value);
    }
    renderProductGrid(result, "[data-product-grid]");
  }
  searchInput?.addEventListener("input", debounce(refreshGrid, 250));
  categoryFilter?.addEventListener("change", refreshGrid);
  sortSelect?.addEventListener("change", refreshGrid);
  delegateEvent("[data-product-grid]", "click", ".add-to-cart-btn", (_event, target) => {
    const id = target.getAttribute("data-id");
    const product = window.PRODUCTS?.find((p) => p.id === id);
    if (product) {
      Cart.addItem(product);
      Toast.show(`${product.name} added to cart`, "success");
      target.textContent = "Added ✓";
      setTimeout(() => (target.textContent = "Add to Cart"), 1000);
    }
  });
  delegateEvent("[data-product-grid]", "click", ".wishlist-btn", (_event, target) => {
    const id = target.getAttribute("data-id");
    const product = window.PRODUCTS?.find((p) => p.id === id);
    if (product) {
      const added = Wishlist.toggle(product);
      Toast.show(added ? "Added to wishlist" : "Removed from wishlist", "info");
    }
  });
  const couponForm = document.querySelector("#couponForm");
  if (couponForm) {
    couponForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = couponForm.querySelector("[name='coupon']");
      if (!input) return;
      const result = CouponEngine.applyCoupon(input.value, Cart.getTotal());
      Toast.show(result.message, result.valid ? "success" : "error");
    });
  }
  const bookingForm = document.querySelector("#bookingForm");
  if (bookingForm) {
    bookingForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const formData = Object.fromEntries(new FormData(bookingForm).entries());
      const { isValid, errors } = Validator.validateBookingForm(formData);
      Validator.showErrors(errors);
      if (isValid) {
        Toast.show("Booking confirmed! Thank you.", "success");
        bookingForm.reset();
      }
    });
  }
  const reviewForm = document.querySelector("#reviewForm");
  if (reviewForm) {
    reviewForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(reviewForm).entries());
      Reviews.addReview({
        productId: data.productId,
        author: data.author,
        rating: Number(data.rating),
        comment: data.comment,
      });
      Toast.show("Review submitted!", "success");
      reviewForm.reset();
    });
  }
  const loginForm = document.querySelector("#loginForm");
  loginForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(loginForm).entries());
    const result = Auth.login(data.email, data.password);
    Toast.show(result.message, result.success ? "success" : "error");
  });
  const registerForm = document.querySelector("#registerForm");
  registerForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(registerForm).entries());
    const result = Auth.register(data.name, data.email, data.password);
    Toast.show(result.message, result.success ? "success" : "error");
  });
  const checkoutBtn = document.querySelector("[data-checkout-btn]");
  checkoutBtn?.addEventListener("click", () => {
    const items = Cart.getItems();
    if (items.length === 0) {
      Toast.show("Your cart is empty.", "warning");
      return;
    }
    const order = OrderHistory.placeOrder(items);
    Cart.clearCart();
    Toast.show(`Order ${order.id} placed successfully!`, "success");
    OrderHistory.renderHistory("[data-order-history]");
  });
  ModalManager.bindCloseTriggers("[data-modal]", "[data-modal-close]");
  document.querySelectorAll("[data-modal-open]").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const target = trigger.getAttribute("data-modal-open");
      if (target) ModalManager.open(target);
    });
  });
  initVisitorCounter("[data-visitor-counter]", 250);
  OrderHistory.renderHistory("[data-order-history]");
});
