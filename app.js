// PARTY LINES 2026 · multi-player app on Supabase.
// Race data, safe seats, state names and map shapes come from data.js.
// The database enforces every rule (membership, sealing, the deadline, admin-only results);
// the UI only mirrors those rules so people aren't offered actions that will be refused.
(function () {
  "use strict";

  // Publishable key: meant to be public. Row-level security in supabase/schema.sql does the protecting.
  const SUPABASE_URL = "https://wcfbdchexoirufbzhtop.supabase.co";
  const SUPABASE_KEY = "sb_publishable_FgUu-Su6ytntUPMz4o-ttQ_mhWb5-Zh";
  // Tue Nov 3, 2026, 6:00 p.m. ET. The server holds the real deadline; this only drives the UI.
  const DEADLINE = Date.parse("2026-11-03T23:00:00Z");

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { flowType: "implicit", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const BY_ID = Object.fromEntries(STATES.map(s => [s.id, s]));
  // Sub-leaderboards. Keys match the check constraint on profiles.grp.
  const GROUPS = [
    { key: "polisci", name: "Political Science Department", short: "Political Science" },
    { key: "friends", name: "Friends", short: "Friends" },
    { key: "family", name: "Family", short: "Family" },
  ];
  const GROUP_BY = Object.fromEntries(GROUPS.map(g => [g.key, g]));
  // Senate seats decided before the game: 65 seats not up in 2026 (R 31, D 34 incl. King and Sanders)
  // plus the 19 races outside the game (safe D 9, safe R 10) = D 43, R 41. The 16 game races decide the rest.
  const BASE_D = 34 + Object.values(SAFE).filter(x => x === "D").length;
  const BASE_R = 31 + Object.values(SAFE).filter(x => x === "R").length;

  // ---- state ----
  let session = null, me = null, booted = false, handledUid = undefined;
  let players = [], board = [];
  const docs = { me: emptyDoc(), them: emptyDoc(), results: { picks: {} } };
  let themFor = null;
  const dirty = {}, inflight = {}, again = {}, timers = {};
  let channel = null, refreshT = null, pollT = null;
  let confirmOpen = false, entryError = "";
  let tab = load("pl-tab") || "picks";
  let compareId = load("pl-compare");
  let lbFilter = load("pl-board") || "all";
  if (lbFilter !== "all" && !GROUP_BY[lbFilter]) lbFilter = "all";

  const $ = id => document.getElementById(id);
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function emptyDoc() { return { picks: {}, sealed: false, sealed_at: null }; }
  function norm(row) {
    const picks = row && row.races && typeof row.races === "object" && !Array.isArray(row.races) ? row.races : {};
    return { picks: JSON.parse(JSON.stringify(picks)), sealed: !!(row && row.sealed), sealed_at: (row && row.sealed_at) || null };
  }
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => (session && session.user ? session.user.id : null);
  const isAdmin = () => !!(me && me.is_admin);
  const pastDeadline = () => Date.now() >= DEADLINE;

  // ---- values ----
  function signed(p) {
    if (!p || p.pts === null || p.pts === undefined || p.pts === "" || isNaN(+p.pts)) return null;
    const v = Math.abs(+p.pts);
    if (v === 0) return 0;
    if (p.side !== "L" && p.side !== "R") return null;
    return p.side === "L" ? -v : v;
  }
  const trim = v => String(Math.round(v * 10) / 10);
  function fmt(st, v) {
    if (v === null) return "—";
    if (Math.abs(v) < 0.05) return "EVEN";
    return (v < 0 ? (st.ind ? "I" : "D") : "R") + "+" + trim(Math.abs(v));
  }
  function valClass(st, v) {
    if (v === null || Math.abs(v) < 0.05) return "ve";
    return v < 0 ? (st.ind ? "vi" : "vd") : "vr";
  }
  // Full color at a 10-point margin; DEM and REP end on the safe-seat (wordmark) colors so a +10 pick matches a safe state
  const FULL = 10;
  const NEUTRAL = [158, 163, 174], DEM = [29, 71, 200], IND = [176, 126, 6], REP = [196, 30, 46];
  function chipColor(st, v) {
    const t = Math.pow(Math.min(Math.abs(v) / FULL, 1), 0.85);
    const end = v < 0 ? (st.ind ? IND : DEM) : REP;
    const c = NEUTRAL.map((n, i) => Math.round(n + (end[i] - n) * t));
    const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    return { bg: `rgb(${c.join(",")})`, fg: lum < 0.55 ? "#FFFFFF" : "#12151D" };
  }
  function entries(key) {
    const out = [];
    for (const st of STATES) { const v = signed(docs[key].picks[st.id]); if (v !== null) out.push({ st, v }); }
    return out;
  }
  // Matches the server's sealing check: a winner and a margin above 0 in every race
  function complete(picks) {
    return STATES.every(st => { const p = picks[st.id]; return p && (p.side === "L" || p.side === "R") && typeof p.pts === "number" && p.pts > 0; });
  }

  // ---- senate balance ----
  function seats(key) {
    let d = BASE_D, i = 0, r = BASE_R, open = 0;
    STATES.forEach(st => {
      const v = signed(docs[key].picks[st.id]);
      if (v === null || Math.abs(v) < 0.05) open++;
      else if (v > 0) r++;
      else if (st.ind) i++;
      else d++;
    });
    let control;
    if (r >= 50) control = { cls: "r", text: r === 50 ? "R control (VP tiebreak)" : "R control" };
    else if (d >= 51) control = { cls: "d", text: "D control" };
    else if (open) control = { cls: "", text: "Control undecided" };
    else control = { cls: "i", text: "Independents hold the balance" };
    return { d, i, r, open, control };
  }
  function seatText(sc) {
    return `<span class="d">D ${sc.d}</span>${sc.i ? ` · <span class="i">I ${sc.i}</span>` : ""} · <span class="r">R ${sc.r}</span>${sc.open ? ` · ${sc.open} open` : ""}`;
  }
  function seatBar(sc) {
    const w = n => n + "%";
    return `<div class="sb-track" role="img" aria-label="Senate: ${sc.d} Democrats, ${sc.i} independents, ${sc.r} Republicans, ${sc.open} undecided">` +
      `<span class="sb-d" style="width:${w(sc.d)}"></span><span class="sb-i" style="width:${w(sc.i)}"></span><span class="sb-o" style="width:${w(sc.open)}"></span><span class="sb-r" style="width:${w(sc.r)}"></span><i class="sb-mid"></i></div>` +
      `<div class="sb-labels"><span>${seatText(sc)}</span><span class="sb-ctl ${sc.control.cls}">${sc.control.text}</span></div>`;
  }

  // ---- which rows each tab shows ----
  const others = () => players.filter(p => p.id !== uid());
  const target = () => others().find(p => p.id === compareId) || null;
  function compareSeal(t) {
    const n = esc(t.display_name);
    const mine = docs.me.sealed, theirs = !!t.sealed;
    if (mine && theirs) return null;
    const late = pastDeadline();
    if (!mine && !theirs) return {
      line: late ? `<strong>Neither of you sealed before the deadline.</strong> Picks can't be compared.` : `<strong>Neither of you has sealed yet.</strong> You and ${n} both need to seal before you can compare.`,
      map: "until you both seal" };
    if (!mine) return {
      line: late ? `<strong>${n} sealed, but you didn't before the deadline.</strong> Picks can't be compared.` : `<strong>${n} has sealed.</strong> Seal your picks to see theirs.`,
      map: "until you seal" };
    return {
      line: late ? `<strong>${n} didn't seal before the deadline.</strong> Their picks stay hidden.` : `<strong>${n} hasn't sealed yet.</strong> Their picks appear once they seal.`,
      map: `until ${n} seals` };
  }
  function rowsFor() {
    const you = { key: "me", name: "You", visible: true };
    const actual = { key: "results", name: "Actual", mapName: "Official results", visible: true };
    if (tab === "results") return [actual];
    if (tab === "compare") {
      const t = target();
      if (!t) return [you, actual];
      const seal = compareSeal(t);
      const them = { key: "them", name: t.display_name, visible: !seal && themFor === t.id };
      if (seal) { them.sealedHtml = seal.line; them.mapSeal = seal.map; }
      else if (themFor !== t.id) { them.sealedHtml = "<strong>Loading…</strong>"; them.mapSeal = "loading"; }
      return [you, them, actual];
    }
    return [you, actual];
  }
  let rowByKey = {};

  // ---- the line ----
  function renderLine(rows) {
    const plot = $("plot");
    let maxAbs = 0;
    rows.forEach(r => { if (r.visible) entries(r.key).forEach(e => { maxAbs = Math.max(maxAbs, Math.abs(e.v)); }); });
    const D = Math.min(50, Math.max(15, Math.ceil((maxAbs + 1) / 5) * 5));
    const step = D <= 20 ? 5 : 10;
    const pct = v => ((Math.max(-D, Math.min(D, v)) + D) / (2 * D)) * 100;
    plot.style.setProperty("--zero-pct", pct(0) + "%");
    plot.innerHTML = "";

    const axis = document.createElement("div");
    axis.className = "axis";
    for (let t = -D; t <= D; t += step) {
      const el = document.createElement("span");
      el.className = "tick" + (t < 0 ? " d" : t > 0 ? " r" : "");
      el.style.left = pct(t) + "%";
      el.textContent = t === 0 ? "" : "+" + Math.abs(t);
      axis.appendChild(el);
    }
    plot.appendChild(axis);

    const width = plot.clientWidth || 600;
    const chipW = width < 480 ? 44 : 50, chipH = width < 480 ? 36 : 40, gapX = 3, laneH = chipH + 6;

    rows.forEach(r => {
      const key = r.key;
      const row = document.createElement("div");
      row.className = "row";
      const head = document.createElement("div");
      head.className = "row-head";
      const name = document.createElement("span");
      name.className = "row-name";
      name.textContent = r.name;
      head.appendChild(name);
      row.appendChild(head);

      if (!r.visible) {
        const s = document.createElement("div");
        s.className = "sealed";
        s.innerHTML = `<span class="seal-icon">SEALED</span><span>${r.sealedHtml || ""}</span>`;
        row.appendChild(s);
        plot.appendChild(row);
        return;
      }

      const list = entries(key);
      if (list.length) {
        const dem = list.filter(e => e.v < -0.04).length, rep = list.filter(e => e.v > 0.04).length, even = list.length - dem - rep;
        const tally = document.createElement("span");
        tally.className = "row-tally";
        tally.innerHTML = `<span class="d">D/I ${dem}</span> · <span class="r">R ${rep}</span>${even ? " · even " + even : ""}${list.length < 16 ? " · " + (16 - list.length) + " to go" : ""}`;
        head.appendChild(tally);
      }
      const sc = seats(key);
      const seatPill = document.createElement("span");
      seatPill.className = "row-tally row-seats";
      seatPill.innerHTML = `Senate ${seatText(sc)} · <b class="${sc.control.cls}">${sc.control.text}</b>`;
      head.appendChild(seatPill);
      if (!list.length) {
        const e = document.createElement("div");
        e.className = "row-empty";
        e.innerHTML = key === "results"
          ? `<span>Results go here on election night${isAdmin() && tab !== "results" ? ". Enter them under Results entry." : " as races are called."}</span>`
          : `<span>No picks yet. ${key === "me" && tab === "picks" ? "Enter margins below and they'll land here." : ""}</span>`;
        row.appendChild(e);
        plot.appendChild(row);
        return;
      }

      // stack chips into lanes so close calls don't overlap
      const items = list.map(e => ({ ...e, x: (pct(e.v) / 100) * width })).sort((a, b) => a.x - b.x || a.v - b.v);
      const laneRight = [];
      items.forEach(it => {
        let lane = laneRight.findIndex(x => it.x - chipW / 2 >= x + gapX);
        if (lane === -1) { lane = laneRight.length; laneRight.push(-Infinity); }
        laneRight[lane] = it.x + chipW / 2;
        it.lane = lane;
      });
      const lanes = document.createElement("div");
      lanes.className = "lanes";
      lanes.style.height = (laneRight.length * laneH + 10) + "px";
      items.forEach(it => {
        const c = chipColor(it.st, it.v);
        const chip = document.createElement("div");
        chip.className = "chip" + (Math.abs(it.v) > D ? " over" + (it.v < 0 ? " left" : "") : "");
        chip.style.left = pct(it.v) + "%";
        chip.style.top = (it.lane * laneH + 2) + "px";
        chip.style.background = c.bg;
        chip.style.color = c.fg;
        chip.title = `${it.st.name}: ${fmt(it.st, it.v)} (${r.name})`;
        chip.innerHTML = `<b>${it.st.id}</b><span>${fmt(it.st, it.v)}</span>`;
        lanes.appendChild(chip);
      });
      row.appendChild(lanes);
      plot.appendChild(row);
    });

    const zero = document.createElement("div");
    zero.className = "zero";
    zero.style.left = pct(0) + "%";
    zero.innerHTML = '<span class="zero-tag">EVEN</span>';
    plot.appendChild(zero);
  }

  // ---- the maps ----
  let mapPaths = {}, mapSig = "";
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  document.body.appendChild(tip);

  $("legend").innerHTML =
    `<span><i style="background:linear-gradient(90deg,rgb(29,71,200),rgb(158,163,174))"></i>Dem</span>` +
    `<span><i style="background:linear-gradient(90deg,rgb(176,126,6),rgb(158,163,174))"></i>Ind</span>` +
    `<span><i style="background:linear-gradient(90deg,rgb(158,163,174),rgb(196,30,46))"></i>Rep</span>` +
    `<span><i style="background:var(--safe-d)"></i>Safe D</span>` +
    `<span><i style="background:var(--safe-r)"></i>Safe R</span>` +
    `<span><i style="background:var(--map-pending)"></i>No pick yet</span>` +
    `<span><i style="background:var(--map-none)"></i>No race</span>`;

  function buildMaps(rows) {
    const NS = "http://www.w3.org/2000/svg";
    const wrap = $("maps");
    wrap.innerHTML = "";
    mapPaths = {};
    rows.forEach(r => {
      const key = r.key, label = r.mapName || r.name;
      const fig = document.createElement("figure");
      fig.className = "map-panel";
      fig.dataset.key = key;
      fig.innerHTML = `<figcaption><span class="row-name">${esc(label)}</span><span class="row-tally" data-role="tally"></span></figcaption><div class="seatbar" data-role="seats"></div><div class="map-box"></div>`;
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", "0 0 975 610");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", key === "results" ? "Results map" : key === "me" ? "Your map" : `${label}'s map`);
      mapPaths[key] = {};
      Object.keys(PATHS).forEach(ab => {
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", PATHS[ab]);
        p.dataset.st = ab;
        p.dataset.map = key;
        if (BY_ID[ab]) p.classList.add("game");
        svg.appendChild(p);
        mapPaths[key][ab] = p;
      });
      fig.querySelector(".map-box").appendChild(svg);
      const seal = document.createElement("div");
      seal.className = "map-seal";
      seal.hidden = true;
      seal.innerHTML = '<span class="seal-icon">SEALED</span><span data-role="seal-text"></span>';
      fig.querySelector(".map-box").appendChild(seal);
      wrap.appendChild(fig);
    });
  }

  function renderMaps(rows) {
    const sig = rows.map(r => r.key + ":" + r.name).join("|");
    if (sig !== mapSig) { hideTip(); buildMaps(rows); mapSig = sig; }
    rows.forEach(r => {
      const key = r.key;
      const fig = $("maps").querySelector(`.map-panel[data-key="${key}"]`);
      const visible = r.visible;
      const seal = fig.querySelector(".map-seal");
      seal.hidden = visible;
      seal.querySelector("[data-role=seal-text]").textContent = r.mapSeal || "";
      Object.entries(mapPaths[key]).forEach(([ab, p]) => {
        let fill;
        if (BY_ID[ab]) {
          const v = visible ? signed(docs[key].picks[ab]) : null;
          fill = v === null ? "var(--map-pending)" : chipColor(BY_ID[ab], v).bg;
        } else if (SAFE[ab]) {
          fill = SAFE[ab] === "D" ? "var(--safe-d)" : "var(--safe-r)";
        } else {
          fill = "var(--map-none)";
        }
        p.style.fill = fill;
      });
      const tally = fig.querySelector("[data-role=tally]");
      const seatsEl = fig.querySelector("[data-role=seats]");
      if (!visible) {
        tally.textContent = "sealed";
        seatsEl.innerHTML = `<div class="sb-track sealed-track"></div><div class="sb-labels"><span>Senate balance sealed</span></div>`;
        return;
      }
      seatsEl.innerHTML = seatBar(seats(key));
      const list = entries(key);
      const dem = list.filter(e => e.v < -0.04).length, rep = list.filter(e => e.v > 0.04).length;
      tally.innerHTML = list.length
        ? `<span class="d">D/I ${dem}</span> · <span class="r">R ${rep}</span>${list.length < 16 ? " · " + (16 - list.length) + " to go" : ""}`
        : (key === "results" ? "no races called yet" : "no picks yet");
    });
  }

  function tipHTML(key, ab) {
    const st = BY_ID[ab];
    const name = STATE_NAMES[ab] || ab;
    if (!st) {
      if (SAFE[ab]) return `<div class="tip-title">${name}</div><div class="tip-row">Senate race in 2026 · <b>Safe ${SAFE[ab]}</b></div><div class="tip-row">Not part of the game</div>`;
      return `<div class="tip-title">${name}</div><div class="tip-row">No Senate race in 2026</div>`;
    }
    const row = rowByKey[key] || { visible: false, name: "" };
    const lp = st.ind ? "I" : "D";
    let html = `<div class="tip-title">${name}${st.rcv ? '<span class="tag">Ranked choice</span>' : ""}</div>` +
      `<div class="tip-row">${st.L} (${lp}) vs ${st.R} (R)</div>` +
      (st.also ? `<div class="tip-row">Also running: ${st.also}</div>` : "") +
      (st.winnerOnly ? `<div class="tip-row">Scored on winner only</div>` : "");
    const who = key === "results" ? "Result" : key === "me" ? "Your pick" : `${esc(row.name)}'s pick`;
    if (!row.visible) return html + `<div class="tip-row">${who}: <b>sealed</b></div>`;
    const p = docs[key].picks[ab];
    const v = signed(p);
    if (v === null) {
      if (p && p.side && key !== "results") return html + `<div class="tip-row">${who}: <b>${p.side === "L" ? st.L : st.R}</b>, no margin yet</div>`;
      return html + `<div class="tip-row">${who}: <b>${key === "results" ? "not called yet" : "none yet"}</b></div>`;
    }
    const c = chipColor(st, v);
    const chip = `<span class="tip-chip" style="background:${c.bg};color:${c.fg}">${fmt(st, v)}</span>`;
    if (Math.abs(v) < 0.05) return html + `<div class="tip-row">${who}: <b>dead even</b>${chip}</div>`;
    const winner = v < 0 ? st.L : st.R;
    const verb = key === "results" ? "won by" : "by";
    return html + `<div class="tip-row">${who}: <b>${winner}</b> ${verb} ${trim(Math.abs(v))} pts${chip}</div>`;
  }
  let hotPath = null;
  function showTip(path, x, y) {
    if (hotPath && hotPath !== path) hotPath.classList.remove("hot");
    hotPath = path;
    path.classList.add("hot");
    path.parentNode.appendChild(path); // bring outline to front
    tip.innerHTML = tipHTML(path.dataset.map, path.dataset.st);
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }
  function hideTip() {
    tip.hidden = true;
    if (hotPath) { hotPath.classList.remove("hot"); hotPath = null; }
  }
  $("maps").addEventListener("pointermove", e => {
    const path = e.target.closest("path[data-st]");
    if (path) showTip(path, e.clientX, e.clientY); else hideTip();
  });
  $("maps").addEventListener("pointerleave", e => { if (e.pointerType === "mouse") hideTip(); });
  $("maps").addEventListener("pointerdown", e => {
    const path = e.target.closest("path[data-st]");
    if (path) showTip(path, e.clientX, e.clientY);
  });
  document.addEventListener("pointerdown", e => { if (!e.target.closest("#maps")) hideTip(); });
  window.addEventListener("scroll", () => { if (!tip.hidden) hideTip(); }, { passive: true });

  // ---- entry panel (your picks, or results for admins) ----
  const editKey = () => (tab === "results" ? "results" : "me");
  function editable() {
    if (!me) return false;
    if (editKey() === "results") return isAdmin();
    return !docs.me.sealed && !pastDeadline();
  }
  let cardsBuilt = false;
  function buildCards() {
    const wrap = $("cards");
    wrap.innerHTML = "";
    STATES.forEach(st => {
      const card = document.createElement("article");
      card.className = "card";
      card.dataset.st = st.id;
      if (st.ind) card.dataset.ind = "";
      card.innerHTML = `
        <div class="card-top">
          <h3>${st.name}</h3>${st.rcv ? '<span class="tag">Ranked choice</span>' : ""}${st.winnerOnly ? '<span class="tag">Winner only</span>' : ""}
          <span class="mini" data-role="mini">—</span>
        </div>
        <div class="pick">
          <button type="button" class="cand L${st.ind ? " ind" : ""}" data-side="L" aria-pressed="false">${st.L}<small>${st.ind ? "IND" : "DEM"}</small></button>
          <button type="button" class="cand R" data-side="R" aria-pressed="false">${st.R}<small>REP</small></button>
        </div>
        <label class="by">wins by <input id="pts-${st.id}" type="number" inputmode="decimal" min="0" max="99" step="0.1" placeholder="0.0"> pts</label>${st.also ? `<p class="hint">Also running: ${st.also}.${st.winnerOnly ? " Your margin shows on the line and map, but only the winner counts toward your score." : ""}</p>` : ""}`;
      wrap.appendChild(card);
    });
    cardsBuilt = true;
  }
  function syncCards() {
    if (!cardsBuilt) buildCards();
    const canEdit = editable();
    const picks = docs[editKey()].picks;
    document.querySelectorAll(".card").forEach(card => {
      const st = BY_ID[card.dataset.st];
      const p = picks[st.id] || {};
      card.dataset.side = p.side || ""; // tints the margin box's focus ring to the chosen party
      card.querySelectorAll(".cand").forEach(b => {
        b.setAttribute("aria-pressed", String(p.side === b.dataset.side));
        b.disabled = !canEdit;
      });
      const input = card.querySelector("input");
      input.disabled = !canEdit;
      if (document.activeElement !== input) input.value = (p.pts === null || p.pts === undefined) ? "" : p.pts;
      const v = signed(p);
      const mini = card.querySelector("[data-role=mini]");
      mini.textContent = fmt(st, v);
      if (v !== null) { const c = chipColor(st, v); mini.style.background = c.bg; mini.style.color = c.fg; }
      else { mini.style.background = ""; mini.style.color = ""; }
    });
  }
  function sealedWhen(iso) {
    if (!iso) return "";
    try { return " on " + new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; }
  }
  function renderEntryHead() {
    const head = $("entry-head");
    const key = editKey();
    const n = entries(key).length;
    let title, right = "", note = "";
    if (key === "results") {
      title = "Actual results";
      if (n) right = '<button type="button" class="btn ghost" id="clear">Clear results</button>';
      note = "Fill these in as races are called. Everyone sees them the moment you enter them.";
    } else {
      title = "Your picks";
      const d = docs.me;
      if (d.sealed) {
        right = `<span class="locked-note"><span class="seal-icon">SEALED</span>Sealed${sealedWhen(d.sealed_at)}. These are final.</span>`;
      } else if (pastDeadline()) {
        right = `<span class="locked-note">Picks closed at 6:00 p.m. ET on Nov 3. These weren't sealed, so they don't count.</span>`;
      } else {
        const ok = complete(d.picks);
        right = `${n ? '<button type="button" class="btn ghost" id="clear">Clear picks</button>' : ""}<button type="button" class="btn" id="seal" ${ok ? "" : "disabled"}>Seal picks</button>`;
        note = n === 16 && !ok
          ? "Every race needs a winner and a margin above 0 before you can seal."
          : "Pick a winner, then type the margin. Tap the winner again to clear a race. Picks close Tue, Nov 3 at 6:00 p.m. ET.";
      }
    }
    head.innerHTML = `<h2>${title}</h2><span class="count">${n} / 16 placed</span><span class="spacer"></span>${right}`;
    $("entry-note").textContent = note;
    const sealBtn = $("seal"); if (sealBtn) sealBtn.onclick = () => { confirmOpen = "seal"; renderConfirm(); };
    const clear = $("clear"); if (clear) clear.onclick = () => { confirmOpen = "clear"; renderConfirm(); };
  }
  function renderConfirm() {
    const slot = $("confirm-slot");
    const key = editKey();
    if (confirmOpen === "clear") {
      const n = Object.keys(docs[key].picks).length;
      if (!n || !editable()) { confirmOpen = false; renderConfirm(); return; }
      const what = key === "results" ? "the entered results" : "all of your picks";
      slot.innerHTML = `<div class="confirm"><p>Clear ${what}? This can't be undone.</p><button type="button" class="btn" id="clear-yes">Clear</button><button type="button" class="btn ghost" id="clear-no">Cancel</button></div>`;
      $("clear-yes").onclick = () => { docs[key].picks = {}; confirmOpen = false; queueWrite(key); renderAll(); };
      $("clear-no").onclick = () => { confirmOpen = false; renderConfirm(); };
      return;
    }
    if (confirmOpen === "seal" && key === "me" && editable() && complete(docs.me.picks)) {
      slot.innerHTML = `<div class="confirm warn"><p><strong>Sealing is permanent.</strong> Once you seal, you can't change or unseal any of your 16 picks, even before the deadline. You'll be able to compare with every other player who has sealed.</p><button type="button" class="btn" id="seal-yes">Seal my picks</button><button type="button" class="btn ghost" id="seal-no">Cancel</button></div>`;
      $("seal-yes").onclick = seal;
      $("seal-no").onclick = () => { confirmOpen = false; renderConfirm(); };
      return;
    }
    confirmOpen = false;
    slot.innerHTML = entryError ? `<p class="msg error" role="alert">${esc(entryError)}</p>` : "";
  }

  $("cards").addEventListener("click", e => {
    const b = e.target.closest(".cand");
    if (!b || b.disabled || !editable()) return;
    const key = editKey();
    const id = b.closest(".card").dataset.st;
    const picks = docs[key].picks;
    const input = $("pts-" + id);
    if (picks[id] && picks[id].side === b.dataset.side) {
      // tapping the selected candidate again clears this race
      delete picks[id];
      if (input) { input.value = ""; input.blur(); }
      queueWrite(key);
      renderAll();
      return;
    }
    const p = { ...(picks[id] || { pts: null }) };
    p.side = b.dataset.side;
    picks[id] = p;
    queueWrite(key);
    renderAll();
    if (input && (p.pts === null || p.pts === undefined || p.pts === "")) input.focus();
  });
  $("cards").addEventListener("input", e => {
    const input = e.target.closest("input");
    if (!input || !editable()) return;
    const key = editKey();
    const id = input.closest(".card").dataset.st;
    const picks = docs[key].picks;
    const p = { ...(picks[id] || {}) };
    const raw = input.value.trim();
    p.pts = raw === "" || isNaN(+raw) ? null : Math.min(99, Math.abs(+raw));
    picks[id] = p;
    queueWrite(key);
    renderAll();
  });

  // ---- scorecard (Your picks and Compare) ----
  function renderScore(rows) {
    const el = $("score");
    const people = rows.filter(r => r.key !== "results" && r.visible);
    const results = entries("results");
    let html = "<h2>Scorecard</h2>";
    if (!results.length) {
      el.innerHTML = html + `<p class="score-wait">Scores appear as soon as the first result is entered on election night.</p>`;
      return;
    }
    const sign = v => Math.abs(v) < 0.05 ? 0 : Math.sign(v);
    const stats = {};
    people.forEach(p => { stats[p.key] = { called: 0, n: 0, mn: 0, err: 0 }; });
    const rowsOut = [];
    results.sort((a, b) => a.v - b.v).forEach(({ st, v: actual }) => {
      const pr = {};
      people.forEach(p => {
        const g = signed(docs[p.key].picks[st.id]);
        pr[p.key] = g;
        if (g === null) return;
        const s = stats[p.key];
        s.n++;
        if (!st.winnerOnly) { s.mn++; s.err += Math.abs(g - actual); }
        if (sign(g) === sign(actual)) s.called++;
      });
      rowsOut.push({ st, actual, pr });
    });
    const avg = k => stats[k].mn ? stats[k].err / stats[k].mn : null;
    let winLeader = null, missLeader = null;
    if (people.length === 2) {
      const [a, b] = people.map(p => p.key);
      if (stats[a].called !== stats[b].called) winLeader = stats[a].called > stats[b].called ? a : b;
      const ma = avg(a), mb = avg(b);
      if (ma !== null && mb !== null && ma !== mb) missLeader = ma < mb ? a : b;
    }
    html += `<p class="score-wait">${results.length} of 16 races in.</p>`;
    html += `<div class="duel">` + people.map(p => {
      const s = stats[p.key], a = avg(p.key);
      const badges = [winLeader === p.key ? "most winners" : "", missLeader === p.key ? "closest margins" : ""].filter(Boolean).join(" · ");
      return `<div class="duelist${winLeader === p.key || missLeader === p.key ? " lead" : ""}"><h3>${esc(p.name)}${badges ? "<em>" + badges + "</em>" : ""}</h3>
        <div class="stat"><span>Winners called</span><b>${s.called} / ${s.n}</b></div>
        <div class="stat"><span>Average miss</span><b>${a === null ? "—" : trim(a) + " pts"}</b></div></div>`;
    }).join("") + `</div>`;
    html += `<div class="table-wrap"><table><thead><tr><th>State</th>${people.map(p => `<th>${esc(p.name)}</th>`).join("")}<th>Actual</th></tr></thead><tbody>` +
      rowsOut.map(r => `<tr><td>${r.st.name}${r.st.winnerOnly ? ' <span class="tag">Winner only</span>' : ""}</td>` +
        people.map(p => {
          const g = r.pr[p.key];
          const mark = g === null ? "" : (sign(g) === sign(r.actual) ? '<span class="mark ok" title="Called the winner">✓</span>' : '<span class="mark miss" title="Missed the winner">✗</span>');
          return `<td class="m ${valClass(r.st, g)}">${fmt(r.st, g)} ${mark}</td>`;
        }).join("") +
        `<td class="m ${valClass(r.st, r.actual)}">${fmt(r.st, r.actual)}</td></tr>`).join("") +
      `</tbody></table></div>`;
    el.innerHTML = html;
  }

  // ---- leaderboard ----
  const MEDAL = ["", "1st", "2nd", "3rd"];
  function placeify(list, same) {
    list.forEach((r, i) => { r.place = i > 0 && same(list[i - 1], r) ? list[i - 1].place : i + 1; });
    return list;
  }
  function medal(place) {
    return place <= 3
      ? `<span class="medal m${place}" title="${MEDAL[place]} place" aria-label="${MEDAL[place]} place">${place}</span>`
      : `<span class="medal mx" aria-label="Place ${place}">${place}</span>`;
  }
  function boardBar() {
    const btns = [{ key: "all", short: "Everyone" }].concat(GROUPS).map(g =>
      `<button type="button" data-filter="${g.key}" aria-pressed="${lbFilter === g.key}">${g.short}</button>`).join("");
    const opts = GROUPS.map(g => `<option value="${g.key}"${me.grp === g.key ? " selected" : ""}>${g.name}</option>`).join("");
    const mine = isAdmin()
      ? `<span class="my-grp">You're on every group's leaderboard as host</span>`
      : `<label class="my-grp">Your group <select id="my-grp">${opts}</select></label>`;
    return `<div class="lb-bar"><div class="seg" role="group" aria-label="Which leaderboard">${btns}</div>${mine}</div>` +
      `<p class="msg error" id="grp-msg" role="alert"></p>`;
  }
  function renderBoard() {
    const el = $("leaderboard");
    // Admins (the host) know everyone, so they appear on every group's leaderboard
    const adminIds = new Set(players.filter(p => p.is_admin).map(p => p.id));
    const inView = p => lbFilter === "all" || p.grp === lbFilter || adminIds.has(p.id);
    const shown = players.filter(inView);
    const sealed = shown.filter(p => p.sealed), open = shown.filter(p => !p.sealed);
    const rowsIn = board.filter(inView);
    const racesIn = board.length ? board[0].races_in : 0;
    const you = id => (id === uid() ? " (you)" : "");
    const title = lbFilter === "all" ? "Leaderboard" : `Leaderboard · ${GROUP_BY[lbFilter].name}`;
    let html = `<h2>${title}</h2>` + boardBar();
    if (!shown.length) {
      el.innerHTML = html + `<p class="score-wait">No one has joined this group yet.</p>`;
      return;
    }
    if (!racesIn) {
      html += `<p class="panel-lede">${sealed.length} of ${shown.length} player${shown.length === 1 ? " has" : "s have"} sealed. Rankings appear once the first result is entered on election night.</p>`;
      html += `<h3>Sealed</h3>` + (sealed.length
        ? `<ul class="sealed-list">${sealed.map(p => `<li><span class="seal-icon">SEALED</span>${esc(p.display_name)}${you(p.id)}</li>`).join("")}</ul>`
        : `<p class="score-wait">No one has sealed yet.</p>`);
      if (open.length) {
        html += `<h3>${pastDeadline() ? "Didn't seal" : "Not sealed yet"}</h3><ul class="sealed-list">${open.map(p => `<li class="no">${esc(p.display_name)}${you(p.id)}</li>`).join("")}</ul>`;
      }
      el.innerHTML = html;
      return;
    }
    // ties are judged on the same 2-decimal average that's displayed
    const missKey = r => (r.avg_miss === null ? Infinity : Math.round(Number(r.avg_miss) * 100));
    const showMiss = r => (r.avg_miss === null ? "—" : Number(r.avg_miss).toFixed(2) + " pts");
    const byName = (a, b) => a.display_name.localeCompare(b.display_name);
    if (!rowsIn.length) {
      el.innerHTML = html + `<p class="score-wait">No one in this group sealed their picks.</p>`;
      return;
    }
    const rows = rowsIn.map(r => ({ ...r }));
    const byWins = placeify(rows.slice().sort((a, b) => (b.called - a.called) || (missKey(a) - missKey(b)) || byName(a, b)),
      (a, b) => a.called === b.called && missKey(a) === missKey(b));
    const byMiss = placeify(rows.filter(r => r.avg_miss !== null).map(r => ({ ...r })).sort((a, b) => (missKey(a) - missKey(b)) || byName(a, b)),
      (a, b) => missKey(a) === missKey(b));
    const tr = (r, cells) => `<tr class="${r.id === uid() ? "me" : ""}"><td class="place">${medal(r.place)}</td><td>${esc(r.display_name)}${you(r.id)}</td>${cells}</tr>`;
    html += `<p class="panel-lede">${racesIn} of 16 races in · ${rows.length} sealed player${rows.length === 1 ? "" : "s"}.</p>`;
    html += `<div class="boards">` +
      `<div class="board"><h3>Most winners called</h3><p class="hint">If players call the same number of winners, whoever's margins were closer to the real results ranks higher (see Closest margins).</p><div class="table-wrap"><table><thead><tr><th></th><th>Player</th><th>Winners called</th></tr></thead><tbody>` +
        byWins.map(r => tr(r, `<td class="m">${r.called} / ${racesIn}</td>`)).join("") +
      `</tbody></table></div></div>` +
      `<div class="board"><h3>Closest margins</h3><p class="hint">How far off your margins were, on average, in points. Lower is better. Montana doesn't count here.</p>` +
        (byMiss.length
          ? `<div class="table-wrap"><table><thead><tr><th></th><th>Player</th><th>Average miss</th></tr></thead><tbody>` +
            byMiss.map(r => tr(r, `<td class="m">${showMiss(r)}</td>`)).join("") + `</tbody></table></div>`
          : `<p class="score-wait">Appears once a race other than Montana has a result.</p>`) +
      `</div></div>`;
    el.innerHTML = html;
  }

  // ---- views ----
  function renderCompareBar() {
    const bar = $("compare-bar");
    bar.hidden = tab !== "compare";
    if (bar.hidden) return;
    const sel = $("compare-select");
    const list = others();
    if (!list.length) {
      sel.innerHTML = `<option value="">No one else has joined yet</option>`;
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const opt = p => `<option value="${esc(p.id)}">${esc(p.display_name)}${p.sealed ? " · sealed" : ""}</option>`;
    const html = GROUPS.map(g => {
      const inG = list.filter(p => p.grp === g.key);
      return inG.length ? `<optgroup label="${g.name}">${inG.map(opt).join("")}</optgroup>` : "";
    }).join("");
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    sel.value = compareId || "";
  }
  function setStatus(text, live) {
    const s = $("status");
    s.textContent = text;
    s.classList.toggle("live", !!live);
  }
  function renderChrome() {
    const signedIn = !!session, member = !!me;
    $("nav").hidden = !member;
    $("auth").hidden = member;
    $("signin-box").hidden = signedIn;
    $("join-box").hidden = !signedIn || member;
    $("rules").hidden = member && tab !== "rules";
    const acct = $("account");
    acct.hidden = !signedIn;
    if (signedIn) {
      const who = member ? me.display_name : session.user.email;
      acct.innerHTML = `<b>${esc(who)}</b>${isAdmin() ? " · admin" : ""} · <button type="button" class="linkbtn" id="signout">Sign out</button>`;
      $("signout").onclick = signOut;
    }
    document.querySelector('#tabs [data-tab="results"]').hidden = !isAdmin();
    document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tab === tab)));
    const game = member && (tab === "picks" || tab === "compare" || tab === "results");
    $("maps-sec").hidden = !game;
    $("line-sec").hidden = !game;
    $("entry-sec").hidden = !member || !(tab === "picks" || tab === "results");
    $("score").hidden = !member || !(tab === "picks" || tab === "compare");
    $("leaderboard").hidden = !member || tab !== "leaderboard";
  }
  function renderAll() {
    renderChrome();
    if (!me) return;
    if (tab === "leaderboard") { renderBoard(); return; }
    if (tab === "rules") return;
    renderCompareBar();
    const rows = rowsFor();
    rowByKey = Object.fromEntries(rows.map(r => [r.key, r]));
    renderMaps(rows);
    renderLine(rows);
    if (tab === "picks" || tab === "results") { syncCards(); renderEntryHead(); renderConfirm(); }
    if (tab === "picks" || tab === "compare") renderScore(rows);
  }

  document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.tab === tab) return;
    tab = b.dataset.tab;
    confirmOpen = false;
    entryError = "";
    save("pl-tab", tab);
    hideTip();
    if (tab === "leaderboard") scheduleRefresh();
    if (tab === "compare") loadThem();
    renderAll();
  }));
  $("leaderboard").addEventListener("click", e => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    lbFilter = b.dataset.filter;
    save("pl-board", lbFilter);
    renderBoard();
  });
  $("leaderboard").addEventListener("change", async e => {
    if (e.target.id !== "my-grp") return;
    const grp = e.target.value;
    e.target.disabled = true;
    const { data, error } = await sb.rpc("set_group", { grp });
    if (error || !data || !data.ok) {
      renderBoard();
      $("grp-msg").textContent = (data && data.error) || (error && error.message) || "Couldn't change your group.";
      return;
    }
    me.grp = grp;
    await refreshLists();
    renderAll();
  });
  $("compare-select").addEventListener("change", e => {
    compareId = e.target.value || null;
    save("pl-compare", compareId);
    loadThem();
    renderAll();
  });

  let resizeT;
  new ResizeObserver(() => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (me && !$("line-sec").hidden) renderLine(rowsFor()); }, 80);
  }).observe($("plot"));

  // ---- saving ----
  function queueWrite(key) {
    dirty[key] = true;
    entryError = "";
    setStatus("Saving…", true);
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => flush(key), 600);
  }
  async function flush(key) {
    if (inflight[key]) { again[key] = true; return; }
    inflight[key] = true;
    const races = JSON.parse(JSON.stringify(docs[key].picks));
    let error = null;
    try {
      if (key === "me") {
        ({ error } = await sb.from("picks").upsert({ user_id: uid(), races }, { onConflict: "user_id" }));
      } else {
        const r = await sb.from("results").update({ races }).eq("id", 1).select("id");
        error = r.error || (r.data && r.data.length ? null : { message: "Only admins can enter results." });
      }
    } catch (e) {
      error = { message: "Couldn't save. Check your connection." };
    }
    inflight[key] = false;
    if (error) {
      again[key] = false;
      dirty[key] = false;
      entryError = error.message || "Couldn't save.";
      setStatus("Couldn't save", false);
      await reloadDoc(key); // show what the server actually has
      renderAll();
      return;
    }
    if (again[key]) { again[key] = false; return flush(key); }
    dirty[key] = false;
    setStatus("Saved · live", true);
  }
  async function settle(key) {
    clearTimeout(timers[key]);
    if (dirty[key] && !inflight[key]) await flush(key);
    while (inflight[key]) await new Promise(r => setTimeout(r, 80));
  }
  async function seal() {
    const btn = $("seal-yes");
    if (btn) btn.disabled = true;
    setStatus("Sealing…", true);
    await settle("me");
    const { data, error } = await sb.from("picks")
      .upsert({ user_id: uid(), races: docs.me.picks, sealed: true }, { onConflict: "user_id" })
      .select("races, sealed, sealed_at").single();
    confirmOpen = false;
    if (error) {
      entryError = error.message || "Couldn't seal your picks.";
      setStatus("Couldn't seal", false);
      await reloadDoc("me");
    } else {
      docs.me = norm(data);
      dirty.me = false;
      entryError = "";
      setStatus("Sealed · live", true);
      await refreshLists();
    }
    renderAll();
  }
  window.addEventListener("beforeunload", e => {
    if (Object.values(dirty).some(Boolean) || Object.values(inflight).some(Boolean)) { e.preventDefault(); e.returnValue = ""; }
  });

  // ---- loading ----
  async function reloadDoc(key) {
    if (key === "me") {
      const { data } = await sb.from("picks").select("races, sealed, sealed_at").eq("user_id", uid()).maybeSingle();
      docs.me = norm(data);
    } else if (key === "results") {
      const { data } = await sb.from("results").select("races").eq("id", 1).maybeSingle();
      docs.results = { picks: norm(data).picks };
    }
  }
  async function refreshLists() {
    const [pl, lb] = await Promise.all([sb.rpc("list_players"), sb.rpc("leaderboard")]);
    if (!pl.error) players = pl.data || [];
    if (!lb.error) board = lb.data || [];
    const list = others();
    if (!list.find(p => p.id === compareId)) {
      compareId = (list.find(p => p.sealed) || list[0] || {}).id || null;
      save("pl-compare", compareId);
    }
    await loadThem();
  }
  function scheduleRefresh() {
    clearTimeout(refreshT);
    refreshT = setTimeout(() => { refreshLists().then(renderAll); }, 400);
  }
  // Fetch the compared player's picks once you've both sealed (the database refuses before that)
  async function loadThem() {
    const t = target();
    if (!t || !t.sealed || !docs.me.sealed) { themFor = null; docs.them = emptyDoc(); return; }
    if (themFor === t.id) return;
    const id = t.id;
    const { data } = await sb.from("picks").select("races, sealed, sealed_at").eq("user_id", id).maybeSingle();
    if (compareId !== id) return;
    if (data) { docs.them = norm(data); themFor = id; }
    renderAll();
  }
  async function loadAll() {
    const [pk, rs] = await Promise.all([
      sb.from("picks").select("races, sealed, sealed_at").eq("user_id", uid()).maybeSingle(),
      sb.from("results").select("races").eq("id", 1).maybeSingle(),
    ]);
    docs.me = norm(pk.data);
    docs.results = { picks: norm(rs.data).picks };
    themFor = null;
    docs.them = emptyDoc();
    await refreshLists();
  }

  function subscribe() {
    unsubscribe();
    channel = sb.channel("party-lines")
      .on("postgres_changes", { event: "*", schema: "public", table: "picks" }, payload => {
        const row = payload.new;
        if (row && row.user_id) {
          if (row.user_id === uid()) { if (!dirty.me && !inflight.me) docs.me = norm(row); }
          else if (row.user_id === themFor) docs.them = norm(row);
        }
        scheduleRefresh();
        renderAll();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "results" }, payload => {
        if (payload.new && !dirty.results && !inflight.results) docs.results = { picks: norm(payload.new).picks };
        scheduleRefresh();
        renderAll();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => scheduleRefresh())
      .subscribe(status => {
        if (status === "SUBSCRIBED") setStatus("Live", true);
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setStatus("Lost connection · reload to reconnect", false);
      });
    // Other players' seal status isn't pushed to you until you've sealed too, so poll the player list
    clearInterval(pollT);
    pollT = setInterval(() => { if (!document.hidden) scheduleRefresh(); }, 30000);
  }
  function unsubscribe() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    clearInterval(pollT);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && me) scheduleRefresh(); });

  // ---- auth ----
  async function onSession(s, force) {
    const id = s && s.user ? s.user.id : null;
    session = s;
    if (!force && booted && id === handledUid) return; // token refreshes, repeat events
    handledUid = id;
    booted = true;
    if (!s) {
      me = null;
      unsubscribe();
      players = []; board = [];
      docs.me = emptyDoc(); docs.them = emptyDoc(); docs.results = { picks: {} };
      setStatus("Not signed in", false);
      renderAll();
      return;
    }
    setStatus("Connecting…", false);
    const { data: prof, error } = await sb.from("profiles").select("id, display_name, is_admin, grp").eq("id", id).maybeSingle();
    if (error) { setStatus("Couldn't connect · reload to retry", false); renderAll(); return; }
    me = prof || null;
    if (!me) {
      setStatus("Signed in · not joined", false);
      renderAll();
      $("join-name").focus();
      return;
    }
    if (tab === "results" && !me.is_admin) tab = "picks";
    if (!["picks", "compare", "leaderboard", "rules", "results"].includes(tab)) tab = "picks";
    await loadAll();
    subscribe();
    renderAll();
  }
  async function signOut() {
    await Promise.all(Object.keys(dirty).filter(k => dirty[k]).map(settle));
    await sb.auth.signOut();
    await onSession(null, true);
  }

  $("signin-form").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("signin-email").value.trim();
    const msg = $("signin-msg"), btn = e.target.querySelector("button");
    if (!email) return;
    btn.disabled = true;
    msg.className = "msg";
    msg.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    btn.disabled = false;
    if (error) { msg.className = "msg error"; msg.textContent = error.message; return; }
    msg.className = "msg ok";
    msg.textContent = `We sent a code to ${email}. Type it below. It can take a minute to arrive, so check spam too.`;
    codeEmail = email;
    $("code-form").hidden = false;
    $("code-msg").textContent = "";
    $("signin-code").value = "";
    $("signin-code").focus();
  });
  // Sign-in is by code only: email scanners (common at universities) open links, which would use up the one-time token
  let codeEmail = null;
  $("code-form").addEventListener("submit", async e => {
    e.preventDefault();
    const msg = $("code-msg"), btn = e.target.querySelector("button");
    const token = $("signin-code").value.replace(/\s/g, "");
    if (!codeEmail || !token) return;
    btn.disabled = true;
    msg.className = "msg";
    msg.textContent = "Checking…";
    const { error } = await sb.auth.verifyOtp({ email: codeEmail, token, type: "email" });
    btn.disabled = false;
    if (error) { msg.className = "msg error"; msg.textContent = error.message; return; }
    msg.textContent = "";
    $("code-form").hidden = true;
    $("signin-msg").textContent = "";
  });
  $("join-form").addEventListener("submit", async e => {
    e.preventDefault();
    const msg = $("join-msg"), btn = e.target.querySelector("button[type=submit]");
    const picked = e.target.querySelector("input[name=join-grp]:checked");
    if (!picked) { msg.className = "msg error"; msg.textContent = "Choose how you know Riley."; return; }
    btn.disabled = true;
    msg.className = "msg";
    msg.textContent = "Joining…";
    const { data, error } = await sb.rpc("join_game", { display_name: $("join-name").value, code: $("join-code").value, grp: picked.value });
    btn.disabled = false;
    if (error || !data || !data.ok) {
      msg.className = "msg error";
      msg.textContent = (data && data.error) || (error && error.message) || "Couldn't join.";
      return;
    }
    $("join-code").value = "";
    msg.textContent = "";
    tab = "picks";
    save("pl-tab", tab);
    await onSession(session, true);
  });

  // A magic link that failed (expired, already used) comes back with the reason in the URL hash
  (function showLinkError() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ""));
    const err = h.get("error_description");
    if (!err) return;
    const msg = $("signin-msg");
    msg.className = "msg error";
    msg.textContent = err.replace(/\+/g, " ") + ". Request a new code below and type it in instead.";
    history.replaceState(null, "", location.pathname + location.search);
  })();

  sb.auth.onAuthStateChange((event, s) => {
    // run outside the auth callback; awaiting Supabase calls inside it can deadlock
    setTimeout(() => onSession(s), 0);
  });
  sb.auth.getSession().then(({ data }) => onSession(data.session));
})();
