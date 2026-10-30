// Sathi v0 prototype — static catalog, browse → detail → book. No AI planning.
// All persistence is localStorage only (bookings, leads, mock sign-in session).

let CATALOG = [];
let currentSlug = null;
let bookingDraft = null; // { slug, date, travellers }

const LS_SESSION = "sathi_proto_session";
const LS_BOOKINGS = "sathi_proto_bookings";
const LS_LEADS = "sathi_proto_leads";

// ---------- analytics (PostHog) ----------
// track() is a thin, defensive wrapper: if the PostHog snippet hasn't loaded
// (blocked, offline, etc.) this silently no-ops rather than breaking the app.
// Event names/properties follow the real Sathi V0 Analytics PRD where this
// static prototype can support them.
function track(event, props) {
  try {
    if (window.posthog && typeof window.posthog.capture === "function") {
      window.posthog.capture(event, props || {});
    }
  } catch (e) { /* no-op */ }
}

let lastClickSource = null;   // surface a trip card was clicked from, read once by openDetail()
let lastTab = null;           // previous detail tab, for trip_tab_viewed
let lastTabAt = null;         // timestamp the current tab was opened, for seconds_on_previous_tab
let seenDays = new Set();     // itinerary days already counted as viewed, reset per trip
let lastFilters = { focus: "", difficulty: "" }; // for computing trip_list_filtered's action

function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }

function getSession() { try { return JSON.parse(localStorage.getItem(LS_SESSION)); } catch (e) { return null; } }
function setSession(s) { localStorage.setItem(LS_SESSION, JSON.stringify(s)); renderSessionArea(); }
function getBookings() { try { return JSON.parse(localStorage.getItem(LS_BOOKINGS)) || []; } catch (e) { return []; } }
function saveBookings(arr) { localStorage.setItem(LS_BOOKINGS, JSON.stringify(arr)); }
function getLeads() { try { return JSON.parse(localStorage.getItem(LS_LEADS)) || []; } catch (e) { return []; } }
function saveLeads(arr) { localStorage.setItem(LS_LEADS, JSON.stringify(arr)); }

function renderSessionArea() {
  const s = getSession();
  const el = document.getElementById("session-area");
  el.innerHTML = s
    ? `<span class="session-chip" onclick="go('mytrips')">${esc(s.name)} &middot; sign out</span>`
    : `<span class="session-chip" onclick="go('signin')">Sign in</span>`;
  if (s) {
    el.querySelector(".session-chip").onclick = (e) => {
      if (e.target.textContent.includes("sign out") || true) {
        if (confirm("Sign out of " + s.name + "?")) { localStorage.removeItem(LS_SESSION); renderSessionArea(); go('home'); }
      }
    };
  }
}

// ---------- routing ----------
function go(view, arg) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + view).classList.add("active");
  window.scrollTo(0, 0);
  if (view === "browse") {
    const r = renderBrowse();
    lastFilters = { ...r.filters };
    track("trip_list_viewed", {
      filter_applied: !!(r.filters.focus || r.filters.difficulty),
      filters: r.filters,
      result_count: r.count,
    });
  }
  if (view === "home") renderHome();
  if (view === "detail" && arg) openDetail(arg);
  if (view === "mytrips") renderMyTrips();
  if (view === "activity") renderActivity();
  history.replaceState(null, "", "#" + view + (arg ? "/" + arg : ""));
}

function homeElementClick(element) {
  track("home_element_clicked", { element });
}

function onFilterChange(changedType) {
  const r = renderBrowse();
  const value = changedType === "focus" ? r.filters.focus : r.filters.difficulty;
  const prevValue = lastFilters[changedType];
  const action = value && !prevValue ? "added" : (!value && prevValue ? "removed" : "changed");
  track("trip_list_filtered", {
    filter_type: changedType,
    filter_value: value || null,
    action,
    result_count: r.count,
  });
  lastFilters = { ...r.filters };
}

// ---------- Home ----------
function renderHome() {
  const popular = [...CATALOG].sort((a, b) => a.popularity_rank - b.popularity_rank).slice(0, 3);
  document.getElementById("popular-trips").innerHTML = popular.map((t, i) => tripCardHtml(t, "home_popular", i + 1)).join("");
}

// ---------- Trip card (shared between Home + Browse) ----------
function tripCardHtml(t, surface, position) {
  const thumb = t.image
    ? `<img class="thumb" src="${esc(t.image)}" alt="${esc(t.title)}">`
    : `<div class="thumb-placeholder">${esc(t.title)}</div>`;
  const focusLabel = (t.focus && t.focus[0]) ? t.focus[0].charAt(0).toUpperCase() + t.focus[0].slice(1) : "Trip";
  return `<div class="trip-card" onclick="cardClick('${t.slug}','${surface}',${position})">
    ${thumb}
    <div class="body">
      <div class="focus-tag">${esc(focusLabel)}</div>
      <h3>${esc(t.title)}</h3>
      <div class="meta">${t.duration_days} days &middot; ${cap(t.difficulty)} &middot; ${esc((t.tags && t.tags[0]) || "")}</div>
      <div class="price-row">
        <div class="price">From $${t.price_from_traveler} <small>/ person</small></div>
        <button class="btn btn-secondary" style="padding:7px 12px;font-size:12px;" onclick="event.stopPropagation(); cardClick('${t.slug}','${surface}',${position})">View details</button>
      </div>
    </div>
  </div>`;
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

// trip_card_clicked fires here, once, regardless of which element inside the
// card was tapped — then the real navigation proceeds as before.
function cardClick(slug, surface, position) {
  track("trip_card_clicked", { trip_id: slug, surface, position });
  lastClickSource = surface;
  go("detail", slug);
}

// ---------- Browse ----------
// Returns { count, filters } so callers (go(), onFilterChange()) can fire the
// right analytics event without re-deriving filter state themselves.
function renderBrowse() {
  const focusSel = document.getElementById("filter-focus");
  if (focusSel.options.length <= 1) {
    const allFocus = [...new Set(CATALOG.flatMap(t => t.focus))].sort();
    allFocus.forEach(f => { const o = document.createElement("option"); o.value = f; o.textContent = cap(f); focusSel.appendChild(o); });
  }
  const focusVal = document.getElementById("filter-focus").value;
  const diffVal = document.getElementById("filter-difficulty").value;
  let list = CATALOG.filter(t => (!focusVal || t.focus.includes(focusVal)) && (!diffVal || t.difficulty === diffVal));
  list = list.sort((a, b) => a.popularity_rank - b.popularity_rank);
  const surface = (focusVal || diffVal) ? "all_trips_filtered" : "all_trips";
  document.getElementById("browse-grid").innerHTML = list.map((t, i) => tripCardHtml(t, surface, i + 1)).join("") || '<p class="empty-note">No trips match those filters.</p>';
  return { count: list.length, filters: { focus: focusVal, difficulty: diffVal } };
}

// ---------- Trip detail ----------
function openDetail(slug) {
  currentSlug = slug;
  const t = CATALOG.find(c => c.slug === slug);
  if (!t) return;
  track("trip_details_viewed", { trip_id: slug, source_section: lastClickSource || null });
  lastClickSource = null;
  lastTab = null;
  lastTabAt = null;
  seenDays = new Set();
  document.getElementById("detail-crumb-title").textContent = t.title;
  document.getElementById("detail-hero-wrap").innerHTML = t.image
    ? `<img class="detail-hero" src="${esc(t.image)}" alt="${esc(t.title)}">`
    : `<div class="detail-hero-placeholder">${esc(t.title)}</div>`;
  document.getElementById("detail-kicker").textContent = `NEPAL · ${(t.tags[0] || "").toUpperCase()} · GUIDED TRIP`;
  document.getElementById("detail-title").textContent = t.title;
  document.getElementById("detail-desc").textContent = t.description;

  const maxAlt = Math.max(...t.days.map(d => d.altitude_m || 0));
  document.getElementById("detail-stats").innerHTML = `
    <div class="stat-cell"><div class="f">Duration</div><div class="v">${t.duration_days} days</div></div>
    <div class="stat-cell"><div class="f">Max altitude</div><div class="v">${maxAlt.toLocaleString()} m</div></div>
    <div class="stat-cell"><div class="f">Level</div><div class="v">${cap(t.difficulty)}</div></div>
    <div class="stat-cell"><div class="f">Best time</div><div class="v">${(t.best_seasons || []).slice(0,2).join(", ")}</div></div>`;

  // Overview tab
  document.getElementById("pane-overview").innerHTML = `
    <h3 style="font-size:16px;">What's included</h3>
    <ul class="included-list">
      <li>Licensed, English-speaking guide</li>
      <li>Permits and park/conservation fees</li>
      <li>Accommodation as described in the itinerary</li>
      <li>Airport or hotel transfers on arrival/departure days</li>
    </ul>
    <p class="note-inline" style="margin-bottom:20px;">Meals beyond those listed, personal gear, and travel insurance are not included unless stated.</p>
    <h3 style="font-size:16px;">Tags</h3>
    <div>${t.tags.map(tag => `<span class="focus-tag" style="margin-right:6px;">${esc(tag)}</span>`).join("")}</div>`;

  // Itinerary tab — real day-by-day from the catalog
  document.getElementById("pane-itinerary").innerHTML = `
    <p style="color:var(--ink-soft);font-size:13.5px;margin-bottom:16px;">${t.duration_days} days, day by day.</p>
    ${t.days.map(d => `
      <div class="day-card" data-day="${d.day}">
        <div class="d-head">
          <span class="d-num">Day ${d.day}</span>
          <span class="d-title">${esc(d.title)}</span>
          <span class="d-meta">${esc(d.location)} &middot; ${d.altitude_m ? d.altitude_m.toLocaleString() + ' m' : ''}</span>
        </div>
        <ul>${d.bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>
        ${d.insider_tip ? `<div class="tip">Insider tip: ${esc(d.insider_tip)}</div>` : ""}
      </div>`).join("")}`;

  // FAQ tab — grounded, non-duplicated content; altitude question only shown when relevant
  const faqs = buildFaqs(t, maxAlt);
  document.getElementById("pane-faq").innerHTML = faqs.map((f, i) => `
    <div class="faq-item" onclick="toggleFaq(this, 'faq_${i}')">
      <div class="q">${esc(f.q)} <span>${'▾'}</span></div>
      <div class="a">${esc(f.a)}</div>
    </div>`).join("");

  document.getElementById("detail-price").innerHTML = `From $${t.price_from_traveler}<small> / person</small>`;
  switchDetailTab("overview");
}

function buildFaqs(t, maxAlt) {
  const faqs = [
    { q: "Do I need a visa?", a: "Most visitors get a tourist visa on arrival in Kathmandu, payable in USD. Check the current rules for your passport before you fly." },
  ];
  if (maxAlt >= 3000) {
    faqs.push({ q: "What about altitude sickness?", a: `Overnight stops above 3,000 m on this route follow the recommended 300–500 m/night sleeping-altitude gain, with rest days built in. Your guide checks in daily.` });
    faqs.push({ q: "Do I need travel insurance?", a: "Yes — insurance with helicopter evacuation coverage is required for this trip, since it goes above 3,000 m." });
  }
  faqs.push({ q: "What's included in the price?", a: "Guide fees, permits, and the accommodation described in the itinerary. Flights, personal gear, and travel insurance are not included unless stated." });
  faqs.push({ q: "Is tipping expected?", a: "Tipping guides and porters is customary in Nepal — typically 10–15% of the trip cost, pooled and given at the end of the trip." });
  faqs.push({ q: "Can I customise the dates or group size?", a: "Yes — pick your dates and traveller count at booking. For bigger changes to the route itself, message us and we'll check what's possible with the partner." });
  return faqs;
}

function switchDetailTab(tab) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
  document.getElementById("pane-" + tab).classList.add("active");

  const now = Date.now();
  const secondsOnPrevious = lastTabAt ? Math.round((now - lastTabAt) / 1000) : null;
  track("trip_tab_viewed", { trip_id: currentSlug, tab, previous_tab: lastTab, seconds_on_previous_tab: secondsOnPrevious });
  lastTab = tab;
  lastTabAt = now;

  if (tab === "itinerary") observeDayCards();
}

// Fires itinerary_day_viewed once per day, the first time at least half of that
// day's card has been on screen for 1s+ — mirrors the PRD's "viewed impression" rule.
function observeDayCards() {
  const cards = document.querySelectorAll("#pane-itinerary .day-card");
  if (!cards.length) return;
  const t = CATALOG.find(c => c.slug === currentSlug);
  const totalDays = t ? t.duration_days : cards.length;
  const slugAtObserveTime = currentSlug;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
        const day = Number(entry.target.dataset.day);
        if (!seenDays.has(day) && currentSlug === slugAtObserveTime) {
          seenDays.add(day);
          track("itinerary_day_viewed", { trip_id: slugAtObserveTime, day_number: day, total_days: totalDays });
        }
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });
  cards.forEach(c => observer.observe(c));
}

// toggleFaq fires faq_opened only on the open transition, not on collapse.
function toggleFaq(el, faqId) {
  const opening = !el.classList.contains("open");
  el.classList.toggle("open");
  if (opening) track("faq_opened", { trip_id: currentSlug, faq_id: faqId });
}

// ---------- Booking flow ----------
function addDaysISO(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function formatDateLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function startBooking() {
  const t = CATALOG.find(c => c.slug === currentSlug);
  track("select_dates_clicked", { trip_id: t.slug, price_shown: t.price_from_traveler, tab: lastTab });
  bookingDraft = { slug: t.slug, title: t.title, durationDays: t.duration_days };
  document.getElementById("booking-trip-title").textContent = t.title;
  document.getElementById("booking-trip-sub").textContent = `${t.duration_days} days · From $${t.price_from_traveler}/person`;
  document.getElementById("booking-date").value = "";
  document.getElementById("booking-end-date").value = "";
  document.getElementById("booking-end-date").removeAttribute("min");
  document.getElementById("booking-duration-note").textContent = `This trip needs a minimum of ${t.duration_days} days.`;
  document.getElementById("booking-travellers").value = "1";
  showBookingStep(1);
  go("booking");
  track("booking_started", { trip_id: t.slug });
}

// Start date picked (or changed): auto-populate the end date to start + the itinerary's
// real duration, and set that same date as the end-date field's `min` so the native date
// picker greys out anything earlier — the user can still push the end date later, just
// never shorter than the itinerary actually needs.
function onStartDateChange() {
  const start = document.getElementById("booking-date").value;
  const endInput = document.getElementById("booking-end-date");
  if (!start || !bookingDraft) { endInput.removeAttribute("min"); return; }
  const minEnd = addDaysISO(start, bookingDraft.durationDays);
  endInput.min = minEnd;
  // auto-populate end date: on first pick, or whenever the current end date would now be
  // too short for the (possibly new) start date
  if (!endInput.value || endInput.value < minEnd) {
    endInput.value = minEnd;
  }
  document.getElementById("booking-duration-note").textContent =
    `This trip needs a minimum of ${bookingDraft.durationDays} days — end date defaults to ${formatDateLabel(minEnd)}, but you can push it later.`;
}
function showBookingStep(n) {
  [1,2,3].forEach(i => {
    document.getElementById("booking-step-" + i).style.display = (i === n) ? "block" : "none";
    document.getElementById("dot-" + i).classList.toggle("active", i === n);
  });
}
function bookingNext() {
  const date = document.getElementById("booking-date").value;
  const endDate = document.getElementById("booking-end-date").value;
  if (!date) { alert("Pick a start date to continue."); return; }
  if (!endDate) { alert("Pick an end date to continue."); return; }
  const minEnd = addDaysISO(date, bookingDraft.durationDays);
  if (endDate < minEnd) {
    alert(`This trip needs at least ${bookingDraft.durationDays} days — the earliest possible end date is ${formatDateLabel(minEnd)}.`);
    return;
  }
  bookingDraft.date = date;
  bookingDraft.endDate = endDate;
  bookingDraft.travellers = document.getElementById("booking-travellers").value;

  const leadTimeDays = Math.round((new Date(date + "T00:00:00") - new Date()) / 86400000);
  track("dates_selected", {
    trip_id: bookingDraft.slug,
    start_month: date.slice(0, 7),
    lead_time_days: leadTimeDays,
    group_size: Number(bookingDraft.travellers),
  });

  const session = getSession();
  if (session) {
    completeBooking(session.email);
  } else {
    showBookingStep(2);
  }
}
function bookingBack() { showBookingStep(1); }
function showEmailCapture() { document.getElementById("email-capture-box").style.display = "block"; }
function submitLead() {
  const email = document.getElementById("lead-email").value.trim();
  if (!email || !email.includes("@")) { alert("Enter a valid email."); return; }
  const leads = getLeads();
  leads.push({ slug: bookingDraft.slug, title: bookingDraft.title, date: bookingDraft.date, endDate: bookingDraft.endDate, travellers: bookingDraft.travellers, email, capturedAt: new Date().toISOString() });
  saveLeads(leads);
  track("lead_captured", { trip_id: bookingDraft.slug });
  showBookingStep(3);
  document.getElementById("confirm-box-content").innerHTML = `
    <div class="icon">&#128231;</div>
    <h2>Got it — we've noted your interest</h2>
    <p style="color:var(--ink-soft);font-size:13.5px;">We recorded <b>${esc(bookingDraft.title)}</b> for <b>${esc(email)}</b>.
    This is a prototype, so no email was actually sent — but the event is logged.</p>
    <div style="margin-top:18px;"><button class="btn btn-primary" onclick="go('home')">Back to home</button></div>`;
}
function completeBooking(email) {
  const bookings = getBookings();
  const booking = {
    id: "bk_" + Math.random().toString(36).slice(2, 10),
    slug: bookingDraft.slug, title: bookingDraft.title, date: bookingDraft.date, endDate: bookingDraft.endDate,
    travellers: bookingDraft.travellers, userEmail: email, bookedAt: new Date().toISOString(),
  };
  bookings.push(booking);
  saveBookings(bookings);
  track("booking_confirmed", { trip_id: booking.slug, booking_id: booking.id, group_size: Number(booking.travellers) });
  showBookingStep(3);
  document.getElementById("confirm-box-content").innerHTML = `
    <div class="icon">&#9989;</div>
    <h2>Trip booked</h2>
    <p style="color:var(--ink-soft);font-size:13.5px;"><b>${esc(bookingDraft.title)}</b><br>
    ${formatDateLabel(bookingDraft.date)} &rarr; ${formatDateLabel(bookingDraft.endDate)} &middot; ${esc(bookingDraft.travellers)} traveller(s)</p>
    <div style="margin-top:18px;display:flex;gap:10px;justify-content:center;">
      <button class="btn btn-primary" onclick="go('mytrips')">View my trips</button>
      <button class="btn btn-secondary" onclick="go('home')">Back to home</button>
    </div>`;
}

// if someone signs in while a booking is in progress, finish that booking automatically
function doSignIn() {
  const name = document.getElementById("signin-name").value.trim();
  const email = document.getElementById("signin-email").value.trim();
  if (!name || !email || !email.includes("@")) { alert("Enter your name and a valid email."); return; }
  setSession({ name, email });
  // Link this browser's prior anonymous events to a real identity — same
  // concept as the PRD's user_id, using email as the identifier for now.
  if (window.posthog && typeof window.posthog.identify === "function") {
    posthog.identify(email, { name });
  }
  if (bookingDraft && bookingDraft.date) {
    go("booking");
    completeBooking(email);
  } else {
    go("home");
  }
}

// ---------- My trips ----------
function renderMyTrips() {
  const session = getSession();
  const el = document.getElementById("mytrips-content");
  if (!session) {
    el.innerHTML = `<p class="empty-note">Sign in to see your booked trips.</p><p style="text-align:center;"><button class="btn btn-primary" onclick="go('signin')">Sign in</button></p>`;
    return;
  }
  const mine = getBookings().filter(b => b.userEmail === session.email);
  if (!mine.length) {
    el.innerHTML = `<p class="empty-note">No trips booked yet.</p><p style="text-align:center;"><button class="btn btn-primary" onclick="go('browse')">Browse trips</button></p>`;
    return;
  }
  el.innerHTML = mine.map(b => `
    <div class="day-card">
      <div class="d-head"><span class="d-title">${esc(b.title)}</span><span class="d-meta">${formatDateLabel(b.date)} &rarr; ${formatDateLabel(b.endDate)} &middot; ${esc(b.travellers)} traveller(s)</span></div>
      <div class="note-inline">Booked ${new Date(b.bookedAt).toLocaleString()}</div>
    </div>`).join("");
}

// ---------- Activity log ----------
function renderActivity() {
  const bookings = getBookings();
  const leads = getLeads();
  document.getElementById("activity-bookings").innerHTML = bookings.length
    ? `<table class="simple-table"><thead><tr><th>Trip</th><th>Start</th><th>End</th><th>Travellers</th><th>Email</th><th>Booked at</th></tr></thead><tbody>
        ${bookings.map(b => `<tr><td>${esc(b.title)}</td><td>${esc(b.date)}</td><td>${esc(b.endDate)}</td><td>${esc(b.travellers)}</td><td>${esc(b.userEmail)}</td><td>${new Date(b.bookedAt).toLocaleString()}</td></tr>`).join("")}
      </tbody></table>`
    : '<p class="empty-note">No bookings recorded yet.</p>';
  document.getElementById("activity-leads").innerHTML = leads.length
    ? `<table class="simple-table"><thead><tr><th>Trip</th><th>Email</th><th>Start</th><th>End</th><th>Captured at</th></tr></thead><tbody>
        ${leads.map(l => `<tr><td>${esc(l.title)}</td><td>${esc(l.email)}</td><td>${esc(l.date)}</td><td>${esc(l.endDate)}</td><td>${new Date(l.capturedAt).toLocaleString()}</td></tr>`).join("")}
      </tbody></table>`
    : '<p class="empty-note">No leads captured yet.</p>';
}
function clearAllData() {
  if (!confirm("Clear all local bookings, leads, and session data?")) return;
  localStorage.removeItem(LS_SESSION); localStorage.removeItem(LS_BOOKINGS); localStorage.removeItem(LS_LEADS);
  renderSessionArea(); renderActivity();
}

// ---------- init ----------
track("session_started", { device_type: /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "desktop" });

fetch("assets/catalog.json").then(r => r.json()).then(data => {
  CATALOG = data;
  renderSessionArea();
  const hash = location.hash.replace("#", "");
  const [view, arg] = hash.split("/");
  go(["home","browse","detail","booking","signin","mytrips","activity"].includes(view) ? view : "home", arg);
});
