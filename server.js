const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "filedrop";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

if (!MONGODB_URI) throw new Error("MONGODB_URI environment variable is required.");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use(express.static(path.join(__dirname, "public")));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 20)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 5 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname || file.originalname.length > 180) return cb(new Error("Filename is missing or too long."));
    cb(null, true);
  }
});

function prettySize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function safeId(id) {
  return /^[0-9a-f-]{36}(?:\.[a-zA-Z0-9]{1,20})?$/.test(id);
}
function publicFile(doc) {
  return {
    id: doc.id,
    name: doc.name,
    size: doc.size,
    sizeLabel: prettySize(doc.size),
    uploadedAt: doc.uploadedAt
  };
}

const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
let filesCollection;

// Import files created by the previous FileDrop version, if its upload volume is reused.
async function migrateExistingFiles() {
  const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true }).filter(entry => entry.isFile() && !entry.name.endsWith(".meta.json"));
  for (const entry of entries) {
    const id = entry.name;
    if (!safeId(id)) continue;
    const fullPath = path.join(UPLOAD_DIR, id);
    const stat = fs.statSync(fullPath);
    let name = id;
    let uploadedAt = stat.mtime.toISOString();
    try {
      const meta = JSON.parse(fs.readFileSync(`${fullPath}.meta.json`, "utf8"));
      name = path.basename(meta.originalName || id);
      uploadedAt = meta.uploadedAt || uploadedAt;
    } catch (_) {}
    await filesCollection.updateOne({ id }, { $setOnInsert: { id, name, size: stat.size, uploadedAt } }, { upsert: true });
  }
}

app.get("/api/files", async (req, res) => {
  try {
    const docs = await filesCollection.find({}).sort({ uploadedAt: -1 }).toArray();
    const files = docs.map(publicFile);
    res.json({ files, totalFiles: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0), maxFileSize: MAX_FILE_SIZE });
  } catch (error) {
    console.error("List files error:", error.message);
    res.status(500).json({ error: "Could not read stored files from the database." });
  }
});

app.post("/api/upload", upload.array("files", 5), async (req, res) => {
  const uploaded = req.files || [];
  if (!uploaded.length) return res.status(400).json({ error: "Choose at least one file." });
  const docs = uploaded.map(file => ({
    id: file.filename,
    name: path.basename(file.originalname),
    size: file.size,
    uploadedAt: new Date().toISOString()
  }));
  try {
    await filesCollection.insertMany(docs);
    res.status(201).json({ message: `${docs.length} file(s) uploaded successfully.`, files: docs.map(publicFile) });
  } catch (error) {
    // Avoid leaving orphaned files if the database write fails.
    for (const file of uploaded) {
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
    console.error("Save upload metadata error:", error.message);
    res.status(500).json({ error: "The upload could not be recorded in MongoDB. Please try again." });
  }
});

app.get("/api/download/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!safeId(id)) return res.status(400).json({ error: "Invalid file ID." });
    const doc = await filesCollection.findOne({ id });
    if (!doc) return res.status(404).json({ error: "File not found." });
    const filePath = path.join(UPLOAD_DIR, id);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return res.status(404).json({ error: "File data not found in storage." });
    res.download(filePath, path.basename(doc.name));
  } catch (error) {
    console.error("Download error:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "Could not download file." });
  }
});

app.delete("/api/files/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!safeId(id)) return res.status(400).json({ error: "Invalid file ID." });
    const doc = await filesCollection.findOne({ id });
    if (!doc) return res.status(404).json({ error: "File not found." });
    const filePath = path.join(UPLOAD_DIR, id);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    try { fs.unlinkSync(`${filePath}.meta.json`); } catch (_) {}
    await filesCollection.deleteOne({ id });
    res.status(204).end();
  } catch (error) {
    console.error("Delete error:", error.message);
    res.status(500).json({ error: "Could not delete file." });
  }
});

app.get("/api/health", async (req, res) => {
  try {
    await client.db(DB_NAME).command({ ping: 1 });
    res.json({ ok: true, database: "MongoDB connected", storage: "Docker volume" });
  } catch (_) {
    res.status(503).json({ ok: false, database: "MongoDB unavailable" });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? "Each file must be 10 MB or smaller."
      : error.code === "LIMIT_FILE_COUNT" ? "Upload up to 5 files at a time."
      : error.message;
    return res.status(400).json({ error: message });
  }
  if (error) {
    // Request-aborted errors can happen when a browser cancels an upload.
    if (req.aborted || error.code === "ECONNRESET" || /request aborted/i.test(error.message || "")) {
      console.warn("Upload request was interrupted by the client.");
      return;
    }
    console.error("Request error:", error);
    if (!res.headersSent) res.status(400).json({ error: error.message || "Upload failed." });
  } else next();
});

async function start() {
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await client.connect();
      const db = client.db(DB_NAME);
      filesCollection = db.collection("files");
      await filesCollection.createIndex({ id: 1 }, { unique: true });
      await migrateExistingFiles();
      app.listen(PORT, "0.0.0.0", () => {
        console.log(`FileDrop is running on port ${PORT}`);
        console.log(`Uploads directory: ${UPLOAD_DIR}`);
        console.log(`MongoDB database: ${DB_NAME}`);
      });
      return;
    } catch (error) {
      lastError = error;
      console.log(`Waiting for MongoDB (${attempt}/20): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  console.error("Could not connect to MongoDB:", lastError);
  process.exit(1);
}
start();
