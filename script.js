/* =====================================================================
   MARGIN — script.js
   A vanilla-JS single-page app backed entirely by Supabase.
   No build step, no framework — just DOM APIs and the Supabase client.
   ===================================================================== */

(function () {
"use strict";

/* ---------------------------------------------------------------------
   0. SUPABASE CLIENT
   --------------------------------------------------------------------- */

if (!window.supabase) {
  console.error("Supabase JS library failed to load.");
}
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const MAX_PDF_MB = 25;
const MAX_IMG_MB = 5;

/* ---------------------------------------------------------------------
   1. STATE
   --------------------------------------------------------------------- */

let currentUser = null;      // Supabase auth user, or null
let currentProfile = null;   // row from public.profiles, or null
let authReady = false;
let pendingRedirect = null;  // where to send the user after login

let subjectsCache = [];      // [{id, name}]
let notesCache = null;       // all notes, refreshed per home/admin visit
let razorpayScriptLoaded = false;

const homeState = { search: "", subjectId: "", className: "", type: "all", sort: "newest" };
let adminActiveTab = "notes";

const viewRoot = document.getElementById("view-root");

/* ---------------------------------------------------------------------
   2. SMALL UTILITIES
   --------------------------------------------------------------------- */

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatPrice(note) {
  if (note.is_free) return "Free";
  const n = Number(note.price || 0);
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function sanitizeFilename(name) {
  return String(name).trim().replace(/[^a-zA-Z0-9.\-_]/g, "_").slice(-100);
}

function toast(message, type = "info", duration = 3800) {
  const stack = document.getElementById("toast-stack");
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function navigate(hash) {
  if (location.hash === hash) { router(); } else { location.hash = hash; }
}

function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function coverPublicUrl(path) {
  if (!path) return null;
  const { data } = supabase.storage.from("cover-images").getPublicUrl(path);
  return data?.publicUrl || null;
}

async function getSignedPdfUrl(path, { download = false, expiresIn = 3600 } = {}) {
  const opts = download ? { download: true } : {};
  const { data, error } = await supabase.storage.from("notes-pdfs").createSignedUrl(path, expiresIn, opts);
  if (error) throw error;
  return data.signedUrl;
}

/* ---------------------------------------------------------------------
   3. AUTH
   --------------------------------------------------------------------- */

async function handleSessionChange(session) {
  currentUser = session?.user || null;
  if (currentUser) {
    const { data, error } = await supabase.from("profiles").select("*").eq("id", currentUser.id).single();
    currentProfile = error ? null : data;
  } else {
    currentProfile = null;
  }
  refreshAuthUI();
}

function refreshAuthUI() {
  const isAdmin = !!currentProfile?.is_admin;
  qsa("[data-guest-only]").forEach((el) => el.classList.toggle("hidden", !!currentUser));
  qsa("[data-user-only]").forEach((el) => el.classList.toggle("hidden", !currentUser));
  qsa("[data-requires-admin]").forEach((el) => el.classList.toggle("hidden", !isAdmin));
  qsa("[data-requires-auth]").forEach((el) => el.classList.toggle("hidden", !currentUser));

  if (currentUser) {
    const initial = (currentProfile?.full_name || currentUser.email || "U").trim().charAt(0).toUpperCase();
    qs("#user-menu-initial").textContent = initial;
    qs("#user-menu-email").textContent = currentUser.email;
  }
}

async function signUp(fullName, email, password) {
  const { data, error } = await supabase.auth.signUp({
    email, password, options: { data: { full_name: fullName } },
  });
  if (error) throw error;
  return data;
}

async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signOut() {
  await supabase.auth.signOut();
  navigate("#/");
}

function requireAuth() {
  if (!currentUser) {
    pendingRedirect = location.hash || "#/";
    toast("Please log in to continue.", "info");
    navigate("#/login");
    return false;
  }
  return true;
}

function requireAdmin() {
  if (!requireAuth()) return false;
  if (!currentProfile?.is_admin) {
    toast("That page is for admins only.", "error");
    navigate("#/");
    return false;
  }
  return true;
}

/* ---------------------------------------------------------------------
   4. DATA ACCESS
   --------------------------------------------------------------------- */

async function fetchSubjects() {
  const { data, error } = await supabase.from("subjects").select("*").order("name", { ascending: true });
  if (error) throw error;
  subjectsCache = data || [];
  return subjectsCache;
}

async function fetchAllNotes() {
  const { data, error } = await supabase
    .from("notes")
    .select("*, subject:subjects(id, name)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  notesCache = data || [];
  return notesCache;
}

async function fetchNoteById(id) {
  const { data, error } = await supabase
    .from("notes")
    .select("*, subject:subjects(id, name)")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

async function fetchMyPurchase(noteId) {
  if (!currentUser) return null;
  const { data, error } = await supabase
    .from("purchases")
    .select("*")
    .eq("note_id", noteId)
    .eq("user_id", currentUser.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function matchesSearch(note, term) {
  if (!term) return true;
  const t = term.toLowerCase();
  return (
    (note.title || "").toLowerCase().includes(t) ||
    (note.chapter || "").toLowerCase().includes(t) ||
    (note.subject?.name || "").toLowerCase().includes(t) ||
    (note.description || "").toLowerCase().includes(t) ||
    (note.class_name || "").toLowerCase().includes(t)
  );
}

function applyFilters(notes, { search, subjectId, className, type }) {
  return notes.filter((n) =>
    matchesSearch(n, search) &&
    (!subjectId || n.subject_id === subjectId) &&
    (!className || n.class_name === className) &&
    (type === "all" || (type === "free" && n.is_free) || (type === "paid" && !n.is_free))
  );
}

function applySort(notes, sort) {
  const arr = [...notes];
  if (sort === "price_asc") arr.sort((a, b) => Number(a.price) - Number(b.price));
  else if (sort === "price_desc") arr.sort((a, b) => Number(b.price) - Number(a.price));
  else arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return arr;
}

function isHomeFiltering() {
  return !!(homeState.search || homeState.subjectId || homeState.className || homeState.type !== "all" || homeState.sort !== "newest");
}

/* ---------------------------------------------------------------------
   5. ROUTER
   --------------------------------------------------------------------- */

function parseHash() {
  const raw = (location.hash || "#/").slice(1);
  const [pathPart, queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const query = new URLSearchParams(queryPart || "");
  return { segments, query };
}

async function router() {
  closeMobileNav();
  closeUserMenu();
  const { segments, query } = parseHash();
  viewRoot.focus();

  try {
    if (segments.length === 0) {
      await renderHome(query.get("q") || "");
    } else if (segments[0] === "note" && segments[1]) {
      await renderNoteDetails(segments[1]);
    } else if (segments[0] === "login") {
      renderLogin();
    } else if (segments[0] === "signup") {
      renderSignup();
    } else if (segments[0] === "my-notes") {
      if (requireAuth()) await renderMyNotes();
    } else if (segments[0] === "admin") {
      if (requireAdmin()) await renderAdmin(query.get("tab") || adminActiveTab);
    } else {
      renderNotFound();
    }
  } catch (err) {
    console.error(err);
    viewRoot.innerHTML = `<div class="container center-msg"><h2>Something went wrong</h2><p>${escapeHtml(err.message || "Please try again.")}</p></div>`;
  }

  qsa('[data-link]').forEach((a) => {
    a.classList.toggle("router-active", a.getAttribute("href") === location.hash);
  });
}

/* ---------------------------------------------------------------------
   6. HOME VIEW
   --------------------------------------------------------------------- */

function noteCardHtml(note) {
  const cover = coverPublicUrl(note.cover_path);
  const badge = note.is_free
    ? `<span class="note-card__badge note-card__badge--free">Free</span>`
    : `<span class="note-card__badge note-card__badge--paid">Paid</span>`;
  const featured = note.is_featured ? `<span class="note-card__featured">★ Featured</span>` : "";
  const coverInner = cover
    ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" />`
    : `<div class="note-card__cover-fallback">${escapeHtml(note.subject?.name || "Notes")}<br/>${escapeHtml(note.class_name || "")}</div>`;

  return `
    <a class="note-card" href="#/note/${note.id}" data-link>
      <div class="note-card__cover">${coverInner}${badge}${featured}</div>
      <div class="note-card__body">
        <div class="note-card__subject">${escapeHtml(note.subject?.name || "General")} · ${escapeHtml(note.class_name || "")}</div>
        <h3 class="note-card__title">${escapeHtml(note.title)}</h3>
        <div class="note-card__meta">
          <span>${escapeHtml(note.chapter || "")}</span>
          <span class="note-card__price">${formatPrice(note)}</span>
        </div>
      </div>
    </a>`;
}

function skeletonGrid(count = 4) {
  return `<div class="skeleton-grid">${Array.from({ length: count }).map(() => `<div class="skeleton-card"></div>`).join("")}</div>`;
}

function emptyState(title, body) {
  return `
    <div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><path d="M4 4h12l4 4v12H4V4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M16 4v4h4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(body)}</p>
    </div>`;
}

async function renderHome(initialQuery) {
  if (initialQuery) homeState.search = initialQuery;

  viewRoot.innerHTML = `
    <section class="hero container">
      <p class="hero__eyebrow">Your notes, organized</p>
      <h1>Everything you need, one <span class="highlight">chapter</span> at a time.</h1>
      <p class="lede">Browse notes by subject and class, preview before you buy, and keep every purchase in your library.</p>
      <form id="hero-search-form" class="hero-search">
        <input id="hero-search-input" type="search" placeholder="Search by title, chapter, or subject…" value="${escapeHtml(homeState.search)}" />
        <button type="submit" class="btn btn--primary">Search</button>
      </form>
    </section>

    <section class="container" id="chip-row-wrap"></section>
    <section class="container" id="filter-bar-wrap"></section>
    <section class="container" id="home-results">${skeletonGrid(8)}</section>
  `;

  qs("#hero-search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    homeState.search = qs("#hero-search-input").value.trim();
    renderHomeResults();
  });

  try {
    await Promise.all([fetchSubjects(), fetchAllNotes()]);
  } catch (err) {
    qs("#home-results").innerHTML = `<div class="empty-state"><h3>Couldn't load notes</h3><p>${escapeHtml(err.message)}</p></div>`;
    return;
  }

  renderChipRow();
  renderFilterBar();
  renderHomeResults();
}

function renderChipRow() {
  const classes = [...new Set(notesCache.map((n) => n.class_name).filter(Boolean))].sort();
  const wrap = qs("#chip-row-wrap");
  if (subjectsCache.length === 0 && classes.length === 0) { wrap.innerHTML = ""; return; }

  const subjectChips = subjectsCache.map((s) => `<button class="chip ${homeState.subjectId === s.id ? "is-active" : ""}" data-subject-chip="${s.id}">${escapeHtml(s.name)}</button>`).join("");

  wrap.innerHTML = `
    <div class="chip-row" id="chip-row">
      <button class="chip ${!homeState.subjectId ? "is-active" : ""}" data-subject-chip="">All subjects</button>
      ${subjectChips}
    </div>`;

  qsa("[data-subject-chip]", wrap).forEach((btn) => {
    btn.addEventListener("click", () => {
      homeState.subjectId = btn.dataset.subjectChip || "";
      renderChipRow();
      renderFilterBar();
      renderHomeResults();
    });
  });
}

function renderFilterBar() {
  const classes = [...new Set(notesCache.map((n) => n.class_name).filter(Boolean))].sort();
  const wrap = qs("#filter-bar-wrap");
  wrap.innerHTML = `
    <div class="filter-bar">
      <div class="filter-bar__group">
        <label for="f-subject">Subject</label>
        <select id="f-subject">
          <option value="">All subjects</option>
          ${subjectsCache.map((s) => `<option value="${s.id}" ${homeState.subjectId === s.id ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
        </select>
      </div>
      <div class="filter-bar__group">
        <label for="f-class">Class</label>
        <select id="f-class">
          <option value="">All classes</option>
          ${classes.map((c) => `<option value="${escapeHtml(c)}" ${homeState.className === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
        </select>
      </div>
      <div class="filter-bar__group">
        <label for="f-type">Type</label>
        <select id="f-type">
          <option value="all" ${homeState.type === "all" ? "selected" : ""}>Free &amp; Paid</option>
          <option value="free" ${homeState.type === "free" ? "selected" : ""}>Free only</option>
          <option value="paid" ${homeState.type === "paid" ? "selected" : ""}>Paid only</option>
        </select>
      </div>
      <div class="filter-bar__group">
        <label for="f-sort">Sort by</label>
        <select id="f-sort">
          <option value="newest" ${homeState.sort === "newest" ? "selected" : ""}>Newest first</option>
          <option value="price_asc" ${homeState.sort === "price_asc" ? "selected" : ""}>Price: low to high</option>
          <option value="price_desc" ${homeState.sort === "price_desc" ? "selected" : ""}>Price: high to low</option>
        </select>
      </div>
      ${isHomeFiltering() ? `<button class="btn btn--ghost btn--sm" id="f-clear" style="margin-left:auto;">Clear filters</button>` : ""}
    </div>`;

  qs("#f-subject").addEventListener("change", (e) => { homeState.subjectId = e.target.value; renderChipRow(); renderHomeResults(); });
  qs("#f-class").addEventListener("change", (e) => { homeState.className = e.target.value; renderHomeResults(); });
  qs("#f-type").addEventListener("change", (e) => { homeState.type = e.target.value; renderHomeResults(); });
  qs("#f-sort").addEventListener("change", (e) => { homeState.sort = e.target.value; renderHomeResults(); });
  const clearBtn = qs("#f-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    homeState.search = ""; homeState.subjectId = ""; homeState.className = ""; homeState.type = "all"; homeState.sort = "newest";
    qs("#hero-search-input").value = "";
    renderChipRow(); renderFilterBar(); renderHomeResults();
  });
}

function renderHomeResults() {
  const results = qs("#home-results");
  if (!notesCache) return;

  if (notesCache.length === 0) {
    results.innerHTML = emptyState("No notes available", "Nothing has been added yet. Check back soon.");
    return;
  }

  if (isHomeFiltering()) {
    const filtered = applySort(applyFilters(notesCache, homeState), homeState.sort);
    results.innerHTML = `
      <div class="section__head"><h2>${filtered.length} result${filtered.length === 1 ? "" : "s"}</h2></div>
      ${filtered.length ? `<div class="note-grid">${filtered.map(noteCardHtml).join("")}</div>` : emptyState("No matches", "Try a different search term or filter.")}
    `;
    return;
  }

  const featured = notesCache.filter((n) => n.is_featured).slice(0, 6);
  const latest = notesCache.slice(0, 8);
  const free = notesCache.filter((n) => n.is_free).slice(0, 8);
  const paid = notesCache.filter((n) => !n.is_free).slice(0, 8);

  const section = (title, linkType, items) => {
    if (!items.length) return "";
    return `
      <section class="section">
        <div class="section__head">
          <h2>${title}</h2>
          <a href="#" class="section__link" data-view-all="${linkType}">View all</a>
        </div>
        <div class="note-grid">${items.map(noteCardHtml).join("")}</div>
      </section>`;
  };

  results.innerHTML = `
    ${section("Featured notes", "featured", featured)}
    ${section("Latest notes", "newest", latest)}
    ${section("Free notes", "free", free)}
    ${section("Paid notes", "paid", paid)}
  `;

  qsa("[data-view-all]", results).forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const kind = a.dataset.viewAll;
      if (kind === "free") homeState.type = "free";
      else if (kind === "paid") homeState.type = "paid";
      else if (kind === "featured") homeState.search = "featured-view"; // handled below
      if (kind === "featured") {
        results.innerHTML = `<div class="section__head"><h2>Featured notes</h2></div><div class="note-grid">${featured.map(noteCardHtml).join("")}</div>`;
        return;
      }
      renderFilterBar();
      renderHomeResults();
      window.scrollTo({ top: results.offsetTop - 90, behavior: "smooth" });
    });
  });
}

/* ---------------------------------------------------------------------
   7. NOTE DETAILS VIEW
   --------------------------------------------------------------------- */

async function renderNoteDetails(id) {
  viewRoot.innerHTML = `<div class="container"><div class="loading-spin"></div></div>`;

  let note;
  try {
    note = await fetchNoteById(id);
  } catch (err) {
    viewRoot.innerHTML = `<div class="container center-msg"><h2>Note not found</h2><p>It may have been removed.</p><a class="btn btn--primary" href="#/" data-link>Back to home</a></div>`;
    return;
  }

  const purchase = await fetchMyPurchase(note.id).catch(() => null);
  const hasAccess = note.is_free || !!purchase;
  const cover = coverPublicUrl(note.cover_path);

  viewRoot.innerHTML = `
    <div class="container details">
      <div>
        <div class="details__preview" id="preview-box">
          ${cover ? `<img class="details__preview-cover" src="${escapeHtml(cover)}" alt="" />` : ""}
          <div id="preview-body"><div class="loading-spin"></div></div>
        </div>
      </div>

      <aside class="details__panel">
        <div class="details__tags">
          <span class="tag">${escapeHtml(note.subject?.name || "General")}</span>
          <span class="tag">${escapeHtml(note.class_name || "")}</span>
          ${note.is_featured ? `<span class="tag">★ Featured</span>` : ""}
        </div>
        <h1>${escapeHtml(note.title)}</h1>
        ${note.chapter ? `<p class="text-sm"><strong>Chapter:</strong> ${escapeHtml(note.chapter)}</p>` : ""}
        ${note.description ? `<p>${escapeHtml(note.description)}</p>` : ""}

        <div class="details__price">
          ${note.is_free ? "Free" : formatPrice(note)}
          ${!note.is_free ? `<small> one-time</small>` : ""}
        </div>

        <div id="details-cta" class="stack"></div>

        <div class="details__meta-row"><span>Uploaded</span><span>${formatDate(note.created_at)}</span></div>
        <div class="details__meta-row"><span>Status</span><span>${note.is_free ? "Free" : "Paid"}</span></div>
      </aside>
    </div>
  `;

  const previewBody = qs("#preview-body");
  const cta = qs("#details-cta");

  if (hasAccess) {
    try {
      const viewUrl = await getSignedPdfUrl(note.pdf_path, { expiresIn: 3600 });
      previewBody.innerHTML = `<iframe class="details__preview-frame" src="${escapeHtml(viewUrl)}" title="PDF preview"></iframe>`;
      cta.innerHTML = `
        <a class="btn btn--primary btn--block" href="${escapeHtml(viewUrl)}" target="_blank" rel="noopener">Open PDF</a>
        <button class="btn btn--ghost btn--block" id="download-btn">Download PDF</button>
      `;
      qs("#download-btn").addEventListener("click", async () => {
        try {
          const dlUrl = await getSignedPdfUrl(note.pdf_path, { download: true, expiresIn: 300 });
          window.location.href = dlUrl;
        } catch (err) { toast("Couldn't prepare the download: " + err.message, "error"); }
      });
    } catch (err) {
      previewBody.innerHTML = `<div class="details__locked"><p>Couldn't load the PDF: ${escapeHtml(err.message)}</p></div>`;
    }
  } else if (!note.is_free && note.allow_preview) {
    try {
      const previewUrl = await getSignedPdfUrl(note.pdf_path, { expiresIn: 90 });
      previewBody.innerHTML = `<iframe class="details__preview-frame" src="${escapeHtml(previewUrl)}" title="PDF preview"></iframe>`;
    } catch (err) {
      previewBody.innerHTML = lockedHtml();
    }
    cta.innerHTML = buyButtonHtml(note);
    wireBuyButton(note);
  } else {
    previewBody.innerHTML = lockedHtml();
    cta.innerHTML = buyButtonHtml(note);
    wireBuyButton(note);
  }
}

function lockedHtml() {
  return `
    <div class="details__locked">
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none"><rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 10V7a4 4 0 018 0v3" stroke="currentColor" stroke-width="1.5"/></svg>
      <p>This is a paid note. Buy it to unlock the full PDF.</p>
    </div>`;
}

function buyButtonHtml(note) {
  return `<button class="btn btn--marker btn--block" id="buy-now-btn" data-note-id="${note.id}">Buy Now — ${formatPrice(note)}</button>`;
}

function wireBuyButton(note) {
  const btn = qs("#buy-now-btn");
  if (btn) btn.addEventListener("click", () => buyNote(note));
}

/* ---------------------------------------------------------------------
   8. PAYMENT FLOW (Razorpay)
   --------------------------------------------------------------------- */

function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (razorpayScriptLoaded && window.Razorpay) return resolve();
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => { razorpayScriptLoaded = true; resolve(); };
    script.onerror = () => reject(new Error("Could not load the payment window. Check your connection."));
    document.body.appendChild(script);
  });
}

async function buyNote(note) {
  if (!requireAuth()) return;
  const btn = qs("#buy-now-btn");
  const originalText = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Starting payment…"; }

  try {
    const { data, error } = await supabase.functions.invoke("create-razorpay-order", {
      body: { note_id: note.id },
    });
    if (error) throw new Error(error.message || "Could not start payment.");
    if (data?.error) throw new Error(data.error);

    await loadRazorpayScript();

    const options = {
      key: data.key_id,
      amount: data.amount,
      currency: data.currency,
      name: "Margin",
      description: data.note_title,
      order_id: data.razorpay_order_id,
      prefill: { email: currentUser.email },
      theme: { color: "#1B1F3B" },
      handler: function (response) {
        verifyPaymentAndUnlock(response, note);
      },
      modal: {
        ondismiss: function () {
          toast("Payment cancelled — the note is still locked.", "info");
          if (btn) { btn.disabled = false; btn.textContent = originalText; }
        },
      },
    };

    const rzp = new window.Razorpay(options);
    rzp.on("payment.failed", function (resp) {
      toast("Payment failed: " + (resp?.error?.description || "please try again."), "error");
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
    });
    rzp.open();
  } catch (err) {
    toast(err.message || "Could not start payment.", "error");
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

async function verifyPaymentAndUnlock(razorpayResponse, note) {
  toast("Verifying your payment…", "info");
  try {
    const { data, error } = await supabase.functions.invoke("verify-razorpay-payment", {
      body: {
        razorpay_order_id: razorpayResponse.razorpay_order_id,
        razorpay_payment_id: razorpayResponse.razorpay_payment_id,
        razorpay_signature: razorpayResponse.razorpay_signature,
      },
    });
    if (error) throw new Error(error.message || "Verification failed.");
    if (!data?.success) throw new Error(data?.error || "Payment could not be verified.");

    toast("Payment successful! Unlocking your note…", "success");
    await renderNoteDetails(note.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    toast("Payment verification failed: " + err.message, "error");
  }
}

/* ---------------------------------------------------------------------
   9. LOGIN / SIGNUP VIEWS
   --------------------------------------------------------------------- */

function renderLogin() {
  if (currentUser) { navigate("#/"); return; }
  viewRoot.innerHTML = `
    <div class="auth-wrap">
      <div class="card-panel">
        <h1>Log in</h1>
        <p class="text-sm">Welcome back. Enter your details to continue.</p>
        <div id="auth-msg"></div>
        <form id="login-form">
          <div class="field"><label for="li-email">Email</label><input id="li-email" type="email" required autocomplete="email" /></div>
          <div class="field"><label for="li-password">Password</label><input id="li-password" type="password" required autocomplete="current-password" /></div>
          <button class="btn btn--primary btn--block" type="submit">Log in</button>
        </form>
        <p class="text-sm" style="margin-top:16px;">New here? <a class="text-link" href="#/signup" data-link>Create an account</a></p>
      </div>
    </div>`;

  qs("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = qs("#auth-msg");
    msg.innerHTML = "";
    const email = qs("#li-email").value.trim();
    const password = qs("#li-password").value;
    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      await signIn(email, password);
      toast("Welcome back!", "success");
      navigate(pendingRedirect || "#/");
      pendingRedirect = null;
    } catch (err) {
      msg.innerHTML = `<div class="form-msg form-msg--error">${escapeHtml(err.message)}</div>`;
      submitBtn.disabled = false;
    }
  });
}

function renderSignup() {
  if (currentUser) { navigate("#/"); return; }
  viewRoot.innerHTML = `
    <div class="auth-wrap">
      <div class="card-panel">
        <h1>Create your account</h1>
        <p class="text-sm">Sign up to buy notes and build your library.</p>
        <div id="auth-msg"></div>
        <form id="signup-form">
          <div class="field"><label for="su-name">Full name</label><input id="su-name" type="text" required autocomplete="name" /></div>
          <div class="field"><label for="su-email">Email</label><input id="su-email" type="email" required autocomplete="email" /></div>
          <div class="field"><label for="su-password">Password</label><input id="su-password" type="password" required minlength="6" autocomplete="new-password" /></div>
          <div class="field"><label for="su-password2">Confirm password</label><input id="su-password2" type="password" required minlength="6" autocomplete="new-password" /></div>
          <button class="btn btn--primary btn--block" type="submit">Sign up</button>
        </form>
        <p class="text-sm" style="margin-top:16px;">Already have an account? <a class="text-link" href="#/login" data-link>Log in</a></p>
      </div>
    </div>`;

  qs("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = qs("#auth-msg");
    msg.innerHTML = "";
    const fullName = qs("#su-name").value.trim();
    const email = qs("#su-email").value.trim();
    const password = qs("#su-password").value;
    const password2 = qs("#su-password2").value;
    if (password !== password2) {
      msg.innerHTML = `<div class="form-msg form-msg--error">Passwords don't match.</div>`;
      return;
    }
    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      const data = await signUp(fullName, email, password);
      if (data.session) {
        toast("Account created!", "success");
        navigate("#/");
      } else {
        msg.innerHTML = `<div class="form-msg form-msg--success">Account created! Check your email to confirm before logging in.</div>`;
        submitBtn.disabled = false;
      }
    } catch (err) {
      msg.innerHTML = `<div class="form-msg form-msg--error">${escapeHtml(err.message)}</div>`;
      submitBtn.disabled = false;
    }
  });
}

/* ---------------------------------------------------------------------
   10. MY NOTES (LIBRARY)
   --------------------------------------------------------------------- */

async function renderMyNotes() {
  viewRoot.innerHTML = `
    <div class="container">
      <div class="page-header"><h1>My Notes</h1><p>Everything you've purchased, in one place.</p></div>
      <div id="library-body"><div class="loading-spin"></div></div>
    </div>`;

  const { data, error } = await supabase
    .from("purchases")
    .select("*, notes(*, subject:subjects(name)), orders(amount)")
    .eq("user_id", currentUser.id)
    .order("purchased_at", { ascending: false });

  const body = qs("#library-body");
  if (error) {
    body.innerHTML = `<div class="empty-state"><h3>Couldn't load your library</h3><p>${escapeHtml(error.message)}</p></div>`;
    return;
  }
  if (!data || data.length === 0) {
    body.innerHTML = emptyState("No purchases yet", "Notes you buy will show up here for quick access.");
    return;
  }

  body.innerHTML = `<div class="library-list">${data.map((p) => {
    const n = p.notes;
    if (!n) return "";
    const cover = coverPublicUrl(n.cover_path);
    return `
      <div class="library-item">
        <div class="library-item__thumb">${cover ? `<img src="${escapeHtml(cover)}" alt="" />` : "📄"}</div>
        <div class="library-item__info">
          <div class="library-item__title">${escapeHtml(n.title)}</div>
          <div class="library-item__meta">${escapeHtml(n.subject?.name || "")} · Purchased ${formatDate(p.purchased_at)} · Paid ${p.orders ? "₹" + Number(p.orders.amount).toLocaleString("en-IN") : ""}</div>
        </div>
        <div class="row-gap">
          <button class="btn btn--ghost btn--sm" data-open-note="${n.id}" data-note-path="${escapeHtml(n.pdf_path)}">Open PDF</button>
          <button class="btn btn--primary btn--sm" data-download-note="${n.id}" data-note-path="${escapeHtml(n.pdf_path)}">Download</button>
        </div>
      </div>`;
  }).join("")}</div>`;

  qsa("[data-open-note]", body).forEach((btn) => btn.addEventListener("click", async () => {
    try { window.open(await getSignedPdfUrl(btn.dataset.notePath, { expiresIn: 3600 }), "_blank"); }
    catch (err) { toast("Couldn't open PDF: " + err.message, "error"); }
  }));
  qsa("[data-download-note]", body).forEach((btn) => btn.addEventListener("click", async () => {
    try { window.location.href = await getSignedPdfUrl(btn.dataset.notePath, { download: true, expiresIn: 300 }); }
    catch (err) { toast("Couldn't download PDF: " + err.message, "error"); }
  }));
}

/* ---------------------------------------------------------------------
   11. NOT FOUND
   --------------------------------------------------------------------- */

function renderNotFound() {
  viewRoot.innerHTML = `<div class="container center-msg"><h2>Page not found</h2><a class="btn btn--primary" href="#/" data-link>Back to home</a></div>`;
}

/* =======================================================================
   12. ADMIN
   ======================================================================= */

async function renderAdmin(tab) {
  adminActiveTab = tab || "notes";
  viewRoot.innerHTML = `
    <div class="container">
      <div class="page-header"><h1>Admin Dashboard</h1><p>Manage notes, subjects, orders and sales.</p></div>
      <div class="admin-shell">
        <nav class="admin-tabs" id="admin-tabs">
          ${["notes", "subjects", "orders", "sales", "users"].map((t) =>
            `<button class="admin-tab ${adminActiveTab === t ? "is-active" : ""}" data-admin-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`
          ).join("")}
        </nav>
        <div class="admin-content" id="admin-content"><div class="loading-spin"></div></div>
      </div>
    </div>`;

  qsa("[data-admin-tab]").forEach((btn) => btn.addEventListener("click", () => {
    history.replaceState(null, "", `#/admin?tab=${btn.dataset.adminTab}`);
    renderAdmin(btn.dataset.adminTab);
  }));

  const content = qs("#admin-content");
  try {
    if (adminActiveTab === "notes") await renderAdminNotes(content);
    else if (adminActiveTab === "subjects") await renderAdminSubjects(content);
    else if (adminActiveTab === "orders") await renderAdminOrders(content);
    else if (adminActiveTab === "sales") await renderAdminSales(content);
    else if (adminActiveTab === "users") await renderAdminUsers(content);
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><h3>Couldn't load this tab</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

/* ---- 12a. Admin: Notes ---- */

async function renderAdminNotes(content) {
  await Promise.all([fetchSubjects(), fetchAllNotes()]);

  content.innerHTML = `
    <div class="admin-toolbar">
      <h2 class="mt-0">Notes (${notesCache.length})</h2>
      <button class="btn btn--marker" id="add-note-btn">+ Add Note</button>
    </div>
    <div id="notes-table-wrap">
      ${notesCache.length === 0 ? emptyState("No notes yet", "Click \u201c+ Add Note\u201d to upload your first PDF.") : adminNotesTable(notesCache)}
    </div>`;

  qs("#add-note-btn").addEventListener("click", () => openNoteModal(null));
  wireAdminNotesTableEvents(content);
}

function adminNotesTable(notes) {
  return `
    <table class="data-table">
      <thead><tr><th>Title</th><th>Subject</th><th>Class</th><th>Status</th><th>Price</th><th>Uploaded</th><th></th></tr></thead>
      <tbody>
        ${notes.map((n) => `
          <tr data-note-row="${n.id}">
            <td data-label="Title">${escapeHtml(n.title)}${n.is_featured ? " ★" : ""}</td>
            <td data-label="Subject">${escapeHtml(n.subject?.name || "—")}</td>
            <td data-label="Class">${escapeHtml(n.class_name || "")}</td>
            <td data-label="Status"><span class="badge ${n.is_free ? "badge--free" : "badge--paid"}">${n.is_free ? "Free" : "Paid"}</span></td>
            <td data-label="Price">${formatPrice(n)}</td>
            <td data-label="Uploaded">${formatDate(n.created_at)}</td>
            <td data-label="" class="actions">
              <button class="btn btn--ghost btn--sm" data-edit-note="${n.id}">Edit</button>
              <button class="btn btn--ghost btn--sm" data-toggle-free="${n.id}">Make ${n.is_free ? "Paid" : "Free"}</button>
              <button class="btn btn--danger btn--sm" data-delete-note="${n.id}">Delete</button>
            </td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function wireAdminNotesTableEvents(content) {
  qsa("[data-edit-note]", content).forEach((btn) => btn.addEventListener("click", () => {
    const note = notesCache.find((n) => n.id === btn.dataset.editNote);
    openNoteModal(note);
  }));
  qsa("[data-delete-note]", content).forEach((btn) => btn.addEventListener("click", () => deleteNote(btn.dataset.deleteNote)));
  qsa("[data-toggle-free]", content).forEach((btn) => btn.addEventListener("click", () => toggleFreePaid(btn.dataset.toggleFree)));
}

function openNoteModal(note) {
  const isEdit = !!note;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal-panel">
      <div class="modal-head"><h2 class="mt-0">${isEdit ? "Edit note" : "Add note"}</h2><button class="icon-btn" id="modal-close">&times;</button></div>
      <div id="modal-msg"></div>
      <form id="note-form">
        <div class="field"><label for="nf-title">Title</label><input id="nf-title" required value="${isEdit ? escapeHtml(note.title) : ""}" /></div>
        <div class="field-row">
          <div class="field">
            <label for="nf-subject">Subject</label>
            <select id="nf-subject" required>
              <option value="">Select subject…</option>
              ${subjectsCache.map((s) => `<option value="${s.id}" ${isEdit && note.subject_id === s.id ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
            </select>
          </div>
          <div class="field"><label for="nf-class">Class</label><input id="nf-class" required placeholder="e.g. Class 10" value="${isEdit ? escapeHtml(note.class_name) : ""}" /></div>
        </div>
        <div class="field"><label for="nf-chapter">Chapter</label><input id="nf-chapter" value="${isEdit ? escapeHtml(note.chapter || "") : ""}" /></div>
        <div class="field"><label for="nf-desc">Description</label><textarea id="nf-desc">${isEdit ? escapeHtml(note.description || "") : ""}</textarea></div>

        <div class="field"><label for="nf-pdf">PDF file ${isEdit ? "(leave empty to keep current file)" : ""}</label>
          <input id="nf-pdf" type="file" accept="application/pdf" ${isEdit ? "" : "required"} />
          <div class="field-hint">PDF only, up to ${MAX_PDF_MB}MB.</div>
        </div>
        <div class="field"><label for="nf-cover">Cover image (optional)</label>
          <input id="nf-cover" type="file" accept="image/png,image/jpeg,image/webp" />
          <div class="field-hint">JPG/PNG/WebP, up to ${MAX_IMG_MB}MB.</div>
        </div>

        <div class="switch-row">
          <div><strong>Free note</strong><div class="field-hint">Anyone can view and download for free.</div></div>
          <label class="switch"><input type="checkbox" id="nf-free" ${!isEdit || note.is_free ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="field" id="nf-price-wrap" style="${(!isEdit || note.is_free) ? "display:none;" : ""}">
          <label for="nf-price">Price (₹)</label>
          <input id="nf-price" type="number" min="1" step="1" value="${isEdit ? note.price : ""}" />
        </div>
        <div class="switch-row" id="nf-preview-wrap" style="${(!isEdit || note.is_free) ? "display:none;" : ""}">
          <div><strong>Allow preview</strong><div class="field-hint">Show a short, view-only preview before purchase.</div></div>
          <label class="switch"><input type="checkbox" id="nf-preview" ${!isEdit || note.allow_preview ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label>
        </div>
        <div class="switch-row">
          <div><strong>Featured</strong><div class="field-hint">Show in the Featured Notes section on the home page.</div></div>
          <label class="switch"><input type="checkbox" id="nf-featured" ${isEdit && note.is_featured ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label>
        </div>

        <button class="btn btn--primary btn--block" type="submit" style="margin-top:16px;">${isEdit ? "Save changes" : "Add note"}</button>
      </form>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  qs("#modal-close", backdrop).addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  const freeToggle = qs("#nf-free", backdrop);
  freeToggle.addEventListener("change", () => {
    qs("#nf-price-wrap", backdrop).style.display = freeToggle.checked ? "none" : "";
    qs("#nf-preview-wrap", backdrop).style.display = freeToggle.checked ? "none" : "";
  });

  qs("#note-form", backdrop).addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = qs("#modal-msg", backdrop);
    msg.innerHTML = "";
    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";

    try {
      const isFree = qs("#nf-free", backdrop).checked;
      const priceVal = Number(qs("#nf-price", backdrop).value || 0);
      if (!isFree && (!priceVal || priceVal <= 0)) throw new Error("Enter a price greater than ₹0 for a paid note.");

      const payload = {
        title: qs("#nf-title", backdrop).value.trim(),
        subject_id: qs("#nf-subject", backdrop).value,
        class_name: qs("#nf-class", backdrop).value.trim(),
        chapter: qs("#nf-chapter", backdrop).value.trim(),
        description: qs("#nf-desc", backdrop).value.trim(),
        is_free: isFree,
        price: isFree ? 0 : priceVal,
        allow_preview: isFree ? true : qs("#nf-preview", backdrop).checked,
        is_featured: qs("#nf-featured", backdrop).checked,
      };

      const pdfFile = qs("#nf-pdf", backdrop).files[0];
      const coverFile = qs("#nf-cover", backdrop).files[0];

      if (pdfFile) {
        validateFile(pdfFile, ["application/pdf"], MAX_PDF_MB, "PDF");
        payload.pdf_path = await uploadFile("notes-pdfs", pdfFile);
      }
      if (coverFile) {
        validateFile(coverFile, ["image/jpeg", "image/png", "image/webp"], MAX_IMG_MB, "Cover image");
        payload.cover_path = await uploadFile("cover-images", coverFile);
      }

      if (isEdit) {
        const oldPdfPath = note.pdf_path;
        const oldCoverPath = note.cover_path;
        const { error } = await supabase.from("notes").update(payload).eq("id", note.id);
        if (error) throw error;
        if (pdfFile && oldPdfPath && oldPdfPath !== payload.pdf_path) {
          await supabase.storage.from("notes-pdfs").remove([oldPdfPath]).catch(() => {});
        }
        if (coverFile && oldCoverPath && oldCoverPath !== payload.cover_path) {
          await supabase.storage.from("cover-images").remove([oldCoverPath]).catch(() => {});
        }
        toast("Note updated.", "success");
      } else {
        payload.created_by = currentUser.id;
        const { error } = await supabase.from("notes").insert(payload);
        if (error) throw error;
        toast("Note added.", "success");
      }

      close();
      await renderAdminNotes(qs("#admin-content"));
    } catch (err) {
      msg.innerHTML = `<div class="form-msg form-msg--error">${escapeHtml(err.message)}</div>`;
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? "Save changes" : "Add note";
    }
  });
}

function validateFile(file, allowedTypes, maxMb, label) {
  if (!allowedTypes.includes(file.type)) throw new Error(`${label} must be one of: ${allowedTypes.join(", ")}.`);
  if (file.size > maxMb * 1024 * 1024) throw new Error(`${label} must be under ${maxMb}MB.`);
}

async function uploadFile(bucket, file) {
  const path = `${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    contentType: file.type, upsert: false,
  });
  if (error) throw error;
  return path;
}

async function deleteNote(id) {
  const note = notesCache.find((n) => n.id === id);
  if (!note) return;
  if (!confirm(`Delete "${note.title}"? This can't be undone.`)) return;

  try {
    const { error } = await supabase.from("notes").delete().eq("id", id);
    if (error) throw error;
    await Promise.all([
      note.pdf_path ? supabase.storage.from("notes-pdfs").remove([note.pdf_path]).catch(() => {}) : null,
      note.cover_path ? supabase.storage.from("cover-images").remove([note.cover_path]).catch(() => {}) : null,
    ]);
    toast("Note deleted.", "success");
    await renderAdminNotes(qs("#admin-content"));
  } catch (err) {
    toast("Couldn't delete note: " + err.message, "error");
  }
}

async function toggleFreePaid(id) {
  const note = notesCache.find((n) => n.id === id);
  if (!note) return;
  const makingPaid = note.is_free;
  if (makingPaid && (!note.price || note.price <= 0)) {
    const input = prompt("Set a price in ₹ for this note:");
    const price = Number(input);
    if (!input || !price || price <= 0) { toast("A valid price is required to make a note paid.", "error"); return; }
    note.price = price;
  }
  try {
    const { error } = await supabase.from("notes").update({ is_free: !makingPaid, price: makingPaid ? note.price : 0 }).eq("id", id);
    if (error) throw error;
    toast(`Note is now ${makingPaid ? "Paid" : "Free"}.`, "success");
    await renderAdminNotes(qs("#admin-content"));
  } catch (err) {
    toast("Couldn't update note: " + err.message, "error");
  }
}

/* ---- 12b. Admin: Subjects ---- */

async function renderAdminSubjects(content) {
  await fetchSubjects();
  content.innerHTML = `
    <div class="admin-toolbar">
      <h2 class="mt-0">Subjects (${subjectsCache.length})</h2>
    </div>
    <form id="add-subject-form" class="row-gap" style="margin-bottom:20px;">
      <input id="subject-name-input" placeholder="e.g. Physics" required style="flex:1; min-width:200px; border:1px solid var(--border); border-radius:8px; padding:9px 12px;" />
      <button class="btn btn--marker" type="submit">Add Subject</button>
    </form>
    <div id="subjects-table-wrap">
      ${subjectsCache.length === 0 ? emptyState("No subjects yet", "Add your first subject above.") : `
        <table class="data-table">
          <thead><tr><th>Name</th><th>Added</th><th></th></tr></thead>
          <tbody>
            ${subjectsCache.map((s) => `
              <tr>
                <td data-label="Name">${escapeHtml(s.name)}</td>
                <td data-label="Added">${formatDate(s.created_at)}</td>
                <td data-label="" class="actions"><button class="btn btn--danger btn--sm" data-delete-subject="${s.id}">Delete</button></td>
              </tr>`).join("")}
          </tbody>
        </table>`}
    </div>`;

  qs("#add-subject-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = qs("#subject-name-input");
    const name = input.value.trim();
    if (!name) return;
    try {
      const { error } = await supabase.from("subjects").insert({ name });
      if (error) throw error;
      toast("Subject added.", "success");
      await renderAdminSubjects(content);
    } catch (err) {
      toast("Couldn't add subject: " + err.message, "error");
    }
  });

  qsa("[data-delete-subject]", content).forEach((btn) => btn.addEventListener("click", async () => {
    if (!confirm("Delete this subject? Notes using it will show as \u201cGeneral\u201d.")) return;
    try {
      const { error } = await supabase.from("subjects").delete().eq("id", btn.dataset.deleteSubject);
      if (error) throw error;
      toast("Subject deleted.", "success");
      await renderAdminSubjects(content);
    } catch (err) {
      toast("Couldn't delete subject: " + err.message, "error");
    }
  }));
}

/* ---- 12c. Admin: Orders ---- */

async function renderAdminOrders(content) {
  content.innerHTML = `<div class="loading-spin"></div>`;
  const { data, error } = await supabase
    .from("orders")
    .select("*, profiles(email), order_items(price, notes(title))")
    .order("created_at", { ascending: false });

  if (error) { content.innerHTML = `<div class="empty-state"><h3>Couldn't load orders</h3><p>${escapeHtml(error.message)}</p></div>`; return; }
  if (!data || data.length === 0) { content.innerHTML = `<h2 class="mt-0">Orders</h2>${emptyState("No orders yet", "Orders will appear here once someone buys a note.")}`; return; }

  content.innerHTML = `
    <h2 class="mt-0">Orders (${data.length})</h2>
    <table class="data-table">
      <thead><tr><th>Date</th><th>Buyer</th><th>Note</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>
        ${data.map((o) => `
          <tr>
            <td data-label="Date">${formatDate(o.created_at)}</td>
            <td data-label="Buyer">${escapeHtml(o.profiles?.email || "—")}</td>
            <td data-label="Note">${escapeHtml((o.order_items || []).map((i) => i.notes?.title).filter(Boolean).join(", ") || "—")}</td>
            <td data-label="Amount">₹${Number(o.amount).toLocaleString("en-IN")}</td>
            <td data-label="Status"><span class="badge badge--status-${o.status}">${o.status}</span></td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

/* ---- 12d. Admin: Sales dashboard ---- */

async function renderAdminSales(content) {
  content.innerHTML = `<div class="loading-spin"></div>`;
  const [ordersRes, notesRes] = await Promise.all([
    supabase.from("orders").select("amount, status, created_at").order("created_at", { ascending: false }),
    fetchAllNotes(),
  ]);

  if (ordersRes.error) { content.innerHTML = `<div class="empty-state"><h3>Couldn't load sales</h3><p>${escapeHtml(ordersRes.error.message)}</p></div>`; return; }

  const orders = ordersRes.data || [];
  const paidOrders = orders.filter((o) => o.status === "paid");
  const totalRevenue = paidOrders.reduce((sum, o) => sum + Number(o.amount), 0);
  const totalFreeNotes = notesRes.filter((n) => n.is_free).length;
  const totalPaidNotes = notesRes.filter((n) => !n.is_free).length;

  const { data: recent } = await supabase
    .from("orders")
    .select("*, profiles(email), order_items(price, notes(title))")
    .eq("status", "paid")
    .order("created_at", { ascending: false })
    .limit(8);

  content.innerHTML = `
    <h2 class="mt-0">Sales</h2>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-card__label">Total revenue</div><div class="stat-card__value">₹${totalRevenue.toLocaleString("en-IN")}</div></div>
      <div class="stat-card"><div class="stat-card__label">Paid orders</div><div class="stat-card__value">${paidOrders.length}</div></div>
      <div class="stat-card"><div class="stat-card__label">Total orders</div><div class="stat-card__value">${orders.length}</div></div>
      <div class="stat-card"><div class="stat-card__label">Free notes</div><div class="stat-card__value">${totalFreeNotes}</div></div>
      <div class="stat-card"><div class="stat-card__label">Paid notes</div><div class="stat-card__value">${totalPaidNotes}</div></div>
    </div>
    <h3>Recent purchases</h3>
    ${!recent || recent.length === 0 ? emptyState("No purchases yet", "Successful purchases will appear here.") : `
      <table class="data-table">
        <thead><tr><th>Date</th><th>Buyer</th><th>Note</th><th>Amount</th></tr></thead>
        <tbody>
          ${recent.map((o) => `
            <tr>
              <td data-label="Date">${formatDate(o.created_at)}</td>
              <td data-label="Buyer">${escapeHtml(o.profiles?.email || "—")}</td>
              <td data-label="Note">${escapeHtml((o.order_items || []).map((i) => i.notes?.title).filter(Boolean).join(", ") || "—")}</td>
              <td data-label="Amount">₹${Number(o.amount).toLocaleString("en-IN")}</td>
            </tr>`).join("")}
        </tbody>
      </table>`}
  `;
}

/* ---- 12e. Admin: Users ---- */

async function renderAdminUsers(content) {
  content.innerHTML = `<div class="loading-spin"></div>`;
  const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  if (error) { content.innerHTML = `<div class="empty-state"><h3>Couldn't load users</h3><p>${escapeHtml(error.message)}</p></div>`; return; }

  content.innerHTML = `
    <h2 class="mt-0">Users (${data.length})</h2>
    ${data.length === 0 ? emptyState("No users yet", "Users will appear here once people sign up.") : `
      <table class="data-table">
        <thead><tr><th>Email</th><th>Name</th><th>Joined</th><th>Role</th></tr></thead>
        <tbody>
          ${data.map((u) => `
            <tr>
              <td data-label="Email">${escapeHtml(u.email || "—")}</td>
              <td data-label="Name">${escapeHtml(u.full_name || "—")}</td>
              <td data-label="Joined">${formatDate(u.created_at)}</td>
              <td data-label="Role">${u.is_admin ? `<span class="badge badge--paid">Admin</span>` : "User"}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <p class="field-hint" style="margin-top:12px;">To make someone an admin, run a SQL update in the Supabase dashboard — see README.md.</p>`}
  `;
}

/* ---------------------------------------------------------------------
   13. GLOBAL NAV WIRING
   --------------------------------------------------------------------- */

function closeMobileNav() {
  qs("#primary-nav").classList.remove("open");
  qs("#mobile-nav-toggle").setAttribute("aria-expanded", "false");
}
function closeUserMenu() {
  qs("#user-menu-dropdown").classList.add("hidden");
  qs("#user-menu-btn")?.setAttribute("aria-expanded", "false");
}

document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-link]");
  if (link) {
    e.preventDefault();
    navigate(link.getAttribute("href"));
  }
});

qs("#mobile-nav-toggle").addEventListener("click", () => {
  const nav = qs("#primary-nav");
  const open = nav.classList.toggle("open");
  qs("#mobile-nav-toggle").setAttribute("aria-expanded", String(open));
});

qs("#user-menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const dd = qs("#user-menu-dropdown");
  const isOpen = !dd.classList.contains("hidden");
  dd.classList.toggle("hidden", isOpen);
  qs("#user-menu-btn").setAttribute("aria-expanded", String(!isOpen));
});
document.addEventListener("click", () => closeUserMenu());

qs("#logout-btn").addEventListener("click", async () => {
  await signOut();
  toast("Logged out.", "info");
});

qs("#header-search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = qs("#header-search-input").value.trim();
  homeState.search = value;
  navigate("#/");
  setTimeout(() => renderHomeResults(), 0);
});

/* ---------------------------------------------------------------------
   14. INIT
   --------------------------------------------------------------------- */

supabase.auth.onAuthStateChange(async (_event, session) => {
  await handleSessionChange(session);
  if (!authReady) {
    authReady = true;
    window.addEventListener("hashchange", router);
    router();
  } else {
    router();
  }
});

})();
