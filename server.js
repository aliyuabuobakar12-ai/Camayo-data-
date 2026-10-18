require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("JWT_SECRET is required and must be at least 32 characters.");
  process.exit(1);
}
const VTPASS_BASE_URL = process.env.VTPASS_BASE_URL || "https://vtpass.com/api";
const VTPASS_API_KEY = process.env.VTPASS_API_KEY || "";
const VTPASS_PUBLIC_KEY = process.env.VTPASS_PUBLIC_KEY || "";
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.static(path.join(__dirname)));

const db = new Database(process.env.DB_PATH || path.join(__dirname, "camayo.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wallet_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  credited_at TEXT,
  provider_response TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  request_id TEXT,
  type TEXT NOT NULL,
  network TEXT,
  phone TEXT,
  plan TEXT,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  provider_response TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({message:"Ba ka shiga ba."});
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({message:"Session bai inganta ba."});
  }
}

function signUser(user) {
  return jwt.sign({id:user.id, email:user.email}, JWT_SECRET, {expiresIn:"7d"});
}

app.post("/api/register", async (req,res)=>{
  try {
    const {name,email,password} = req.body;
    if (!name || !email || !password || password.length < 6)
      return res.status(400).json({message:"Cika suna, email, da password (aƙalla 6)."});
    const normalized = email.trim().toLowerCase();
    const exists = db.prepare("SELECT id FROM users WHERE email=?").get(normalized);
    if (exists) return res.status(409).json({message:"Wannan email yana da account."});
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare("INSERT INTO users(name,email,password_hash,balance) VALUES(?,?,?,0)")
      .run(name.trim(), normalized, hash);
    const user = db.prepare("SELECT id,name,email,balance FROM users WHERE id=?").get(result.lastInsertRowid);
    res.json({token:signUser(user), user});
  } catch (e) {
    res.status(500).json({message:"An samu matsala wajen register."});
  }
});

app.post("/api/login", async (req,res)=>{
  try {
    const {email,password} = req.body;
    const user = db.prepare("SELECT * FROM users WHERE email=?").get((email||"").trim().toLowerCase());
    if (!user || !(await bcrypt.compare(password||"", user.password_hash)))
      return res.status(401).json({message:"Email ko password ba daidai ba."});
    res.json({token:signUser(user), user:{id:user.id,name:user.name,email:user.email,balance:user.balance}});
  } catch {
    res.status(500).json({message:"An samu matsala wajen login."});
  }
});

app.get("/api/me", auth, (req,res)=>{
  const user = db.prepare("SELECT id,name,email,balance FROM users WHERE id=?").get(req.user.id);
  if (!user) return res.status(404).json({message:"User bai samu ba."});
  res.json({user});
});


function paystackHeaders() {
  return {
    "Authorization": `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
  };
}

async function paystackRequest(endpoint, options={}) {
  const response = await fetch(`https://api.paystack.co${endpoint}`, {
    ...options,
    headers: { ...paystackHeaders(), ...(options.headers || {}) }
  });
  return await response.json();
}

function creditWalletFromDeposit(reference, providerResponse) {
  const deposit = db.prepare("SELECT * FROM wallet_deposits WHERE reference=?").get(reference);
  if (!deposit || deposit.status === "success") return {credited:false, deposit};

  const verifyData = providerResponse?.data || providerResponse;
  const status = verifyData?.status;
  const paidAmount = Number(verifyData?.amount || 0) / 100;

  if (status !== "success" || Math.round(paidAmount * 100) !== Math.round(Number(deposit.amount) * 100)) {
    db.prepare("UPDATE wallet_deposits SET status=?, provider_response=? WHERE reference=?")
      .run(status || "failed", JSON.stringify(providerResponse), reference);
    return {credited:false, deposit};
  }

  const credit = db.transaction(() => {
    const current = db.prepare("SELECT balance FROM users WHERE id=?").get(deposit.user_id);
    if (!current) throw new Error("User not found");

    db.prepare("UPDATE users SET balance=balance+? WHERE id=?")
      .run(deposit.amount, deposit.user_id);

    db.prepare(`
      UPDATE wallet_deposits
      SET status='success', credited_at=CURRENT_TIMESTAMP, provider_response=?
      WHERE reference=?
    `).run(JSON.stringify(providerResponse), reference);

    db.prepare(`
      INSERT INTO transactions
      (user_id,request_id,type,network,phone,plan,amount,status,provider_response)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run(
      deposit.user_id, reference, "wallet_funding", null, null, "Paystack",
      deposit.amount, "success", JSON.stringify(providerResponse)
    );
  });

  credit();
  return {credited:true};
}

app.post("/api/wallet/initialize", auth, async (req,res)=>{
  try {
    if (!PAYSTACK_SECRET_KEY)
      return res.status(503).json({message:"PAYSTACK_SECRET_KEY ba a cikin .env ba."});

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 100 || amount > 1000000)
      return res.status(400).json({message:"Saka kuɗi tsakanin ₦100 da ₦1,000,000."});

    const user = db.prepare("SELECT id,email FROM users WHERE id=?").get(req.user.id);
    if (!user) return res.status(404).json({message:"User bai samu ba."});

    const reference = `CAMAYO_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    const result = await paystackRequest("/transaction/initialize", {
      method:"POST",
      body:JSON.stringify({
        email:user.email,
        amount:Math.round(amount * 100),
        currency:"NGN",
        reference,
        callback_url:`${APP_URL}/?payment=callback&reference=${encodeURIComponent(reference)}`,
        metadata: JSON.stringify({user_id:user.id, purpose:"wallet_funding"})
      })
    });

    if (!result.status || !result.data?.authorization_url)
      return res.status(502).json({message:result.message || "Paystack bai fara payment ba."});

    db.prepare(`
      INSERT INTO wallet_deposits(user_id,reference,amount,status,provider_response)
      VALUES(?,?,?,?,?)
    `).run(user.id, reference, amount, "pending", JSON.stringify(result));

    res.json({
      authorization_url: result.data.authorization_url,
      reference: result.data.reference
    });
  } catch {
    res.status(500).json({message:"An samu matsala wajen fara payment."});
  }
});

app.get("/api/wallet/verify/:reference", auth, async (req,res)=>{
  try {
    if (!PAYSTACK_SECRET_KEY)
      return res.status(503).json({message:"PAYSTACK_SECRET_KEY ba a cikin .env ba."});

    const reference = req.params.reference;
    const deposit = db.prepare("SELECT * FROM wallet_deposits WHERE reference=? AND user_id=?")
      .get(reference, req.user.id);
    if (!deposit) return res.status(404).json({message:"Payment reference bai samu ba."});

    const result = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, {
      method:"GET"
    });

    const credited = creditWalletFromDeposit(reference, result);
    const user = db.prepare("SELECT balance FROM users WHERE id=?").get(req.user.id);

    res.json({
      status: result?.data?.status || "unknown",
      credited: credited.credited,
      balance: user?.balance ?? 0,
      message: credited.credited ? "An ƙara kuɗin wallet." : "Ba a tabbatar da payment ba tukuna."
    });
  } catch {
    res.status(500).json({message:"An kasa tabbatar da payment."});
  }
});

/* Paystack webhook: verify HMAC SHA512 before processing. */
app.post("/api/paystack/webhook", (req,res)=>{
  try {
    const signature = req.headers["x-paystack-signature"];
    const expected = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
      .digest("hex");

    if (!signature || signature !== expected) return res.sendStatus(401);

    // Acknowledge quickly. Paystack can retry webhook events if it doesn't get 200.
    res.sendStatus(200);

    if (req.body?.event === "charge.success" && req.body?.data?.reference) {
      try {
        creditWalletFromDeposit(req.body.data.reference, req.body);
      } catch (e) {
        console.error("Webhook credit error:", e.message);
      }
    }
  } catch {
    res.sendStatus(400);
  }
});

const SERVICE_MAP = {
  "MTN":"mtn-data",
  "Airtel":"airtel-data",
  "Glo":"glo-data",
  "9mobile":"etisalat-data"
};

async function vtpass(pathname, body = null) {
  const isGet = pathname === "/service-variations";

  const headers = {
    "api-key": VTPASS_API_KEY,
    "public-key": VTPASS_PUBLIC_KEY
  };

  const options = {
    method: isGet ? "GET" : "POST",
    headers
  };

  if (!isGet) {
    headers["Content-Type"] = "application/json";
    headers["secret-key"] = process.env.VTPASS_SECRET_KEY || "";

    options.body = JSON.stringify(body || {});
  }

  const response = await fetch(
    VTPASS_BASE_URL + pathname +
      (isGet && body?.serviceID
        ? "?serviceID=" + encodeURIComponent(body.serviceID)
        : ""),
    options
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error("VTpass HTTP error: " + response.status);
  }

  return data;
}


app.get("/api/plans", auth, async (req,res)=>{
  const network = req.query.network;
  const serviceID = SERVICE_MAP[network];
  if (!serviceID) return res.status(400).json({message:"Network ba a gane ba."});
  if (!VTPASS_API_KEY || !VTPASS_PUBLIC_KEY)
    return res.status(503).json({message:"Sanya VTpass API keys a .env kafin amfani da real plans."});

  try {
    const data = await vtpass("/service-variations", {serviceID});
    const content = data.content?.variations || [];
    const plans = content.map(v => ({
      code:v.variation_code,
      name:v.name,
      amount:Number(v.variation_amount)
    }));
    res.json({plans});
  } catch {
    res.status(502).json({message:"An kasa haɗuwa da VTpass."});
  }
});

app.post("/api/buy", auth, async (req,res)=>{
  const {network,phone,plan} = req.body;
  const serviceID = SERVICE_MAP[network];
  if (!serviceID || !/^0\d{10}$/.test(phone) || !plan)
    return res.status(400).json({message:"Bayani bai cika ba."});
  if (!VTPASS_API_KEY || !VTPASS_PUBLIC_KEY)
    return res.status(503).json({message:"VTpass API keys ba su cikin .env."});

  const request_id = "CAMAYO_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex");
  try {
    const variation = await vtpass("/service-variations", {serviceID});
    const found = (variation.content?.variations || []).find(v=>v.variation_code===plan);
    if (!found) return res.status(400).json({message:"Plan bai samu ba."});
    const amount = Number(found.variation_amount);

    const user = db.prepare("SELECT id,balance FROM users WHERE id=?").get(req.user.id);
    if (!user || user.balance < amount)
      return res.status(400).json({message:"Wallet balance bai isa ba."});

    const deduct = db.prepare("UPDATE users SET balance=balance-? WHERE id=?");
    deduct.run(amount, req.user.id);

    let result;
    try {
      result = await vtpass("/pay", {
        request_id,
        serviceID,
        billersCode: phone,
        variation_code: plan,
        amount,
        phone
      });
    } catch {
      db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(amount, req.user.id);
      return res.status(502).json({message:"VTpass bai amsa ba; an mayar da kuɗin wallet."});
    }

    const code = result?.code;
    const success = code === "000" || code === "099";
    db.prepare(`INSERT INTO transactions
      (user_id,request_id,type,network,phone,plan,amount,status,provider_response)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(req.user.id,request_id,"data",network,phone,plan,amount,success?"success":"failed",JSON.stringify(result));

    if (!success) {
      db.prepare("UPDATE users SET balance=balance+? WHERE id=?").run(amount, req.user.id);
      return res.status(400).json({message:result?.response_description || "Siyan data bai yi nasara ba.", provider:result});
    }

    res.json({message:"An sayi data cikin nasara.", request_id, provider:result});
  } catch {
    res.status(500).json({message:"An samu matsala wajen sayen data."});
  }
});

app.get("/api/history", auth, (req,res)=>{
  const transactions = db.prepare(`
    SELECT id,request_id,type,network,phone,plan,amount,status,created_at
    FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 100
  `).all(req.user.id);
  res.json({transactions});
});

app.get("/api/health",(req,res)=>res.json({ok:true}));

app.get("*",(req,res)=>{
  res.sendFile(path.join(__dirname,"index.html"));
});

app.listen(PORT,()=>console.log(`Camayo Data running on http://localhost:${PORT}`));
