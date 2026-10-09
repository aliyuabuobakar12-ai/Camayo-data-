const API = "/api";

const authPage = document.getElementById("authPage");
const appPage = document.getElementById("appPage");
const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const loginTab = document.getElementById("loginTab");
const registerTab = document.getElementById("registerTab");
const authMessage = document.getElementById("authMessage");

const tokenKey = "camayo_token";
let token = localStorage.getItem(tokenKey);
let currentUser = null;

function setMessage(el, text, ok=false) {
  el.textContent = text || "";
  el.style.color = ok ? "#067647" : "#b42318";
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function api(path, options={}) {
  const response = await fetch(API + path, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "An samu matsala.");
  return data;
}

function showAuth() {
  authPage.classList.remove("hidden");
  appPage.classList.add("hidden");
}

function showApp() {
  authPage.classList.add("hidden");
  appPage.classList.remove("hidden");
}

function showLogin() {
  loginForm.classList.remove("hidden");
  registerForm.classList.add("hidden");
  loginTab.classList.add("active");
  registerTab.classList.remove("active");
  setMessage(authMessage, "");
}

function showRegister() {
  registerForm.classList.remove("hidden");
  loginForm.classList.add("hidden");
  registerTab.classList.add("active");
  loginTab.classList.remove("active");
  setMessage(authMessage, "");
}

loginTab.addEventListener("click", showLogin);
registerTab.addEventListener("click", showRegister);

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMessage(authMessage, "Ana shiga...");
  try {
    const data = await api("/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.getElementById("loginEmail").value.trim(),
        password: document.getElementById("loginPassword").value
      })
    });
    token = data.token;
    localStorage.setItem(tokenKey, token);
    await startApp();
  } catch (err) {
    setMessage(authMessage, err.message);
  }
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMessage(authMessage, "Ana yin register...");
  try {
    const data = await api("/register", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("registerName").value.trim(),
        email: document.getElementById("registerEmail").value.trim(),
        password: document.getElementById("registerPassword").value
      })
    });
    token = data.token;
    localStorage.setItem(tokenKey, token);
    await startApp();
  } catch (err) {
    setMessage(authMessage, err.message);
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  token = null;
  currentUser = null;
  localStorage.removeItem(tokenKey);
  showAuth();
  showLogin();
});

function openPage(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  if (id === "historyPage") loadHistory();
}

document.querySelectorAll("[data-page]").forEach(btn => {
  btn.addEventListener("click", () => openPage(btn.dataset.page));
});

document.getElementById("fundBtn").addEventListener("click", () => {
  document.getElementById("fundModal").classList.remove("hidden");
});
document.getElementById("closeFund").addEventListener("click", () => {
  document.getElementById("fundModal").classList.add("hidden");
});

document.getElementById("fundForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById("fundAmount").value);
  const msg = document.getElementById("fundMessage");
  const btn = document.getElementById("fundSubmit");
  if (!Number.isFinite(amount) || amount < 100) {
    setMessage(msg, "Mafi ƙarancin kuɗin saka wa wallet shi ne ₦100.");
    return;
  }
  btn.disabled = true;
  setMessage(msg, "Ana buɗe Paystack...", true);
  try {
    const data = await api("/wallet/initialize", {
      method: "POST",
      body: JSON.stringify({amount})
    });
    window.location.href = data.authorization_url;
  } catch (err) {
    setMessage(msg, err.message);
    btn.disabled = false;
  }
});

async function handlePaymentCallback() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("payment") !== "callback" || !params.get("reference")) return;
  const reference = params.get("reference");
  try {
    const data = await api(`/wallet/verify/${encodeURIComponent(reference)}`);
    await loadMe();
    alert(data.credited ? "An ƙara kuɗin wallet cikin nasara." : "Payment bai tabbatar ba tukuna.");
  } catch (err) {
    alert(err.message);
  } finally {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

async function loadMe() {
  const data = await api("/me");
  currentUser = data.user;
  document.getElementById("userName").textContent = currentUser.email;
  document.getElementById("homeName").textContent = currentUser.name;
  document.getElementById("balance").textContent =
    `₦${Number(currentUser.balance).toLocaleString("en-NG", {minimumFractionDigits:2})}`;
}

const networkEl = document.getElementById("network");
const planEl = document.getElementById("plan");
const planInfo = document.getElementById("planInfo");

networkEl.addEventListener("change", async () => {
  const network = networkEl.value;
  planEl.innerHTML = '<option value="">Ana loda plans...</option>';
  planEl.disabled = true;
  planInfo.textContent = "";
  if (!network) return;

  try {
    const data = await api(`/plans?network=${encodeURIComponent(network)}`);
    planEl.innerHTML = '<option value="">Zaɓi plan</option>';
    for (const plan of data.plans || []) {
      const option = document.createElement("option");
      option.value = plan.code;
      option.textContent = `${plan.name} - ₦${Number(plan.amount).toLocaleString("en-NG")}`;
      option.dataset.amount = plan.amount;
      option.dataset.name = plan.name;
      planEl.appendChild(option);
    }
    planEl.disabled = false;
  } catch (err) {
    planEl.innerHTML = '<option value="">An kasa ɗauko plans</option>';
    setMessage(document.getElementById("buyMessage"), err.message);
  }
});

planEl.addEventListener("change", () => {
  const selected = planEl.options[planEl.selectedIndex];
  planInfo.textContent = selected?.dataset?.amount
    ? `Farashi: ₦${Number(selected.dataset.amount).toLocaleString("en-NG")}`
    : "";
});

document.getElementById("buyBtn").addEventListener("click", async () => {
  const phone = document.getElementById("phone").value.trim();
  const network = networkEl.value;
  const plan = planEl.value;
  const message = document.getElementById("buyMessage");
  const btn = document.getElementById("buyBtn");

  if (!network || !plan || !/^0\d{10}$/.test(phone)) {
    setMessage(message, "Zaɓi network/plan kuma saka lambar waya mai inganci.");
    return;
  }

  btn.disabled = true;
  setMessage(message, "Ana sarrafa sayen data...", true);

  try {
    const data = await api("/buy", {
      method: "POST",
      body: JSON.stringify({ network, phone, plan })
    });
    setMessage(message, data.message || "An kammala.", true);
    await loadMe();
    await loadHistory();
  } catch (err) {
    setMessage(message, err.message);
  } finally {
    btn.disabled = false;
  }
});

async function loadHistory() {
  const box = document.getElementById("historyList");
  box.innerHTML = "Ana loda tarihi...";
  try {
    const data = await api("/history");
    if (!data.transactions?.length) {
      box.innerHTML = '<p class="muted">Babu transaction tukuna.</p>';
      return;
    }
    box.innerHTML = "";
    data.transactions.forEach(tx => {
      const div = document.createElement("div");
      div.className = "history-item";
      const statusClass = tx.status === "success" ? "status-success" : "status-failed";
      div.innerHTML = `
        <strong>${tx.network} — ${tx.plan || "Data"}</strong>
        <p>${tx.phone || ""}</p>
        <p>₦${Number(tx.amount || 0).toLocaleString("en-NG")}</p>
        <small class="${statusClass}">${tx.status}</small>
      `;
      box.appendChild(div);
    });
  } catch (err) {
    box.innerHTML = `<p class="message">${err.message}</p>`;
  }
}

async function startApp() {
  try {
    await loadMe();
    showApp();
    openPage("homePage");
    await handlePaymentCallback();
  } catch (err) {
    localStorage.removeItem(tokenKey);
    token = null;
    showAuth();
    setMessage(authMessage, "Session ta ƙare. Sake shiga.");
  }
}

if (token) startApp();
else showAuth();
