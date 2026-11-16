/* Order Tracking & Shipping Dashboard — logic (v1.9 restyled + auto-CSV / parts / recursive PDF) */

let ongoingOrders = JSON.parse(localStorage.getItem("ongoingOrders") || "[]");
let shippedOrders = JSON.parse(localStorage.getItem("shippedOrders") || "[]");
let stagingOrders = JSON.parse(localStorage.getItem("stagingOrders") || "[]");
let knownParts = JSON.parse(localStorage.getItem("knownParts") || "[]"); // unique part numbers for autocomplete
let expandedDates = {};
let expandedEntries = {};
let importedFileName = "OrderTracker";
let localPdfFolderHandle = null;
/** Map: basename without .pdf (lower) -> { fileHandle, displayName, relativePath } */
let pdfFileMap = new Map();
let undoStack = [];

/** File System Access handle for auto-save CSV (session + IndexedDB) */
let autoSaveCsvHandle = null;
let autoSaveCsvEnabled = false;
let autoSaveDebounceTimer = null;

// ---------------------------------------------------------------------------
// IndexedDB helpers — persist file handle across reloads (same origin)
// ---------------------------------------------------------------------------
const IDB_NAME = "OrderTrackerFS";
const IDB_STORE = "handles";

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// State / save
// ---------------------------------------------------------------------------
function saveState() {
  undoStack.push(JSON.stringify({ ongoingOrders, shippedOrders, stagingOrders }));
  if (undoStack.length > 50) undoStack.shift();
  updateUndoBadge();
}

function saveKnownParts() {
  // Keep sorted unique list
  knownParts = [...new Set(knownParts.map((p) => String(p).trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
  localStorage.setItem("knownParts", JSON.stringify(knownParts));
}

function rememberPart(partNo) {
  const p = (partNo || "").trim();
  if (!p) return;
  if (!knownParts.some((x) => x.toLowerCase() === p.toLowerCase())) {
    knownParts.push(p);
    saveKnownParts();
  }
  refreshPartSuggestions();
}

/** Collect part numbers from all orders into knownParts */
function harvestPartsFromOrders() {
  const add = (p) => {
    const t = (p || "").trim();
    if (t && !knownParts.some((x) => x.toLowerCase() === t.toLowerCase())) knownParts.push(t);
  };
  ongoingOrders.forEach((o) => add(o.partNo));
  shippedOrders.forEach((o) => add(o.partNo));
  saveKnownParts();
  refreshPartSuggestions();
}

function saveData() {
  localStorage.setItem("ongoingOrders", JSON.stringify(ongoingOrders));
  localStorage.setItem("shippedOrders", JSON.stringify(shippedOrders));
  localStorage.setItem("stagingOrders", JSON.stringify(stagingOrders));
  harvestPartsFromOrders();
  scheduleAutoSaveCsv();
}

function showSaveIndicator(msg) {
  const indicator = document.getElementById("saveIndicator");
  if (!indicator) return;
  if (msg) indicator.textContent = msg;
  else indicator.textContent = autoSaveCsvEnabled ? "Saved · CSV ✓" : "Saved ✓";
  indicator.classList.add("show");
  setTimeout(() => indicator.classList.remove("show"), 2000);
}

function manualSave() {
  saveData();
  writeAutoSaveCsvNow().then(() => showSaveIndicator());
}

function updateUndoBadge() {
  const badge = document.getElementById("undoCountBadge");
  const btn = document.getElementById("undoBtn");
  if (!badge || !btn) return;
  if (undoStack.length > 0) {
    badge.textContent = undoStack.length;
    badge.classList.remove("hidden");
    btn.disabled = false;
  } else {
    badge.classList.add("hidden");
    btn.disabled = true;
  }
}

function updateAutoSaveStatusUi() {
  const el = document.getElementById("autoSaveStatus");
  if (!el) return;
  if (autoSaveCsvEnabled && autoSaveCsvHandle) {
    el.textContent = `Auto-CSV: ${autoSaveCsvHandle.name || "linked"}`;
    el.classList.remove("text-slate-400");
    el.classList.add("text-sage-700");
  } else {
    el.textContent = "Auto-CSV: off";
    el.classList.add("text-slate-400");
    el.classList.remove("text-sage-700");
  }
}

// ---------------------------------------------------------------------------
// Auto-save CSV (File System Access API)
// ---------------------------------------------------------------------------
async function linkAutoSaveCsv() {
  if (!window.showSaveFilePicker) {
    alert("Auto-save CSV needs Chrome or Edge (File System Access API).");
    return;
  }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: getTimestampedFilename(),
      types: [{ description: "CSV Files", accept: { "text/csv": [".csv"] } }],
    });
    autoSaveCsvHandle = handle;
    autoSaveCsvEnabled = true;
    await idbSet("autoSaveCsvHandle", handle);
    await writeAutoSaveCsvNow();
    updateAutoSaveStatusUi();
    showSaveIndicator("CSV linked & saved ✓");
  } catch (err) {
    if (err.name !== "AbortError") console.error(err);
  }
}

async function unlinkAutoSaveCsv() {
  autoSaveCsvHandle = null;
  autoSaveCsvEnabled = false;
  await idbDelete("autoSaveCsvHandle");
  updateAutoSaveStatusUi();
}

async function restoreAutoSaveCsvHandle() {
  try {
    const handle = await idbGet("autoSaveCsvHandle");
    if (!handle) return;
    // Permission may need re-grant after reload
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      perm = await handle.requestPermission({ mode: "readwrite" });
    }
    if (perm === "granted") {
      autoSaveCsvHandle = handle;
      autoSaveCsvEnabled = true;
      updateAutoSaveStatusUi();
    } else {
      // Keep handle in IDB but mark off until user re-links / grants
      autoSaveCsvEnabled = false;
      updateAutoSaveStatusUi();
    }
  } catch (e) {
    console.warn("Could not restore CSV auto-save handle", e);
  }
}

function scheduleAutoSaveCsv() {
  if (!autoSaveCsvEnabled || !autoSaveCsvHandle) return;
  clearTimeout(autoSaveDebounceTimer);
  autoSaveDebounceTimer = setTimeout(() => {
    writeAutoSaveCsvNow().then(() => showSaveIndicator());
  }, 400);
}

async function writeAutoSaveCsvNow() {
  if (!autoSaveCsvEnabled || !autoSaveCsvHandle) return;
  try {
    const csv = generateCSVString();
    const writable = await autoSaveCsvHandle.createWritable();
    await writable.write(csv);
    await writable.close();
  } catch (err) {
    console.error("Auto-save CSV failed", err);
    // Permission lost?
    autoSaveCsvEnabled = false;
    updateAutoSaveStatusUi();
  }
}

// ---------------------------------------------------------------------------
// PDF folder — recursive scan
// ---------------------------------------------------------------------------
async function selectPDFFolder() {
  if (!window.showDirectoryPicker) {
    alert("Your browser does not support directory picking. Please use Chrome or Edge.");
    return;
  }
  try {
    localPdfFolderHandle = await window.showDirectoryPicker();
    await idbSet("pdfFolderHandle", localPdfFolderHandle);
    await scanPdfFolderRecursive();
  } catch (err) {
    if (err.name !== "AbortError") console.error(err);
  }
}

async function restorePdfFolderHandle() {
  try {
    const handle = await idbGet("pdfFolderHandle");
    if (!handle) return;
    let perm = await handle.queryPermission({ mode: "read" });
    if (perm !== "granted") {
      perm = await handle.requestPermission({ mode: "read" });
    }
    if (perm === "granted") {
      localPdfFolderHandle = handle;
      await scanPdfFolderRecursive();
    }
  } catch (e) {
    console.warn("Could not restore PDF folder handle", e);
  }
}

/** Recursively walk directory handle; fill pdfFileMap */
async function scanPdfFolderRecursive() {
  pdfFileMap.clear();
  if (!localPdfFolderHandle) return;

  async function walk(dirHandle, relativePath) {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".pdf")) {
        const base = entry.name.replace(/\.pdf$/i, "");
        const key = base.toLowerCase();
        // Prefer first match; deeper paths still stored under basename
        if (!pdfFileMap.has(key)) {
          pdfFileMap.set(key, {
            fileHandle: entry,
            displayName: base,
            fileName: entry.name,
            relativePath: relativePath ? `${relativePath}/${entry.name}` : entry.name,
          });
        }
      } else if (entry.kind === "directory") {
        const nextRel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        try {
          await walk(entry, nextRel);
        } catch (e) {
          console.warn("Skip subfolder", nextRel, e);
        }
      }
    }
  }

  await walk(localPdfFolderHandle, "");
  const count = pdfFileMap.size;
  const status = document.getElementById("pdfStatus");
  if (status) {
    status.classList.remove("hidden");
    status.innerText = `Loaded ${count} PDF(s) incl. subfolders`;
  }
  refreshPartSuggestions();
  render();
}

async function openPDF(partOrFileName) {
  if (!localPdfFolderHandle || pdfFileMap.size === 0) {
    alert("Please select your PDF folder first using the 'PDF Folder' button.");
    return;
  }
  const raw = (partOrFileName || "").trim();
  const base = raw.replace(/\.pdf$/i, "");
  const key = base.toLowerCase();
  const hit = pdfFileMap.get(key);
  if (!hit) {
    alert(`Could not find a PDF matching "${base}" (searched selected folder + subfolders).`);
    return;
  }
  try {
    const file = await hit.fileHandle.getFile();
    const blobUrl = URL.createObjectURL(file);
    window.open(blobUrl, "_blank");
  } catch (err) {
    alert(`Could not open "${hit.relativePath}".`);
    console.error(err);
  }
}

/**
 * Rebuild datalist only with matches for the typed query.
 * Empty query → no options (focus alone does not open a full list).
 */
function refreshPartSuggestions(query) {
  const datalist = document.getElementById("pdfSuggestions");
  if (!datalist) return;
  datalist.innerHTML = "";

  const q = (query == null ? "" : String(query)).trim().toLowerCase();
  if (!q) return; // nothing typed → no suggestions

  const seen = new Set();
  const addOpt = (value) => {
    const v = (value || "").trim();
    if (!v) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    if (!k.includes(q)) return; // only predict matches
    seen.add(k);
    const option = document.createElement("option");
    option.value = v;
    datalist.appendChild(option);
  };

  knownParts.forEach(addOpt);
  for (const { displayName } of pdfFileMap.values()) addOpt(displayName);
}

/** Call from part inputs: only suggest after the user has typed */
function onPartInput(el) {
  if (!el) return;
  refreshPartSuggestions(el.value);
}

// ---------------------------------------------------------------------------
// Undo / dark mode / UI toggles
// ---------------------------------------------------------------------------
function undo() {
  if (undoStack.length === 0) {
    alert("Nothing to undo");
    return;
  }
  const previous = JSON.parse(undoStack.pop());
  ongoingOrders = previous.ongoingOrders || [];
  shippedOrders = previous.shippedOrders || [];
  stagingOrders = previous.stagingOrders || [];
  saveData();
  updateUndoBadge();
  render();
}

function toggleDarkMode() {
  document.documentElement.classList.toggle("dark");
  localStorage.setItem("trackerDarkMode", document.documentElement.classList.contains("dark") ? "1" : "0");
  if (window.lucide) lucide.createIcons();
}

function toggleDateAccordion(dateStr) {
  expandedDates[dateStr] = !expandedDates[dateStr];
  render();
}

function toggleEntrySubmenu(uniqueId) {
  expandedEntries[uniqueId] = !expandedEntries[uniqueId];
  render();
}

function getDayOfWeek(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function getTimestampedFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${importedFileName}_${dateStr}_${timeStr}.csv`;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
function addOrder() {
  const dueDate = document.getElementById("newDueDate").value;
  const wn = document.getElementById("newWN").value;
  const partNo = document.getElementById("newPart").value.trim();
  const po = (document.getElementById("newPO").value || "").trim();
  const qty = parseInt(document.getElementById("newQty").value) || 1;
  const priority = document.getElementById("newPriority").checked;

  if (!dueDate || !partNo) {
    alert("Enter a Due Date and Part Number");
    return;
  }
  if (po && (ongoingOrders.some((o) => o.po && o.po.toLowerCase() === po.toLowerCase()) ||
             shippedOrders.some((s) => s.po && s.po.toLowerCase() === po.toLowerCase()))) {
    alert("That PO is already used. Each order needs a unique PO.");
    return;
  }

  saveState();
  rememberPart(partNo);
  ongoingOrders.push({
    id: "ord_" + Date.now() + Math.random().toString(36).substr(2, 9),
    priority,
    done: false,
    statusType: "normal",
    dueDate,
    wn,
    partNo,
    po,
    qty,
    originalQty: qty,
    scrappedQty: 0,
  });

  saveData();
  render();

  document.getElementById("newPart").value = "";
  document.getElementById("newQty").value = 1;
  document.getElementById("newPO").value = "";
  document.getElementById("newPriority").checked = false;
}

/** Match shipped history to an ongoing order.
 *  1. Same internal id
 *  2. Same non-empty PO
 *  3. Fallback for old rows with no PO: part + due + W/N + original qty
 */
function findExistingShipped(order) {
  if (order.id) {
    const byId = shippedOrders.find((s) => s.id === order.id);
    if (byId) return byId;
  }
  const po = (order.po || "").trim().toLowerCase();
  if (po) {
    return shippedOrders.find((s) => (s.po || "").trim().toLowerCase() === po);
  }
  const orig = order.originalQty || order.qty;
  return shippedOrders.find(
    (s) =>
      !(s.po && s.po.trim()) &&
      s.partNo === order.partNo &&
      s.dueDate === order.dueDate &&
      s.wn === order.wn &&
      (s.originalQty || s.qty) === orig &&
      s.statusType !== "completed_partial"
  );
}

function deleteOrder(index, isShipped, subIndex = null) {
  if (!confirm("Are you sure you want to delete this record?")) return;
  saveState();

  if (isShipped) {
    const record = shippedOrders[index];
    if (subIndex !== null && record.subRecords) {
      record.subRecords.splice(subIndex, 1);
      if (record.subRecords.length === 0) shippedOrders.splice(index, 1);
    } else {
      shippedOrders.splice(index, 1);
    }
  } else {
    ongoingOrders.splice(index, 1);
  }

  saveData();
  render();
}

function shipOrder(index) {
  // Stage full remaining qty (does not go to history yet)
  saveState();
  const order = ongoingOrders[index];
  if (!order.id) order.id = "ord_" + Date.now() + Math.random().toString(36).substr(2, 9);
  stagingOrders.push({
    id: order.id,
    priority: order.priority,
    dueDate: order.dueDate,
    wn: order.wn,
    partNo: order.partNo,
    po: order.po || "",
    qty: order.qty,
    originalQty: order.originalQty || order.qty,
    scrapLog: order.scrapLog || [],
  });
  ongoingOrders.splice(index, 1);
  saveData();
  render();
}

function shipPartialOrder(index) {
  const order = ongoingOrders[index];
  if (!order.id) order.id = "ord_" + Date.now() + Math.random().toString(36).substr(2, 9);
  const qtyToShip = prompt(`Qty to stage (remaining ${order.qty}):`, Math.floor(order.qty / 2));
  if (qtyToShip === null) return;
  const parsedQty = parseInt(qtyToShip);
  if (isNaN(parsedQty) || parsedQty <= 0 || parsedQty > order.qty) {
    alert("Enter a valid quantity.");
    return;
  }
  saveState();
  stagingOrders.push({
    id: order.id,
    priority: order.priority,
    dueDate: order.dueDate,
    wn: order.wn,
    partNo: order.partNo,
    po: order.po || "",
    qty: parsedQty,
    originalQty: order.originalQty || order.qty,
    scrapLog: order.scrapLog || [],
  });
  order.scrapLog = [];
  order.qty -= parsedQty;
  order.statusType = "partial";
  if (order.qty <= 0) ongoingOrders.splice(index, 1);
  saveData();
  render();
}

function confirmShipFromStaging(index) {
  saveState();
  const item = stagingOrders[index];
  if (!item) return;
  const today = new Date().toISOString().split("T")[0];
  const fakeOrder = {
    id: item.id,
    priority: item.priority,
    dueDate: item.dueDate,
    wn: item.wn,
    partNo: item.partNo,
    po: item.po || "",
    qty: item.qty,
    originalQty: item.originalQty || item.qty,
  };
  let existingRecord = findExistingShipped(fakeOrder);
  if (existingRecord) {
    if (!existingRecord.subRecords) existingRecord.subRecords = [];
    if (existingRecord.subRecords.length === 0 && existingRecord.qty) {
      existingRecord.subRecords.push({ type: "shipped", date: existingRecord.shippedDate || today, qty: existingRecord.qty });
    }
    existingRecord.subRecords.push({ type: "shipped", date: today, qty: item.qty });
    existingRecord.shippedDate = today;
    existingRecord.po = item.po || existingRecord.po || "";
    existingRecord.id = item.id;
    const totalAccounted = existingRecord.subRecords.reduce((acc, s) => acc + s.qty, 0);
    if (totalAccounted >= (existingRecord.originalQty || item.originalQty || item.qty)) {
      existingRecord.statusType = "completed_partial";
    }
  } else {
    const scrapSubs = (item.scrapLog || []).map((s) => ({
      type: "scrapped",
      scrapType: s.type,
      date: s.date,
      qty: s.qty,
    }));
    const shipSub = { type: "shipped", date: today, qty: item.qty };
    const subs = scrapSubs.length ? [...scrapSubs, shipSub] : null;
    shippedOrders.push({
      id: item.id,
      priority: item.priority,
      statusType: scrapSubs.length ? "completed_partial" : "normal",
      dueDate: item.dueDate,
      shippedDate: today,
      wn: item.wn,
      partNo: item.partNo,
      po: item.po || "",
      qty: item.qty,
      originalQty: item.originalQty || item.qty,
      subRecords: subs,
    });
  }
  stagingOrders.splice(index, 1);
  saveData();
  render();
}

function shipStagingByWn(wn) {
  const indexes = stagingOrders.map((o, i) => (o.wn === wn ? i : -1)).filter((i) => i >= 0).reverse();
  if (!indexes.length) { alert(`Nothing in the queue for ${wn}.`); return; }
  indexes.forEach((i) => confirmShipFromStaging(i));
}

function returnFromStaging(index) {
  saveState();
  const item = stagingOrders[index];
  if (!item) return;
  let target = ongoingOrders.find((o) => o.id === item.id);
  if (target) {
    target.qty += item.qty;
    if (target.qty >= (target.originalQty || target.qty)) target.statusType = "normal";
  } else {
    ongoingOrders.push({
      id: item.id,
      priority: item.priority,
      done: false,
      statusType: "normal",
      dueDate: item.dueDate,
      wn: item.wn,
      partNo: item.partNo,
      po: item.po || "",
      qty: item.qty,
      originalQty: item.originalQty || item.qty,
      scrapLog: item.scrapLog || [],
    });
  }
  stagingOrders.splice(index, 1);
  saveData();
  render();
}

function renderStaging() {
  const table = document.getElementById("stagingTable");
  if (!table) return;
  if (!stagingOrders.length) {
    table.innerHTML = `<tr><td colspan="7" class="text-center text-slate-400 py-4 text-sm">Queue empty — click Ship on an ongoing order to stage it</td></tr>`;
    return;
  }
  table.innerHTML = stagingOrders.map((item, index) => `
    <tr>
      <td>${item.dueDate || ""}</td>
      <td>${item.wn || ""}</td>
      <td>${(item.partNo || "").replace(/</g, "<")}</td>
      <td>${(item.po || "").replace(/</g, "<")}</td>
      <td>${item.qty}${(item.scrapLog || []).reduce((a, s) => a + (s.qty || 0), 0) ? `<div class="text-[11px] font-bold text-rose-600">scrap ${(item.scrapLog || []).reduce((a, s) => a + (s.qty || 0), 0)}</div>` : ""}</td>
      <td><button class="btn-action btn-ship btn-trendy" onclick="confirmShipFromStaging(${index})">Ship</button></td>
      <td><button class="btn-action btn-return btn-trendy" onclick="returnFromStaging(${index})">Return</button></td>
    </tr>`).join("");
}

function printBOL() {
  const section = document.getElementById("bolSection");
  const preview = document.getElementById("bolPreview");
  if (!section || !preview) return;
  if (!stagingOrders.length) {
    alert("Shipping queue is empty. Stage orders first.");
    return;
  }
  const byWn = { Wolfsteel: [], NAC: [] };
  stagingOrders.forEach((o) => byWn[o.wn === "NAC" ? "NAC" : "Wolfsteel"].push(o));
  let html = "";
  ["Wolfsteel", "NAC"].forEach((wn) => {
    const list = byWn[wn];
    if (!list.length) return;
    html += `<div><div class="font-display font-extrabold text-base text-slate-900 mb-1">${wn}</div>`;
    list.forEach((o) => {
      html += `<div>${o.qty} &nbsp; ${o.partNo || ""} &nbsp; ${o.po || ""}</div>`;
    });
    html += `</div>`;
  });
  if (!html) html = `<div class="text-slate-400">Nothing to write.</div>`;
  preview.innerHTML = html;
  section.classList.remove("hidden");
  section.scrollIntoView({ behavior: "smooth", block: "start" });
  if (window.lucide) lucide.createIcons();
}

function closeBOL() {
  const section = document.getElementById("bolSection");
  if (section) section.classList.add("hidden");
}

let scrapTargetIndex = null;
let scrapLines = [];

function openScrapModal(index) {
  const order = ongoingOrders[index];
  if (!order) return;
  scrapTargetIndex = index;
  scrapLines = [];
  const label = (order.po && order.po.trim()) ? `PO ${order.po}` : `${order.partNo || "order"} (no PO)`;
  document.getElementById("scrapModalTitle").textContent = `Scrap Entry For order ${label}`;
  document.getElementById("scrapModalSub").textContent = `${order.partNo || ""} · remaining ${order.qty} · original ${order.originalQty || order.qty}`;
  document.getElementById("scrapTypeInput").value = "";
  document.getElementById("scrapQtyInput").value = order.qty;
  document.getElementById("scrapModal").classList.remove("hidden");
  renderScrapLines();
  setTimeout(() => document.getElementById("scrapTypeInput").focus(), 30);
}

function closeScrapModal() {
  scrapTargetIndex = null;
  scrapLines = [];
  document.getElementById("scrapModal").classList.add("hidden");
}

function scrapLinesTotal() {
  return scrapLines.reduce((a, l) => a + l.qty, 0);
}

function renderScrapLines() {
  const el = document.getElementById("scrapLineList");
  const hint = document.getElementById("scrapRemainingHint");
  const order = scrapTargetIndex != null ? ongoingOrders[scrapTargetIndex] : null;
  const used = scrapLinesTotal();
  const remain = order ? Math.max(0, order.qty - used) : 0;
  if (el) {
    el.innerHTML = scrapLines.length
      ? scrapLines.map((l, i) => `<div class="flex items-center justify-between px-3 py-1.5 rounded-xl bg-cream-100 border border-cream-200"><span>${l.qty} × ${l.type}</span><button class="text-rose-600 text-xs font-bold" onclick="removeScrapLine(${i})">remove</button></div>`).join("")
      : `<div class="text-slate-400 text-xs">No scrap lines yet — add type and amount</div>`;
  }
  if (hint && order) hint.textContent = `Queued ${used} · still available ${remain} of ${order.qty}`;
}

function addScrapLine() {
  if (scrapTargetIndex == null) return;
  const order = ongoingOrders[scrapTargetIndex];
  if (!order) return;
  const type = (document.getElementById("scrapTypeInput").value || "scrap").trim();
  const qty = parseInt(document.getElementById("scrapQtyInput").value);
  if (isNaN(qty) || qty <= 0) { alert("Enter an amount greater than 0."); return; }
  if (scrapLinesTotal() + qty > order.qty) {
    alert(`Only ${order.qty - scrapLinesTotal()} left to scrap on this order.`);
    return;
  }
  scrapLines.push({ type, qty });
  document.getElementById("scrapTypeInput").value = "";
  document.getElementById("scrapQtyInput").value = Math.max(1, order.qty - scrapLinesTotal());
  renderScrapLines();
  document.getElementById("scrapTypeInput").focus();
}

function removeScrapLine(i) {
  scrapLines.splice(i, 1);
  renderScrapLines();
}

function confirmScrap() {
  if (scrapTargetIndex == null) return;
  const order = ongoingOrders[scrapTargetIndex];
  if (!order) { closeScrapModal(); return; }
  // If they typed a line but didn't click Add, include it
  const typedType = (document.getElementById("scrapTypeInput").value || "").trim();
  const typedQty = parseInt(document.getElementById("scrapQtyInput").value);
  if (typedType && !isNaN(typedQty) && typedQty > 0 && scrapLinesTotal() + typedQty <= order.qty) {
    scrapLines.push({ type: typedType, qty: typedQty });
  }
  if (!scrapLines.length) { alert("Add at least one scrap line."); return; }
  const index = scrapTargetIndex;
  const lines = scrapLines.slice();
  closeScrapModal();
  applyScrapLines(index, lines);
}

function applyScrapLines(index, lines) {
  const order = ongoingOrders[index];
  if (!order) return;
  if (!order.id) order.id = "ord_" + Date.now() + Math.random().toString(36).substr(2, 9);
  if (!order.scrapLog) order.scrapLog = [];
  const origTotal = order.originalQty || order.qty;
  const totalScrap = lines.reduce((a, l) => a + l.qty, 0);
  if (totalScrap <= 0 || totalScrap > order.qty) return;

  saveState();
  const today = new Date().toISOString().split("T")[0];
  lines.forEach((l) => order.scrapLog.push({ type: l.type || "scrap", date: today, qty: l.qty }));
  order.qty -= totalScrap;
  order.originalQty = origTotal;
  order.statusType = "partial";

  // Only write a history row if nothing is left to ship.
  // Otherwise scrap stays on the order and is attached when it is actually shipped.
  if (order.qty <= 0) {
    const subs = order.scrapLog.map((s) => ({
      type: "scrapped",
      scrapType: s.type,
      date: s.date,
      qty: s.qty,
    }));
    shippedOrders.push({
      id: order.id,
      priority: order.priority,
      statusType: "completed_partial",
      dueDate: order.dueDate,
      shippedDate: today,
      wn: order.wn,
      partNo: order.partNo,
      po: order.po || "",
      qty: origTotal,
      originalQty: origTotal,
      subRecords: subs,
    });
    ongoingOrders.splice(index, 1);
  }

  saveData();
  render();
}

function returnOrder(index, subIndex) {
  saveState();
  const record = shippedOrders[index];
  const sub = record.subRecords[subIndex];

  let targetOngoing = ongoingOrders.find((o) => o.id === record.id);

  if (targetOngoing) {
    targetOngoing.qty += sub.qty;
    if (targetOngoing.qty >= targetOngoing.originalQty) {
      targetOngoing.statusType = "normal";
    }
  } else {
    const restoredQty = sub.qty;
    const origTotal = record.originalQty;
    ongoingOrders.push({
      id: record.id,
      priority: record.priority,
      statusType: restoredQty >= origTotal ? "normal" : "partial",
      dueDate: record.dueDate,
      wn: record.wn,
      partNo: record.partNo,
      po: record.po || "",
      qty: restoredQty,
      originalQty: origTotal,
    });
  }

  record.subRecords.splice(subIndex, 1);

  const totalAccounted = record.subRecords.reduce((acc, s) => acc + s.qty, 0);
  if (totalAccounted < record.originalQty) {
    record.statusType = "partial";
  }

  if (record.subRecords.length === 0) {
    shippedOrders.splice(index, 1);
  }

  saveData();
  render();
}

function updateOngoing(index, field, value) {
  saveState();
  if (field === "qty") {
    const raw = String(value).split("/")[0].trim();
    ongoingOrders[index][field] = parseInt(raw) || 0;
    ongoingOrders[index]["originalQty"] = ongoingOrders[index][field];
    ongoingOrders[index]["statusType"] = "normal";
  } else if (field === "partNo") {
    ongoingOrders[index][field] = value;
    rememberPart(value);
  } else {
    ongoingOrders[index][field] = value;
  }
  saveData();
  render();
}

function updateShipped(index, field, value) {
  saveState();
  if (field === "partNo") rememberPart(value);
  shippedOrders[index][field] = value;
  saveData();
  render();
}

function sortOngoing() {
  ongoingOrders.sort((a, b) => {
    if (a.priority && !b.priority) return -1;
    if (!a.priority && b.priority) return 1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });
}

function sortShipped() {
  shippedOrders.sort((a, b) => new Date(b.shippedDate) - new Date(a.shippedDate));
}

function getPreviousBusinessDay(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().split("T")[0];
}

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

/** Compare YYYY-MM-DD as local calendar days */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = new Date(todayISO() + "T00:00:00");
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  return Math.round((d - t) / 86400000);
}

/**
 * Urgency based on ship-by date (previous business day before due).
 * overdue: ship-by < today
 * due-soon: ship-by === today (or within 0 days)
 */
function getOrderUrgency(order) {
  if (!order?.dueDate) return { level: "ok", shipBy: "" };
  const shipBy = getPreviousBusinessDay(order.dueDate);
  const delta = daysUntil(shipBy);
  if (delta === null) return { level: "ok", shipBy };
  if (delta < 0) return { level: "overdue", shipBy, delta };
  if (delta === 0) return { level: "due-soon", shipBy, delta };
  return { level: "ok", shipBy, delta };
}

function hasPdfMatch(partNo) {
  if (!partNo || pdfFileMap.size === 0) return null; // null = folder not loaded
  const key = String(partNo).trim().replace(/\.pdf$/i, "").toLowerCase();
  return pdfFileMap.has(key);
}

function pdfStatusHtml(partNo) {
  const match = hasPdfMatch(partNo);
  if (match === null) return ""; // no folder selected
  if (match) return `<span class="pdf-found">PDF ✓</span>`;
  return `<span class="pdf-missing">No PDF</span>`;
}

function toggleDensity() {
  document.documentElement.classList.toggle("compact");
  const on = document.documentElement.classList.contains("compact");
  localStorage.setItem("trackerCompact", on ? "1" : "0");
  const label = document.getElementById("densityLabel");
  if (label) label.textContent = on ? "Comfort" : "Compact";
  if (window.lucide) lucide.createIcons();
}

function updateShipByDayStrip() {
  const strip = document.getElementById("shipByDayStrip");
  if (!strip) return;

  const counts = {};
  ongoingOrders.forEach((o) => {
    if (!o.dueDate) return;
    const shipBy = getPreviousBusinessDay(o.dueDate);
    if (!counts[shipBy]) counts[shipBy] = 0;
    counts[shipBy]++;
  });

  const dates = Object.keys(counts).sort();
  if (!dates.length) {
    strip.innerHTML = `<span class="text-xs text-slate-400">No ongoing orders</span>`;
    return;
  }

  const today = todayISO();
  strip.innerHTML = dates
    .map((d) => {
      const day = getDayOfWeek(d);
      const n = counts[d];
      let cls = "shipby-chip";
      if (d < today) cls += " overdue";
      else if (d === today) cls += " today";
      const label = d === today ? "Today" : d < today ? "Overdue" : day;
      return `<span class="${cls}" title="Ship by ${d}"><strong>${label}</strong> ${d.slice(5)} · ${n} order${n === 1 ? "" : "s"}</span>`;
    })
    .join("");
}

/** Monday → Sunday of the current local week */
function getCurrentWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0 Sun … 6 Sat
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const toISO = (d) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  return { start: toISO(monday), end: toISO(sunday) };
}

function isShippedThisWeek(order) {
  // Keep open partials visible so scrap/ship history doesn't disappear
  if (order.statusType === "partial") return true;
  const { start, end } = getCurrentWeekRange();
  const dates = [order.shippedDate];
  if (order.subRecords) order.subRecords.forEach((s) => dates.push(s.date));
  return dates.some((d) => d && d >= start && d <= end);
}

function updateStats() {
  const ongoingCount = ongoingOrders.length;
  const priorityCount = ongoingOrders.filter((o) => o.priority).length;
  const partialCount = ongoingOrders.filter((o) => o.statusType === "partial").length;
  const shippedCount = shippedOrders.filter((o) => isShippedThisWeek(o)).length;
  const overdueCount = ongoingOrders.filter((o) => getOrderUrgency(o).level === "overdue").length;

  const el = (id) => document.getElementById(id);
  if (el("statOngoing")) el("statOngoing").textContent = ongoingCount;
  if (el("statPriority")) el("statPriority").textContent = priorityCount;
  if (el("statPartial")) el("statPartial").textContent = partialCount;
  if (el("statShipped")) el("statShipped").textContent = shippedCount;
  if (el("statOverdue")) el("statOverdue").textContent = overdueCount;
  updateShipByDayStrip();
}

function render() {
  sortOngoing();
  sortShipped();
  updateStats();
  updateUndoBadge();
  refreshPartSuggestions();
  renderStaging();

  const search = (document.getElementById("searchBox")?.value || "").toLowerCase();
  const ongoingTable = document.getElementById("ongoingTable");
  const shippedTable = document.getElementById("shippedTable");
  if (!ongoingTable || !shippedTable) return;

  ongoingTable.innerHTML = "";
  shippedTable.innerHTML = "";

  let lastShipByDate = "";

  ongoingOrders.forEach((order, index) => {
    const text = JSON.stringify(order).toLowerCase();
    if (search && !text.includes(search)) return;

    const shipByDate = getPreviousBusinessDay(order.dueDate);
    const shipByDayOfWeek = getDayOfWeek(shipByDate);

    if (lastShipByDate !== shipByDate) {
      ongoingTable.innerHTML += `
        <tr class="separator-row">
          <td colspan="11" class="rounded-lg">
            Ship By: ${shipByDate} (${shipByDayOfWeek}) — Due: ${order.dueDate} (${getDayOfWeek(order.dueDate)})
          </td>
        </tr>`;
      lastShipByDate = shipByDate;
    }

    const urgency = getOrderUrgency(order);
    const rowClasses = [];
    if (order.priority) rowClasses.push("priority-row");
    if (order.done) rowClasses.push("done-row");
    if (order.statusType === "partial") rowClasses.push("partial-row");
    if (urgency.level === "overdue") rowClasses.push("overdue-row");
    else if (urgency.level === "due-soon") rowClasses.push("due-soon-row");

    const dueDay = getDayOfWeek(order.dueDate);
    const origTotal = order.originalQty || order.qty;
    const qtyDisplay =
      order.statusType === "partial" || (order.scrappedQty && order.scrappedQty > 0)
        ? `${order.qty}/${origTotal}`
        : order.qty;
    const badgeLabel = order.statusType === "partial" ? "P" : "";
    const urgencyBadge =
      urgency.level === "overdue"
        ? `<span class="overdue-badge">Overdue</span>`
        : urgency.level === "due-soon"
          ? `<span class="due-soon-badge">Ship today</span>`
          : "";

    const partEsc = (order.partNo || "").replace(/'/g, "\\'");
    const pdfMatch = hasPdfMatch(order.partNo);
    const pdfHtml =
      pdfMatch === true
        ? `<span class="pdf-link" onclick="event.stopPropagation(); openPDF('${partEsc}')">📄 Open PDF</span> ${pdfStatusHtml(order.partNo)}`
        : pdfMatch === false
          ? `${pdfStatusHtml(order.partNo)}`
          : `<span class="pdf-link" onclick="event.stopPropagation(); openPDF('${partEsc}')">📄 Open PDF</span>`;

    const scrapTotal = (order.scrapLog || []).reduce((a, s) => a + (s.qty || 0), 0);
    const scrapHtml = scrapTotal > 0
      ? `<div class="text-[11px] font-bold text-rose-600 mt-0.5">scrap ${scrapTotal}</div>`
      : "";

    ongoingTable.innerHTML += `
      <tr class="${rowClasses.join(" ")}">
        <td class="text-center">
          <input type="checkbox" class="rounded border-slate-300" ${order.priority ? "checked" : ""} onchange="updateOngoing(${index}, 'priority', this.checked)">
        </td>
        <td class="text-center">
          <input type="checkbox" class="rounded border-slate-300" ${order.done ? "checked" : ""} onchange="updateOngoing(${index}, 'done', this.checked)">
        </td>
        <td class="text-center">
          <strong class="text-peach-600">${badgeLabel}</strong>
        </td>
        <td>
          <div class="flex items-center gap-1.5 flex-wrap">
            <input type="date" value="${order.dueDate}" onchange="updateOngoing(${index}, 'dueDate', this.value)">
            <span class="day-badge">${dueDay}</span>
            ${urgencyBadge}
          </div>
        </td>
        <td>
          <select onchange="updateOngoing(${index}, 'wn', this.value)">
            <option ${order.wn === "Wolfsteel" ? "selected" : ""}>Wolfsteel</option>
            <option ${order.wn === "NAC" ? "selected" : ""}>NAC</option>
          </select>
        </td>
        <td>
          <input type="text" value="${(order.partNo || "").replace(/"/g, "&quot;")}" onchange="updateOngoing(${index}, 'partNo', this.value)" oninput="onPartInput(this)" list="pdfSuggestions" autocomplete="off" class="w-full min-w-[120px]">
          <br>${pdfHtml}
        </td>
        <td>
          <input type="text" value="${order.po || ""}" onchange="updateOngoing(${index}, 'po', this.value)" placeholder="PO #" class="w-24">
          ${!(order.po && String(order.po).trim()) ? '<div class="no-po-badge">Add PO</div>' : ""}
        </td>
        <td>
          <input type="text" value="${qtyDisplay}" onchange="updateOngoing(${index}, 'qty', this.value)" class="w-20">
          ${scrapHtml}
        </td>
        <td>
          <button class="btn-action btn-ship btn-trendy" onclick="shipOrder(${index})">Ship</button>
        </td>
        <td>
          <button class="btn-action btn-partial btn-trendy" onclick="shipPartialOrder(${index})">Partial</button>
        </td>
        <td>
          <button class="btn-action btn-scrap btn-trendy" onclick="openScrapModal(${index})">Scrap</button>
        </td>
        <td>
          <button class="btn-action btn-delete btn-trendy" onclick="deleteOrder(${index}, false)">Del</button>
        </td>
      </tr>`;
  });

  const shippedByDate = {};
  let shippedThisWeekVisible = 0;
  shippedOrders.forEach((order, index) => {
    // History panel: only current week (Mon–Sun local)
    if (!isShippedThisWeek(order)) return;
    const text = JSON.stringify(order).toLowerCase();
    if (search && !text.includes(search)) return;
    const dateKey = order.shippedDate;
    if (!shippedByDate[dateKey]) shippedByDate[dateKey] = [];
    shippedByDate[dateKey].push({ order, index });
    shippedThisWeekVisible++;
  });

  if (shippedThisWeekVisible === 0) {
    const { start, end } = getCurrentWeekRange();
    shippedTable.innerHTML = `
      <tr>
        <td colspan="9" class="text-center text-slate-400 py-6 text-sm">
          No shipments this week (${start} → ${end}). Older history is still in local data / CSV export.
        </td>
      </tr>`;
  }

  Object.keys(shippedByDate)
    .sort()
    .reverse()
    .forEach((dateKey) => {
      const isOpen = expandedDates[dateKey] !== false;
      const dateArrow = isOpen ? "▼" : "▶";
      const dayName = getDayOfWeek(dateKey);

      shippedTable.innerHTML += `
        <tr class="separator-row" onclick="toggleDateAccordion('${dateKey}')">
          <td colspan="9" class="rounded-lg">
            ${dateArrow} Shipped Date: ${dateKey} (${dayName})
          </td>
        </tr>`;

      if (isOpen) {
        shippedByDate[dateKey].forEach((item) => {
          const order = item.order;
          const index = item.index;
          const hasSubRecords = order.subRecords && order.subRecords.length > 0;
          const isPartiallyActive = order.statusType === "partial";

          const rowClass = isPartiallyActive ? "partial-row" : "shipped-row";
          const badge = isPartiallyActive ? "P" : hasSubRecords ? "Done" : "";
          const dueDay = getDayOfWeek(order.dueDate);

          let qtyDisplay = order.qty;
          if (hasSubRecords) {
            const totalShipped = order.subRecords
              .filter((s) => s.type === "shipped")
              .reduce((acc, s) => acc + s.qty, 0);
            qtyDisplay = isPartiallyActive
              ? `${totalShipped}/${order.originalQty}`
              : `${totalShipped}/${order.originalQty} (Completed)`;
          }

          const partEsc = (order.partNo || "").replace(/'/g, "\\'");
          const pdfMatch = hasPdfMatch(order.partNo);
          const pdfHtml =
            pdfMatch === true
              ? `<span class="pdf-link" onclick="event.stopPropagation(); openPDF('${partEsc}')">📄 Open PDF</span> ${pdfStatusHtml(order.partNo)}`
              : pdfMatch === false
                ? `${pdfStatusHtml(order.partNo)}`
                : `<span class="pdf-link" onclick="event.stopPropagation(); openPDF('${partEsc}')">📄 Open PDF</span>`;

          const scrapTotal = (order.subRecords || [])
            .filter((s) => s.type === "scrapped")
            .reduce((a, s) => a + (s.qty || 0), 0);
          const scrapHtml = scrapTotal > 0
            ? `<div class="text-[11px] font-bold text-rose-600 mt-0.5">scrap ${scrapTotal}</div>`
            : "";
          const isSubOpen = expandedEntries[uniqueSubId];
          const subArrow = isSubOpen ? "▼" : "▶";

          shippedTable.innerHTML += `
            <tr class="${rowClass} ${hasSubRecords ? "clickable-row" : ""}" ${
            hasSubRecords ? `onclick="toggleEntrySubmenu('${uniqueSubId}')"` : ""
          }>
              <td class="text-center">
                <input type="checkbox" class="rounded border-slate-300" ${order.priority ? "checked" : ""} onclick="event.stopPropagation()" onchange="updateShipped(${index}, 'priority', this.checked)">
              </td>
              <td class="text-center">
                <strong class="text-sage-700">${hasSubRecords ? subArrow + " " + badge : badge}</strong>
              </td>
              <td>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <input type="date" value="${order.dueDate}" onclick="event.stopPropagation()" onchange="updateShipped(${index}, 'dueDate', this.value)">
                  <span class="day-badge">${dueDay}</span>
                </div>
              </td>
              <td>
                <input type="date" value="${order.shippedDate}" onclick="event.stopPropagation()" onchange="updateShipped(${index}, 'shippedDate', this.value)">
              </td>
              <td>
                <select onclick="event.stopPropagation()" onchange="updateShipped(${index}, 'wn', this.value)">
                  <option ${order.wn === "Wolfsteel" ? "selected" : ""}>Wolfsteel</option>
                  <option ${order.wn === "NAC" ? "selected" : ""}>NAC</option>
                </select>
              </td>
              <td>
                <input type="text" value="${(order.partNo || "").replace(/"/g, "&quot;")}" onclick="event.stopPropagation()" onchange="updateShipped(${index}, 'partNo', this.value)" oninput="onPartInput(this)" list="pdfSuggestions" autocomplete="off" class="w-full min-w-[120px]">
                <br>${pdfHtml}
              </td>
              <td>
                <input type="text" value="${order.po || ""}" onclick="event.stopPropagation()" onchange="updateShipped(${index}, 'po', this.value)" placeholder="PO #" class="w-24">
                ${!(order.po && order.po.trim()) ? '<div class="no-po-badge">Add PO</div>' : ""}
              </td>
              <td>
                <input type="text" value="${qtyDisplay}" onclick="event.stopPropagation()" onchange="updateShipped(${index}, 'qty', this.value)" class="w-28">
                ${scrapHtml}
              </td>
              <td>
                <button class="btn-action btn-return btn-trendy" ${hasSubRecords ? 'style="display:none;"' : ""} onclick="event.stopPropagation(); returnOrder(${index}, 0)">Return</button>
              </td>
              <td>
                <button class="btn-action btn-delete btn-trendy" onclick="event.stopPropagation(); deleteOrder(${index}, true)">Del</button>
              </td>
            </tr>`;

          if (hasSubRecords && isSubOpen) {
            order.subRecords.forEach((sub, subIdx) => {
              const subTypeLabel = sub.type === "scrapped" ? `🔴 Scrapped${sub.scrapType ? " · " + sub.scrapType : ""}` : "🟢 Shipped";
              shippedTable.innerHTML += `
                <tr class="sub-row">
                  <td></td>
                  <td class="text-center"><strong>${subTypeLabel}</strong></td>
                  <td colspan="2">Date: ${sub.date}</td>
                  <td colspan="2">Qty: <strong>${sub.qty}</strong></td>
                  <td></td>
                  <td>
                    <button class="btn-action btn-return btn-trendy" style="padding:0.25rem 0.5rem;font-size:0.65rem" onclick="returnOrder(${index}, ${subIdx})">Return</button>
                  </td>
                  <td>
                    <button class="btn-action btn-delete btn-trendy" style="padding:0.25rem 0.5rem;font-size:0.65rem" onclick="deleteOrder(${index}, true, ${subIdx})">Remove</button>
                  </td>
                </tr>`;
            });
          }
        });
      }
    });

  if (window.lucide) lucide.createIcons();
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
function generateCSVString() {
  let csv =
    "Table,Priority,Status,Due Date,Activity Date,Works/Network,Part Number,Quantity Shipped,Original Quantity,Event Type,PO\n";

  ongoingOrders.forEach((order) => {
    csv +=
      [
        "Ongoing",
        order.priority ? "Yes" : "No",
        order.statusType === "partial" ? "Partial" : "Normal",
        order.dueDate,
        "",
        `"${order.wn || ""}"`,
        `"${(order.partNo || "").replace(/"/g, '""')}"`,
        order.qty,
        order.originalQty || order.qty,
        "Active",
        `"${(order.po || "").replace(/"/g, '""')}"`,
      ].join(",") + "\n";
  });

  shippedOrders.forEach((order) => {
    if (order.subRecords && order.subRecords.length > 0) {
      order.subRecords.forEach((sub) => {
        csv +=
          [
            "History",
            order.priority ? "Yes" : "No",
            order.statusType === "partial" ? "Partial (Active)" : "Completed",
            order.dueDate,
            sub.date,
            `"${order.wn || ""}"`,
            `"${(order.partNo || "").replace(/"/g, '""')}"`,
            sub.qty,
            order.originalQty,
            sub.type === "scrapped" ? "Scrap" : "Partial Shipment",
          ].join(",") + "\n";
      });
    } else {
      csv +=
        [
          "History",
          order.priority ? "Yes" : "No",
          "Full Shipped",
          order.dueDate,
          order.shippedDate,
          `"${order.wn || ""}"`,
          `"${(order.partNo || "").replace(/"/g, '""')}"`,
          order.qty,
          order.originalQty || order.qty,
          "Full Ship",
          `"${(order.po || "").replace(/"/g, '""')}"`,
        ].join(",") + "\n";
    }
  });

  // Appendix: known parts for easy re-import / reference
  if (knownParts.length) {
    csv += "\n# Known Part Numbers (autocomplete reference — not order rows)\n";
    knownParts.forEach((p) => {
      csv += `KnownPart,,,,,,,,,,"${String(p).replace(/"/g, '""')}"\n`;
    });
  }

  return "\ufeff" + csv;
}

async function exportCSV() {
  const csv = generateCSVString();
  const filename = getTimestampedFilename();

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "CSV Files", accept: { "text/csv": [".csv"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(csv);
      await writable.close();
      return;
    } catch (err) {
      if (err.name !== "AbortError") console.error(err);
      else return;
    }
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseCsvRow(rowStr) {
  const values = [];
  let inQuotes = false;
  let currentVal = "";
  for (const char of rowStr) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(currentVal);
      currentVal = "";
    } else {
      currentVal += char;
    }
  }
  values.push(currentVal);
  return values;
}

function stripQuotes(s) {
  return String(s || "")
    .replace(/^"|"$/g, "")
    .trim();
}

function parsePriorityFlag(v) {
  const s = String(v || "")
    .trim()
    .toLowerCase();
  return s === "yes" || s === "true" || s === "1";
}

function parseDoneFlag(v) {
  const s = String(v || "")
    .trim()
    .toLowerCase();
  return s === "yes" || s === "true" || s === "1";
}

/** Detect legacy schema: table,priority,done,dueDate,shippedDate,wn,partNo,qty */
function isLegacyCsvHeader(headerCells) {
  const h = headerCells.map((c) => stripQuotes(c).toLowerCase());
  const joined = h.join(",");
  // Classic Nov 2026-style export
  if (h[0] === "table" && h.includes("duedate") && h.includes("partno") && h.includes("qty")) {
    return true;
  }
  // Heuristic: short header without Event Type / Original Quantity
  if (
    h[0] === "table" &&
    !joined.includes("event type") &&
    !joined.includes("eventtype") &&
    !joined.includes("original quantity") &&
    !joined.includes("originalquantity")
  ) {
    return true;
  }
  return false;
}

function processLegacyCSV(rows) {
  // rows[0] = header; data from 1..
  const header = parseCsvRow(rows[0]).map((c) => stripQuotes(c).toLowerCase());
  const idx = (name) => header.indexOf(name);

  const iTable = idx("table");
  const iPriority = idx("priority");
  const iDone = idx("done");
  const iDue = idx("duedate");
  const iShipped = idx("shippeddate");
  const iWn = idx("wn");
  const iPart = idx("partno");
  const iQty = idx("qty");

  for (let i = 1; i < rows.length; i++) {
    const rowStr = rows[i];
    if (!rowStr.trim() || rowStr.trim().startsWith("#")) continue;
    const values = parseCsvRow(rowStr);
    if (!values.length) continue;

    const tableRaw = stripQuotes(values[iTable >= 0 ? iTable : 0]).toLowerCase();
    const priority = parsePriorityFlag(values[iPriority >= 0 ? iPriority : 1]);
    const done = parseDoneFlag(values[iDone >= 0 ? iDone : 2]);
    const dueDate = stripQuotes(values[iDue >= 0 ? iDue : 3]);
    const shippedDate = stripQuotes(values[iShipped >= 0 ? iShipped : 4]);
    const wn = stripQuotes(values[iWn >= 0 ? iWn : 5]);
    const partNo = stripQuotes(values[iPart >= 0 ? iPart : 6]);
    const qty = parseInt(values[iQty >= 0 ? iQty : 7], 10) || 1;

    if (!partNo) continue;
    rememberPart(partNo);

    if (tableRaw === "ongoing") {
      ongoingOrders.push({
        id: "ord_" + Math.random().toString(36).substr(2, 9),
        priority,
        done,
        statusType: "normal",
        dueDate,
        wn,
        partNo,
        qty,
        originalQty: qty,
      });
    } else if (tableRaw === "shipped" || tableRaw === "history") {
      shippedOrders.push({
        id: "ord_" + Math.random().toString(36).substr(2, 9),
        priority,
        statusType: "normal",
        dueDate,
        shippedDate: shippedDate || dueDate || new Date().toISOString().split("T")[0],
        wn,
        partNo,
        qty,
        originalQty: qty,
        subRecords: null,
      });
    }
  }
}

function processNewFormatCSV(rows) {
  for (let i = 1; i < rows.length; i++) {
    const rowStr = rows[i];
    if (!rowStr.trim() || rowStr.trim().startsWith("#")) continue;

    const values = parseCsvRow(rowStr);
    const tableType = (values[0] || "").trim();

    if (tableType === "KnownPart") {
      const p = stripQuotes(values[10] || values[6] || "");
      if (p) rememberPart(p);
      continue;
    }

    if (values.length < 10) continue;

    const priority = parsePriorityFlag(values[1]);
    const status = (values[2] || "").trim();
    const dueDate = (values[3] || "").trim();
    const actDate = (values[4] || "").trim();
    const wn = stripQuotes(values[5]);
    const partNo = stripQuotes(values[6]);
    const qty = parseInt(values[7], 10) || 1;
    const origQty = parseInt(values[8], 10) || qty;
    const eventType = (values[9] || "").trim();
    const po = stripQuotes(values[10] || "");

    if (partNo) rememberPart(partNo);

    if (tableType === "Ongoing") {
      ongoingOrders.push({
        id: "ord_" + Math.random().toString(36).substr(2, 9),
        priority,
        done: false,
        statusType: status === "Partial" ? "partial" : "normal",
        dueDate,
        wn,
        partNo,
        po,
        qty,
        originalQty: origQty,
      });
    } else {
      const existing = shippedOrders.find(
        (s) =>
          (po && (s.po || "").toLowerCase() === po.toLowerCase()) ||
          (!po && s.partNo === partNo && s.dueDate === dueDate && s.wn === wn)
      );
      const subItem = {
        type: eventType === "Scrap" ? "scrapped" : "shipped",
        date: actDate || new Date().toISOString().split("T")[0],
        qty: qty,
      };

      if (eventType === "Full Ship") {
        shippedOrders.push({
          id: "ord_" + Math.random().toString(36).substr(2, 9),
          priority,
          statusType: "normal",
          dueDate,
          shippedDate: actDate,
          wn,
          partNo,
          po,
          qty,
          originalQty: origQty,
          subRecords: null,
        });
      } else {
        if (existing) {
          if (!existing.subRecords) existing.subRecords = [];
          existing.subRecords.push(subItem);
          if (origQty > existing.originalQty) existing.originalQty = origQty;
        } else {
          shippedOrders.push({
            id: "ord_" + Math.random().toString(36).substr(2, 9),
            priority,
            statusType: status.includes("Completed") ? "completed_partial" : "partial",
            dueDate,
            shippedDate: actDate,
            wn,
            partNo,
            qty: origQty,
            originalQty: origQty,
            subRecords: [subItem],
          });
        }
      }
    }
  }
}

function processCSVContent(content, filename = "OrderTracker") {
  saveState();
  importedFileName = filename.replace(/\.[^/.]+$/, "").replace(/_\d{4}-\d{2}-\d{2}_\d{4}$/, "");

  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  const rows = content.trim().split(/\r?\n/);
  if (rows.length <= 1) return;

  ongoingOrders = [];
  shippedOrders = [];

  const headerCells = parseCsvRow(rows[0]);
  if (isLegacyCsvHeader(headerCells)) {
    processLegacyCSV(rows);
  } else {
    processNewFormatCSV(rows);
  }

  saveData();
  render();
}

function openCSV() {
  document.getElementById("csvFile").click();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  if (localStorage.getItem("trackerDarkMode") === "1") {
    document.documentElement.classList.add("dark");
  }
  if (localStorage.getItem("trackerCompact") === "1") {
    document.documentElement.classList.add("compact");
    const label = document.getElementById("densityLabel");
    if (label) label.textContent = "Comfort";
  }

  harvestPartsFromOrders();
  refreshPartSuggestions();
  await restoreAutoSaveCsvHandle();
  updateAutoSaveStatusUi();
  await restorePdfFolderHandle();

  document.getElementById("csvFile").addEventListener("change", function (event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
      processCSVContent(e.target.result, file.name);
      event.target.value = "";
    };
    reader.readAsText(file);
  });

  render();
  if (window.lucide) lucide.createIcons();
}

document.addEventListener("DOMContentLoaded", init);
