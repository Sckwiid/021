// ==UserScript==
// @name         Meshy True Model Capture
// @namespace    https://github.com/sckwiid/meshy-download
// @version      1.0.2
// @description  Capture les vrais GLB decryptes par le viewer Meshy au document-start.
// @match        https://meshy.ai/*
// @match        https://www.meshy.ai/*
// @match        https://*.meshy.ai/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  var page = window;
  if (!isAllowedMeshyHost(page.location.hostname)) return;
  if (page.__meshyTrueModelCapture) return;
  page.__meshyTrueModelCapture = true;

  var GOOD_EXTS = [".glb", ".gltf", ".obj", ".fbx", ".stl", ".ply", ".dae", ".usdz"];
  var HOST_HINTS = ["cdn-models", "assets.meshy", "amazonaws.com", "storage.googleapis.com", "cdn.sketchfab.com"];
  var OriginalWorker = page.Worker;
  var originalFetch = page.fetch ? page.fetch.bind(page) : null;
  var originalCreateObjectURL = page.URL && page.URL.createObjectURL ? page.URL.createObjectURL.bind(page.URL) : null;
  var models = new Map();
  var panel = null;
  var pendingRender = false;
  var lastHref = page.location.href;

  function isAllowedMeshyHost(hostname) {
    return hostname === "meshy.ai" || hostname.endsWith(".meshy.ai");
  }

  function isModelPage() {
    return page.location.pathname.indexOf("/3d-models/") !== -1;
  }

  function text(value) {
    return value == null ? "" : String(value);
  }

  function safeUrl(raw) {
    try {
      return new page.URL(text(raw), page.location.href);
    } catch (error) {
      return null;
    }
  }

  function isGlbBuffer(buffer) {
    if (!buffer || buffer.byteLength < 4) return false;
    return new DataView(buffer).getUint32(0, true) === 0x46546c67;
  }

  function isLikelyNetworkModel(url) {
    var parsed = safeUrl(url);
    if (!parsed) return false;
    if (parsed.protocol === "blob:") return true;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;

    var lowPath = parsed.pathname.toLowerCase();
    var host = parsed.hostname.toLowerCase();
    var hasExt = GOOD_EXTS.some(function (ext) {
      return lowPath.endsWith(ext) || lowPath.indexOf(ext + "/") !== -1;
    });
    var hasMeshyAssetHint = HOST_HINTS.some(function (hint) {
      return host.indexOf(hint) !== -1 || parsed.href.toLowerCase().indexOf(hint) !== -1;
    });

    return hasExt || hasMeshyAssetHint || /x-amz-signature|signature/i.test(parsed.search);
  }

  function extensionFor(url) {
    var parsed = safeUrl(url);
    var path = parsed ? parsed.pathname.toLowerCase() : text(url).toLowerCase();
    return GOOD_EXTS.find(function (ext) {
      return path.endsWith(ext);
    }) || ".glb";
  }

  function sanitizeFilename(value) {
    return text(value).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").slice(0, 130) || "meshy_model.glb";
  }

  function filenameFor(entry, index) {
    if (entry.filename) return entry.filename;
    if (entry.url && entry.url.indexOf("blob:") !== 0) {
      var parsed = safeUrl(entry.url);
      if (parsed) {
        var raw = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
        if (raw && raw.indexOf(".") !== -1) return sanitizeFilename(raw);
      }
    }
    var slug = page.location.pathname.split("/").filter(Boolean).pop() || "meshy_model";
    return sanitizeFilename(slug + "_" + (index + 1) + extensionFor(entry.url));
  }

  function formatSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function priorityFor(source) {
    if (/worker/i.test(source)) return 3;
    if (/createObjectURL/i.test(source)) return 2;
    if (/fetch|xhr/i.test(source)) return 1;
    return 0;
  }

  function addModel(entry) {
    if (!entry || !entry.url) return;
    var key = entry.url;
    var next = {
      url: entry.url,
      size: entry.size || 0,
      source: entry.source || "capture",
      type: entry.type || "GLB",
      filename: entry.filename || ""
    };
    var previous = models.get(key);
    if (previous && priorityFor(previous.source) >= priorityFor(next.source)) return;
    models.set(key, next);
    scheduleRender();
  }

  function reportBlob(blob, source, knownUrl) {
    if (!blob || !blob.size) return;
    if (!originalCreateObjectURL && page.URL && page.URL.createObjectURL) {
      originalCreateObjectURL = page.URL.createObjectURL.bind(page.URL);
    }
    if (!knownUrl && !originalCreateObjectURL) return;
    var blobUrl = knownUrl || originalCreateObjectURL(blob);
    addModel({
      url: blobUrl,
      size: blob.size,
      source: source,
      type: "GLB"
    });
  }

  function inspectBuffer(buffer, source) {
    if (!buffer || buffer.byteLength < 1000) return;
    try {
      var copy = buffer.slice ? buffer.slice(0) : buffer;
      if (isGlbBuffer(copy)) {
        reportBlob(new page.Blob([copy], { type: "model/gltf-binary" }), source);
      }
    } catch (error) {}
  }

  function inspectBlob(blob, source, knownUrl) {
    if (!blob || typeof blob.size !== "number" || blob.size < 1000) return;
    if (blob.type === "model/gltf-binary" || blob.type === "model/gltf+json") {
      reportBlob(blob, source, knownUrl);
      return;
    }
    if (blob.size < 100000) return;
    blob.arrayBuffer().then(function (buffer) {
      if (isGlbBuffer(buffer)) reportBlob(blob, source + "-magic", knownUrl);
    }).catch(function () {});
  }

  function inspectWorkerMessage(event) {
    var data = event && event.data;
    if (!data) return;

    if (data.type === "process" && data.success && data.data && data.data.byteLength > 1000) {
      inspectBuffer(data.data, "worker-wasm");
      return;
    }
    if (data instanceof page.ArrayBuffer || data instanceof ArrayBuffer) {
      inspectBuffer(data, "worker-raw");
      return;
    }
    if ((page.ArrayBuffer && page.ArrayBuffer.isView && page.ArrayBuffer.isView(data)) || ArrayBuffer.isView(data)) {
      inspectBuffer(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "worker-view");
    }
  }

  function hookWorker() {
    if (!OriginalWorker) return;
    page.Worker = function MeshyWorkerProxy(scriptURL, options) {
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
    page.Worker.prototype = OriginalWorker.prototype;
    try {
      Object.defineProperty(page.Worker, Symbol.hasInstance, {
        value: function (instance) {
          return instance instanceof OriginalWorker;
        }
      });
    } catch (error) {}
  }

  function hookFetch() {
    if (!originalFetch) return;
    page.fetch = function () {
      var input = arguments[0];
      var url = typeof input === "string" ? input : input && input.url;
      var shouldInspect = isLikelyNetworkModel(url);
      return originalFetch.apply(this, arguments).then(function (response) {
        var responseUrl = response.url || url;
        if (shouldInspect || isLikelyNetworkModel(responseUrl)) {
          response.clone().arrayBuffer().then(function (buffer) {
            inspectBuffer(buffer, "fetch");
          }).catch(function () {});
        }
        return response;
      });
    };
  }

  function hookCreateObjectURL() {
    if (!page.URL || !page.URL.createObjectURL || !originalCreateObjectURL) return;
    page.URL.createObjectURL = function (blob) {
      var url = originalCreateObjectURL(blob);
      inspectBlob(blob, "createObjectURL", url);
      return url;
    };
  }

  function scanPerformance() {
    try {
      page.performance.getEntriesByType("resource").forEach(function (entry) {
        if (!entry || !isLikelyNetworkModel(entry.name)) return;
        originalFetch(entry.name).then(function (response) {
          return response.clone().arrayBuffer();
        }).then(function (buffer) {
          inspectBuffer(buffer, "performance");
        }).catch(function () {});
      });
    } catch (error) {}
  }

  function ensurePanel() {
    if (panel) return;
    if (!isModelPage()) return;
    if (!page.document.body) {
      schedulePanelMount();
      return;
    }

    panel = page.document.createElement("div");
    panel.id = "meshy-true-capture-panel";
    panel.innerHTML = '<style>#meshy-true-capture-panel{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:min(430px,calc(100vw - 28px));font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#20211f;background:#fff;border:1px solid #d9d6cc;border-radius:8px;box-shadow:0 18px 45px rgba(0,0,0,.28);overflow:hidden}#meshy-true-capture-panel *{box-sizing:border-box}#meshy-true-capture-panel .mc-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;background:#f8f7f3;border-bottom:1px solid #d9d6cc}#meshy-true-capture-panel .mc-title{display:grid;gap:2px;min-width:0}#meshy-true-capture-panel .mc-title strong{font-size:14px;line-height:1.2;color:#20211f}#meshy-true-capture-panel .mc-title span{font-size:12px;color:#676b63}#meshy-true-capture-panel .mc-title small{font-size:11px;color:#0f7771;line-height:1.25}#meshy-true-capture-panel .mc-actions{display:flex;gap:6px;flex-shrink:0}#meshy-true-capture-panel button{border:1px solid #d9d6cc;border-radius:8px;background:#fff;color:#20211f;min-height:32px;padding:0 10px;font:700 12px system-ui;cursor:pointer}#meshy-true-capture-panel button:hover{border-color:#9ccac6;background:#e5f3f1;color:#095b56}#meshy-true-capture-panel .mc-primary{background:#0f7771;border-color:#0f7771;color:#fff}#meshy-true-capture-panel .mc-primary:hover{background:#095b56;color:#fff}#meshy-true-capture-panel .mc-list{max-height:310px;overflow:auto;display:grid;gap:8px;padding:10px;background:#fff}#meshy-true-capture-panel .mc-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px;border:1px solid #d9d6cc;border-radius:8px;background:#fff}#meshy-true-capture-panel .mc-meta{min-width:0;display:grid;gap:4px}#meshy-true-capture-panel .mc-meta strong{font-size:13px;color:#20211f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#meshy-true-capture-panel .mc-meta span,#meshy-true-capture-panel .mc-empty{font-size:12px;color:#676b63}#meshy-true-capture-panel .mc-empty{padding:24px;text-align:center;background:#f8f7f3;border:1px dashed #cbc7bb;border-radius:8px}</style><div class="mc-head"><div class="mc-title"><strong>Meshy True Capture</strong><span data-count>0 modele</span><small data-hint>Charge le modele, puis attends la detection worker.</small></div><div class="mc-actions"><button type="button" data-scan>Scan</button><button type="button" class="mc-primary" data-all>Tout</button><button type="button" data-hide>Masquer</button></div></div><div class="mc-list" data-list></div>';
    page.document.body.appendChild(panel);
    panel.querySelector("[data-hide]").addEventListener("click", function () {
      panel.style.display = "none";
    });
    panel.querySelector("[data-scan]").addEventListener("click", scanPerformance);
    panel.querySelector("[data-all]").addEventListener("click", function () {
      Array.from(models.values()).forEach(function (entry, index) {
        page.setTimeout(function () {
          download(entry, index);
        }, index * 220);
      });
    });
    render();
  }

  function scheduleRender() {
    if (pendingRender) return;
    pendingRender = true;
    page.setTimeout(function () {
      pendingRender = false;
      if (panel) render();
    }, 80);
  }

  function render() {
    if (!panel) return;
    var items = Array.from(models.values()).sort(function (a, b) {
      return priorityFor(b.source) - priorityFor(a.source) || (b.size || 0) - (a.size || 0);
    });
    panel.querySelector("[data-count]").textContent = items.length + " modele" + (items.length > 1 ? "s" : "");
    panel.querySelector("[data-hint]").textContent = items.some(function (item) {
      return /worker|createObjectURL/.test(item.source);
    }) ? "Modele de la page capture." : "Le vrai modele arrive via worker; recharge si besoin.";

    var list = panel.querySelector("[data-list]");
    list.textContent = "";
    if (!items.length) {
      var empty = page.document.createElement("div");
      empty.className = "mc-empty";
      empty.textContent = "Aucun modele detecte pour le moment. Recharge la page avec ce script actif.";
      list.appendChild(empty);
      return;
    }

    items.forEach(function (entry, index) {
      var row = page.document.createElement("div");
      row.className = "mc-row";
      var meta = page.document.createElement("div");
      meta.className = "mc-meta";
      var title = page.document.createElement("strong");
      title.textContent = filenameFor(entry, index);
      var detail = page.document.createElement("span");
      detail.textContent = entry.source + (entry.size ? " - " + formatSize(entry.size) : "");
      meta.appendChild(title);
      meta.appendChild(detail);
      var button = page.document.createElement("button");
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

  function download(entry, index) {
    var a = page.document.createElement("a");
    a.href = entry.url;
    a.download = filenameFor(entry, index);
    a.rel = "noopener";
    page.document.body.appendChild(a);
    a.click();
    a.remove();
  }

  hookWorker();
  hookFetch();
  hookCreateObjectURL();

  function schedulePanelMount() {
    if (!isModelPage()) return;
    if (schedulePanelMount.pending) return;
    schedulePanelMount.pending = true;
    var mount = function () {
      page.setTimeout(function () {
        schedulePanelMount.pending = false;
        ensurePanel();
        render();
      }, 1800);
    };
    if (page.document.readyState === "loading") {
      page.document.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
      mount();
    }
  }

  schedulePanelMount();

  page.setInterval(function () {
    if (page.location.href === lastHref) return;
    lastHref = page.location.href;
    if (isModelPage()) schedulePanelMount();
  }, 1000);

  console.log("[Meshy True Capture] Hooks Worker/fetch/createObjectURL actifs", page.location.href);
})();
