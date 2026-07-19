(function () {
  "use strict";

  var DATA_DIRECTORY = "secure-data-v3";
  var MANIFEST_URL = DATA_DIRECTORY + "/manifest.json";
  var DEVICE_PASSWORD_KEY = "sr-prospects:v1:device-password";
  var FORMAT = "sr-gallery-encrypted-dashboard-data";
  var running = false;

  function fromBase64Url(value) {
    var base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer), function (byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  async function sha256Hex(bytes) {
    return toHex(await crypto.subtle.digest("SHA-256", bytes));
  }

  function status(message, kind) {
    var node = document.getElementById("unlockStatus");
    if (!node) return;
    node.textContent = message;
    node.className = "notice" + (kind ? " " + kind : "");
  }

  async function fetchManifest() {
    var response = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("Manifest indisponible");
    var manifest = await response.json();
    if (
      manifest.format !== FORMAT ||
      manifest.version !== 1 ||
      !manifest.kdf ||
      !manifest.algorithm ||
      !manifest.source ||
      !Array.isArray(manifest.chunks)
    ) {
      throw new Error("Format de données invalide");
    }
    return manifest;
  }

  async function deriveKey(password, manifest) {
    var encoder = new TextEncoder();
    var material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: manifest.kdf.hash,
        salt: fromBase64Url(manifest.kdf.salt),
        iterations: manifest.kdf.iterations
      },
      material,
      { name: "AES-GCM", length: manifest.algorithm.keyLength },
      false,
      ["decrypt"]
    );
  }

  async function downloadAndDecryptChunk(manifest, chunk, key, done, total) {
    status("Chargement sécurisé · " + done + "/" + total + " blocs", "blue");
    var response = await fetch(DATA_DIRECTORY + "/" + chunk.file, { cache: "no-store" });
    if (!response.ok) throw new Error("Bloc chiffré indisponible");
    var encrypted = chunk.transportEncoding === "base64url"
      ? fromBase64Url((await response.text()).trim())
      : new Uint8Array(await response.arrayBuffer());
    if ((await sha256Hex(encrypted)) !== chunk.sha256) {
      throw new Error("Intégrité du bloc invalide");
    }
    var decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(chunk.iv),
        additionalData: fromBase64Url(chunk.aad),
        tagLength: manifest.algorithm.tagLength
      },
      key,
      encrypted
    );
    var bytes = new Uint8Array(decrypted);
    if (bytes.length !== chunk.plaintextBytes) {
      throw new Error("Taille de bloc invalide");
    }
    return bytes;
  }

  function concatenate(parts, totalBytes) {
    var output = new Uint8Array(totalBytes);
    var offset = 0;
    parts.forEach(function (part) {
      output.set(part, offset);
      offset += part.length;
    });
    if (offset !== totalBytes) throw new Error("Taille finale invalide");
    return output;
  }

  function executeAuthenticatedSource(source) {
    return new Promise(function (resolve, reject) {
      var blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      var script = document.createElement("script");
      script.src = blobUrl;
      script.onload = function () {
        URL.revokeObjectURL(blobUrl);
        script.remove();
        resolve();
      };
      script.onerror = function () {
        URL.revokeObjectURL(blobUrl);
        script.remove();
        reject(new Error("Données authentifiées illisibles"));
      };
      document.head.appendChild(script);
    });
  }

  async function unlock(password) {
    if (!password || password.length < 16) throw new Error("Mot de passe incorrect");
    status("Préparation du déverrouillage…", "blue");
    var manifest = await fetchManifest();
    var key = await deriveKey(password, manifest);
    var parts = [];
    for (var index = 0; index < manifest.chunks.length; index += 1) {
      parts.push(
        await downloadAndDecryptChunk(
          manifest,
          manifest.chunks[index],
          key,
          index + 1,
          manifest.chunks.length
        )
      );
    }
    var sourceBytes = concatenate(parts, manifest.source.bytes);
    if ((await sha256Hex(sourceBytes)) !== manifest.source.sha256) {
      throw new Error("Intégrité globale invalide");
    }
    status("Ouverture du dashboard…", "green");
    await executeAuthenticatedSource(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes));
    if (!window.SR_META || !Array.isArray(window.SR_PROSPECTS)) {
      throw new Error("Données incomplètes");
    }
  }

  window.addEventListener("sr-dashboard-unlock-request", async function (event) {
    if (running) return;
    running = true;
    try {
      await unlock(event.detail && event.detail.password ? event.detail.password : "");
      if (event.detail && event.detail.remember) {
        try { window.localStorage.setItem(DEVICE_PASSWORD_KEY, event.detail.password); } catch (storageError) {}
      }
      if (event.detail && typeof event.detail.start === "function") {
        event.detail.start();
      } else if (window.SRDashboard && typeof window.SRDashboard.start === "function") {
        window.SRDashboard.start();
      }
    } catch (error) {
      status(
        error && /indisponible|format/i.test(error.message)
          ? "La base sécurisée est momentanément indisponible."
          : "Mot de passe incorrect ou données impossibles à déchiffrer.",
        "red"
      );
    } finally {
      running = false;
    }
  });
})();
