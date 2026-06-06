(function () {
  if (window.__meshyPageCapture && window.__meshyPageCapture.show) {
    window.__meshyPageCapture.show();
    return;
  }

  var GOOD_EXTS = [".glb", ".gltf", ".obj", ".fbx", ".stl", ".ply", ".dae", ".usdz"];
  var HOST_HINTS = ["cdn-models", "assets.meshy", "amazonaws.com", "storage.googleapis.com", "cdn.sketchfab.com"];
  var originalCreateObjectURL = URL.createObjectURL.bind(URL);
  var originalFetch = window.fetch ? window.fetch.bind(window) : null;
  var OriginalWorker = window.Worker;
  var originalXhrOpen = XMLHttpRequest.prototype.open;
  var originalXhrSend = XMLHttpRequest.prototype.send;
  var models = new Map();
  var panel = null;
  var scanTimer = 0;

  function text(value) {
    return value == null ? "" : String(value);
  }

  function isGlbBuffer(buffer) {
    if (!buffer || buffer.byteLength < 4) return false;
    return new DataView(buffer).getUint32(0, true) === 0x46546c67;
  }

  function extensionFromUrl(url) {
    var low = text(url).toLowerCase();
    return GOOD_EXTS.find(function (ext) {
      return low.indexOf(ext) !== -1;
    }) || ".glb";
  }

  function looksLikeModelUrl(url) {
    var low = text(url).toLowerCase();
    if (GOOD_EXTS.some(function (ext) { return low.indexOf(ext) !== -1; })) return true;
    return HOST_HINTS.some(function (hint) { return low.indexOf(hint) !== -1; }) && low.indexOf("signature") !== -1;
  }

  function normalizeUrl(raw, base) {
    try {
      var cleaned = text(raw)
        .replace(/^["'({\[]+/, "")
        .replace(/[)"'\]},;]+$/g, "")
        .replace(/&amp;/g, "&");
      if (!cleaned) return "";
      if (cleaned.indexOf("//") === 0) return new URL("https:" + cleaned).href;
      return new URL(cleaned, base || location.href).href;
    } catch (e) {
      return "";
    }
  }

  function fileNameFor(entry, index) {
    if (entry.filename) return entry.filename;
    try {
      var name = decodeURIComponent(new URL(entry.url).pathname.split("/").filter(Boolean).pop() || "");
      if (name && name.indexOf(".") !== -1) return name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").slice(0, 120);
    } catch (e) {}
    return "meshy_model_" + (index + 1) + extensionFromUrl(entry.url);
  }

  function formatSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function extractUrls(source, base) {
    var decoded = text(source)
      .replace(/\\u002F/gi, "/")
      .replace(/\\\//g, "/")
      .replace(/&quot;/g, "\"")
      .replace(/&#x27;/g, "'");
    var found = [];
    var absolute = /(?:https?:)?\/\/[^\s"'<>`]+/gi;
    var relative = /(?:\.{0,2}\/)[^\s"'<>`]+/gi;
    var match;
    while ((match = absolute.exec(decoded))) {
      var url = normalizeUrl(match[0], base);
      if (url && looksLikeModelUrl(url)) found.push(url);
    }
    while ((match = relative.exec(decoded))) {
      if (!GOOD_EXTS.some(function (ext) { return match[0].toLowerCase().indexOf(ext) !== -1; })) continue;
      var relUrl = normalizeUrl(match[0], base);
      if (relUrl && looksLikeModelUrl(relUrl)) found.push(relUrl);
    }
    return found;
  }

  function addModel(entry) {
    if (!entry || !entry.url) return;
    var key = entry.url;
    if (models.has(key)) return;
    models.set(key, {
      url: entry.url,
      source: entry.source || "capture",
      size: entry.size || 0,
      filename: entry.filename || "",
      type: (entry.type || extensionFromUrl(entry.url).replace(".", "") || "glb").toUpperCase()
    });
    render();
  }

  function addUrl(url, source) {
    var normalized = normalizeUrl(url, location.href);
    if (!normalized || !looksLikeModelUrl(normalized)) return;
    addModel({ url: normalized, source: source || "url" });
  }

  function reportBlob(blob, source, knownUrl) {
    if (!blob || !blob.size) return;
    var url = knownUrl || originalCreateObjectURL(blob);
    addModel({
      url: url,
      source: source || "blob",
      size: blob.size,
      filename: "",
      type: "GLB"
    });
  }

  function inspectBlob(blob, source, knownUrl) {
    if (!(blob instanceof Blob || blob instanceof File) || blob.size < 1024) return;
    if (blob.type === "model/gltf-binary" || blob.type === "model/gltf+json") {
      reportBlob(blob, source, knownUrl);
      return;
    }
    if (blob.size < 10000) return;
    blob.arrayBuffer().then(function (buffer) {
      if (isGlbBuffer(buffer)) reportBlob(blob, source, knownUrl);
    }).catch(function () {});
  }

  function inspectBuffer(buffer, source) {
    if (!buffer || buffer.byteLength < 1024) return;
    var copy = buffer.slice ? buffer.slice(0) : buffer;
    if (isGlbBuffer(copy)) {
      reportBlob(new Blob([copy], { type: "model/gltf-binary" }), source);
    }
  }

  function inspectWorkerMessage(event) {
    var data = event && event.data;
    if (!data) return;
    if (data.type === "process" && data.success && data.data && data.data.byteLength > 1000) {
      inspectBuffer(data.data, "worker");
      return;
    }
    if (data instanceof ArrayBuffer && data.byteLength > 1000) {
      inspectBuffer(data, "worker");
      return;
    }
    if (ArrayBuffer.isView(data) && data.byteLength > 1000) {
      inspectBuffer(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "worker");
    }
  }

  function hookWorker() {
    if (!OriginalWorker) return;
    window.Worker = function MeshyCaptureWorker(scriptURL, options) {
      var worker = new OriginalWorker(scriptURL, options);
      var proto = Object.getPrototypeOf(worker);
      var desc = Object.getOwnPropertyDescriptor(proto, "onmessage");
      if (desc && desc.set) {
        Object.defineProperty(worker, "onmessage", {
          configurable: true,
          get: function () {
            return desc.get ? desc.get.call(worker) : undefined;
          },
          set: function (listener) {
            desc.set.call(worker, function (event) {
              inspectWorkerMessage(event);
              return listener && listener.call(this, event);
            });
          }
        });
      }
      var originalAddEventListener = worker.addEventListener.bind(worker);
      worker.addEventListener = function (type, listener, options2) {
        if (type === "message") {
          return originalAddEventListener(type, function (event) {
            inspectWorkerMessage(event);
            return listener && listener.call(this, event);
          }, options2);
        }
        return originalAddEventListener(type, listener, options2);
      };
      return worker;
    };
    window.Worker.prototype = OriginalWorker.prototype;
    try {
      Object.defineProperty(window.Worker, Symbol.hasInstance, {
        value: function (instance) {
          return instance instanceof OriginalWorker;
        }
      });
    } catch (e) {}
  }

  function hookFetch() {
    if (!originalFetch) return;
    window.fetch = function () {
      var input = arguments[0];
      var rawUrl = typeof input === "string" ? input : input && input.url;
      var url = normalizeUrl(rawUrl || "", location.href);
      return originalFetch.apply(this, arguments).then(function (response) {
        var responseUrl = response.url || url;
        if (looksLikeModelUrl(url) || looksLikeModelUrl(responseUrl)) addUrl(responseUrl || url, "fetch-url");
        if (looksLikeModelUrl(url) || looksLikeModelUrl(responseUrl)) {
          response.clone().arrayBuffer().then(function (buffer) {
            inspectBuffer(buffer, "fetch");
          }).catch(function () {});
        }
        return response;
      });
    };
  }

  function hookObjectUrl() {
    URL.createObjectURL = function (blob) {
      var url = originalCreateObjectURL(blob);
      inspectBlob(blob, "createObjectURL", url);
      return url;
    };
  }

  function hookXhr() {
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__meshCaptureUrl = normalizeUrl(url, location.href);
      return originalXhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener("load", function () {
        var url = this.responseURL || this.__meshCaptureUrl;
        if (looksLikeModelUrl(url)) addUrl(url, "xhr-url");
        try {
          if (this.response instanceof ArrayBuffer) inspectBuffer(this.response, "xhr");
          if (this.response instanceof Blob) inspectBlob(this.response, "xhr");
          if (typeof this.responseText === "string" && this.responseText.length < 12000000) {
            extractUrls(this.responseText, url || location.href).forEach(function (found) {
              addUrl(found, "xhr-text");
            });
          }
        } catch (e) {}
      });
      return originalXhrSend.apply(this, arguments);
    };
  }

  function scanDom() {
    try {
      var html = document.documentElement ? document.documentElement.innerHTML : "";
      if (html.length > 15000000) html = html.slice(0, 15000000);
      extractUrls(html, location.href).forEach(function (url) {
        addUrl(url, "dom");
      });
    } catch (e) {}
  }

  function scheduleDomScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanDom, 450);
  }

  function download(entry, index) {
    var a = document.createElement("a");
    a.href = entry.url;
    a.download = fileNameFor(entry, index);
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function render() {
    if (!panel) return;
    var items = Array.from(models.values());
    var count = panel.querySelector("[data-count]");
    var list = panel.querySelector("[data-list]");
    count.textContent = items.length + " modele" + (items.length > 1 ? "s" : "");
    list.textContent = "";
    if (!items.length) {
      var empty = document.createElement("div");
      empty.className = "md-empty";
      empty.textContent = "Aucun modele detecte pour le moment.";
      list.appendChild(empty);
      return;
    }
    items.forEach(function (entry, index) {
      var row = document.createElement("div");
      row.className = "md-row";
      var meta = document.createElement("div");
      meta.className = "md-meta";
      var name = document.createElement("strong");
      name.textContent = fileNameFor(entry, index);
      var detail = document.createElement("span");
      detail.textContent = entry.source + (entry.size ? " - " + formatSize(entry.size) : "");
      meta.appendChild(name);
      meta.appendChild(detail);
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = "Telecharger";
      button.addEventListener("click", function () {
        download(entry, index);
      });
      row.appendChild(meta);
      row.appendChild(button);
      list.appendChild(row);
    });
  }

  function createPanel() {
    panel = document.createElement("div");
    panel.id = "meshy-capture-panel";
    panel.innerHTML = '<style>#meshy-capture-panel{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:min(390px,calc(100vw - 28px));font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#20211f;background:#fff;border:1px solid #d9d6cc;border-radius:8px;box-shadow:0 18px 45px rgba(0,0,0,.24);overflow:hidden}#meshy-capture-panel *{box-sizing:border-box}#meshy-capture-panel .md-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;background:#f8f7f3;border-bottom:1px solid #d9d6cc}#meshy-capture-panel .md-title{display:grid;gap:2px}#meshy-capture-panel .md-title strong{font-size:14px;line-height:1.2}#meshy-capture-panel .md-title span{font-size:12px;color:#676b63}#meshy-capture-panel .md-actions{display:flex;gap:6px}#meshy-capture-panel button{border:1px solid #d9d6cc;border-radius:8px;background:#fff;color:#20211f;min-height:32px;padding:0 10px;font:700 12px system-ui;cursor:pointer}#meshy-capture-panel button:hover{border-color:#9ccac6;background:#e5f3f1;color:#095b56}#meshy-capture-panel .md-primary{background:#0f7771;border-color:#0f7771;color:#fff}#meshy-capture-panel .md-primary:hover{background:#095b56;color:#fff}#meshy-capture-panel .md-list{max-height:290px;overflow:auto;display:grid;gap:8px;padding:10px;background:#fff}#meshy-capture-panel .md-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px;border:1px solid #d9d6cc;border-radius:8px;background:#fff}#meshy-capture-panel .md-meta{min-width:0;display:grid;gap:4px}#meshy-capture-panel .md-meta strong{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#meshy-capture-panel .md-meta span,#meshy-capture-panel .md-empty{font-size:12px;color:#676b63}#meshy-capture-panel .md-empty{padding:24px;text-align:center;background:#f8f7f3;border:1px dashed #cbc7bb;border-radius:8px}</style><div class="md-head"><div class="md-title"><strong>Meshy Capture</strong><span data-count>0 modele</span></div><div class="md-actions"><button type="button" data-rescan>Scan</button><button type="button" class="md-primary" data-all>Tout</button><button type="button" data-close>Fermer</button></div></div><div class="md-list" data-list></div>';
    document.documentElement.appendChild(panel);
    panel.querySelector("[data-close]").addEventListener("click", function () {
      panel.style.display = "none";
    });
    panel.querySelector("[data-rescan]").addEventListener("click", scanDom);
    panel.querySelector("[data-all]").addEventListener("click", function () {
      Array.from(models.values()).forEach(function (entry, index) {
        setTimeout(function () {
          download(entry, index);
        }, index * 220);
      });
    });
    render();
  }

  function show() {
    if (!panel) createPanel();
    panel.style.display = "block";
    render();
  }

  hookWorker();
  hookFetch();
  hookObjectUrl();
  hookXhr();
  createPanel();
  scanDom();

  try {
    new MutationObserver(scheduleDomScan).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  } catch (e) {}

  window.__meshyPageCapture = {
    show: show,
    models: models,
    scan: scanDom
  };
})();
