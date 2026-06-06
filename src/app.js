const MODEL_EXTENSIONS = [".glb", ".gltf", ".obj", ".fbx", ".stl", ".ply", ".dae", ".usdz"];
const MODEL_HOST_HINTS = [
  "cdn-models",
  "assets.meshy",
  "amazonaws.com",
  "storage.googleapis.com",
  "cdn.sketchfab.com"
];

const state = {
  models: [],
  targetUrl: "",
  captureSource: ""
};

const els = {
  scanForm: document.querySelector("#scan-form"),
  targetUrl: document.querySelector("#target-url"),
  statusLine: document.querySelector("#status-line"),
  resultCount: document.querySelector("#result-count"),
  resultContext: document.querySelector("#result-context"),
  modelList: document.querySelector("#model-list"),
  rowTemplate: document.querySelector("#model-row-template"),
  openTarget: document.querySelector("#open-target"),
  downloadAll: document.querySelector("#download-all"),
  exportList: document.querySelector("#export-list"),
  toast: document.querySelector("#toast"),
  bookmarkletLink: document.querySelector("#bookmarklet-link"),
  copyBookmarklet: document.querySelector("#copy-bookmarklet"),
  copyBookmarkletInline: document.querySelector("#copy-bookmarklet-inline"),
  copyConsoleScript: document.querySelector("#copy-console-script"),
  tabLink: document.querySelector("#tab-link"),
  tabCapture: document.querySelector("#tab-capture"),
  linkPanel: document.querySelector("#link-panel"),
  capturePanel: document.querySelector("#capture-panel")
};

function setStatus(message, type = "") {
  els.statusLine.textContent = message;
  els.statusLine.classList.toggle("is-warning", type === "warning");
  els.statusLine.classList.toggle("is-error", type === "error");
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.classList.remove("is-visible");
  }, 2400);
}

function normaliseInputUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("URL vide.");
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withProtocol).href;
}

function cleanCandidateUrl(raw) {
  return raw
    .replace(/^["'({\[]+/, "")
    .replace(/[)"'\]},;]+$/g, "")
    .replace(/&amp;/g, "&");
}

function normaliseCandidateUrl(raw, baseUrl) {
  const cleaned = cleanCandidateUrl(raw);
  if (!cleaned) return "";
  try {
    if (cleaned.startsWith("//")) return new URL(`https:${cleaned}`).href;
    return new URL(cleaned, baseUrl).href;
  } catch {
    return "";
  }
}

function getModelExtension(url) {
  const lower = url.toLowerCase();
  return MODEL_EXTENSIONS.find(ext => lower.includes(ext)) || "";
}

function isLikelyModelUrl(url) {
  const lower = url.toLowerCase();
  if (MODEL_EXTENSIONS.some(ext => lower.includes(ext))) return true;
  return MODEL_HOST_HINTS.some(hint => lower.includes(hint)) && lower.includes("signature");
}

function isMeshyPage(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "meshy.ai" || host.endsWith(".meshy.ai");
  } catch {
    return false;
  }
}

function filenameFromUrl(url, index = 1) {
  try {
    const parsed = new URL(url);
    const raw = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
    const withoutQuery = raw.split("?")[0];
    if (withoutQuery && withoutQuery.includes(".")) return sanitizeFilename(withoutQuery);
  } catch {
    // fall through
  }
  const ext = getModelExtension(url) || ".glb";
  return `model_${index}${ext}`;
}

function sanitizeFilename(value) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").slice(0, 120) || "model.glb";
}

function formatCount(count) {
  return `${count} modèle${count > 1 ? "s" : ""}`;
}

function addModel(url, source, meta = {}) {
  if (!url || !isLikelyModelUrl(url)) return false;
  if (state.models.some(model => model.url === url)) return false;
  const index = state.models.length + 1;
  state.models.push({
    url,
    source,
    filename: meta.filename || filenameFromUrl(url, index),
    type: (getModelExtension(url) || ".asset").replace(".", "").toUpperCase(),
    size: meta.size || 0
  });
  return true;
}

function extractModelUrls(text, baseUrl) {
  const decoded = text
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
  const matches = new Set();
  const absoluteUrlPattern = /(?:https?:)?\/\/[^\s"'<>`]+/gi;
  const relativePattern = /(?:\.{0,2}\/)[^\s"'<>`]+/gi;

  for (const match of decoded.matchAll(absoluteUrlPattern)) {
    const candidate = normaliseCandidateUrl(match[0], baseUrl);
    if (candidate && isLikelyModelUrl(candidate)) matches.add(candidate);
  }

  for (const match of decoded.matchAll(relativePattern)) {
    if (!MODEL_EXTENSIONS.some(ext => match[0].toLowerCase().includes(ext))) continue;
    const candidate = normaliseCandidateUrl(match[0], baseUrl);
    if (candidate && isLikelyModelUrl(candidate)) matches.add(candidate);
  }

  return [...matches];
}

function isGlbBuffer(buffer) {
  if (!buffer || buffer.byteLength < 4) return false;
  const view = new DataView(buffer);
  return view.getUint32(0, true) === 0x46546c67;
}

async function scanTarget(url) {
  state.models = [];
  state.targetUrl = url;
  renderModels();

  if (isLikelyModelUrl(url)) {
    addModel(url, "lien direct");
  }

  setStatus("Chargement du lien...");
  const response = await fetch(url, {
    credentials: "omit",
    cache: "no-store"
  });

  const contentType = response.headers.get("content-type") || "";
  const buffer = await response.arrayBuffer();

  if (isGlbBuffer(buffer)) {
    addModel(url, "fichier binaire", { filename: filenameFromUrl(url, 1), size: buffer.byteLength });
    return;
  }

  const canReadAsText = contentType.includes("text") ||
    contentType.includes("json") ||
    contentType.includes("javascript") ||
    contentType.includes("xml") ||
    buffer.byteLength < 8_000_000;

  if (!canReadAsText) return;

  const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const urls = extractModelUrls(text, url);
  urls.forEach(candidate => addModel(candidate, "page"));
}

function renderModels() {
  const count = state.models.length;
  els.resultCount.textContent = formatCount(count);
  els.resultContext.textContent = state.targetUrl ? new URL(state.targetUrl).hostname : "aucun lien chargé";
  els.downloadAll.disabled = count === 0;
  els.exportList.disabled = count === 0;
  els.openTarget.disabled = !state.targetUrl;

  if (count === 0) {
    els.modelList.innerHTML = `
      <div class="empty-state">
        <div class="empty-visual" aria-hidden="true">
          <svg viewBox="0 0 80 80">
            <path d="M40 8 68 24v32L40 72 12 56V24L40 8Z"></path>
            <path d="M13 24 40 40l27-16M40 40v31M27 16l27 16"></path>
          </svg>
        </div>
        <p>Aucun modèle détecté.</p>
      </div>`;
    return;
  }

  els.modelList.innerHTML = "";
  state.models.forEach((model, index) => {
    const row = els.rowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".model-name").textContent = model.filename;
    row.querySelector(".model-url").textContent = model.url;
    row.querySelector(".model-url").title = model.url;
    row.querySelector(".model-badge").textContent = model.type;
    row.querySelector(".download-one").addEventListener("click", () => downloadModel(model, index));
    els.modelList.append(row);
  });
}

function downloadModel(model, index = 0) {
  const link = document.createElement("a");
  link.href = model.url;
  link.download = model.filename || filenameFromUrl(model.url, index + 1);
  link.rel = "noopener";
  link.target = "_blank";
  document.body.append(link);
  link.click();
  link.remove();
}

function exportModels() {
  const payload = {
    source: state.targetUrl,
    generatedAt: new Date().toISOString(),
    models: state.models
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  downloadModel({ url, filename: "meshy-models.json" });
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  showToast(`${label} copié.`);
}

function minifyForBookmarklet(source) {
  return source
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([{}();,:])\s*/g, "$1");
}

function externalBookmarklet() {
  const captureUrl = new URL("src/capture.js", document.baseURI).href;
  return `javascript:(()=>{const s=document.createElement('script');s.src='${captureUrl}?v='+Date.now();document.documentElement.append(s);})()`;
}

function inlineBookmarklet() {
  if (!state.captureSource) return externalBookmarklet();
  return `javascript:${minifyForBookmarklet(state.captureSource)}`;
}

async function loadCaptureSource() {
  try {
    const response = await fetch(new URL("src/capture.js", document.baseURI), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.captureSource = await response.text();
  } catch {
    state.captureSource = "";
  }
  els.bookmarkletLink.href = inlineBookmarklet();
}

function switchTab(next) {
  const isCapture = next === "capture";
  els.tabLink.classList.toggle("is-active", !isCapture);
  els.tabCapture.classList.toggle("is-active", isCapture);
  els.tabLink.setAttribute("aria-selected", String(!isCapture));
  els.tabCapture.setAttribute("aria-selected", String(isCapture));
  els.linkPanel.hidden = isCapture;
  els.capturePanel.hidden = !isCapture;
}

function bindEvents() {
  els.scanForm.addEventListener("submit", async event => {
    event.preventDefault();
    let url;
    try {
      url = normaliseInputUrl(els.targetUrl.value);
    } catch {
      setStatus("URL invalide.", "error");
      return;
    }

    state.targetUrl = url;
    renderModels();

    try {
      await scanTarget(url);
      renderModels();
      if (state.models.length > 0) {
        setStatus(`${formatCount(state.models.length)} détecté${state.models.length > 1 ? "s" : ""}.`);
      } else if (isMeshyPage(url)) {
        setStatus("Scan direct bloqué ou aucun fichier public trouvé. Utilise le mode Capture sur l’onglet Meshy.", "warning");
      } else {
        setStatus("Aucun fichier 3D direct trouvé dans cette page.", "warning");
      }
    } catch (error) {
      renderModels();
      if (state.models.length > 0) {
        setStatus("Lien direct ajouté. La lecture distante est bloquée, mais le téléchargement par lien reste disponible.", "warning");
      } else if (isMeshyPage(url)) {
        setStatus("Le navigateur bloque cette page depuis GitHub Pages. Passe par le mode Capture.", "warning");
      } else {
        setStatus(`Impossible de lire ce lien: ${error.message}`, "error");
      }
    }
  });

  els.openTarget.addEventListener("click", () => {
    if (!state.targetUrl) return;
    window.open(state.targetUrl, "_blank", "noopener,noreferrer");
  });

  els.downloadAll.addEventListener("click", () => {
    state.models.forEach((model, index) => {
      window.setTimeout(() => downloadModel(model, index), index * 220);
    });
  });

  els.exportList.addEventListener("click", exportModels);

  els.copyBookmarklet.addEventListener("click", () => copyText(inlineBookmarklet(), "Bookmarklet"));
  els.copyBookmarkletInline.addEventListener("click", () => copyText(inlineBookmarklet(), "Bookmarklet"));
  els.copyConsoleScript.addEventListener("click", async () => {
    if (!state.captureSource) await loadCaptureSource();
    const script = state.captureSource || externalBookmarklet().replace(/^javascript:/, "");
    copyText(script, "Script");
  });

  els.tabLink.addEventListener("click", () => switchTab("link"));
  els.tabCapture.addEventListener("click", () => switchTab("capture"));
}

bindEvents();
loadCaptureSource();
renderModels();
