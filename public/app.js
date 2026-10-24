const $ = selector => document.querySelector(selector);
const input = $("#file-input");
const zone = $("#drop-zone");
const form = $("#upload-form");
const selected = $("#selected-files");
const uploadButton = $("#upload-button");
const uploadMessage = $("#upload-message");
const fileList = $("#file-list");
const searchInput = $("#search-input");
let chosenFiles = [];
let savedFiles = [];
const MAX_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 5;

function safe(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[ch]);
}
function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Just now" : date.toLocaleString();
}
function fileKind(name) {
  const ext = (name.split(".").pop() || "FILE").toUpperCase();
  return ext.length > 5 ? "FILE" : ext;
}
function setMessage(text, kind = "") {
  uploadMessage.textContent = text;
  uploadMessage.className = kind;
}
function updateSelection(files) {
  const incoming = Array.from(files || []);
  const combined = [...chosenFiles];
  for (const file of incoming) {
    if (!combined.some(existing => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) {
      combined.push(file);
    }
  }
  if (combined.length > MAX_FILES) {
    setMessage("You can upload up to 5 files at a time.", "message-error");
  } else {
    setMessage(combined.length ? `${combined.length} file(s) ready to upload.` : "Your files stay on this machine.");
  }
  chosenFiles = combined.slice(0, MAX_FILES);
  renderSelection();
}
function renderSelection() {
  selected.hidden = chosenFiles.length === 0;
  selected.innerHTML = chosenFiles.map((file, index) => `
    <div class="selected-item">
      <span class="selected-name" title="${safe(file.name)}">${safe(file.name)}</span>
      <span class="selected-size">${sizeLabel(file.size)}</span>
      <button class="remove-selected" type="button" data-remove-selected="${index}" title="Remove ${safe(file.name)} from selection" aria-label="Remove ${safe(file.name)} from selection">×</button>
    </div>
  `).join("");
  uploadButton.disabled = chosenFiles.length === 0 || chosenFiles.some(file => file.size > MAX_SIZE);
  if (chosenFiles.some(file => file.size > MAX_SIZE)) setMessage("Each file must be 10 MB or smaller.", "message-error");
}
selected.addEventListener("click", event => {
  const button = event.target.closest("[data-remove-selected]");
  if (!button) return;
  const index = Number(button.dataset.removeSelected);
  if (!Number.isInteger(index) || index < 0 || index >= chosenFiles.length) return;
  chosenFiles.splice(index, 1);
  renderSelection();
  setMessage(chosenFiles.length ? `${chosenFiles.length} file(s) ready to upload.` : "Selection cleared. Choose files to upload.");
});
$("#browse-button").addEventListener("click", () => input.click());
zone.addEventListener("click", event => {
  if (event.target.closest("button")) return;
  input.click();
});
zone.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    input.click();
  }
});
input.addEventListener("change", () => {
  updateSelection(input.files);
  input.value = "";
});
["dragenter", "dragover"].forEach(type => zone.addEventListener(type, event => {
  event.preventDefault();
  zone.classList.add("drag-over");
}));
["dragleave", "drop"].forEach(type => zone.addEventListener(type, event => {
  event.preventDefault();
  zone.classList.remove("drag-over");
}));
zone.addEventListener("drop", event => updateSelection(event.dataTransfer.files));

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!chosenFiles.length) return;
  const tooLarge = chosenFiles.find(file => file.size > MAX_SIZE);
  if (tooLarge) {
    setMessage(`${tooLarge.name} is larger than 10 MB.`, "message-error");
    return;
  }
  const data = new FormData();
  chosenFiles.forEach(file => data.append("files", file));
  uploadButton.disabled = true;
  uploadButton.innerHTML = "Uploading…";
  setMessage("Uploading your files…");
  try {
    const response = await fetch("/api/upload", { method: "POST", body: data });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Upload failed.");
    chosenFiles = [];
    renderSelection();
    setMessage(result.message, "message-success");
    await loadFiles();
  } catch (error) {
    setMessage(error.message || "Upload failed. Try again.", "message-error");
  } finally {
    uploadButton.innerHTML = 'Upload files <span>↗</span>';
    uploadButton.disabled = chosenFiles.length === 0;
  }
});

function renderFiles(files) {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = files.filter(file => file.name.toLowerCase().includes(query));
  $("#file-count").textContent = files.length;
  $("#all-files-count").textContent = files.length;
  if (!filtered.length) {
    fileList.innerHTML = files.length
      ? '<div class="empty-state"><span class="empty-icon">⌕</span><strong>No matching files.</strong><p>Try another search.</p></div>'
      : '<div class="empty-state"><span class="empty-icon">↥</span><strong>Your space is waiting.</strong><p>Upload your first file to see it here.</p></div>';
  } else {
    fileList.innerHTML = filtered.map(file => `
      <article class="file-row">
        <div class="file-icon">${safe(fileKind(file.name))}</div>
        <div class="file-info"><div class="file-name" title="${safe(file.name)}">${safe(file.name)}</div><div class="file-meta">${safe(file.sizeLabel)} · ${safe(dateLabel(file.uploadedAt))}</div></div>
        <div class="file-actions">
          <a class="action-btn" href="/api/download/${encodeURIComponent(file.id)}" title="Download ${safe(file.name)}" aria-label="Download ${safe(file.name)}">↓</a>
          <button class="action-btn delete" type="button" data-delete="${safe(file.id)}" title="Delete ${safe(file.name)}" aria-label="Delete ${safe(file.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg></button>
        </div>
      </article>`).join("");
  }
}
async function loadFiles() {
  try {
    const response = await fetch("/api/files", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load files.");
    savedFiles = result.files;
    $("#storage-used").textContent = sizeLabel(result.totalBytes);
    const percent = result.totalBytes ? Math.min(100, (result.totalBytes / (100 * 1024 * 1024)) * 100) : 0;
    $("#storage-bar-fill").style.width = `${percent}%`;
    $("#storage-percent").textContent = `${percent.toFixed(1)}% of 100 MB demo guide`;
    $("#connection-status").textContent = "Storage connected";
    renderFiles(savedFiles);
  } catch (error) {
    $("#connection-status").textContent = "Connection issue";
    fileList.innerHTML = `<div class="empty-state"><strong>Could not load files.</strong><p>${safe(error.message)}</p></div>`;
  }
}
fileList.addEventListener("click", async event => {
  const button = event.target.closest("[data-delete]");
  if (!button) return;
  const id = button.dataset.delete;
  const file = savedFiles.find(item => item.id === id);
  if (!confirm(`Delete "${file ? file.name : "this file"}"? This cannot be undone.`)) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "Could not delete file.");
    }
    setMessage("File deleted.", "message-success");
    await loadFiles();
  } catch (error) {
    setMessage(error.message || "Could not delete file.", "message-error");
  }
});
searchInput.addEventListener("input", () => renderFiles(savedFiles));
$("#refresh-button").addEventListener("click", loadFiles);
loadFiles();
