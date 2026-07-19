(function () {
  "use strict";

  var root = document.getElementById("app");
  var DEVICE_PASSWORD_KEY = "sr-prospects:v1:device-password";

  if (!window.SR_META || !Array.isArray(window.SR_PROSPECTS)) {
    renderLockedScreen();
    return;
  }

  if (window.__SR_DASHBOARD_BOOTED__) return;
  window.__SR_DASHBOARD_BOOTED__ = true;

  var meta = window.SR_META;
  var baseProspects = window.SR_PROSPECTS;

  function renderLockedScreen() {
    root.innerHTML =
      "<div class='app-shell' style='min-height:100vh;display:grid;place-items:center;padding:24px'>" +
        "<main class='panel' style='width:min(520px,100%);overflow:hidden'>" +
          "<div class='panel-body' style='padding:34px'>" +
            "<div class='brand' style='padding:0 0 26px'>" +
              "<div class='brand-logo-frame'><img class='brand-logo' src='assets/sr-galerie-logo.png' alt='SR Galerie' /></div>" +
              "<div class='brand-copy'><strong>PROSPECTS</strong><span>Base protégée</span></div>" +
            "</div>" +
            "<div class='eyebrow'>Accès privé</div>" +
            "<h1 class='view-title' style='font-size:28px'>Déverrouiller le dashboard</h1>" +
            "<p class='view-subtitle' style='margin-bottom:22px'>Les données nominatives ne sont pas incluses dans cette version publique. Saisissez votre mot de passe pour charger la base chiffrée.</p>" +
            "<form id='unlockForm'>" +
              "<label class='field full'><span>Mot de passe</span>" +
                "<input id='unlockPassword' name='password' type='password' autocomplete='current-password' placeholder='Votre mot de passe' required />" +
              "</label>" +
              "<button class='primary-btn' type='submit' style='width:100%;margin-top:12px'>Déverrouiller</button>" +
            "</form>" +
            "<label class='check-row' style='margin-top:14px'><input id='rememberDevice' type='checkbox' checked /> <span>Autoriser ce PC et ne plus redemander le mot de passe</span></label>" +
            "<div id='unlockStatus' class='notice' style='margin-top:14px'>L’autorisation reste uniquement sur ce navigateur. Elle peut être retirée à tout moment en effaçant les données du site.</div>" +
          "</div>" +
        "</main>" +
      "</div>";

    window.SRDashboard = {
      start: function (payload, prospects) {
        if (payload && payload.meta && Array.isArray(payload.prospects)) {
          window.SR_META = payload.meta;
          window.SR_PROSPECTS = payload.prospects;
        } else if (payload && Array.isArray(prospects)) {
          window.SR_META = payload;
          window.SR_PROSPECTS = prospects;
        }
        if (!window.SR_META || !Array.isArray(window.SR_PROSPECTS)) return false;
        var sourceScript = document.querySelector("script[src*='app.js']");
        var source = sourceScript ? sourceScript.getAttribute("src").split("?")[0] : "app.js";
        var script = document.createElement("script");
        script.src = source + "?boot=" + Date.now();
        document.body.appendChild(script);
        return true;
      }
    };

    var form = document.getElementById("unlockForm");
    if (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var passwordInput = document.getElementById("unlockPassword");
        var status = document.getElementById("unlockStatus");
        var unlockEvent = new CustomEvent("sr-dashboard-unlock-request", {
          detail: {
            password: passwordInput ? passwordInput.value : "",
            remember: Boolean(document.getElementById("rememberDevice") && document.getElementById("rememberDevice").checked),
            start: window.SRDashboard.start
          }
        });
        window.dispatchEvent(unlockEvent);
        if (window.SR_META && Array.isArray(window.SR_PROSPECTS)) {
          window.SRDashboard.start();
        }
        if (passwordInput) passwordInput.value = "";
      });
    }

    try {
      var savedPassword = window.localStorage.getItem(DEVICE_PASSWORD_KEY);
      if (savedPassword) {
        window.setTimeout(function () {
          window.dispatchEvent(new CustomEvent("sr-dashboard-unlock-request", {
            detail: { password: savedPassword, remember: true, start: window.SRDashboard.start }
          }));
        }, 0);
      }
    } catch (error) {}
  }

  var STORAGE = {
    patches: "sr-prospects:v1:patches",
    viewMode: "sr-prospects:v1:view-mode",
    messageStats: "sr-prospects:v1:message-stats"
  };

  var ROUTES = [
    { id: "overview", label: "Vue d’ensemble", icon: "📊" },
    { id: "prospects", label: "Tous les prospects", icon: "👥" },
    { id: "followups", label: "Plan d’envoi", icon: "📤" }
  ];

  var STATUS_OPTIONS = [
    "",
    "À qualifier",
    "À contacter",
    "Envoyé",
    "Ouvert",
    "Contacté",
    "Répondu",
    "Intéressé",
    "À relancer",
    "Sans réponse",
    "Spam / refus",
    "Non pertinent"
  ];

  var DECISION_OPTIONS = ["", "Approuvé", "Exclu"];
  var PROFESSION_OPTIONS = [
    "Avocat",
    "Notaire",
    "Dentiste",
    "Architecte",
    "Expert-comptable",
    "Médecin",
    "Conseil en gestion de patrimoine",
    "Commissaire de justice",
    "Juridique à qualifier"
  ];
  var PAGE_SIZE = 60;
  var patches = readJson(STORAGE.patches, {});
  var messageStats = readJson(STORAGE.messageStats, {});

  var state = {
    route: routeFromHash(),
    search: "",
    segment: "",
    profession: "",
    confidence: "",
    status: "",
    decision: "",
    headcount: "",
    sortKey: "fitScore",
    sortDir: "desc",
    page: 1,
    viewMode: safeStorageGet(STORAGE.viewMode) === "grid" ? "grid" : "list",
    modalId: null,
    contactId: null,
    mobileOpen: false
  };

  var MESSAGES = [
    {
      id: "voisins",
      emoji: "📍",
      recommended: true,
      name: "Voisins du 8e",
      audience: "Cabinets du 8e arrondissement",
      subject: "Une idée pour vos bureaux, dans le 8e",
      body: "Bonjour,\n\nNous sommes voisins dans le 8e : SR Galerie accompagne les cabinets qui souhaitent installer des œuvres dans leurs bureaux via une formule de leasing, sans achat immédiat.\n\nJe peux vous envoyer une sélection de 3 œuvres avec leur budget mensuel indicatif, simplement pour voir si cela pourrait fonctionner chez vous. Je vous l’envoie ?\n\nVictor Ustarazzo\nSR Galerie · 46 rue de Laborde\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    },
    {
      id: "curiosite",
      emoji: "💭",
      recommended: true,
      name: "Question qui intrigue",
      audience: "Cabinets partout en France",
      subject: "Une question sur vos bureaux",
      body: "Bonjour,\n\nAvez-vous déjà envisagé de faire vivre vos bureaux avec des œuvres sélectionnées pour l’espace, plutôt que d’acheter une décoration figée ?\n\nSR Galerie propose une formule de leasing d’art pour les professionnels. Si vous êtes curieux, je vous envoie 3 exemples adaptés à un cabinet d’avocats, avec leur budget mensuel. Ça vous intéresse ?\n\nVictor Ustarazzo\nSR Galerie\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    },
    {
      id: "projection",
      emoji: "🖼️",
      recommended: true,
      name: "Projection sur photo",
      audience: "Accueil ou salle de réunion visible",
      subject: "3 œuvres pour vous projeter",
      body: "Bonjour,\n\nSi vous m’envoyez une photo de votre accueil ou d’une salle de réunion, je peux préparer une mini-sélection de 3 œuvres SR Galerie adaptées à l’espace, avec le budget mensuel correspondant à titre indicatif.\n\nL’idée est simplement de vous aider à vous projeter. Je vous montre ?\n\nVictor Ustarazzo\nSR Galerie\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    },
    {
      id: "budget",
      emoji: "💶",
      name: "Budget mensuel",
      audience: "Cabinets sensibles au coût initial",
      subject: "Quel budget mensuel pour vos murs ?",
      body: "Bonjour,\n\nPour équiper des bureaux avec de l’art, le frein est souvent le budget d’achat initial. Le leasing permet d’aborder le projet sous forme de budget mensuel.\n\nSi vous me donnez une fourchette, même approximative, je peux vous répondre avec 3 pistes concrètes. Quel niveau souhaitez-vous regarder ?\n\nVictor Ustarazzo\nSR Galerie\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    },
    {
      id: "evolutive",
      emoji: "🔄",
      name: "Sélection évolutive",
      audience: "Cabinets attentifs à leur environnement",
      subject: "Faire évoluer les œuvres",
      body: "Bonjour,\n\nPour que l’art ne devienne pas un décor figé, nous pouvons imaginer une sélection appelée à évoluer selon les modalités du projet. SR Galerie propose le leasing d’œuvres aux entreprises.\n\nJe peux vous envoyer un exemple pour un accueil et une salle de réunion, avec budget indicatif. Utile pour vous ?\n\nVictor Ustarazzo\nSR Galerie\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    },
    {
      id: "accueil",
      emoji: "🤝",
      name: "Accueil des clients",
      audience: "Cabinets recevant beaucoup de clients",
      subject: "Votre accueil, autrement",
      body: "Bonjour,\n\nL’accueil et les salles de réunion sont souvent les premiers espaces que voient les clients. SR Galerie aide les cabinets à y installer des œuvres en leasing, avec une sélection pensée pour leur environnement professionnel.\n\nJe peux vous envoyer 3 exemples et leurs budgets mensuels indicatifs. Je vous les adresse ?\n\nVictor Ustarazzo\nSR Galerie\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    },
    {
      id: "personnalite",
      emoji: "✨",
      name: "Personnalité des bureaux",
      audience: "Marque employeur et expérience des lieux",
      subject: "Donner du relief aux bureaux",
      body: "Bonjour,\n\nLes œuvres peuvent devenir un sujet de conversation et donner davantage de personnalité aux espaces de travail. SR Galerie propose une sélection en leasing pour les entreprises.\n\nJe peux vous préparer 3 pistes adaptées à un cabinet d’avocats, avec un budget mensuel indicatif. Souhaitez-vous les recevoir ?\n\nVictor Ustarazzo\nSR Galerie\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    },
    {
      id: "orientation",
      emoji: "🧭",
      name: "Trouver le bon interlocuteur",
      audience: "Emails génériques et formulaires",
      subject: "Qui s’occupe de vos bureaux ?",
      body: "Bonjour,\n\nJe cherche la personne qui s’occupe de l’aménagement ou de l’expérience des bureaux chez [Cabinet]. SR Galerie propose du leasing d’œuvres d’art pour les espaces professionnels.\n\nEst-ce un sujet que vous suivez ? Sinon, pourriez-vous simplement m’indiquer le bon interlocuteur ?\n\nVictor Ustarazzo\nSR Galerie\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    },
    {
      id: "associe",
      emoji: "⚖️",
      name: "Message à un associé",
      audience: "Associé ou dirigeant identifié",
      subject: "Une sélection pour [Cabinet]",
      body: "Bonjour Maître [Nom],\n\nJe vous contacte avec une proposition simple : imaginer une sélection d’œuvres pour l’accueil ou les salles de réunion de [Cabinet], via une formule de leasing.\n\nJe peux vous envoyer 3 exemples concrets et leur budget mensuel indicatif ; vous verrez rapidement si le sujet mérite d’être creusé. Je vous les transmets ?\n\nVictor Ustarazzo\nSR Galerie\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    },
    {
      id: "comptable",
      emoji: "🧾",
      name: "Angle comptable prudent",
      audience: "Structures établies",
      subject: "Leasing d’art : 3 exemples chiffrés",
      body: "Bonjour,\n\nCertains cabinets étudient le leasing d’œuvres pour aménager leurs bureaux tout en étalant le coût dans le temps. Le traitement comptable et fiscal dépend naturellement de la situation de l’entreprise et doit être validé avec son expert-comptable.\n\nJe peux vous envoyer une présentation très courte et 3 exemples chiffrés. Souhaitez-vous la recevoir ?\n\nVictor Ustarazzo\nSR Galerie\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    },
    {
      id: "timing",
      emoji: "📅",
      name: "Bon moment",
      audience: "Déménagement ou rénovation possible",
      subject: "Un projet pour vos bureaux cette année ?",
      body: "Bonjour,\n\nAvez-vous un projet d’emménagement, de rénovation ou simplement de rafraîchissement des bureaux cette année ? SR Galerie peut proposer une sélection d’œuvres en leasing pour l’accueil, les circulations ou les salles de réunion.\n\nSi le timing est pertinent, je vous envoie quelques exemples ; sinon, je peux revenir au meilleur moment. Quand serait-ce utile ?\n\nVictor Ustarazzo\nSR Galerie\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    },
    {
      id: "trois-reponses",
      emoji: "💬",
      name: "Réponse en trois secondes",
      audience: "Relance très légère ou interlocuteur pressé",
      subject: "Maintenant, plus tard, ou pas utile ?",
      body: "Bonjour,\n\nPetite question pour ne pas vous envoyer une présentation inutile : le sujet de l’art dans vos bureaux est-il plutôt à explorer maintenant, à revoir plus tard, ou simplement pas d’actualité ?\n\nSi c’est à explorer, je vous envoie 3 œuvres et un budget mensuel indicatif, sans long dossier.\n\nVictor Ustarazzo\nSR Galerie\nvictor@srgalerie.com\n\nSi ce sujet n’est pas pertinent, dites-le-moi et je ne vous relancerai pas."
    }
  ];

  MESSAGES.forEach(function (message) {
    if (!messageStats[message.id]) {
      messageStats[message.id] = { sent: 0, opened: 0, replies: 0, interested: 0, spam: 0 };
    }
  });

  var addressIndex = buildAddressIndex(baseProspects);

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      showToast("Sauvegarde locale indisponible dans ce navigateur");
      return false;
    }
  }

  function readJson(key, fallback) {
    var value = safeStorageGet(key);
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  function routeFromHash() {
    var candidate = String(location.hash || "").replace(/^#\/?/, "");
    return ROUTES.some(function (route) { return route.id === candidate; })
      ? candidate
      : "overview";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function cleanText(value) {
    return String(value == null ? "" : value).trim();
  }

  function normalize(value) {
    return cleanText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’']/g, " ")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .toLowerCase();
  }

  function number(value) {
    return new Intl.NumberFormat("fr-FR").format(Number(value) || 0);
  }

  function dateFr(value) {
    if (!value) return "Non renseignée";
    var date = new Date(value + (String(value).length === 10 ? "T12:00:00" : ""));
    if (Number.isNaN(date.getTime())) return cleanText(value);
    return new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    }).format(date);
  }

  function initials(name) {
    var words = cleanText(name).split(/\s+/).filter(Boolean);
    if (!words.length) return "SR";
    return (words[0].charAt(0) + (words[1] ? words[1].charAt(0) : words[0].charAt(1) || "")).toUpperCase();
  }

  function safeImageUrl(value) {
    var candidate = cleanText(value);
    if (!candidate) return "";
    try {
      var url = new URL(candidate, location.href);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function avatarMarkup(prospect, extraClass) {
    var logoUrl = safeImageUrl(prospect && prospect.logoUrl);
    var name = prospect && prospect.name ? prospect.name : "SR Galerie";
    return "<div class='avatar" + (extraClass ? " " + escapeHtml(extraClass) : "") + "'>" +
      "<span class='avatar-fallback' aria-hidden='true'>" + escapeHtml(initials(name)) + "</span>" +
      (logoUrl
        ? "<img class='avatar-image' data-logo-image src='" + escapeHtml(logoUrl) + "' alt='Logo de " +
          escapeHtml(name) + "' loading='lazy' decoding='async' referrerpolicy='no-referrer' />"
        : "") +
    "</div>";
  }

  function personAvatarMarkup(person) {
    var name = [cleanText(person && person.firstName), cleanText(person && person.lastName)].filter(Boolean).join(" ") || "Associé";
    var photoUrl = safeImageUrl(person && (person.photoUrl || person.imageUrl));
    return "<div class='person-avatar'>" +
      "<span class='person-avatar-fallback' aria-hidden='true'>" + escapeHtml(initials(name)) + "</span>" +
      (photoUrl
        ? "<img class='person-avatar-image' data-person-image src='" + escapeHtml(photoUrl) + "' alt='Photo de " +
          escapeHtml(name) + "' loading='lazy' decoding='async' referrerpolicy='no-referrer' />"
        : "") +
    "</div>";
  }

  function contactChannel(prospect) {
    var preferred = normalize(prospect && prospect.preferredContactChannel);
    if (preferred === "contact form" && safeImageUrl(prospect && prospect.contactForm)) {
      return { label: "Formulaire", color: "violet" };
    }
    if (preferred === "linkedin" && safeImageUrl(prospect && prospect.linkedin)) {
      return { label: "LinkedIn", color: "blue" };
    }
    if (preferred === "email" && cleanText(prospect && prospect.email)) {
      return { label: "Email", color: "green" };
    }
    if (cleanText(prospect && prospect.email)) return { label: "Email", color: "green" };
    if (safeImageUrl(prospect && prospect.linkedin)) return { label: "LinkedIn", color: "blue" };
    if (safeImageUrl(prospect && prospect.contactForm)) return { label: "Formulaire", color: "violet" };
    return { label: "À enrichir", color: "" };
  }

  function contactLinksMarkup(prospect) {
    var links = [];
    var decisionMakers = Array.isArray(prospect.decisionMakers) ? prospect.decisionMakers : [];
    decisionMakers.forEach(function (person) {
      var fullName = [cleanText(person.firstName), cleanText(person.lastName)].filter(Boolean).join(" ");
      var source = safeImageUrl(person.sourceUrl);
      if (fullName && source) {
        links.push({ label: cleanText(person.role) || "Associé", value: fullName, href: source });
      }
    });
    var email = cleanText(prospect.email);
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      links.push({ label: "Email", value: email, href: "mailto:" + encodeURIComponent(email) });
    }
    decisionMakers.forEach(function (person) {
      var fullName = [cleanText(person.firstName), cleanText(person.lastName)].filter(Boolean).join(" ");
      var linkedin = safeImageUrl(person.linkedin || person.linkedinUrl);
      if (fullName && linkedin) links.push({ label: "LinkedIn · " + fullName, value: linkedin, href: linkedin });
    });
    [
      ["🌐 Site officiel", prospect.website],
      ["📝 Formulaire", prospect.contactForm]
    ].forEach(function (entry) {
      var href = safeImageUrl(entry[1]);
      if (href) links.push({ label: entry[0], value: cleanText(entry[1]), href: href });
    });
    if (!links.length) {
      return "<div class='contact-empty'>Aucun contact vérifié pour le moment.</div>";
    }
    return "<div class='contact-shortcuts'>" + links.map(function (link) {
      return "<a class='contact-link' href='" + escapeHtml(link.href) + "'" +
        (link.href.indexOf("mailto:") === 0 ? "" : " target='_blank' rel='noreferrer'") +
        " title='" + escapeHtml(link.value) + "'><span>" + escapeHtml(link.label) + "</span><b aria-hidden='true'>🔗</b></a>";
    }).join("") + "</div>";
  }

  function wireImageFallbacks() {
    document.querySelectorAll("[data-logo-image]").forEach(function (image) {
      var parent = image.closest(".avatar");
      function reveal() {
        if (parent) parent.classList.add("has-image");
      }
      function fallback() {
        if (parent) parent.classList.remove("has-image");
        image.remove();
      }
      image.addEventListener("load", reveal, { once: true });
      image.addEventListener("error", fallback, { once: true });
      if (image.complete) {
        if (image.naturalWidth > 0) reveal();
        else fallback();
      }
    });
    document.querySelectorAll("[data-person-image]").forEach(function (image) {
      var parent = image.closest(".person-avatar");
      function reveal() { if (parent) parent.classList.add("has-image"); }
      function fallback() { if (parent) parent.classList.remove("has-image"); image.remove(); }
      image.addEventListener("load", reveal, { once: true });
      image.addEventListener("error", fallback, { once: true });
      if (image.complete) {
        if (image.naturalWidth > 0) reveal();
        else fallback();
      }
    });
  }

  function isCabinet(prospect) {
    return normalize(prospect.segment).indexOf("cabinet d avocat") !== -1;
  }

  function professionOf(prospect) {
    var explicit = cleanText(prospect && prospect.profession);
    if (explicit) return explicit;
    var segment = normalize(prospect && prospect.segment);
    var name = normalize(prospect && prospect.name);
    if (segment.indexOf("notarial") !== -1 || name.indexOf("notaire") !== -1) return "Notaire";
    if (segment.indexOf("commissaire de justice") !== -1 || name.indexOf("huissier") !== -1) return "Commissaire de justice";
    if (segment.indexOf("avocat") !== -1 || name.indexOf("avocat") !== -1) return "Avocat";
    return "Juridique à qualifier";
  }

  function isPriority(prospect) {
    var segment = normalize(prospect.segment);
    return isCabinet(prospect) ||
      segment.indexOf("sel juridique") !== -1 ||
      segment.indexOf("international") !== -1;
  }

  function needsQualification(prospect) {
    var segment = normalize(prospect.segment);
    return normalize(prospect.confidence) !== "elevee" ||
      segment.indexOf("qualifier") !== -1 ||
      segment.indexOf("individuelle") !== -1;
  }

  function addressKey(prospect) {
    return cleanText(prospect.addressKey) || normalize(prospect.address);
  }

  function physicalAddress(prospect) {
    return cleanText(prospect.physicalAddress) || cleanText(prospect.address);
  }

  function buildAddressIndex(list) {
    var map = {};
    list.forEach(function (prospect) {
      var key = addressKey(prospect);
      if (!key) return;
      if (!map[key]) map[key] = [];
      map[key].push(prospect);
    });
    return map;
  }

  function enriched(prospect) {
    var patch = patches[prospect.id] || {};
    var key = addressKey(prospect);
    var inferredCount = addressIndex[key] ? addressIndex[key].length : 1;
    var merged = Object.assign({}, prospect, patch);
    merged.sameAddressCount = Number(prospect.sameAddressCount) || inferredCount;
    merged.likelyDomiciliation = Boolean(prospect.likelyDomiciliation) || merged.sameAddressCount >= 10;
    merged.status = cleanText(merged.status) || "À qualifier";
    merged.decision = cleanText(merged.decision);
    return merged;
  }

  function allProspects() {
    return baseProspects.map(enriched);
  }

  function getProspect(id) {
    var prospect = baseProspects.find(function (item) { return String(item.id) === String(id); });
    return prospect ? enriched(prospect) : null;
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean))).sort(function (a, b) {
      return String(a).localeCompare(String(b), "fr", { sensitivity: "base" });
    });
  }

  function badge(text, color) {
    return "<span class='badge " + escapeHtml(color || "") + "'>" + escapeHtml(text) + "</span>";
  }

  function confidenceColor(confidence) {
    var value = normalize(confidence);
    if (value === "elevee") return "green";
    if (value === "moyenne") return "gold";
    return "violet";
  }

  function statusColor(status) {
    var value = normalize(status);
    if (value === "interesse" || value === "repondu") return "green";
    if (value === "contacte" || value === "a relancer" || value === "envoye" || value === "ouvert" || value === "sans reponse") return "blue";
    if (value === "non pertinent" || value === "spam refus") return "red";
    return "gold";
  }

  function decisionColor(decision) {
    if (normalize(decision) === "approuve") return "green";
    if (normalize(decision) === "exclu") return "red";
    return "violet";
  }

  function routeCount(routeId) {
    if (routeId === "overview") return "";
    if (routeId === "prospects") return compactNumber(baseProspects.length);
    if (routeId === "followups") {
      return compactNumber(allProspects().filter(function (item) {
        return ["a contacter", "envoye", "ouvert", "contacte", "a relancer", "sans reponse"].includes(normalize(item.status));
      }).length);
    }
    return "";
  }

  function compactNumber(value) {
    var num = Number(value) || 0;
    if (num >= 1000) return new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(num);
    return String(num);
  }

  function filteredProspects(routeId) {
    var list = allProspects();
    if (routeId === "followups") {
      list = list.filter(function (prospect) {
        return ["a contacter", "envoye", "ouvert", "contacte", "a relancer", "sans reponse"].includes(normalize(prospect.status));
      });
    }

    var query = normalize(state.search);
    if (query) {
      list = list.filter(function (prospect) {
        var haystack = normalize([
          prospect.name,
          prospect.address,
          prospect.physicalAddress,
          prospect.segment,
          professionOf(prospect),
          prospect.siret,
          prospect.id,
          prospect.website,
          prospect.email,
          prospect.linkedin,
          prospect.contactForm,
          prospect.logoUrl,
          prospect.logoSourceUrl,
          prospect.evidenceUrl,
          prospect.contactName,
          prospect.contactRole,
          prospect.specialties,
          prospect.notes
        ].join(" "));
        return query.split(" ").every(function (term) { return haystack.indexOf(term) !== -1; });
      });
    }
    if (state.segment) list = list.filter(function (item) { return item.segment === state.segment; });
    if (state.profession) list = list.filter(function (item) { return professionOf(item) === state.profession; });
    if (state.confidence) list = list.filter(function (item) { return item.confidence === state.confidence; });
    if (state.status) list = list.filter(function (item) { return item.status === state.status; });
    if (state.decision) list = list.filter(function (item) { return item.decision === state.decision; });
    if (state.headcount) list = list.filter(function (item) { return item.headcountCode === state.headcount; });

    list.sort(function (a, b) {
      var av = sortValue(a, state.sortKey);
      var bv = sortValue(b, state.sortKey);
      var result;
      if (typeof av === "number" && typeof bv === "number") result = av - bv;
      else result = String(av).localeCompare(String(bv), "fr", { numeric: true, sensitivity: "base" });
      return state.sortDir === "asc" ? result : -result;
    });
    return list;
  }

  function sortValue(item, key) {
    if (key === "fitScore" || key === "activeOffices" || key === "sameAddressCount") {
      return Number(item[key]) || 0;
    }
    if (key === "profession") return professionOf(item);
    return cleanText(item[key]);
  }

  function buildAddressGroups() {
    var list = allProspects();
    var groups = {};
    list.forEach(function (prospect) {
      var key = addressKey(prospect);
      if (!key) return;
      if (!groups[key]) {
        groups[key] = {
          key: key,
          address: physicalAddress(prospect),
          prospects: [],
          priorityCount: 0,
          segments: {}
        };
      }
      groups[key].prospects.push(prospect);
      if (isPriority(prospect)) groups[key].priorityCount += 1;
      groups[key].segments[prospect.segment] = (groups[key].segments[prospect.segment] || 0) + 1;
    });
    var result = Object.keys(groups).map(function (key) {
      var group = groups[key];
      group.count = group.prospects.length;
      group.likelyDomiciliation = group.count >= 10;
      group.topSegment = Object.keys(group.segments).sort(function (a, b) {
        return group.segments[b] - group.segments[a];
      })[0] || "";
      group.topNames = group.prospects
        .slice()
        .sort(function (a, b) { return Number(b.fitScore || 0) - Number(a.fitScore || 0); })
        .slice(0, 3)
        .map(function (item) { return item.name; });
      return group;
    });

    var query = normalize(state.search);
    if (query) {
      result = result.filter(function (group) {
        return normalize([group.address, group.topSegment, group.topNames.join(" ")].join(" "))
          .indexOf(query) !== -1;
      });
    }
    result.sort(function (a, b) {
      var key = state.sortKey;
      var av = key === "address" ? a.address : Number(a[key] != null ? a[key] : a.count);
      var bv = key === "address" ? b.address : Number(b[key] != null ? b[key] : b.count);
      var compare = typeof av === "number"
        ? av - bv
        : String(av).localeCompare(String(bv), "fr", { numeric: true, sensitivity: "base" });
      return state.sortDir === "asc" ? compare : -compare;
    });
    return result;
  }

  function shell() {
    var nav = ROUTES.map(function (route) {
      var active = route.id === state.route ? " active" : "";
      var count = routeCount(route.id);
      return "<button class='nav-item" + active + "' data-route='" + route.id + "'>" +
        "<span class='nav-icon' aria-hidden='true'>" + route.icon + "</span>" +
        "<span class='nav-copy'>" + escapeHtml(route.label) + "</span>" +
        (count ? "<span class='nav-count'>" + escapeHtml(count) + "</span>" : "") +
        "</button>";
    }).join("");

    return "<div class='app-shell'>" +
      "<aside class='sidebar" + (state.mobileOpen ? " open" : "") + "'>" +
        "<div class='brand'>" +
          "<div class='brand-logo-frame'><img class='brand-logo' src='assets/sr-galerie-logo.png' alt='SR Galerie' /></div>" +
          "<div class='brand-copy'><strong>PROSPECTS</strong><span>Paris 8e</span></div>" +
        "</div>" +
        "<div class='nav-label'>Base prospects</div>" +
        "<nav class='nav-list' aria-label='Navigation principale'>" + nav + "</nav>" +
        "<div class='sidebar-foot'>" +
          "<div class='sync'><span class='dot'></span><span>Données chargées localement</span></div>" +
          "<small>" + number(baseProspects.length) + " fiches visibles · aucune action d’envoi intégrée</small>" +
        "</div>" +
      "</aside>" +
      (state.mobileOpen ? "<button class='mobile-overlay' data-action='close-menu' aria-label='Fermer le menu'></button>" : "") +
      "<main class='main'>" +
        "<header class='topbar'>" +
          "<button class='mobile-menu' data-action='toggle-menu' aria-label='Ouvrir le menu'><span aria-hidden='true'>🧭</span></button>" +
          "<label class='searchbox' aria-label='Recherche globale'>" +
            "<input id='globalSearch' type='search' autocomplete='off' placeholder='Rechercher un cabinet, une adresse, un SIREN…' value='" + escapeHtml(state.search) + "' />" +
            "<span class='search-hint' aria-hidden='true'>🔎</span>" +
          "</label>" +
          "<div class='top-actions'>" +
            "<button class='ghost-btn' data-action='export-json'>💾 Sauvegarde JSON</button>" +
            "<button class='primary-btn' data-action='export-csv'>📤 Exporter la vue</button>" +
          "</div>" +
        "</header>" +
        "<div class='content'>" + renderView() + "</div>" +
      "</main>" +
      (state.modalId ? renderModal(getProspect(state.modalId)) : "") +
      (state.contactId ? renderContactModal(getProspect(state.contactId)) : "") +
    "</div>";
  }

  function viewHead(eyebrow, title, subtitle, side) {
    return "<div class='view-head'>" +
      "<div><div class='eyebrow'>" + escapeHtml(eyebrow) + "</div>" +
      "<h1 class='view-title'>" + escapeHtml(title) + "</h1>" +
      "<p class='view-subtitle'>" + escapeHtml(subtitle) + "</p></div>" +
      (side || "<div class='date-pill'>SIRENE · " + escapeHtml(meta.sourceDate || meta.generatedAt || "source officielle") + "</div>") +
    "</div>";
  }

  function renderView() {
    if (state.route === "overview") return renderOverview();
    if (state.route === "followups") return renderSendPlan();
    return renderProspectView(state.route);
  }

  function renderOverview() {
    var visible = allProspects();
    var priority = visible.filter(isPriority);
    var uniqueAddresses = Object.keys(addressIndex).length;
    var priorityAddresses = new Set(priority.map(addressKey).filter(Boolean)).size;
    var approved = visible.filter(function (item) { return normalize(item.decision) === "approuve"; }).length;
    var emailCount = visible.filter(function (item) { return cleanText(item.email); }).length;
    var linkedinCount = visible.filter(function (item) { return safeImageUrl(item.linkedin); }).length;
    var formCount = visible.filter(function (item) { return safeImageUrl(item.contactForm); }).length;
    var professionCounts = {};
    visible.forEach(function (item) {
      var profession = professionOf(item);
      professionCounts[profession] = (professionCounts[profession] || 0) + 1;
    });
    var professionEntries = PROFESSION_OPTIONS.map(function (profession) {
      return [profession, Number(professionCounts[profession]) || 0];
    });
    var maxProfession = Math.max.apply(null, professionEntries.map(function (entry) { return entry[1]; }).concat([1]));
    var top = priority.slice().sort(function (a, b) {
      return Number(b.fitScore || 0) - Number(a.fitScore || 0);
    }).slice(0, 8);

    return "<section class='view'>" +
      viewHead(
        "Pilotage commercial",
        "Prospection juridique · Paris 8e",
        "Une base de travail structurée pour identifier, qualifier puis approuver les bons interlocuteurs avant toute prise de contact."
      ) +
      "<div class='notice' style='margin-bottom:18px'>" +
        "Point de lecture : les " + number(meta.uniqueStructures || 13799) + " correspondent à des entités SIRENE en activité juridique, pas à " +
        number(meta.uniqueStructures || 13799) + " cabinets ni à autant d’avocats. La vue publiée écarte " +
        number(meta.withheldForReview || 0) + " fiches nécessitant une revue RGPD." +
      "</div>" +
      "<div class='kpi-grid'>" +
        kpi("Entités SIRENE brutes", meta.uniqueStructures || 13799, "🗃️", "Point de départ, avant qualification") +
        kpi("Fiches visibles", meta.publishedStructures || visible.length, "👥", "Entités publiques O/O retenues") +
        kpi("Cibles prioritaires", meta.priorityStructures || priority.length, "🎯", number(priorityAddresses) + " adresses distinctes") +
        kpi("Adresses uniques", meta.uniquePublicAddresses || uniqueAddresses, "📍", "Le volume réel de lieux est bien inférieur") +
      "</div>" +
      "<div class='dashboard-grid'>" +
        "<div class='panel'>" +
          "<div class='panel-head'><div><div class='panel-title'>Métiers ciblés</div><div class='panel-note'>La base actuelle couvre le juridique ; les autres métiers sont prêts pour l’extension.</div></div></div>" +
          "<div class='panel-body'><div class='segment-list'>" +
            professionEntries.map(function (entry) {
              var width = entry[1] ? Math.max(2, (entry[1] / maxProfession) * 100) : 0;
              return "<div class='segment-row'>" +
                "<div class='segment-name' title='" + escapeHtml(entry[0]) + "'>" + escapeHtml(entry[0]) + "</div>" +
                "<div class='bar-track'><div class='bar-fill' style='width:" + width.toFixed(1) + "%'></div></div>" +
                "<div class='segment-value'>" + (entry[1] ? number(entry[1]) : "À enrichir") + "</div>" +
              "</div>";
            }).join("") +
          "</div></div>" +
        "</div>" +
        "<div class='panel'>" +
          "<div class='panel-head'><div><div class='panel-title'>Priorités suggérées</div><div class='panel-note'>Score indicatif, jamais une décision automatique</div></div>" +
          "<button class='ghost-btn' data-route='prospects'>Voir les prospects</button></div>" +
          "<div class='panel-body'><div class='priority-list'>" +
            top.map(function (item) {
              return "<button class='priority-item' data-open='" + escapeHtml(item.id) + "'>" +
                "<span class='score-bubble'>" + number(item.fitScore) + "</span>" +
                avatarMarkup(item, "priority-avatar") +
                "<span><span class='priority-name'>" + escapeHtml(item.name) + "</span>" +
                "<span class='priority-meta'>" + escapeHtml(item.address) + "</span></span>" +
              "</button>";
            }).join("") +
          "</div></div>" +
        "</div>" +
      "</div>" +
      "<div class='dashboard-grid' style='margin-top:16px'>" +
        "<div class='panel'><div class='panel-head'><div><div class='panel-title'>Concentration des adresses</div><div class='panel-note'>Une adresse peut héberger de nombreuses entités domiciliées</div></div></div>" +
          "<div class='panel-body'>" +
            "<div class='info-grid'>" +
              infoBox("Entités prioritaires", number(priority.length)) +
              infoBox("Adresses prioritaires", number(priorityAddresses)) +
              infoBox("Décisions approuvées", number(approved)) +
              infoBox("Fiches enrichies localement", number(Object.keys(patches).length)) +
            "</div>" +
            "<div class='contact-summary'>" +
              "<div><span>Email</span><strong>" + number(emailCount) + "</strong></div>" +
              "<div><span>LinkedIn</span><strong>" + number(linkedinCount) + "</strong></div>" +
              "<div><span>Formulaire</span><strong>" + number(formCount) + "</strong></div>" +
            "</div>" +
            "<div class='notice red'>Les adresses très partagées sont signalées comme domiciliation potentielle. Elles doivent être vérifiées avant d’être traitées comme un cabinet réellement implanté sur place.</div>" +
          "</div></div>" +
        "<div class='panel'><div class='panel-head'><div><div class='panel-title'>Prochaine étape recommandée</div><div class='panel-note'>Un pilote mesurable avant toute montée en volume</div></div></div>" +
          "<div class='panel-body'><div class='step-list'>" +
            step(1, "Qualifier 50 cibles", "Vérifier site, spécialité, adresse réelle et email professionnel.") +
            step(2, "Approuver manuellement", "Ne conserver que les fiches cohérentes avec l’offre de leasing.") +
            step(3, "Tester les messages", "Comparer réponse et intérêt sur de petits lots contrôlés.") +
          "</div></div></div>" +
      "</div>" +
    "</section>";
  }

  function kpi(label, value, icon, note) {
    var valueText = /^-?\d+(?:\.\d+)?$/.test(String(value)) ? number(value) : escapeHtml(value);
    return "<div class='kpi-card'><div class='kpi-top'><div class='kpi-label'>" + escapeHtml(label) + "</div>" +
      "<div class='kpi-icon'>" + icon + "</div></div><div class='kpi-value'>" + valueText + "</div>" +
      "<div class='kpi-note'>" + escapeHtml(note) + "</div></div>";
  }

  function step(index, title, text) {
    return "<div class='step'><div class='step-num'>" + index + "</div><div><strong>" + escapeHtml(title) +
      "</strong><p>" + escapeHtml(text) + "</p></div></div>";
  }

  function infoBox(label, value, link) {
    var content = link
      ? "<a href='" + escapeHtml(link) + "' target='_blank' rel='noreferrer'>" + escapeHtml(value) + "</a>"
      : "<span>" + escapeHtml(value) + "</span>";
    return "<div class='info-box'><label>" + escapeHtml(label) + "</label>" + content + "</div>";
  }

  function renderProspectView(routeId) {
    var config = {
      prospects: ["Base opérationnelle", "Tous les prospects", "Cherchez, filtrez et enrichissez chaque fiche. Les données ajoutées restent dans ce navigateur."],
      followups: ["Suivi commercial", "Plan d’envoi", "Les fiches ajoutées depuis la base apparaissent ici, prêtes à recevoir leur séquence de prospection."]
    }[routeId] || ["Base opérationnelle", "Tous les prospects", "Cherchez, filtrez et enrichissez chaque fiche. Les données ajoutées restent dans ce navigateur."];
    var list = filteredProspects(routeId);
    var pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (state.page > pageCount) state.page = pageCount;
    var start = (state.page - 1) * PAGE_SIZE;
    var page = list.slice(start, start + PAGE_SIZE);

    return "<section class='view'>" +
      viewHead(config[0], config[1], config[2]) +
      renderFilters(routeId, list.length) +
      (page.length
        ? (state.viewMode === "grid" ? renderProspectGrid(page) : renderProspectTable(page)) +
          renderPager(pageCount, state.page)
        : "<div class='panel empty'>Aucun prospect ne correspond à ces filtres.</div>") +
    "</section>";
  }

  function renderFilters(routeId, total) {
    var prospects = allProspects();
    var headcounts = unique(prospects.map(function (item) { return item.headcountCode; }));
    return "<div class='toolbar'>" +
      selectFilter("profession", "Tous les métiers", PROFESSION_OPTIONS, state.profession) +
      selectFilter("status", "Tous les statuts", STATUS_OPTIONS.filter(Boolean), state.status) +
      selectFilter("headcount", "Tous les effectifs", headcounts, state.headcount, function (code) {
        var match = prospects.find(function (item) { return item.headcountCode === code; });
        return code === "NN" ? "Effectif inconnu" : code + " · " + (match ? match.headcountLabel : "");
      }) +
      "<span class='result-count'>" + number(total) + " résultat" + (total > 1 ? "s" : "") + " · 60 max/page</span>" +
      "<div class='view-toggle' aria-label='Mode d’affichage'>" +
        "<button class='" + (state.viewMode === "list" ? "active" : "") + "' data-view='list' title='Vue liste' aria-label='Afficher en liste'>📋</button>" +
        "<button class='" + (state.viewMode === "grid" ? "active" : "") + "' data-view='grid' title='Vue grille' aria-label='Afficher en grille'>🗂️</button>" +
      "</div>" +
    "</div>";
  }

  function selectFilter(name, emptyLabel, options, selected, labeler) {
    return "<select class='filter-select' data-filter='" + name + "' aria-label='" + escapeHtml(emptyLabel) + "'>" +
      "<option value=''>" + escapeHtml(emptyLabel) + "</option>" +
      options.map(function (option) {
        var label = labeler ? labeler(option) : option;
        return "<option value='" + escapeHtml(option) + "'" + (option === selected ? " selected" : "") + ">" +
          escapeHtml(label) + "</option>";
      }).join("") +
    "</select>";
  }

  function renderProspectTable(list) {
    return "<div class='table-wrap'><table class='data-table'>" +
      "<thead><tr>" +
        sortableHead("name", "Prospect") +
        sortableHead("profession", "Métier") +
        "<th>Contact</th>" +
        sortableHead("address", "Adresse") +
        sortableHead("headcountCode", "Effectif") +
        sortableHead("sameAddressCount", "À l’adresse") +
        sortableHead("fitScore", "Score") +
        sortableHead("status", "Statut") +
        sortableHead("decision", "Décision") +
      "</tr></thead><tbody>" +
      list.map(function (item) {
        return "<tr data-open='" + escapeHtml(item.id) + "'>" +
          "<td><div class='prospect-cell'>" + avatarMarkup(item) +
            "<div><div class='prospect-name'>" + escapeHtml(item.name) + "</div>" +
            "<div class='prospect-sub'>SIREN " + escapeHtml(item.id) + "</div></div></div></td>" +
          "<td>" + badge(professionOf(item), professionOf(item) === "Avocat" ? "gold" : "violet") + "</td>" +
          "<td>" + (firstDecisionMakerName(item) ? badge(firstDecisionMakerName(item), "blue") : badge("Associé à vérifier", "gold")) + "</td>" +
          "<td title='" + escapeHtml(item.address) + "'>" + escapeHtml(item.address) + "</td>" +
          "<td>" + escapeHtml(item.headcountCode === "NN" ? "Inconnu" : item.headcountLabel) + "</td>" +
          "<td>" + (item.likelyDomiciliation ? badge(number(item.sameAddressCount) + " · à vérifier", "red") : number(item.sameAddressCount)) + "</td>" +
          "<td><span class='score-cell'>" + number(item.fitScore) + "</span></td>" +
          "<td>" + badge(item.status, statusColor(item.status)) + "</td>" +
          "<td>" + (item.decision ? badge(item.decision, decisionColor(item.decision)) : "<span class='mini-tag'>Non décidé</span>") + "</td>" +
        "</tr>";
      }).join("") +
      "</tbody></table></div>";
  }

  function sortableHead(key, label) {
    var arrow = state.sortKey === key ? (state.sortDir === "asc" ? " ⬆️" : " ⬇️") : "";
    return "<th data-sort='" + key + "'>" + escapeHtml(label + arrow) + "</th>";
  }

  function renderProspectGrid(list) {
    return "<div class='grid-results'>" + list.map(function (item) {
      return "<article class='prospect-card' data-open='" + escapeHtml(item.id) + "'>" +
        "<div class='card-head'>" + avatarMarkup(item) +
          "<div class='card-title'><h3>" + escapeHtml(item.name) + "</h3><p>SIREN " + escapeHtml(item.id) + "</p></div>" +
          "<span class='score-bubble'>" + number(item.fitScore) + "</span></div>" +
        "<div class='card-address'>" + escapeHtml(item.address) + "</div>" +
        "<div class='card-tags'>" +
          (firstDecisionMakerName(item) ? badge(firstDecisionMakerName(item), "blue") : badge("Associé à vérifier", "gold")) +
          badge(professionOf(item), professionOf(item) === "Avocat" ? "gold" : "violet") +
          badge(item.status, statusColor(item.status)) +
          (item.likelyDomiciliation ? badge(number(item.sameAddressCount) + " à l’adresse", "red") : "") +
        "</div>" +
      "</article>";
    }).join("") + "</div>";
  }

  function renderPager(pageCount, current) {
    if (pageCount <= 1) return "";
    var pages = [];
    var first = Math.max(1, current - 2);
    var last = Math.min(pageCount, current + 2);
    if (first > 1) pages.push(1);
    for (var page = first; page <= last; page += 1) {
      if (pages.indexOf(page) === -1) pages.push(page);
    }
    if (last < pageCount && pages.indexOf(pageCount) === -1) pages.push(pageCount);
    return "<div class='pager'>" +
      "<button data-page='" + (current - 1) + "' aria-label='Page précédente'" + (current === 1 ? " disabled" : "") + ">⬅️</button>" +
      pages.map(function (pageNumber, index) {
        var previous = pages[index - 1];
        var ellipsis = previous && pageNumber - previous > 1 ? "<span class='mini-tag'>…</span>" : "";
        return ellipsis + "<button data-page='" + pageNumber + "' class='" + (pageNumber === current ? "active" : "") + "'>" + pageNumber + "</button>";
      }).join("") +
      "<button data-page='" + (current + 1) + "' aria-label='Page suivante'" + (current === pageCount ? " disabled" : "") + ">➡️</button>" +
    "</div>";
  }

  function renderMessages() {
    return "<section class='view'>" +
      viewHead(
        "Tests commerciaux",
        "Messages à tester",
        "Douze approches courtes pour tester différents déclencheurs. Les compteurs sont manuels et restent dans ce navigateur."
      ) +
      "<div class='notice' style='margin-bottom:18px'>Commencez par les trois approches marquées « À tester d’abord », sur des petits lots comparables. Mesurez surtout les réponses positives, pas seulement les ouvertures.</div>" +
      "<div class='message-grid'>" +
        MESSAGES.map(function (message) {
          var stats = messageStats[message.id] || { sent: 0, opened: 0, replies: 0, interested: 0, spam: 0 };
          var replyRate = Number(stats.sent) ? Math.round((Number(stats.replies) / Number(stats.sent)) * 100) : 0;
          return "<article class='message-card'>" +
            "<div class='message-card-head'><div style='display:flex;align-items:center;gap:10px'>" +
              "<div class='test-letter' aria-hidden='true'>" + escapeHtml(message.emoji || "💬") + "</div>" +
              "<div><div class='panel-title'>" + escapeHtml(message.name) + "</div>" +
              "<div class='panel-note'>" + escapeHtml(message.audience) + "</div></div></div>" +
              "<div class='message-result-badges'>" +
                (message.recommended ? badge("À tester d’abord", "blue") : "") +
                badge(replyRate + "% réponses", replyRate >= 10 ? "green" : "gold") +
              "</div>" +
            "</div>" +
            "<div class='message-body'>" +
              "<div class='message-meta'><strong>Objet</strong><span>" + escapeHtml(message.subject) + "</span>" +
              "<strong>Cible</strong><span>" + escapeHtml(message.audience) + "</span></div>" +
              "<div class='message-preview'>" + escapeHtml(message.body) + "</div>" +
              "<div class='message-actions'>" +
                "<button class='primary-btn' data-copy-message='" + message.id + "'>Copier le message</button>" +
                "<button class='ghost-btn' data-copy-subject='" + message.id + "'>Copier l’objet</button>" +
              "</div>" +
              "<div class='stats-strip'>" +
                statInput(message.id, "sent", "Envoyés", stats.sent) +
                statInput(message.id, "opened", "Ouverts", stats.opened) +
                statInput(message.id, "replies", "Réponses", stats.replies) +
                statInput(message.id, "interested", "Intéressés", stats.interested) +
                statInput(message.id, "spam", "Spam / refus", stats.spam) +
              "</div>" +
            "</div>" +
          "</article>";
        }).join("") +
      "</div>" +
    "</section>";
  }

  function statInput(messageId, field, label, value) {
    return "<div class='stat-input'><label for='stat-" + messageId + "-" + field + "'>" + escapeHtml(label) + "</label>" +
      "<input id='stat-" + messageId + "-" + field + "' type='number' min='0' step='1' value='" + escapeHtml(value) +
      "' data-message-stat='" + messageId + "' data-stat-field='" + field + "' /></div>";
  }

  function renderSendPlan() {
    var approved = allProspects().filter(function (item) { return normalize(item.decision) === "approuve"; }).length;
    return "<section class='view'>" +
      viewHead(
        "Cadence & validation",
        "Plan d’envoi",
        "Le dashboard prépare les lots et la traçabilité. Il n’envoie aucun email et ne contourne aucune limite de messagerie."
      ) +
      "<div class='kpi-grid'>" +
        kpi("Prospects approuvés", approved, "✅", "Décision humaine enregistrée") +
        kpi("Pilote conseillé", 50, "🧪", "À répartir d’abord entre 3 approches") +
        kpi("Départ prudent / jour", "10–20", "📤", "Puis ajustement selon les signaux") +
        kpi("Envoi direct", 0, "🚫", "Volontairement absent de l’outil") +
      "</div>" +
      "<div class='dashboard-grid'>" +
        "<div class='panel'><div class='panel-head'><div><div class='panel-title'>Workflow avec approbation</div><div class='panel-note'>Chaque étape laisse une preuve vérifiable</div></div></div>" +
          "<div class='panel-body'><div class='step-list'>" +
            step(1, "Vérifier la fiche", "Confirmer activité, site officiel, adresse réelle et spécialité.") +
            step(2, "Renseigner le contact", "Utiliser uniquement une adresse professionnelle publiée, idéalement générique.") +
            step(3, "Conserver la preuve", "Ajouter l’URL source et la date de vérification dans la fiche.") +
            step(4, "Approuver le prospect", "Victor ou Dim valide explicitement l’inclusion dans le pilote.") +
            step(5, "Envoyer depuis la boîte réelle", "Envoi manuel ou CRM contrôlé, avec cadence basse et liste d’exclusion.") +
            step(6, "Mesurer puis décider", "Comparer réponses, intérêt, désinscriptions et erreurs avant d’augmenter le volume.") +
          "</div></div></div>" +
        "<div class='panel'><div class='panel-head'><div><div class='panel-title'>Garde-fous</div><div class='panel-note'>À appliquer à chaque lot</div></div></div>" +
          "<div class='panel-body'>" +
            "<div class='notice red'>Ne jamais deviner une adresse email, automatiser un formulaire de contact ou relancer une personne qui s’est opposée à la prospection.</div>" +
            "<div class='step-list' style='margin-top:12px'>" +
              step("🎯", "Pertinence professionnelle", "Le message doit être lié à l’activité ou aux fonctions du destinataire.") +
              step("🪪", "Identité claire", "Victor et SR Galerie sont identifiables dès le premier message.") +
              step("🛑", "Opposition simple", "Une phrase courte permet de demander l’arrêt des relances.") +
              step("📎", "Pas de pièce jointe au premier contact", "Proposer 3 exemples uniquement si la personne répond positivement.") +
            "</div>" +
          "</div></div>" +
      "</div>" +
      "<div class='panel' style='margin-top:16px'><div class='panel-head'><div><div class='panel-title'>Configuration recommandée avant le pilote</div><div class='panel-note'>Checklist non technique</div></div></div>" +
        "<div class='panel-body'><div class='info-grid'>" +
          infoBox("Expéditeur", "victor@srgalerie.com") +
          infoBox("Domaine", "SPF et DKIM à conserver actifs") +
          infoBox("DMARC", "Ajouter suivi et politique progressive") +
          infoBox("Liste d’exclusion", "Obligatoire avant toute relance") +
        "</div><div class='notice'>Cette page est un plan de travail. Aucun bouton ne déclenche d’envoi.</div></div></div>" +
    "</section>";
  }

  function planDemoRows() {
    var selected = allProspects().filter(function (item) {
      return ["a contacter", "envoye", "ouvert", "contacte", "a relancer", "sans reponse", "repondu", "interesse"].includes(normalize(item.status));
    });
    var seeded = allProspects().filter(isPriority).slice(0, 3);
    var rows = selected.slice(0, 8).map(function (item) { return { prospect: item, demo: false }; });
    seeded.forEach(function (item) {
      if (rows.length < 3 && !rows.some(function (row) { return row.prospect.id === item.id; })) rows.push({ prospect: item, demo: true });
    });
    return rows;
  }

  function planStepMarkup(index, activeIndex, label) {
    var stateClass = index < activeIndex ? "done" : (index === activeIndex ? "current" : "");
    return "<div class='plan-step " + stateClass + "'><span>" + (index + 1) + "</span><small>" + escapeHtml(label) + "</small></div>";
  }

  function renderPlanCard(row, index) {
    var item = row.prospect;
    var statuses = ["À contacter", "Envoyé", "Ouvert", "Répondu", "Intéressé"];
    var normalStatus = normalize(item.status);
    var active = normalStatus === "interesse" ? 4 : normalStatus === "repondu" ? 3 : normalStatus === "ouvert" ? 2 : normalStatus === "envoye" || normalStatus === "contacte" ? 1 : 0;
    var contact = firstDecisionMakerName(item) || cleanText(item.email) || "Contact à confirmer";
    var specialty = cleanText(item.specialties);
    return "<article class='plan-card'>" +
      "<div class='plan-card-head'>" + avatarMarkup(item) +
        "<div class='plan-card-title'><strong>" + escapeHtml(item.name) + "</strong><span>" + escapeHtml(contact) + " · " + escapeHtml(item.address) + "</span></div>" +
        badge(row.demo ? "Démo" : (item.status || "À contacter"), row.demo ? "violet" : statusColor(item.status)) +
      "</div>" +
      "<div class='plan-layout'>" +
        "<div class='plan-message-choice plan-profile'><label>🧭 Profil du prospect</label>" +
          "<div class='plan-profession'>" + escapeHtml(professionOf(item)) + "</div>" +
          "<div class='plan-profile-copy'>" + escapeHtml(specialty || "Cabinet / structure professionnelle à qualifier") + "</div>" +
          "<div class='plan-contact-line'>👤 " + escapeHtml(contact) + "</div>" +
          "<button class='primary-btn' data-action='open-contact' data-contact-id='" + escapeHtml(item.id) + "'>✉️ Contacter</button>" +
        "</div>" +
        "<div class='plan-tracking'><div class='plan-tracking-head'><strong>📈 Suivi du prospect</strong><span>" + escapeHtml(statuses[active]) + "</span></div>" +
          "<div class='plan-timeline'>" + statuses.map(function (label, stepIndex) { return planStepMarkup(stepIndex, active, label); }).join("") + "</div>" +
          "<div class='plan-event'>" + (active === 0 ? "Prêt à être contacté" : active === 1 ? "Message envoyé · suivi d’ouverture" : active === 2 ? "Ouverture détectée · relance à préparer" : active === 3 ? "Réponse reçue · qualifier l’intérêt" : "Intérêt confirmé · organiser un échange") + "</div>" +
        "</div>" +
      "</div>" +
    "</article>";
  }

  function renderSendPlan() {
    var rows = planDemoRows();
    var actualCount = rows.filter(function (row) { return !row.demo; }).length;
    return "<section class='view'>" +
      viewHead("Pilotage commercial", "Plan d’envoi", "Les prospects choisis, leur message et leur suivi commercial au même endroit.") +
      "<div class='plan-summary'>" +
        infoBox("👥 Prospects sélectionnés", number(actualCount)) +
        infoBox("📤 À contacter", number(rows.filter(function (row) { return normalize(row.prospect.status) === "a contacter" || row.demo; }).length)) +
        infoBox("💬 Approches à tester", number(Math.min(6, MESSAGES.length))) +
        infoBox("📈 Suivi", "Du premier contact à l’intérêt") +
      "</div>" +
      "<div class='plan-list'>" + rows.map(renderPlanCard).join("") + "</div>" +
      "<div class='panel plan-learning' style='margin-top:16px'><div class='panel-head'><div><div class='panel-title'>🧠 Messages qui performent</div><div class='panel-note'>Le meilleur message sera privilégié ; les prochains tests partiront de ce qui génère réellement des réponses.</div></div></div>" +
        "<div class='panel-body'><div class='info-grid'>" +
          infoBox("📬 Taux d’ouverture", "À connecter") +
          infoBox("💬 Taux de réponse", "À connecter") +
          infoBox("✨ Intérêts confirmés", "À connecter") +
          infoBox("🎯 Logique", "Tester · mesurer · améliorer") +
        "</div><p class='plan-learning-note'>Les résultats seront comparés par message et par métier afin de recommander la prochaine meilleure approche, sans envoyer automatiquement à grande échelle.</p></div></div>" +
    "</section>";
  }

  function renderSources() {
    var sources = [
      {
        name: "Annuaire des Entreprises",
        role: "Export SIRENE officiel, activité 69.10Z",
        url: "https://annuaire-entreprises.data.gouv.fr/api/export-sirene"
      },
      {
        name: "Base SIRENE",
        role: "Définition et réutilisation des données",
        url: "https://www.data.gouv.fr/fr/datasets/base-sirene-des-entreprises-et-de-leurs-etablissements-siren-siret/"
      },
      {
        name: "CNIL",
        role: "Prospection commerciale par courrier électronique",
        url: "https://www.cnil.fr/fr/la-prospection-commerciale-par-courrier-electronique"
      },
      {
        name: "SR Galerie",
        role: "Offre de leasing et éléments de présentation",
        url: "https://www.srgalerie.com/leasing/"
      }
    ];
    return "<section class='view'>" +
      viewHead(
        "Traçabilité",
        "Sources & méthode",
        "Origine des données, règles de lecture et limites à garder visibles pendant toute la qualification."
      ) +
      "<div class='panel'><div class='panel-head'><div><div class='panel-title'>Sources de référence</div><div class='panel-note'>Liens externes ouverts dans un nouvel onglet</div></div></div>" +
        "<div class='panel-body'><div class='source-list'>" +
          sources.map(function (source) {
            return "<div class='source-item'><strong>" + escapeHtml(source.name) + "</strong>" +
              "<span>" + escapeHtml(source.role) + "</span>" +
              "<a href='" + escapeHtml(source.url) + "' target='_blank' rel='noreferrer'>" + escapeHtml(source.url) + "</a></div>";
          }).join("") +
        "</div></div></div>" +
      "<div class='dashboard-grid' style='margin-top:16px'>" +
        "<div class='panel'><div class='panel-head'><div><div class='panel-title'>Périmètre de la base</div></div></div>" +
          "<div class='panel-body'><div class='info-grid'>" +
            infoBox("Géographie", meta.scope || "Paris 8e · 75108") +
            infoBox("Activité", "69.10Z · Activités juridiques") +
            infoBox("Date source", meta.sourceDate || "Non renseignée") +
            infoBox("Génération", meta.generatedAt || "Non renseignée") +
            infoBox("Établissements actifs", number(meta.rawEstablishments || 0)) +
            infoBox("Entités SIREN uniques", number(meta.uniqueStructures || 0)) +
          "</div></div></div>" +
        "<div class='panel'><div class='panel-head'><div><div class='panel-title'>Limites importantes</div></div></div>" +
          "<div class='panel-body'><div class='step-list'>" +
            step(1, "SIRENE n’est pas une liste de cabinets", "Une ligne peut désigner un indépendant, une société, un office ou une entité domiciliée.") +
            step(2, "L’effectif NN est inconnu", "Il ne signifie jamais zéro salarié.") +
            step(3, "Le score est une aide", "Il ne remplace ni la visite du site ni la décision humaine.") +
            step(4, "Les enrichissements sont locaux", "Ils restent dans le navigateur et doivent être exportés pour être sauvegardés ailleurs.") +
          "</div></div></div>" +
      "</div>" +
      "<div class='notice red' style='margin-top:16px'>La publication GitHub ne doit contenir que les fichiers chiffrés. Ne publiez jamais data.js, les exports CSV ou les enrichissements en clair.</div>" +
    "</section>";
  }

  function renderContactModal(prospect) {
    if (!prospect) {
      state.contactId = null;
      return "";
    }
    var message = personalizeMessage(MESSAGES[0].id, prospect);
    var email = cleanText(prospect.email);
    var mailto = email ? "mailto:" + encodeURIComponent(email) + "?subject=" + encodeURIComponent(message.subject) + "&body=" + encodeURIComponent(message.body) : "";
    return "<div class='modal-backdrop' data-action='close-contact'>" +
      "<section class='modal contact-modal' role='dialog' aria-modal='true' aria-label='Contacter ce prospect'>" +
        "<div class='modal-head'>" + avatarMarkup(prospect, "avatar-large") +
          "<div class='modal-title'><h2>Contacter " + escapeHtml(prospect.name) + "</h2><p>Choisissez une approche courte, puis préparez le message dans votre messagerie.</p></div>" +
          "<button class='icon-btn' data-action='close-contact' aria-label='Fermer'><span aria-hidden='true'>✖️</span></button>" +
        "</div>" +
        "<div class='modal-scroll contact-modal-body'>" +
          "<label class='field full'><span>💬 Approche à envoyer</span><select id='contactMessageSelect' data-contact-message='" + escapeHtml(prospect.id) + "'>" +
            MESSAGES.slice(0, 10).map(function (item, index) { return "<option value='" + escapeHtml(item.id) + "'" + (index === 0 ? " selected" : "") + ">" + escapeHtml(item.emoji + " " + item.name) + "</option>"; }).join("") +
          "</select></label>" +
          "<div class='contact-preview'><div class='contact-preview-label'>Objet</div><strong id='contactSubject'>" + escapeHtml(message.subject) + "</strong><div class='contact-preview-label'>Message</div><pre id='contactBody'>" + escapeHtml(message.body) + "</pre></div>" +
          (email
            ? "<a class='primary-btn' id='contactMailLink' href='" + escapeHtml(mailto) + "'>✉️ Préparer l’email à " + escapeHtml(email) + "</a>"
            : "<div class='notice red'>Aucun email professionnel renseigné pour ce prospect. Complétez la fiche avant l’envoi.</div>") +
          "<div class='contact-modal-actions'><button class='ghost-btn' data-action='mark-sent' data-contact-id='" + escapeHtml(prospect.id) + "'>✅ Marquer comme envoyé</button><span>Le statut est mis à jour manuellement après l’envoi réel.</span></div>" +
        "</div>" +
      "</section>" +
    "</div>";
  }

  function renderModal(prospect) {
    if (!prospect) {
      state.modalId = null;
      return "";
    }
    var patch = patches[prospect.id] || {};
    return "<div class='modal-backdrop' data-action='close-modal'>" +
      "<section class='modal' role='dialog' aria-modal='true' aria-label='Fiche prospect' data-modal-panel>" +
        "<div class='modal-head'>" +
          avatarMarkup(prospect, "avatar-large") +
          "<div class='modal-title'><h2>" + escapeHtml(prospect.name) + "</h2><p>SIREN " + escapeHtml(prospect.id) +
            " · " + escapeHtml(professionOf(prospect)) + "</p></div>" +
          "<button class='icon-btn' data-action='close-modal' aria-label='Fermer'><span aria-hidden='true'>✖️</span></button>" +
        "</div>" +
        "<div class='modal-scroll'><div class='modal-grid'>" +
          "<div class='modal-column'>" +
            "<h3 class='section-title'>Identité SIRENE</h3>" +
            "<div class='info-grid'>" +
              infoBox("🪪 SIRET", prospect.siret || "Non renseigné") +
              infoBox("⚖️ Forme juridique", prospect.legalCategoryLabel || prospect.legalCategory || "Non renseignée") +
              infoBox("📍 Adresse", prospect.address || "Non renseignée") +
              infoBox("👥 Effectif", prospect.headcountCode === "NN" ? "Inconnu · pas zéro" : (prospect.headcountLabel || prospect.headcountCode)) +
              infoBox("📅 Création entreprise", dateFr(prospect.companyCreated || prospect.created)) +
            "</div>" +
            (prospect.likelyDomiciliation
              ? "<div class='notice red' style='margin-bottom:18px'>" + number(prospect.sameAddressCount) +
                " entités partagent cette adresse. Vérifier qu’il s’agit bien d’une implantation réelle avant approbation.</div>"
              : "") +
          "</div>" +
          "<div class='modal-column'>" +
            "<form id='prospectForm' data-prospect-id='" + escapeHtml(prospect.id) + "'>" +
              "<h3 class='section-title'>Qualification commerciale</h3>" +
              decisionMakersMarkup(prospect) +
              "<div class='form-grid'>" +
                formField("website", "🌐 Site officiel", "url", patch.website || prospect.website || "", "https://…") +
                formField("email", "✉️ Email professionnel", "email", patch.email || prospect.email || "", "contact@…") +
                formField("contactLinkedin", "💼 LinkedIn de l’interlocuteur", "url", patch.contactLinkedin || "", "https://linkedin.com/in/…") +
                formField("contactForm", "📝 Formulaire de contact", "url", patch.contactForm || prospect.contactForm || "", "https://…") +
                formField("contactName", "👤 Associé / fondateur", "text", patch.contactName || firstDecisionMakerName(prospect), "Prénom Nom") +
                formField("contactRole", "⚖️ Qualité", "text", patch.contactRole || firstDecisionMakerRole(prospect), "Associé, associé-fondateur…") +
                selectField("profession", "🧭 Métier", PROFESSION_OPTIONS, patch.profession || professionOf(prospect)) +
                formField("specialties", "🎯 Spécialités", "text", patch.specialties || "", "Fiscal, affaires, social…", true) +
                textareaField("notes", "🗒️ Notes internes", patch.notes || "", true) +
              "</div>" +
              "<div class='modal-actions'>" +
                "<button type='button' class='primary-btn' data-action='save-prospect'>Enregistrer la fiche</button>" +
                "<button type='button' class='ghost-btn' data-action='prospect-client'>📤 Prospecter ce client</button>" +
              "</div>" +
            "</form>" +
          "</div>" +
        "</div></div>" +
      "</section>" +
    "</div>";
  }

  function formField(name, label, type, value, placeholder, full) {
    return "<div class='field" + (full ? " full" : "") + "'><label for='field-" + escapeHtml(name) + "'>" + escapeHtml(label) + "</label>" +
      "<input id='field-" + escapeHtml(name) + "' name='" + escapeHtml(name) + "' type='" + escapeHtml(type) +
      "' value='" + escapeHtml(value) + "' placeholder='" + escapeHtml(placeholder || "") + "' /></div>";
  }

  function textareaField(name, label, value, full) {
    return "<div class='field" + (full ? " full" : "") + "'><label for='field-" + escapeHtml(name) + "'>" + escapeHtml(label) + "</label>" +
      "<textarea id='field-" + escapeHtml(name) + "' name='" + escapeHtml(name) + "'>" + escapeHtml(value) + "</textarea></div>";
  }

  function selectField(name, label, options, selected, labeler) {
    return "<div class='field'><label for='field-" + escapeHtml(name) + "'>" + escapeHtml(label) + "</label>" +
      "<select id='field-" + escapeHtml(name) + "' name='" + escapeHtml(name) + "'>" +
      options.map(function (option) {
        var optionLabel = labeler ? labeler(option) : (option || "Non défini");
        return "<option value='" + escapeHtml(option) + "'" + (option === selected ? " selected" : "") + ">" +
          escapeHtml(optionLabel) + "</option>";
      }).join("") +
    "</select></div>";
  }

  function personalizeMessage(messageId, prospect) {
    var message = MESSAGES.find(function (item) { return item.id === messageId; }) || MESSAGES[0];
    var body = message.body;
    var subject = message.subject;
    var cabinet = prospect ? cleanText(prospect.brandName || prospect.name) : "[Cabinet]";
    var contactName = prospect ? cleanText(prospect.contactName) : "";
    body = body.replace(/\[Cabinet\]/g, cabinet || "votre cabinet");
    subject = subject.replace(/\[Cabinet\]/g, cabinet || "votre cabinet");
    body = body.replace(
      "Bonjour Maître [Nom],",
      contactName ? "Bonjour Maître " + contactName + "," : "Bonjour,"
    );
    return { subject: subject, body: body };
  }

  function firstDecisionMakerName(prospect) {
    var people = Array.isArray(prospect && prospect.decisionMakers) ? prospect.decisionMakers : [];
    var person = people[0] || {};
    return [cleanText(person.firstName), cleanText(person.lastName)].filter(Boolean).join(" ");
  }

  function firstDecisionMakerRole(prospect) {
    var people = Array.isArray(prospect && prospect.decisionMakers) ? prospect.decisionMakers : [];
    return cleanText((people[0] || {}).role);
  }

  function decisionMakersMarkup(prospect) {
    var people = Array.isArray(prospect && prospect.decisionMakers) ? prospect.decisionMakers : [];
    if (!people.length) return "<div class='notice red'>Aucun associé/fondateur vérifié pour le moment. Ne pas utiliser un nom déduit.</div>";
    return "<div class='contact-links'><div class='section-title' style='margin:0 0 10px'>👤 Associés / fondateurs vérifiés</div>" + people.map(function (person) {
      var name = [cleanText(person.firstName), cleanText(person.lastName)].filter(Boolean).join(" ");
      var source = safeImageUrl(person.sourceUrl);
      var linkedin = safeImageUrl(person.linkedin || person.linkedinUrl);
      var href = linkedin || source;
      var content = personAvatarMarkup(person) + "<span class='person-copy'><strong>" + escapeHtml(name) + "</strong><small>" + escapeHtml(person.role) + "</small></span>" + (linkedin ? "<b aria-hidden='true'>💼</b>" : "");
      return href
        ? "<a class='person-card' href='" + escapeHtml(href) + "' target='_blank' rel='noreferrer'>" + content + "</a>"
        : "<div class='person-card'>" + content + "</div>";
    }).join("") + "</div>";
  }

  function saveProspect(sendToPlan) {
    var form = document.getElementById("prospectForm");
    if (!form) return;
    var id = form.getAttribute("data-prospect-id");
    var data = new FormData(form);
    var patch = Object.assign({}, patches[id] || {});
    [
      "website",
      "email",
      "contactForm",
      "contactLinkedin",
      "contactName",
      "contactRole",
      "profession",
      "specialties",
      "notes"
    ].forEach(function (field) {
      patch[field] = cleanText(data.get(field));
    });
    if (sendToPlan) {
      patch.status = "À contacter";
      patch.prospectingAddedAt = new Date().toISOString();
    }
    patch.localUpdatedAt = new Date().toISOString();

    Object.keys(patch).forEach(function (key) {
      if (patch[key] === "") delete patch[key];
    });
    patches[id] = patch;
    safeStorageSet(STORAGE.patches, JSON.stringify(patches));
    state.modalId = null;
    if (sendToPlan) {
      state.status = "";
      setRoute("followups");
      showToast("Client ajouté au Plan d’envoi");
      return;
    }
    render();
    showToast("Fiche enregistrée localement");
  }

  function clearFilters() {
    state.search = "";
    state.segment = "";
    state.profession = "";
    state.status = "";
    state.decision = "";
    state.headcount = "";
    state.page = 1;
    state.sortKey = "fitScore";
    state.sortDir = "desc";
    render();
  }

  function setRoute(route) {
    if (!ROUTES.some(function (item) { return item.id === route; })) return;
    state.route = route;
    state.page = 1;
    state.mobileOpen = false;
    if (!["overview", "messages"].includes(route)) {
      state.sortKey = "fitScore";
      state.sortDir = "desc";
    }
    if (location.hash !== "#" + route) location.hash = route;
    render();
  }

  function exportJson() {
    var payload = {
      exportedAt: new Date().toISOString(),
      scope: meta.scope || "Paris 8e",
      patches: patches,
      messageStats: messageStats
    };
    download("sr-galerie-enrichissements-" + isoDate() + ".json", JSON.stringify(payload, null, 2), "application/json");
    showToast("Sauvegarde JSON téléchargée");
  }

  function csvCell(value) {
    var text = String(value == null ? "" : value).replace(/\r?\n/g, " ");
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    var route = ["prospects", "followups"].includes(state.route) ? state.route : "prospects";
    var headers = [
      "SIREN", "SIRET", "Nom", "Segment", "Adresse", "Effectif",
      "Score", "Entités à l’adresse", "Statut", "Décision", "Site", "Email",
      "LinkedIn interlocuteur", "Formulaire", "Spécialités", "Interlocuteur", "Fonction", "Vérifié le", "Notes"
    ];
    var rows = filteredProspects(route).map(function (item) {
      return [
        item.id, item.siret, item.name, item.segment, item.address,
        item.headcountCode === "NN" ? "Inconnu" : item.headcountLabel,
        item.fitScore, item.sameAddressCount, item.status, item.decision,
        item.website, item.email, item.contactLinkedin, item.contactForm, item.specialties,
        item.contactName, item.contactRole, item.sourceCheckedAt, item.notes
      ];
    });
    var content = "\ufeff" + [headers].concat(rows).map(function (row) {
      return row.map(csvCell).join(";");
    }).join("\r\n");
    download("sr-galerie-" + state.route + "-" + isoDate() + ".csv", content, "text/csv;charset=utf-8");
    showToast(number(rows.length) + " ligne" + (rows.length > 1 ? "s" : "") + " exportée" + (rows.length > 1 ? "s" : ""));
  }

  function isoDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function download(filename, content, type) {
    var blob = new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function copyText(value, confirmation) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () {
        showToast(confirmation || "Copié");
      }).catch(function () {
        fallbackCopy(value, confirmation);
      });
    } else {
      fallbackCopy(value, confirmation);
    }
  }

  function fallbackCopy(value, confirmation) {
    var area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      showToast(confirmation || "Copié");
    } catch (error) {
      showToast("Impossible de copier automatiquement");
    }
    area.remove();
  }

  var toastTimer = null;
  function showToast(message) {
    var old = document.querySelector(".toast");
    if (old) old.remove();
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.remove(); }, 2800);
  }

  function render(focusSearch) {
    root.innerHTML = shell();
    wireImageFallbacks();
    document.body.style.overflow = state.modalId || state.contactId ? "hidden" : "";
    if (focusSearch) {
      var input = document.getElementById("globalSearch");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  var searchTimer = null;

  root.addEventListener("click", function (event) {
    var routeButton = event.target.closest("[data-route]");
    if (routeButton) {
      setRoute(routeButton.getAttribute("data-route"));
      return;
    }

    var openButton = event.target.closest("[data-open]");
    if (openButton) {
      state.modalId = openButton.getAttribute("data-open");
      render();
      return;
    }

    var addressRow = event.target.closest("[data-address]");
    if (addressRow) {
      state.search = addressRow.getAttribute("data-address");
      setRoute("prospects");
      return;
    }

    var pageButton = event.target.closest("[data-page]");
    if (pageButton && !pageButton.disabled) {
      state.page = Math.max(1, Number(pageButton.getAttribute("data-page")) || 1);
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    var sortButton = event.target.closest("[data-sort]");
    if (sortButton) {
      var key = sortButton.getAttribute("data-sort");
      if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else {
        state.sortKey = key;
        state.sortDir = ["name", "segment", "profession", "address", "status", "decision"].includes(key) ? "asc" : "desc";
      }
      state.page = 1;
      render();
      return;
    }

    var viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      state.viewMode = viewButton.getAttribute("data-view") === "grid" ? "grid" : "list";
      safeStorageSet(STORAGE.viewMode, state.viewMode);
      render();
      return;
    }

    var copyMessage = event.target.closest("[data-copy-message]");
    if (copyMessage) {
      var message = MESSAGES.find(function (item) { return item.id === copyMessage.getAttribute("data-copy-message"); });
      if (message) copyText("Objet : " + message.subject + "\n\n" + message.body, "Message copié");
      return;
    }

    var copySubject = event.target.closest("[data-copy-subject]");
    if (copySubject) {
      var subjectMessage = MESSAGES.find(function (item) { return item.id === copySubject.getAttribute("data-copy-subject"); });
      if (subjectMessage) copyText(subjectMessage.subject, "Objet copié");
      return;
    }

    var action = event.target.closest("[data-action]");
    if (!action) return;
    var actionName = action.getAttribute("data-action");

    if (actionName === "toggle-menu") {
      state.mobileOpen = !state.mobileOpen;
      render();
    } else if (actionName === "close-menu") {
      state.mobileOpen = false;
      render();
    } else if (actionName === "close-modal") {
      if (action.classList.contains("modal-backdrop") && event.target !== action) return;
      state.modalId = null;
      render();
    } else if (actionName === "open-contact") {
      state.contactId = action.getAttribute("data-contact-id");
      render();
    } else if (actionName === "close-contact") {
      if (action.classList.contains("modal-backdrop") && event.target !== action) return;
      state.contactId = null;
      render();
    } else if (actionName === "clear-filters") {
      clearFilters();
    } else if (actionName === "export-json") {
      exportJson();
    } else if (actionName === "export-csv") {
      exportCsv();
    } else if (actionName === "save-prospect") {
      saveProspect();
    } else if (actionName === "prospect-client") {
      saveProspect(true);
    } else if (actionName === "mark-sent") {
      var sentId = action.getAttribute("data-contact-id");
      if (sentId) {
        patches[sentId] = Object.assign({}, patches[sentId] || {}, { status: "Envoyé", sentAt: new Date().toISOString(), localUpdatedAt: new Date().toISOString() });
        safeStorageSet(STORAGE.patches, JSON.stringify(patches));
      }
      state.contactId = null;
      render();
      showToast("Prospect marqué comme envoyé");
    }
  });

  root.addEventListener("click", function (event) {
    if (event.target.classList.contains("modal-backdrop")) {
      state.modalId = null;
      state.contactId = null;
      render();
    }
  });

  root.addEventListener("input", function (event) {
    if (event.target.id === "globalSearch") {
      state.search = event.target.value;
      state.page = 1;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        if (state.search && !["prospects", "followups"].includes(state.route)) {
          setRoute("prospects");
        } else {
          render(true);
        }
      }, 150);
    }
  });

  root.addEventListener("change", function (event) {
    var filter = event.target.getAttribute("data-filter");
    if (filter) {
      state[filter] = event.target.value;
      state.page = 1;
      render();
      return;
    }
    var messageId = event.target.getAttribute("data-message-stat");
    if (messageId) {
      var field = event.target.getAttribute("data-stat-field");
      if (!messageStats[messageId]) messageStats[messageId] = { sent: 0, replies: 0, interested: 0 };
      messageStats[messageId][field] = Math.max(0, Number(event.target.value) || 0);
      safeStorageSet(STORAGE.messageStats, JSON.stringify(messageStats));
      showToast("Résultat du test enregistré");
      return;
    }
    var contactMessageId = event.target.getAttribute("data-contact-message");
    if (contactMessageId) {
      var contactProspect = getProspect(contactMessageId);
      var selectedMessage = MESSAGES.find(function (item) { return item.id === event.target.value; }) || MESSAGES[0];
      var personalized = personalizeMessage(selectedMessage.id, contactProspect);
      var subjectNode = document.getElementById("contactSubject");
      var bodyNode = document.getElementById("contactBody");
      var mailLink = document.getElementById("contactMailLink");
      if (subjectNode) subjectNode.textContent = personalized.subject;
      if (bodyNode) bodyNode.textContent = personalized.body;
      if (mailLink && contactProspect && contactProspect.email) {
        mailLink.href = "mailto:" + encodeURIComponent(contactProspect.email) + "?subject=" + encodeURIComponent(personalized.subject) + "&body=" + encodeURIComponent(personalized.body);
      }
    }
  });

  window.addEventListener("hashchange", function () {
    var next = routeFromHash();
    if (next !== state.route) {
      state.route = next;
      state.page = 1;
      state.mobileOpen = false;
      state.modalId = null;
      state.contactId = null;
      render();
    }
  });

  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      if (state.modalId) {
        state.modalId = null;
        render();
      } else if (state.contactId) {
        state.contactId = null;
        render();
      } else if (state.mobileOpen) {
        state.mobileOpen = false;
        render();
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      var search = document.getElementById("globalSearch");
      if (search) search.focus();
    }
  });

  window.SRDashboard = {
    start: function () {
      render();
      return true;
    },
    exportPatches: exportJson
  };

  render();
})();
