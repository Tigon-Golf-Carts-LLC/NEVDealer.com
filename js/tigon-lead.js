/*
 * NEV DEALER (https://nevdealer.com) -> TIGON IOT "Webhook Flows" lead integration.
 *
 * Loaded on every page with:  <script src="js/tigon-lead.js" defer></script>
 *
 * What it does:
 *   - Saves first-touch attribution (utm_*, gclid, fbclid) in localStorage for 30 days on every page view.
 *   - Adds a "Get a Quote" lead form modal + floating "Call Now" / "Get a Quote" buttons on every page.
 *   - On dealer pages, adds "Call Now" (dealer's number) + "Get a Quote" buttons under the dealer heading
 *     and sends the dealer name with the lead.
 *   - Renders the inline contact form wherever <div data-tigon-form-mount></div> exists (contact.html).
 *   - Validates, then POSTs multipart/form-data straight from the browser to this website's webhook.
 *
 * The webhook below belongs to NEV DEALER only. Do not copy it to any other website.
 * No signing secret is used or stored here (signatures are optional for this webhook) —
 * never put a webhook secret in this file or any other browser-side file.
 */
(function () {
  "use strict";

  var ENDPOINT = "https://tigoniot.com/hooks/JqEysUbTztACNKApi3sLxTreyeLRy2Eu";
  var FORM_NAME = "Contact form";
  var SITE_PHONE = "1-844-844-6638";
  var SITE_PHONE_TEL = "+18448446638";
  var HONEYPOT = "website";
  var SUCCESS_TEXT = "Thank you! We received your message and a Neighborhood Electric Vehicle specialist will contact you shortly.";
  var ERROR_TEXT = "Sorry, something went wrong. Please try again or call us at " + SITE_PHONE + ".";
  var RATE_LIMIT_TEXT = "Too many tries. Please wait a minute and try again, or call us at " + SITE_PHONE + ".";
  var MAX_FILE_MB = 10;
  var IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif)$/i;
  var TRACK = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
  var STORE_KEY = "tigon_first_touch";
  var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  var instance = 0;
  var lastFocus = null;

  /* ---------- Tracking ---------- */

  // First-touch attribution: the first utm_*/gclid/fbclid seen are kept for 30 days.
  function firstTouch() {
    var current = {}, found = false, q = null;
    try { q = new URLSearchParams(window.location.search); } catch (e) { q = null; }
    TRACK.forEach(function (k) { var v = q && q.get(k); if (v) { current[k] = v; found = true; } });
    var saved = null;
    try { saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || "null"); } catch (e) { saved = null; }
    if (saved && (!saved.ts || Date.now() - saved.ts > MAX_AGE_MS)) saved = null;
    if (!saved && found) {
      saved = { ts: Date.now(), v: current };
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch (e) { /* private mode */ }
    }
    var out = {};
    TRACK.forEach(function (k) { out[k] = (saved && saved.v && saved.v[k]) || current[k] || ""; });
    return out;
  }

  // Google Analytics client id from the _ga cookie: GA1.1.123456.789012 -> 123456.789012
  function gaClientId() {
    var m = document.cookie.match(/(?:^|;\s*)_ga=([^;]+)/);
    if (!m) return "";
    var parts = decodeURIComponent(m[1]).split(".");
    return parts.length >= 4 ? parts.slice(-2).join(".") : "";
  }

  function tracking() {
    var t = firstTouch();
    t.url = window.location.href;
    t.referrer = document.referrer || "";
    t.ga_client_id = gaClientId();
    return t;
  }

  /* ---------- Page context ---------- */

  function digits(s) { return String(s || "").replace(/\D/g, ""); }

  // Dealer pages: <section class="dealer-header"><h1>Hatfield, PA</h1> ... + a tel: link in .dealer-content
  function dealerContext() {
    var h = document.querySelector(".dealer-header h1");
    if (!h) return null;
    var name = h.textContent.trim();
    var phoneText = SITE_PHONE, phoneTel = SITE_PHONE_TEL;
    var link = document.querySelector('.dealer-content a[href^="tel:"]');
    if (link && digits(link.getAttribute("href")).length >= 10) {
      phoneTel = link.getAttribute("href").slice(4);
      phoneText = link.textContent.trim();
    }
    return { name: name, phoneText: phoneText, phoneTel: phoneTel };
  }

  /* ---------- Form markup ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function field(id, name, label, opts) {
    opts = opts || {};
    var attrs = ' name="' + name + '" id="' + id + '-' + name + '" class="form-control"';
    if (opts.type !== "textarea") attrs = ' type="' + (opts.type || "text") + '"' + attrs;
    if (opts.autocomplete) attrs += ' autocomplete="' + opts.autocomplete + '"';
    if (opts.inputmode) attrs += ' inputmode="' + opts.inputmode + '"';
    if (opts.placeholder) attrs += ' placeholder="' + esc(opts.placeholder) + '"';
    if (opts.accept) attrs += ' accept="' + opts.accept + '"';
    if (opts.value) attrs += ' value="' + esc(opts.value) + '"';
    if (opts.readonly) attrs += " readonly";
    if (opts.required) attrs += ' required aria-required="true"';
    attrs += ' aria-describedby="' + id + '-' + name + '-err"';
    var control = opts.type === "textarea"
      ? "<textarea" + attrs + ' rows="4"></textarea>'
      : "<input" + attrs + ">";
    return '<div class="tgn-field' + (opts.half ? " tgn-half" : "") + '">' +
      '<label for="' + id + '-' + name + '">' + esc(label) + (opts.required ? ' <span aria-hidden="true">*</span>' : "") + "</label>" +
      control +
      '<span class="tgn-err" id="' + id + '-' + name + '-err" aria-live="polite"></span>' +
      "</div>";
  }

  function formHTML(id, ctx) {
    var accept = "image/*,.heic,.heif";
    var hidden = ["form_name", "url", "referrer"].concat(TRACK, ["ga_client_id"]).map(function (n) {
      return '<input type="hidden" name="' + n + '" value="' + (n === "form_name" ? esc(FORM_NAME) : "") + '">';
    }).join("");
    if (ctx.dealer) hidden += '<input type="hidden" name="dealer" value="' + esc(ctx.dealer.name) + '">';

    return '<form id="' + id + '" class="tigon-lead-form" method="post" action="' + ENDPOINT + '" enctype="multipart/form-data" novalidate data-tigon-form>' +
      '<div class="tgn-grid">' +
      field(id, "first_name", "First name", { required: true, half: true, autocomplete: "given-name" }) +
      field(id, "last_name", "Last name", { required: true, half: true, autocomplete: "family-name" }) +
      field(id, "email", "Email", { type: "email", required: true, half: true, autocomplete: "email" }) +
      field(id, "phone1", "Phone", { type: "tel", required: true, half: true, autocomplete: "tel" }) +
      field(id, "phone2", "Alternate phone", { type: "tel", half: true }) +
      field(id, "zip_code", "ZIP code", { half: true, inputmode: "numeric", autocomplete: "postal-code" }) +
      field(id, "address", "Address", { autocomplete: "street-address" }) +
      field(id, "brand", "Brand", { half: true, placeholder: "e.g. TIGON", value: ctx.brand, readonly: !!ctx.brand }) +
      field(id, "model", "Model you are interested in", { half: true, placeholder: "e.g. Tigon Blaze 4", value: ctx.model, readonly: !!ctx.model }) +
      field(id, "vin_number", "VIN (optional)", { half: true, value: ctx.vin, readonly: !!ctx.vin }) +
      field(id, "sku_number", "Stock # / SKU (optional)", { half: true, value: ctx.sku, readonly: !!ctx.sku }) +
      field(id, "comments", "Message", { type: "textarea", placeholder: ctx.dealer ? "Questions for " + ctx.dealer.name + "?" : "How can we help?" }) +
      field(id, "image_1", "Photo 1 (optional)", { type: "file", accept: accept }) +
      field(id, "image_2", "Photo 2 (optional)", { type: "file", accept: accept }) +
      field(id, "image_3", "Photo 3 (optional)", { type: "file", accept: accept }) +
      "</div>" +
      '<p class="tgn-hint">Photos: up to ' + MAX_FILE_MB + ' MB each (jpg, png, gif, webp or heic).</p>' +
      // Spam trap: real visitors never see this. It must be sent empty.
      '<div class="tgn-hp" aria-hidden="true">' +
      '<label for="' + id + '-hp">Leave this field empty</label>' +
      '<input type="text" name="' + HONEYPOT + '" id="' + id + '-hp" tabindex="-1" autocomplete="off" value="">' +
      "</div>" +
      hidden +
      '<button type="submit" class="submit-btn tgn-submit">Send Message</button>' +
      '<p class="tigon-msg" role="status" aria-live="polite"></p>' +
      "</form>";
  }

  // Cart details can be supplied on listing pages via data attributes on the mount / opener:
  //   data-brand, data-model, data-vin, data-sku
  function context(el) {
    var d = (el && el.dataset) || {};
    return { dealer: dealerContext(), brand: d.brand || "", model: d.model || "", vin: d.vin || "", sku: d.sku || "" };
  }

  function fillHidden(form) {
    var t = tracking();
    Object.keys(t).forEach(function (k) {
      var el = form.querySelector('input[type="hidden"][name="' + k + '"]');
      if (el) el.value = t[k];
    });
  }

  /* ---------- Validation ---------- */

  function setError(form, name, text) {
    var input = form.querySelector('[name="' + name + '"]');
    var err = input && document.getElementById(input.id + "-err");
    if (err) err.textContent = text || "";
    if (input) {
      if (text) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    }
    return !text;
  }

  function validate(form) {
    var v = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? el.value.trim() : ""; };
    var ok = true, first = null;
    function check(name, msg) {
      var good = setError(form, name, msg);
      if (!good) { ok = false; if (!first) first = name; }
    }
    check("first_name", v("first_name") ? "" : "Please enter your first name.");
    check("last_name", v("last_name") ? "" : "Please enter your last name.");
    var email = v("email");
    check("email", !email ? "Please enter your email." :
      (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? "" : "Please enter a valid email address."));
    var p1 = v("phone1");
    check("phone1", !p1 ? "Please enter your phone number." :
      (digits(p1).length >= 10 ? "" : "Please enter a phone number with at least 10 digits."));
    var p2 = v("phone2");
    check("phone2", !p2 || digits(p2).length >= 10 ? "" : "Please enter a phone number with at least 10 digits.");
    ["image_1", "image_2", "image_3"].forEach(function (n) {
      var input = form.querySelector('[name="' + n + '"]');
      var f = input && input.files && input.files[0];
      var msg = "";
      if (f) {
        if (f.size > MAX_FILE_MB * 1024 * 1024) msg = "Each photo must be smaller than " + MAX_FILE_MB + " MB.";
        else if (!/^image\//.test(f.type) && !IMAGE_EXT.test(f.name)) msg = "Please choose a jpg, png, gif, webp or heic photo.";
      }
      check(n, msg);
    });
    if (first) {
      var el = form.querySelector('[name="' + first + '"]');
      if (el) el.focus();
    }
    return ok;
  }

  /* ---------- Sending ---------- */

  function show(form, text, ok) {
    var el = form.querySelector(".tigon-msg");
    el.textContent = text;
    el.className = "tigon-msg " + (ok ? "tgn-ok" : "tgn-bad");
  }

  function buildData(form) {
    var fd = new FormData(form);
    // Leave out empty file inputs so no blank images are sent.
    ["image_1", "image_2", "image_3"].forEach(function (n) {
      var input = form.querySelector('[name="' + n + '"]');
      if (!input || !input.files || !input.files.length) fd.delete(n);
    });
    var t = tracking();
    Object.keys(t).forEach(function (k) { fd.set(k, t[k]); });
    fd.set("form_name", FORM_NAME);
    if (!fd.has(HONEYPOT)) fd.set(HONEYPOT, "");
    return fd;
  }

  function send(form) {
    if (form.getAttribute("data-sending")) return;
    show(form, "", true);
    if (!validate(form)) { show(form, "Please fix the highlighted fields.", false); return; }

    var button = form.querySelector(".tgn-submit");
    var label = button.textContent;
    var fd = buildData(form);
    form.setAttribute("data-sending", "1");
    button.disabled = true;
    button.textContent = "Sending…";
    show(form, "Sending…", true);

    fetch(ENDPOINT, { method: "POST", body: fd, mode: "cors" })
      .then(function (res) {
        return res.text().then(function (body) {
          var data = null;
          try { data = JSON.parse(body); } catch (e) { data = null; }
          if (res.status === 429) throw new Error(RATE_LIMIT_TEXT);
          if (!res.ok || !data || data.ok !== true) throw new Error((data && (data.error || data.message)) || ERROR_TEXT);
          return data;
        });
      })
      .then(function () {
        // Keep pre-filled cart / dealer details after reset.
        var keep = {};
        ["brand", "model", "vin_number", "sku_number"].forEach(function (n) {
          var el = form.querySelector('[name="' + n + '"]');
          if (el && el.readOnly) keep[n] = el.value;
        });
        form.reset();
        Object.keys(keep).forEach(function (n) { form.querySelector('[name="' + n + '"]').value = keep[n]; });
        fillHidden(form);
        show(form, SUCCESS_TEXT, true);
        if (typeof window.gtag === "function") window.gtag("event", "generate_lead", { form_name: FORM_NAME });
      })
      .catch(function (err) {
        var msg = err && err.message;
        show(form, msg && msg !== "Failed to fetch" && msg !== "Load failed" ? msg : ERROR_TEXT, false);
      })
      .then(function () {
        form.removeAttribute("data-sending");
        button.disabled = false;
        button.textContent = label;
      });
  }

  /* ---------- Modal + call-to-action buttons ---------- */

  function buildModal() {
    var ctx = context(null);
    var id = "tigon-form-modal";
    var wrap = document.createElement("div");
    wrap.className = "tgn-modal";
    wrap.id = "tigon-lead-modal";
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="tgn-backdrop" data-tigon-close></div>' +
      '<div class="tgn-dialog" role="dialog" aria-modal="true" aria-labelledby="tigon-lead-modal-title">' +
      '<button type="button" class="tgn-close" data-tigon-close aria-label="Close">&times;</button>' +
      '<h2 id="tigon-lead-modal-title">' + (ctx.dealer ? "Contact " + esc(ctx.dealer.name) : "Get a Quote") + "</h2>" +
      '<p class="tgn-sub">Prefer to talk? <a href="tel:' + esc(ctx.dealer ? ctx.dealer.phoneTel : SITE_PHONE_TEL) + '">Call ' +
      esc(ctx.dealer ? ctx.dealer.phoneText : SITE_PHONE) + "</a></p>" +
      formHTML(id, ctx) +
      "</div>";
    document.body.appendChild(wrap);
    fillHidden(wrap.querySelector("form"));
    return wrap;
  }

  function openModal(opener) {
    var modal = document.getElementById("tigon-lead-modal") || buildModal();
    // Listing pages: carry the cart's details from the button that opened the modal.
    var d = (opener && opener.dataset) || {};
    [["brand", d.brand], ["model", d.model], ["vin_number", d.vin], ["sku_number", d.sku]].forEach(function (p) {
      var el = modal.querySelector('[name="' + p[0] + '"]');
      if (el && p[1]) { el.value = p[1]; el.readOnly = true; }
    });
    fillHidden(modal.querySelector("form"));
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.documentElement.classList.add("tgn-lock");
    var first = modal.querySelector('[name="first_name"]');
    if (first) first.focus();
  }

  function closeModal() {
    var modal = document.getElementById("tigon-lead-modal");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.documentElement.classList.remove("tgn-lock");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function ctaButtons(phoneText, phoneTel, extraClass) {
    var div = document.createElement("div");
    div.className = "tgn-cta" + (extraClass ? " " + extraClass : "");
    div.innerHTML =
      '<a class="btn tgn-call" href="tel:' + esc(phoneTel) + '">&#9742; Call Now<span class="tgn-num"> ' + esc(phoneText) + "</span></a>" +
      '<button type="button" class="btn tgn-quote" data-tigon-open>Get a Quote</button>';
    return div;
  }

  function addButtons() {
    var dealer = dealerContext();
    var phoneText = dealer ? dealer.phoneText : SITE_PHONE;
    var phoneTel = dealer ? dealer.phoneTel : SITE_PHONE_TEL;

    // Floating bar on every page (bottom of the screen).
    var bar = ctaButtons(phoneText, phoneTel, "tgn-float");
    bar.setAttribute("aria-label", "Contact");
    document.body.appendChild(bar);

    // Nav link
    var navList = document.querySelector("nav ul");
    if (navList && !navList.querySelector("[data-tigon-open]")) {
      var li = document.createElement("li");
      li.innerHTML = '<a href="contact.html" data-tigon-open>Get a Quote</a>';
      navList.appendChild(li);
    }

    // Dealer pages: Call Now + Get a Quote under the dealer heading.
    var header = document.querySelector(".dealer-header");
    if (header && !header.querySelector(".tgn-cta")) header.appendChild(ctaButtons(phoneText, phoneTel, "tgn-inline"));

    // Under any existing "Call Now" / "Apply for Financing" buttons, add a "Get a Quote" button.
    document.querySelectorAll("[data-tigon-cta-after]").forEach(function (el) {
      if (el.nextElementSibling && el.nextElementSibling.hasAttribute("data-tigon-open")) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn tgn-quote";
      b.setAttribute("data-tigon-open", "");
      b.textContent = "Get a Quote";
      el.parentNode.insertBefore(b, el.nextSibling);
    });
  }

  function mountInlineForms() {
    document.querySelectorAll("[data-tigon-form-mount]").forEach(function (mount) {
      if (mount.querySelector("form")) return;
      instance += 1;
      mount.innerHTML = formHTML("tigon-form-inline-" + instance, context(mount));
      fillHidden(mount.querySelector("form"));
    });
  }

  /* ---------- Wiring ---------- */

  // Capture phase: runs before any other handlers and works for forms added later.
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.hasAttribute || !form.hasAttribute("data-tigon-form")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    send(form);
  }, true);

  document.addEventListener("click", function (e) {
    var t = e.target.closest ? e.target : null;
    if (!t) return;
    var opener = t.closest("[data-tigon-open]");
    if (opener) { e.preventDefault(); openModal(opener); return; }
    if (t.closest("[data-tigon-close]")) { e.preventDefault(); closeModal(); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModal();
  });

  function init() {
    firstTouch(); // remember attribution on landing, even if the visitor submits on a later page
    mountInlineForms();
    addButtons();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
