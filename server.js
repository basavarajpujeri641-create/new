require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { neon } = require("@neondatabase/serverless");
const { del: deleteBlob, put: putBlob } = require("@vercel/blob");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "skphotography";
const ADMIN_PHONE = process.env.ADMIN_PHONE || "";
const BOOKING_NOTIFICATION_PHONE =
  process.env.BOOKING_NOTIFICATION_PHONE || ADMIN_PHONE;
const isVercel = Boolean(process.env.VERCEL);
const databaseUrl = process.env.DATABASE_URL;
const sql = databaseUrl ? neon(databaseUrl) : null;
const Database = !isVercel && !sql ? require("better-sqlite3") : null;

function hasBlobCredentials() {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
    (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN)
  );
}

function getConfigurationError() {
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
    return "Set ADMIN_PASSWORD to a unique password of at least 12 characters.";
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 ||
      process.env.JWT_SECRET === "replace_with_a_long_random_secret") {
    return "Set JWT_SECRET to a random secret of at least 32 characters.";
  }
  if (ADMIN_PHONE && !/^\+[1-9]\d{7,14}$/.test(ADMIN_PHONE)) {
    return "Set ADMIN_PHONE in international format.";
  }
  if (isVercel && !databaseUrl) {
    return "Set DATABASE_URL to the Neon Postgres connection string in Vercel project settings.";
  }
  return "";
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");

for (const dir of isVercel ? [] : [PUBLIC_DIR, DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = isVercel || sql
  ? null
  : new Database(path.join(DATA_DIR, "skphotography.db"));
if (db) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      filename TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      service TEXT NOT NULL,
      event_date TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'New',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS password_reset_challenges (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
  const photoColumns = db.prepare("PRAGMA table_info(photos)").all();
  if (!photoColumns.some(column => column.name === "url")) {
    db.exec("ALTER TABLE photos ADD COLUMN url TEXT NOT NULL DEFAULT ''");
  }
}

const parameterize = query => {
  let index = 0;
  return query.replace(/\?/g, () => `$${++index}`);
};

async function queryRows(query, params = []) {
  if (sql) {
    const result = await sql.query(parameterize(query), params, { fullResults: true });
    return result.rows;
  }
  return db.prepare(query).all(...params);
}

async function queryOne(query, params = []) {
  if (sql) {
    const result = await sql.query(parameterize(query), params, { fullResults: true });
    return result.rows[0] || null;
  }
  return db.prepare(query).get(...params) || null;
}

async function execute(query, params = []) {
  if (sql) return sql.query(parameterize(query), params, { fullResults: true });
  return db.prepare(query).run(...params);
}

async function deleteBlobIfUnused(url) {
  if (!sql || !url) return;
  const photo = await queryOne("SELECT id FROM photos WHERE url = ?", [url]);
  if (!photo) await deleteBlob(url);
}

async function deleteLocalImageIfUnused(url) {
  if (sql || !url?.startsWith("/uploads/")) return;
  const filename = path.basename(url);
  const photo = await queryOne(
    "SELECT id FROM photos WHERE filename = ?",
    [filename]
  );
  if (!photo) {
    await fs.promises.unlink(path.join(UPLOAD_DIR, filename)).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

let initialization;
async function initializeDatabase() {
  const configurationError = getConfigurationError();
  if (configurationError) {
    const error = new Error(configurationError);
    error.code = "CONFIGURATION";
    throw error;
  }

  if (sql) {
    const statements = [
      `CREATE TABLE IF NOT EXISTS admins (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      )`,
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      `CREATE TABLE IF NOT EXISTS photos (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        filename TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS bookings (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        service TEXT NOT NULL,
        event_date TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'New',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS password_reset_challenges (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      )`
    ];
    for (const statement of statements) await sql.query(statement);
  }

  for (const [key, value] of Object.entries(defaultSettings)) {
    await execute(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
      [key, value]
    );
  }

  const existing = await queryOne(
    "SELECT id FROM admins WHERE username = ?", [ADMIN_USERNAME]
  );
  if (!existing) {
    const admins = await queryRows("SELECT id FROM admins");
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    if (admins.length === 1) {
      await execute(
        "UPDATE admins SET username = ?, password_hash = ? WHERE id = ?",
        [ADMIN_USERNAME, hash, admins[0].id]
      );
      console.log("Existing admin account updated from server configuration.");
    } else if (admins.length === 0) {
      await execute(
        "INSERT INTO admins (username, password_hash) VALUES (?, ?) " +
        "ON CONFLICT(username) DO NOTHING",
        [ADMIN_USERNAME, hash]
      );
      console.log("Initial admin account created.");
    } else {
      throw new Error("Multiple admin accounts exist; resolve them before changing the admin username.");
    }
  }
}

function ensureInitialized() {
  initialization ||= initializeDatabase().catch(error => {
    initialization = null;
    throw error;
  });
  return initialization;
}

const defaultSettings = {
  photographer: "Sachin K",
  websiteName: "SK Photography",
  phone: "",
  email: "",
  location: "Belagavi, Karnataka",
  instagram: "https://www.instagram.com/sk_photography8296/"
};

app.disable("x-powered-by");
app.use(helmet({
  // This starter uses inline CSS in your existing HTML.
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use("/api", (req, res, next) => {
  ensureInitialized().then(() => next()).catch(error => {
    if (error.code === "CONFIGURATION") {
      return res.status(503).json({ error: error.message });
    }
    console.error("API database initialization failed:", error);
    res.status(503).json({ error: "The database is unavailable. Check the server logs." });
  });
});

// Vercel serves public/ assets from its CDN; keep local static hosting for development.
if (!isVercel) {
  app.use(express.static(PUBLIC_DIR));
  app.use("/uploads", express.static(UPLOAD_DIR, {
    dotfiles: "deny",
    index: false,
    setHeaders(res) {
      res.setHeader("X-Content-Type-Options", "nosniff");
    }
  }));
}

app.get("/", async (req, res, next) => {
  try {
    const index = await fs.promises.readFile(path.join(PUBLIC_DIR, "index.html"));
    res.type("html").send(index);
  } catch (error) {
    console.error("Could not read the homepage file:", error);
    next(error);
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

const passwordResetRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

const passwordResetVerifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Admin login required." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "skphotography",
      audience: "skphotography-admin"
    });

    if (payload.role !== "admin") {
      return res.status(403).json({ error: "Admin access required." });
    }

    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

function cleanText(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

async function sendSms(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (!to || !accountSid || !authToken ||
      (!fromNumber && !messagingServiceSid)) {
    return { sent: false, reason: "SMS notifications are not configured." };
  }

  const message = new URLSearchParams({ To: to, Body: body });
  if (messagingServiceSid) {
    message.set("MessagingServiceSid", messagingServiceSid);
  } else {
    message.set("From", fromNumber);
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: message
      }
    );
    const responseBody = await response.text();
    if (!response.ok) {
      console.error("SMS delivery failed with status", response.status, responseBody);
      return { sent: false, reason: "The SMS provider could not deliver the notification." };
    }
    return { sent: true };
  } catch (error) {
    console.error("SMS delivery failed.", error);
    return { sent: false, reason: "The SMS provider could not be reached." };
  }
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", website: "SK Photography" });
});

// Public website settings
app.get("/api/settings", async (req, res) => {
  const rows = await queryRows("SELECT key, value FROM settings");
  res.json(Object.fromEntries(rows.map(row => [row.key, row.value])));
});

// Public gallery
app.get("/api/photos", async (req, res) => {
  const photos = await queryRows(`
    SELECT id, title, category, filename, url, created_at
    FROM photos ORDER BY id DESC
  `);

  res.json(photos.map(photo => ({
    ...photo,
    image: photo.url || "/uploads/" + photo.filename
  })));
});

// Admin login
app.post("/api/admin/login", loginLimiter, async (req, res) => {
  const username = cleanText(req.body?.username, 100);
  const password = typeof req.body?.password === "string"
    ? req.body.password
    : "";

  if (!username || !password || password.length > 200) {
    return res.status(400).json({ error: "Enter username and password." });
  }

  const admin = await queryOne(
    "SELECT * FROM admins WHERE username = ?", [username]
  );

  // Use a dummy hash when the username doesn't exist.
  const dummyHash =
    "$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6Zx5yP8jX7V6p7J0eQ0rjWJfZ1q9K";

  const valid = await bcrypt.compare(
    password,
    admin?.password_hash || dummyHash
  );

  if (!admin || !valid) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  const token = jwt.sign(
    { role: "admin", username: admin.username },
    process.env.JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: "2h",
      issuer: "skphotography",
      audience: "skphotography-admin"
    }
  );

  res.json({
    message: "Login successful.",
    token,
    expiresIn: 7200
  });
});

app.post("/api/admin/password-reset/request", passwordResetRequestLimiter, async (req, res) => {
  if (!ADMIN_PHONE) {
    return res.status(503).json({
      error: "Set ADMIN_PHONE in international format to enable password reset."
    });
  }

  const code = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
  const codeHash = crypto.createHmac("sha256", process.env.JWT_SECRET)
    .update(code)
    .digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const sms = await sendSms(
    ADMIN_PHONE,
    `Your SK Photography admin password reset code is ${code}. It expires in 10 minutes.`
  );
  if (!sms.sent) {
    return res.status(502).json({
      error: `Could not send the reset code. ${sms.reason}`
    });
  }

  await execute(`
    INSERT INTO password_reset_challenges (id, code_hash, expires_at, attempts)
    VALUES (1, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      code_hash = excluded.code_hash,
      expires_at = excluded.expires_at,
      attempts = 0
  `, [codeHash, expiresAt]);

  res.json({ message: "A reset code was sent to the admin mobile number." });
});

app.post("/api/admin/password-reset/verify", passwordResetVerifyLimiter, async (req, res) => {
  const code = cleanText(req.body?.code, 6);
  const password = typeof req.body?.password === "string"
    ? req.body.password
    : "";
  const challenge = await queryOne(
    "SELECT code_hash, expires_at, attempts FROM password_reset_challenges WHERE id = 1"
  );

  if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now()) {
    await execute("DELETE FROM password_reset_challenges WHERE id = 1");
    return res.status(400).json({
      error: "The reset code is missing or expired. Request a new code."
    });
  }

  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "Enter the 6-digit reset code." });
  }

  if (password.length < 12 || password.length > 200) {
    return res.status(400).json({
      error: "Choose a password between 12 and 200 characters."
    });
  }

  const submittedHash = crypto.createHmac("sha256", process.env.JWT_SECRET)
    .update(code)
    .digest("hex");
  const matches = crypto.timingSafeEqual(
    Buffer.from(challenge.code_hash, "hex"),
    Buffer.from(submittedHash, "hex")
  );

  if (!matches) {
    const attempts = Number(challenge.attempts) + 1;
    if (attempts >= 5) {
      await execute("DELETE FROM password_reset_challenges WHERE id = 1");
    } else {
      await execute(
        "UPDATE password_reset_challenges SET attempts = ? WHERE id = 1",
        [attempts]
      );
    }
    return res.status(400).json({
      error: attempts >= 5
        ? "Too many incorrect attempts. Request a new reset code."
        : "That reset code is incorrect."
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await execute(
    "UPDATE admins SET password_hash = ? WHERE username = ?",
    [passwordHash, ADMIN_USERNAME]
  );
  if ((sql ? result.rowCount : result.changes) === 0) {
    throw new Error("The configured admin account was not found while resetting its password.");
  }

  await execute("DELETE FROM password_reset_challenges WHERE id = 1");
  res.json({ message: "Admin password updated. Sign in with your new password." });
});

// Update contact details and other public settings
app.put("/api/admin/settings", requireAdmin, async (req, res) => {
  const allowed = [
    "photographer", "websiteName", "phone",
    "email", "location", "instagram"
  ];

  const updates = {};
  for (const key of allowed) {
    if (typeof req.body?.[key] === "string") {
      updates[key] = cleanText(req.body[key], 300);
    }
  }

  if (updates.email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  for (const [key, value] of Object.entries(updates)) {
    await execute(
      "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value]
    );
  }

  res.json({ message: "Website settings updated.", settings: updates });
});

// Only allow common raster image formats; never trust file extensions alone.
const allowedMime = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 3 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (!allowedMime.has(file.mimetype)) {
      return cb(new Error("Only JPG, PNG, WEBP, and GIF are allowed."));
    }
    cb(null, true);
  }
});

function isSupportedImage(buffer, mimeType) {
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 &&
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      );
  }
  if (mimeType === "image/webp") {
    return buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP";
  }
  return mimeType === "image/gif" && buffer.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6));
}

function imageExtension(mimeType) {
  return {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif"
  }[mimeType];
}

// Admin uploads one portfolio photo using multipart field "photo".
app.post(
  "/api/admin/photos",
  requireAdmin,
  (req, res, next) => upload.single("photo")(req, res, err => {
    if (err) return next(err);
    next();
  }),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Select a photo." });
    }

    const title = cleanText(req.body.title, 150);
    const category = cleanText(req.body.category, 60);

    if (!title || !category) {
      return res.status(400).json({
        error: "Photo title and category are required."
      });
    }

    if (!isSupportedImage(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({
        error: "The file does not contain a supported image."
      });
    }

    const extension = imageExtension(req.file.mimetype);
    const filename = crypto.randomUUID() + extension;
    let imageUrl;
    try {
      if (sql) {
        if (!hasBlobCredentials()) {
          return res.status(503).json({
            error: "Photo storage is unavailable. Connect a Vercel Blob store to this project and enable it for this deployment environment, or configure BLOB_READ_WRITE_TOKEN."
          });
        }
        const blob = await putBlob(`portfolio/${filename}`, req.file.buffer, {
          access: "public",
          contentType: req.file.mimetype,
          addRandomSuffix: false
        });
        imageUrl = blob.url;
      } else {
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);
        imageUrl = `/uploads/${filename}`;
      }

      let id;
      if (sql) {
        const rows = await queryRows(
          "INSERT INTO photos (title, category, filename, url) VALUES (?, ?, ?, ?) RETURNING id",
          [title, category, filename, imageUrl]
        );
        id = rows[0].id;
      } else {
        const result = await execute(
          "INSERT INTO photos (title, category, filename, url) VALUES (?, ?, ?, ?)",
          [title, category, filename, imageUrl]
        );
        id = result.lastInsertRowid;
      }

      res.status(201).json({
        message: "Photo uploaded.",
        id,
        title,
        category,
        image: imageUrl
      });
    } catch (error) {
      if (imageUrl && sql) {
        await deleteBlob(imageUrl).catch(deleteError =>
          console.error("Could not clean up the uploaded image.", deleteError)
        );
      } else if (!sql) {
        fs.unlink(path.join(UPLOAD_DIR, filename), () => {});
      }
      throw error;
    }
  }
);

app.post(
  "/api/admin/portrait",
  requireAdmin,
  (req, res, next) => upload.single("portrait")(req, res, err => {
    if (err) return next(err);
    next();
  }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Select a portrait image." });
    if (!isSupportedImage(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({ error: "The file does not contain a supported image." });
    }
    if (sql && !hasBlobCredentials()) {
      return res.status(503).json({
        error: "Photo storage is unavailable. Connect a Vercel Blob store to this project and enable it for this deployment environment, or configure BLOB_READ_WRITE_TOKEN."
      });
    }

    const filename = `portrait/${crypto.randomUUID()}${imageExtension(req.file.mimetype)}`;
    let imageUrl;
    let settingSaved = false;
    try {
      if (sql) {
        const blob = await putBlob(filename, req.file.buffer, {
          access: "public",
          contentType: req.file.mimetype
        });
        imageUrl = blob.url;
      } else {
        const localName = filename.split("/").pop();
        fs.writeFileSync(path.join(UPLOAD_DIR, localName), req.file.buffer);
        imageUrl = `/uploads/${localName}`;
      }

      const previous = await queryOne(
        "SELECT value FROM settings WHERE key = ?",
        ["portraitUrl"]
      );
      await execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ["portraitUrl", imageUrl]
      );
      settingSaved = true;
      if (sql && previous?.value && previous.value !== imageUrl) {
        await deleteBlobIfUnused(previous.value);
      } else if (previous?.value && previous.value !== imageUrl) {
        await deleteLocalImageIfUnused(previous.value);
      }
      res.json({ message: "Portrait updated.", image: imageUrl });
    } catch (error) {
      if (imageUrl && sql && !settingSaved) {
        await deleteBlob(imageUrl).catch(deleteError =>
          console.error("Could not clean up the portrait upload.", deleteError)
        );
      } else if (!sql && imageUrl && !settingSaved) {
        fs.unlink(path.join(UPLOAD_DIR, path.basename(filename)), () => {});
      }
      throw error;
    }
  }
);

app.delete("/api/admin/portrait", requireAdmin, async (req, res) => {
  const previous = await queryOne(
    "SELECT value FROM settings WHERE key = ?",
    ["portraitUrl"]
  );
  await execute("DELETE FROM settings WHERE key = ?", ["portraitUrl"]);
  if (sql && previous?.value) await deleteBlobIfUnused(previous.value);
  if (!sql && previous?.value) await deleteLocalImageIfUnused(previous.value);
  res.json({ message: "Portrait removed." });
});

app.put("/api/admin/portrait/select", requireAdmin, async (req, res) => {
  const id = Number(req.body?.photoId);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: "Select a valid portfolio photo." });
  }

  const photo = await queryOne("SELECT url, filename FROM photos WHERE id = ?", [id]);
  if (!photo) return res.status(404).json({ error: "Portfolio photo not found." });

  const previous = await queryOne(
    "SELECT value FROM settings WHERE key = ?",
    ["portraitUrl"]
  );
  const imageUrl = photo.url || `/uploads/${photo.filename}`;
  await execute(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ["portraitUrl", imageUrl]
  );
  if (sql && previous?.value && previous.value !== imageUrl) {
    await deleteBlobIfUnused(previous.value);
  }
  res.json({ message: "Portfolio photo selected as the About portrait." });
});

// Delete a gallery photo
app.delete("/api/admin/photos/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid photo ID." });
  }

  const photo = await queryOne("SELECT * FROM photos WHERE id = ?", [id]);

  if (!photo) {
    return res.status(404).json({ error: "Photo not found." });
  }

  const portrait = await queryOne(
    "SELECT value FROM settings WHERE key = ?",
    ["portraitUrl"]
  );
  await execute("DELETE FROM photos WHERE id = ?", [id]);
  const photoUrl = photo.url || `/uploads/${photo.filename}`;
  if (portrait?.value === photoUrl) {
    await execute("DELETE FROM settings WHERE key = ?", ["portraitUrl"]);
  }

  if (sql) {
    await deleteBlob(photo.url);
  } else {
    fs.unlink(path.join(UPLOAD_DIR, photo.filename), err => {
      if (err && err.code !== "ENOENT") {
        console.error("Could not delete image file:", err.message);
      }
    });
  }

  res.json({ message: "Photo deleted." });
});

// Customer booking form
app.post("/api/bookings", bookingLimiter, async (req, res) => {
  const name = cleanText(req.body?.name, 100);
  const phone = cleanText(req.body?.phone, 25);
  const email = cleanText(req.body?.email, 150);
  const service = cleanText(req.body?.service, 100);
  const eventDate = cleanText(req.body?.event_date, 10);
  const message = cleanText(req.body?.message, 1000);

  const services = [
    "Wedding", "Pre/Post Wedding", "Candid Photography",
    "Cinematic / Traditional Video", "Album Making",
    "Studio / Outdoor Modeling Shoot", "Drone Shoot",
    "Baby Photoshoot", "Maternity Photoshoot", "Baby Shoot",
    "All Type of Photography & Videography", "Other"
  ];

  if (!name || !/^[+\d() -]{7,25}$/.test(phone) ||
      !services.includes(service)) {
    return res.status(400).json({
      error: "Enter your name, valid phone number and service."
    });
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    return res.status(400).json({ error: "Invalid event date." });
  }

  let bookingId;
  if (sql) {
    const rows = await queryRows(`
      INSERT INTO bookings (name, phone, email, service, event_date, message)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id
    `, [name, phone, email, service, eventDate, message]);
    bookingId = rows[0].id;
  } else {
    const result = await execute(`
      INSERT INTO bookings (name, phone, email, service, event_date, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [name, phone, email, service, eventDate, message]);
    bookingId = result.lastInsertRowid;
  }

  const sms = await sendSms(
    BOOKING_NOTIFICATION_PHONE,
    [
      "New SK Photography booking request",
      `Name: ${name}`,
      `Customer mobile: ${phone}`,
      `Service: ${service}`,
      `Date: ${eventDate || "Not specified"}`,
      `Details: ${message || "None"}`,
      `Booking ID: ${bookingId}`
    ].join("\n")
  );

  res.status(201).json({
    message: sms.sent
      ? "Booking request received. The photographer was notified by SMS."
      : "Booking request saved, but the photographer could not be notified by SMS.",
    bookingId,
    notificationSent: sms.sent,
    notificationError: sms.sent ? undefined : sms.reason
  });
});

// Admin views customer bookings
app.get("/api/admin/bookings", requireAdmin, async (req, res) => {
  const bookings = await queryRows(`
    SELECT id, name, phone, email, service, event_date,
           message, status, created_at
    FROM bookings ORDER BY id DESC
  `);

  res.json(bookings);
});

// Admin deletes a booking request.
app.delete("/api/admin/bookings/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid booking ID." });
  }

  const result = await execute("DELETE FROM bookings WHERE id = ?", [id]);
  if ((sql ? result.rowCount : result.changes) === 0) {
    return res.status(404).json({ error: "Booking not found." });
  }

  res.json({ message: "Booking deleted." });
});

// Admin changes booking status
app.patch("/api/admin/bookings/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const status = cleanText(req.body?.status, 20);
  const allowed = ["New", "Contacted", "Confirmed", "Completed", "Cancelled"];

  if (!Number.isSafeInteger(id) || id < 1 ||
      !allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid booking or status." });
  }

  const result = await execute(
    "UPDATE bookings SET status = ? WHERE id = ?",
    [status, id]
  );

  if ((sql ? result.rowCount : result.changes) === 0) {
    return res.status(404).json({ error: "Booking not found." });
  }

  res.json({ message: "Booking status updated." });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

// Safe error responses
app.use((err, req, res, next) => {
  console.error(err.message);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: err.code === "LIMIT_FILE_SIZE"
        ? "Photo must be 3 MB or smaller."
        : "Photo upload failed."
    });
  }

  if (err.message.startsWith("Only JPG")) {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: "Something went wrong." });
});

if (require.main === module) {
  ensureInitialized()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`SK Photography running at http://localhost:${PORT}`);
      });
    })
    .catch(error => {
      console.error("Backend startup failed:", error);
      process.exit(1);
    });
}

module.exports = app;