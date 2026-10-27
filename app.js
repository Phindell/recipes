// Family Recipes — app logic
import { parseIngredient, scaleLine, combineIngredients, isHeading, itemKey, mergeLines } from "./ingredients.js";

const CFG = window.APP_CONFIG || {};
const MODE = CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY ? "cloud" : "local";
let sb = null;

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2));
const lines = t => String(t || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const safeUrl = u => (/^(https?:|data:image\/)/i.test(String(u || "")) ? u : "");
const SLOTS = [["breakfast", "Breakfast"], ["lunch", "Lunch"], ["dinner", "Dinner"]];

function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function fromYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); }
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function openModal(html) { $("#modalBody").innerHTML = html; $("#modal").hidden = false; }
function closeModal() { $("#modal").hidden = true; $("#modalBody").innerHTML = ""; }

async function compressImage(file, maxSide, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, "image/jpeg", quality));
  } finally { URL.revokeObjectURL(url); }
}
const blobToDataURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });

/* ---------- data: demo (this device only) ---------- */
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem("fr_" + k) || "[]"); } catch { return []; } },
  set(k, v) {
    try { localStorage.setItem("fr_" + k, JSON.stringify(v)); }
    catch { toast("This device is out of space for demo data — set up sharing (SETUP.md)."); throw new Error("Storage full"); }
  }
};
const byName = (a, b) => a.name.localeCompare(b.name);
const localApi = {
  async listRecipes() { return LS.get("recipes").sort(byName); },
  async saveRecipe(r) {
    const all = LS.get("recipes"), now = new Date().toISOString();
    if (r.id) { const i = all.findIndex(x => x.id === r.id); all[i] = { ...all[i], ...r, updated_at: now }; LS.set("recipes", all); return all[i]; }
    const n = { ...r, id: uid(), created_at: now, updated_at: now }; all.push(n); LS.set("recipes", all); return n;
  },
  async deleteRecipe(id) {
    LS.set("recipes", LS.get("recipes").filter(x => x.id !== id));
    LS.set("plan", LS.get("plan").filter(p => p.recipe_id !== id));
  },
  async listPlan(from, to) { return LS.get("plan").filter(p => p.plan_date >= from && p.plan_date <= to); },
  async addPlan(e) { const all = LS.get("plan"); const n = { ...e, id: uid(), created_at: new Date().toISOString() }; all.push(n); LS.set("plan", all); return n; },
  async deletePlan(id) { LS.set("plan", LS.get("plan").filter(p => p.id !== id)); },
  async listShopping() { return LS.get("shopping").sort((a, b) => a.created_at.localeCompare(b.created_at)); },
  async addShopping(items) {
    const t = Date.now();
    const rows = items.map((it, i) => ({ id: uid(), checked: false, created_at: new Date(t + i).toISOString(), ...it }));
    LS.set("shopping", [...LS.get("shopping"), ...rows]); return rows;
  },
  async updateShopping(id, patch) { LS.set("shopping", LS.get("shopping").map(x => (x.id === id ? { ...x, ...patch } : x))); },
  async deleteShopping(ids) { const s = new Set(ids); LS.set("shopping", LS.get("shopping").filter(x => !s.has(x.id))); },
  async uploadPhoto(blob) { return blobToDataURL(blob); },
  async importRecipe() { throw new Error("Importing switches on after the cloud setup (SETUP.md). In demo mode, type or paste the recipe below."); }
};

/* ---------- data: shared family cloud (Supabase) ---------- */
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const cloudApi = {
  async listRecipes() { return must(await sb.from("recipes").select("*").order("name")); },
  async saveRecipe(r) {
    const row = { ...r, updated_at: new Date().toISOString() };
    if (r.id) return must(await sb.from("recipes").update(row).eq("id", r.id).select().single());
    delete row.id; row.created_by = state.user?.email || null;
    return must(await sb.from("recipes").insert(row).select().single());
  },
  async deleteRecipe(id) { must(await sb.from("recipes").delete().eq("id", id)); },
  async listPlan(from, to) { return must(await sb.from("meal_plan").select("*").gte("plan_date", from).lte("plan_date", to).order("created_at")); },
  async addPlan(e) { return must(await sb.from("meal_plan").insert(e).select().single()); },
  async deletePlan(id) { must(await sb.from("meal_plan").delete().eq("id", id)); },
  async listShopping() { return must(await sb.from("shopping_items").select("*").order("created_at")); },
  async addShopping(items) { return must(await sb.from("shopping_items").insert(items).select()); },
  async updateShopping(id, patch) { must(await sb.from("shopping_items").update(patch).eq("id", id)); },
  async deleteShopping(ids) { if (ids.length) must(await sb.from("shopping_items").delete().in("id", ids)); },
  async uploadPhoto(blob) {
    const path = `uploads/${uid()}.jpg`;
    must(await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg", cacheControl: "31536000" }));
    return sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
  },
  async importRecipe(payload) {
    const { data, error } = await sb.functions.invoke("import-recipe", { body: payload });
    if (error) {
      let msg = error.message;
      try { const b = await error.context.json(); msg = b.error || msg; } catch {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data.recipe;
  }
};
const api = MODE === "cloud" ? cloudApi : localApi;

/* ---------- state ---------- */
const state = { user: null, recipes: [], plan: [], shopping: [], weekStart: startOfWeek(new Date()), search: "", scale: {}, draft: null };
const recipeById = id => state.recipes.find(r => r.id === id);

async function loadRecipes() { state.recipes = await api.listRecipes(); }
async function loadPlan() { state.plan = await api.listPlan(ymd(state.weekStart), ymd(addDays(state.weekStart, 6))); }
async function loadShopping() { state.shopping = await api.listShopping(); }

/* ---------- router ---------- */
function parseRoute() { const [, view = "recipes", id] = (location.hash.slice(1) || "/recipes").split("/"); return { view, id }; }
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

async function render() {
  if (MODE === "cloud" && !state.user) return renderLogin();
  const { view, id } = parseRoute();
  $$("#tabbar a").forEach(a => a.classList.toggle("active", a.dataset.tab === (view === "recipe" || view === "edit" ? "recipes" : view)));
  $("#tabbar").hidden = false;
  window.scrollTo(0, 0);
  try {
    if (view === "recipe") return renderRecipe(id);
    if (view === "edit") return renderEdit(id);
    if (view === "plan") { await loadPlan(); return renderPlan(); }
    if (view === "shop") { await loadShopping(); return renderShop(); }
    return renderRecipes();
  } catch (e) { $("#view").innerHTML = `<p class="pad center">Something went wrong: ${esc(e.message)}</p>`; }
}

/* ---------- views: login ---------- */
function renderLogin() {
  $("#tabbar").hidden = true;
  $("#view").innerHTML = `
    <form class="login card pad stack" id="loginForm">
      <h2>Welcome 👋</h2>
      <p class="muted">Sign in with your family login.</p>
      <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn primary" type="submit" style="width:100%">Sign in</button>
    </form>`;
  $("#loginForm").onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target), btn = e.target.querySelector("button");
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    const { error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
    if (error) { toast(error.message); btn.disabled = false; btn.textContent = "Sign in"; }
  };
}

/* ---------- views: recipe list ---------- */
function photoOrEmoji(r, cls = "") {
  const u = safeUrl(r.photo_url);
  return u ? `<img src="${esc(u)}" alt="" loading="lazy" class="${cls}">` : `<span>🍲</span>`;
}
function renderRecipes() {
  const q = state.search.toLowerCase();
  const list = state.recipes.filter(r => !q || r.name.toLowerCase().includes(q) || (r.ingredients || []).some(i => i.toLowerCase().includes(q)));
  $("#view").innerHTML = `
    ${MODE === "local" ? `<div class="banner">Demo mode — recipes are saved on this device only. Follow SETUP.md to share with family.</div>` : ""}
    <input type="search" id="search" placeholder="Search recipes or ingredients…" value="${esc(state.search)}" style="margin-top:10px">
    ${list.length ? `<div class="grid">${list.map(r => `
      <a class="rcard card" href="#/recipe/${r.id}"><div class="ph">${photoOrEmoji(r)}</div><div class="nm">${esc(r.name)}</div></a>`).join("")}</div>`
      : `<p class="muted center pad">${state.recipes.length ? "No matches." : "No recipes yet — tap + to add or import your first one."}</p>`}
    <button class="fab" data-act="newRecipe" aria-label="Add recipe">+</button>`;
  const s = $("#search");
  s.oninput = () => { state.search = s.value; const pos = s.selectionStart; renderRecipes(); const n = $("#search"); n.focus(); n.setSelectionRange(pos, pos); };
}

/* ---------- views: recipe detail (Name, Photo, Ingredients, Method, Notes) ---------- */
function renderRecipe(id) {
  const r = recipeById(id);
  if (!r) return ($("#view").innerHTML = `<p class="pad center">Recipe not found. <a href="#/recipes">Back</a></p>`);
  const base = r.servings || null;
  const serves = state.scale[id] || base;
  const factor = base && serves ? serves / base : 1;
  const photo = safeUrl(r.photo_url);
  $("#view").innerHTML = `
    <article class="detail">
      <a href="#/recipes" class="muted" style="text-decoration:none">‹ All recipes</a>
      <h2 class="name">${esc(r.name)}</h2>
      ${photo ? `<div class="hero"><img src="${esc(photo)}" alt="${esc(r.name)}"></div>` : ""}
      <section class="section">
        <h3>Ingredients</h3>
        ${base ? `<div class="scaler">Serves <button data-act="scale" data-id="${r.id}" data-d="-1" aria-label="Fewer">−</button>
          <strong>${serves}</strong><button data-act="scale" data-id="${r.id}" data-d="1" aria-label="More">+</button></div>` : ""}
        <ul class="ing">${(r.ingredients || []).map(i => isHeading(i) ? `<li><strong>${esc(i)}</strong></li>` : `<li>${esc(scaleLine(i, factor))}</li>`).join("")}</ul>
      </section>
      <section class="section">
        <h3>Method</h3>
        ${methodHtml(r.method || [])}
      </section>
      ${r.notes ? `<section class="section"><h3>Extra notes</h3><div class="notes">${esc(r.notes)}</div></section>` : ""}
      ${safeUrl(r.source_url) ? `<p class="hint">Source: <a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(new URL(r.source_url).hostname)}</a></p>` : ""}
      <div class="actions">
        <button class="btn primary" data-act="recipeToShop" data-id="${r.id}">🛒 Add to shopping list</button>
        <button class="btn" data-act="recipeToPlan" data-id="${r.id}">🗓️ Add to plan</button>
        <a class="btn" href="#/edit/${r.id}">✏️ Edit</a>
        <button class="btn danger" data-act="deleteRecipe" data-id="${r.id}">Delete</button>
      </div>
    </article>`;
}

// Steps are numbered; a line ending in ":" starts a new group (e.g. "For the sauce:")
function methodHtml(steps) {
  let html = "", open = false;
  for (const s of steps) {
    if (isHeading(s)) { if (open) html += "</ol>"; html += `<p><strong>${esc(s)}</strong></p>`; open = false; continue; }
    if (!open) { html += `<ol class="method">`; open = true; }
    html += `<li>${esc(s)}</li>`;
  }
  return html + (open ? "</ol>" : "");
}

/* ---------- views: add / edit ---------- */
function renderEdit(id) {
  const existing = id && id !== "new" ? recipeById(id) : null;
  if (!state.draft || state.draft._for !== (id || "new")) {
    state.draft = existing ? { ...existing, _for: id } : { name: "", photo_url: "", ingredients: [], method: [], notes: "", servings: null, source_url: "", _for: "new" };
  }
  const d = state.draft;
  $("#view").innerHTML = `
    <a href="${existing ? "#/recipe/" + existing.id : "#/recipes"}" class="muted" style="text-decoration:none">‹ Cancel</a>
    <h2 style="font-family:var(--serif);margin:6px 0 12px">${existing ? "Edit recipe" : "New recipe"}</h2>
    ${existing ? "" : `
    <div class="card import-box">
      <h3>⚡ Import</h3>
      <div class="tabs-mini">
        <button data-act="impTab" data-t="url" class="on">From a link</button>
        <button data-act="impTab" data-t="text">Paste text</button>
        <button data-act="impTab" data-t="photo">Photo of a recipe</button>
      </div>
      <div data-imp="url"><div class="row"><input type="url" id="impUrl" placeholder="Website, Instagram, TikTok, YouTube, Pinterest link…"><button class="btn primary" data-act="importUrl">Import</button></div>
        <div class="hint">Works with most recipe sites and social posts that have the recipe in the caption.</div></div>
      <div data-imp="text" hidden><textarea id="impText" placeholder="Paste a caption, email or any recipe text…"></textarea>
        <button class="btn primary" data-act="importText" style="margin-top:8px">Sort it into a recipe</button></div>
      <div data-imp="photo" hidden><label class="btn primary">📷 Take or choose a photo<input type="file" id="impPhoto" accept="image/*" hidden></label>
        <div class="hint">Cookbook page, recipe card or a screenshot — it gets read and filled in for you.</div></div>
      <div id="impStatus" class="hint"></div>
    </div>`}
    <form id="editForm" class="stack" style="margin-top:16px">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(d.name)}" required></label>
      <div class="field"><span style="display:block;font-weight:600;margin-bottom:6px;font-size:.92rem">Photo</span>
        <div class="photo-pick"><div class="thumb" id="thumb">${safeUrl(d.photo_url) ? `<img src="${esc(d.photo_url)}" alt="">` : "🍲"}</div>
          <div class="stack" style="flex:1;min-width:0"><label class="btn small">📷 ${d.photo_url ? "Change photo" : "Add photo"}<input type="file" id="photoFile" accept="image/*" hidden></label>
          ${d.photo_url ? `<button type="button" class="btn small" data-act="removePhoto">Remove photo</button>` : ""}</div></div></div>
      <label class="field"><span>Ingredients</span><textarea name="ingredients" rows="8" placeholder="One per line, e.g.&#10;2 cups flour&#10;1 tsp salt">${esc((d.ingredients || []).join("\n"))}</textarea>
        <div class="hint">One per line. A line ending in “:” becomes a heading (e.g. “For the sauce:”).</div></label>
      <label class="field"><span>Method</span><textarea name="method" rows="8" placeholder="One step per line">${esc((d.method || []).join("\n"))}</textarea></label>
      <label class="field"><span>Extra notes</span><textarea name="notes" rows="4" placeholder="Tips, swaps, who loves it…">${esc(d.notes || "")}</textarea></label>
      <div class="row">
        <label class="field" style="width:120px"><span>Serves</span><input type="number" name="servings" min="1" max="99" value="${esc(d.servings ?? "")}"></label>
        <label class="field grow"><span>Source link</span><input type="url" name="source_url" value="${esc(d.source_url || "")}"></label>
      </div>
      <button class="btn primary" type="submit" style="width:100%">Save recipe</button>
    </form>`;

  const form = $("#editForm");
  const syncDraft = () => {
    const f = new FormData(form);
    Object.assign(state.draft, {
      name: f.get("name").trim(), ingredients: lines(f.get("ingredients")),
      method: lines(f.get("method")).map(s => s.replace(/^(step\s*)?\d+[.)]\s*/i, "")),
      notes: f.get("notes").trim(), servings: parseInt(f.get("servings")) || null, source_url: f.get("source_url").trim()
    });
  };
  form.oninput = syncDraft;
  $("#photoFile").onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const blob = await compressImage(file, MODE === "cloud" ? 1600 : 800);
    state.draft._photoBlob = blob;
    state.draft.photo_url = await blobToDataURL(blob); // preview
    $("#thumb").innerHTML = `<img src="${state.draft.photo_url}" alt="">`;
  };
  const impPhoto = $("#impPhoto");
  if (impPhoto) impPhoto.onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const blob = await compressImage(file, 1600, 0.85);
    const dataUrl = await blobToDataURL(blob);
    runImport({ imageBase64: dataUrl.split(",")[1], mediaType: "image/jpeg" });
  };
  form.onsubmit = async e => {
    e.preventDefault(); syncDraft();
    const btn = form.querySelector("button[type=submit]"); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      const d = state.draft;
      if (!d.name) throw new Error("Please give the recipe a name.");
      let photo = d.photo_url || null;
      if (d._photoBlob) photo = await api.uploadPhoto(d._photoBlob);
      const row = { name: d.name, photo_url: photo, ingredients: d.ingredients, method: d.method, notes: d.notes, servings: d.servings, source_url: d.source_url || null };
      if (existing) row.id = existing.id;
      const saved = await api.saveRecipe(row);
      state.draft = null;
      await loadRecipes();
      toast("Saved ✓");
      go("#/recipe/" + saved.id);
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = "Save recipe"; }
  };
}

async function runImport(payload) {
  const status = $("#impStatus");
  status.innerHTML = '<span class="spinner"></span> Importing… this can take up to 30 seconds.';
  $$("[data-act=importUrl],[data-act=importText]").forEach(b => (b.disabled = true));
  try {
    const r = await api.importRecipe(payload);
    Object.assign(state.draft, {
      name: r.name || state.draft.name, photo_url: r.photo_url || state.draft.photo_url,
      ingredients: r.ingredients?.length ? r.ingredients : state.draft.ingredients,
      method: r.method?.length ? r.method : state.draft.method,
      notes: [state.draft.notes, r.notes].filter(Boolean).join("\n"), servings: r.servings || state.draft.servings,
      source_url: r.source_url || state.draft.source_url
    });
    delete state.draft._photoBlob;
    renderEdit(parseRoute().id);
    $("#impStatus").textContent = "✓ Imported — check it over, then tap Save.";
  } catch (e) {
    status.textContent = "⚠️ " + e.message;
    $$("[data-act=importUrl],[data-act=importText]").forEach(b => (b.disabled = false));
  }
}

/* ---------- views: meal plan ---------- */
function renderPlan() {
  const ws = state.weekStart, today = ymd(new Date());
  const end = addDays(ws, 6);
  const days = [...Array(7)].map((_, i) => addDays(ws, i));
  $("#view").innerHTML = `
    <div class="weeknav">
      <button class="btn small" data-act="week" data-d="-7">‹</button>
      <div class="center"><strong>${dayFmt.format(ws)} – ${dayFmt.format(end)}</strong><br>
        <button class="addslot" data-act="week" data-d="0" style="margin-top:4px">This week</button></div>
      <button class="btn small" data-act="week" data-d="7">›</button>
    </div>
    <button class="btn primary" data-act="weekToShop" style="width:100%;margin-bottom:12px">🛒 Make shopping list for this week</button>
    ${days.map(d => {
      const ds = ymd(d);
      return `<div class="day card ${ds === today ? "today" : ""}"><h4>${dayFmt.format(d)}${ds === today ? " · Today" : ""}</h4>
        ${SLOTS.map(([slot, label]) => {
          const items = state.plan.filter(p => p.plan_date === ds && p.slot === slot);
          return `<div class="slot"><div class="lbl">${label}</div><div class="items">
            ${items.map(p => {
              const r = p.recipe_id ? recipeById(p.recipe_id) : null;
              const name = r ? r.name : p.label || "(deleted recipe)";
              return `<span class="chip">${r ? `<a href="#/recipe/${r.id}">${esc(name)}</a>` : esc(name)}${p.servings ? ` · ${p.servings}p` : ""}
                <button data-act="unplan" data-id="${p.id}" aria-label="Remove">×</button></span>`;
            }).join("")}
            <button class="addslot" data-act="planPick" data-date="${ds}" data-slot="${slot}">+ add</button></div></div>`;
        }).join("")}</div>`;
    }).join("")}`;
}

function planPickerModal({ date, slot, recipeId }) {
  const pre = recipeId ? recipeById(recipeId) : null;
  openModal(`
    <h3>${pre ? "Add to plan" : "Choose a meal"}</h3>
    <div class="row">
      <label class="field grow"><span>Day</span><input type="date" id="ppDate" value="${esc(date || ymd(new Date()))}"></label>
      <label class="field grow"><span>Meal</span><select id="ppSlot">${SLOTS.map(([v, l]) => `<option value="${v}" ${v === (slot || "dinner") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field" style="width:90px"><span>People</span><input type="number" id="ppServ" min="1" max="99" placeholder="—" value="${pre?.servings || ""}"></label>
    </div>
    ${pre ? `<p><strong>${esc(pre.name)}</strong></p>` : `
      <input type="search" id="ppSearch" placeholder="Search recipes…" style="margin-top:10px">
      <ul class="pick-list" id="ppList"></ul>
      <label class="field"><span>…or something else</span><input type="text" id="ppLabel" placeholder="e.g. Leftovers, Eat out, Pizza night"></label>`}
    <div class="row" style="margin-top:14px"><button class="btn grow" data-act="closeModal">Cancel</button>
      <button class="btn primary grow" id="ppSave">Add</button></div>`);
  let chosen = pre?.id || null;
  const list = $("#ppList");
  const draw = () => {
    if (!list) return;
    const q = ($("#ppSearch").value || "").toLowerCase();
    list.innerHTML = state.recipes.filter(r => r.name.toLowerCase().includes(q)).map(r => `
      <li data-id="${r.id}" class="${r.id === chosen ? "on" : ""}">${safeUrl(r.photo_url) ? `<img class="mini" src="${esc(r.photo_url)}" alt="">` : `<span class="mini"></span>`}${esc(r.name)}</li>`).join("")
      || `<li class="muted">No recipes found</li>`;
  };
  if (list) {
    draw();
    $("#ppSearch").oninput = draw;
    list.onclick = e => {
      const li = e.target.closest("li[data-id]"); if (!li) return;
      chosen = li.dataset.id; $("#ppLabel").value = "";
      const r = recipeById(chosen); if (r?.servings && !$("#ppServ").value) $("#ppServ").value = r.servings;
      draw();
    };
  }
  $("#ppSave").onclick = async () => {
    const label = $("#ppLabel")?.value.trim();
    if (!chosen && !label) return toast("Pick a recipe or type a meal.");
    const entry = { plan_date: $("#ppDate").value, slot: $("#ppSlot").value, recipe_id: label ? null : chosen, label: label || null, servings: parseInt($("#ppServ").value) || null };
    try { await api.addPlan(entry); closeModal(); toast("Added to plan ✓"); if (parseRoute().view === "plan") { await loadPlan(); renderPlan(); } }
    catch (e) { toast(e.message); }
  };
}

/* ---------- shopping list ---------- */
function shopChecklistModal(title, combined) {
  if (!combined.length) return toast("No ingredients to add.");
  openModal(`
    <h3>${esc(title)}</h3>
    <p class="hint">Untick anything you already have.</p>
    <div class="checklist">${combined.map((c, i) => `
      <label><input type="checkbox" data-i="${i}" checked><span>${esc(c.text)}${c.recipes.length > 1 ? `<span class="src">for ${esc(c.recipes.join(", "))}</span>` : ""}</span></label>`).join("")}</div>
    <div class="row" style="margin-top:14px"><button class="btn grow" data-act="closeModal">Cancel</button>
      <button class="btn primary grow" id="addSel">Add to list</button></div>`);
  $("#addSel").onclick = async () => {
    const picked = $$(".checklist input:checked").map(cb => combined[+cb.dataset.i]);
    try { const n = await addToShopping(picked.map(c => ({ text: c.text, recipe_name: c.recipes.join(", ") || null }))); closeModal(); toast(`${n} item${n === 1 ? "" : "s"} added ✓`); }
    catch (e) { toast(e.message); }
  };
}

// Adds items, merging with matching unticked items already on the list ("2 onions" + "1 onion" → "3 onions")
async function addToShopping(items) {
  await loadShopping();
  const open = state.shopping.filter(s => !s.checked);
  const fresh = [];
  for (const it of items) {
    const k = itemKey(it.text);
    const match = open.find(s => itemKey(s.text) === k);
    if (match) {
      const merged = mergeLines(match.text, it.text);
      const recipeName = [...new Set([match.recipe_name, it.recipe_name].filter(Boolean).join(", ").split(", "))].filter(Boolean).join(", ") || null;
      await api.updateShopping(match.id, { text: merged, recipe_name: recipeName });
      match.text = merged;
    } else fresh.push({ text: it.text, recipe_name: it.recipe_name || null });
  }
  if (fresh.length) await api.addShopping(fresh);
  await loadShopping();
  if (parseRoute().view === "shop") renderShop();
  return items.length;
}

function renderShop() {
  const open = state.shopping.filter(s => !s.checked), done = state.shopping.filter(s => s.checked);
  const li = s => `<li class="${s.checked ? "done" : ""}"><button class="chk" data-act="toggleItem" data-id="${s.id}" aria-label="Tick"></button>
    <span class="txt" data-act="toggleItem" data-id="${s.id}">${esc(s.text)}${s.recipe_name ? `<span class="src">${esc(s.recipe_name)}</span>` : ""}</span>
    <button class="del" data-act="delItem" data-id="${s.id}" aria-label="Delete">×</button></li>`;
  $("#view").innerHTML = `
    <form class="additem" id="addItem"><input type="text" id="newItem" placeholder="Add an item…" autocomplete="off"><button class="btn primary">Add</button></form>
    ${open.length ? `<ul class="list card">${open.map(li).join("")}</ul>` : `<p class="muted center pad">List is empty. Add items, or use 🛒 on a recipe or the meal plan.</p>`}
    ${done.length ? `<div class="subhead">In the cart (${done.length})</div><ul class="list card">${done.map(li).join("")}</ul>` : ""}
    <div class="actions">
      ${open.length ? `<button class="btn" data-act="shareList">📤 Share list</button>` : ""}
      ${done.length ? `<button class="btn" data-act="clearDone">Clear ticked</button>` : ""}
      ${state.shopping.length ? `<button class="btn danger" data-act="clearAll">Clear all</button>` : ""}
    </div>`;
  $("#addItem").onsubmit = async e => {
    e.preventDefault();
    const v = $("#newItem").value.trim(); if (!v) return;
    try { await addToShopping([{ text: v }]); $("#newItem").focus(); } catch (err) { toast(err.message); }
  };
}

/* ---------- settings ---------- */
function settingsModal() {
  openModal(`
    <h3>Settings</h3>
    ${MODE === "local"
      ? `<p>You're in <strong>demo mode</strong>: everything is saved on this device only. Follow <strong>SETUP.md</strong> to share with family and switch on importing.</p>`
      : `<p>Signed in as <strong>${esc(state.user?.email)}</strong>.</p><p class="hint">Everyone signed in sees the same recipes, plan and shopping list.</p>`}
    <div class="row" style="margin-top:14px">
      <button class="btn grow" data-act="closeModal">Close</button>
      ${MODE === "cloud" ? `<button class="btn danger grow" data-act="signOut">Sign out</button>` : ""}
    </div>`);
}

/* ---------- actions (one click handler for the whole app) ---------- */
const actions = {
  closeModal,
  settings: settingsModal,
  newRecipe: () => { state.draft = null; go("#/edit/new"); },
  removePhoto: () => { state.draft.photo_url = ""; delete state.draft._photoBlob; renderEdit(parseRoute().id); },
  impTab: el => {
    $$(".tabs-mini button").forEach(b => b.classList.toggle("on", b === el));
    $$("[data-imp]").forEach(p => (p.hidden = p.dataset.imp !== el.dataset.t));
  },
  importUrl: () => { const u = $("#impUrl").value.trim(); if (!u) return toast("Paste a link first."); runImport({ url: u }); },
  importText: () => { const t = $("#impText").value.trim(); if (!t) return toast("Paste some text first."); runImport({ text: t }); },
  scale: el => {
    const r = recipeById(el.dataset.id); const cur = state.scale[r.id] || r.servings;
    state.scale[r.id] = Math.max(1, cur + +el.dataset.d); renderRecipe(r.id);
  },
  recipeToShop: el => {
    const r = recipeById(el.dataset.id);
    const factor = r.servings && state.scale[r.id] ? state.scale[r.id] / r.servings : 1;
    shopChecklistModal(`Shopping for ${r.name}`, combineIngredients((r.ingredients || []).map(line => ({ line, factor, recipe: r.name }))));
  },
  recipeToPlan: el => planPickerModal({ recipeId: el.dataset.id }),
  deleteRecipe: async el => {
    const r = recipeById(el.dataset.id);
    if (!confirm(`Delete “${r.name}” for everyone?`)) return;
    try { await api.deleteRecipe(r.id); await loadRecipes(); toast("Deleted"); go("#/recipes"); } catch (e) { toast(e.message); }
  },
  week: async el => {
    const d = +el.dataset.d; state.weekStart = d === 0 ? startOfWeek(new Date()) : addDays(state.weekStart, d);
    await loadPlan(); renderPlan();
  },
  planPick: el => planPickerModal({ date: el.dataset.date, slot: el.dataset.slot }),
  unplan: async el => { try { await api.deletePlan(el.dataset.id); await loadPlan(); renderPlan(); } catch (e) { toast(e.message); } },
  weekToShop: () => {
    const entries = [];
    for (const p of state.plan) {
      const r = p.recipe_id && recipeById(p.recipe_id); if (!r) continue;
      const factor = p.servings && r.servings ? p.servings / r.servings : 1;
      (r.ingredients || []).forEach(line => entries.push({ line, factor, recipe: r.name }));
    }
    if (!entries.length) return toast("Add some recipes to this week first.");
    shopChecklistModal("Shopping for this week", combineIngredients(entries));
  },
  toggleItem: async el => {
    const s = state.shopping.find(x => x.id === el.dataset.id); if (!s) return;
    s.checked = !s.checked; renderShop();
    try { await api.updateShopping(s.id, { checked: s.checked }); } catch (e) { toast(e.message); }
  },
  delItem: async el => { try { await api.deleteShopping([el.dataset.id]); await loadShopping(); renderShop(); } catch (e) { toast(e.message); } },
  clearDone: async () => { try { await api.deleteShopping(state.shopping.filter(s => s.checked).map(s => s.id)); await loadShopping(); renderShop(); } catch (e) { toast(e.message); } },
  clearAll: async () => {
    if (!confirm("Clear the whole shopping list for everyone?")) return;
    try { await api.deleteShopping(state.shopping.map(s => s.id)); await loadShopping(); renderShop(); } catch (e) { toast(e.message); }
  },
  shareList: async () => {
    const text = "Shopping list:\n" + state.shopping.filter(s => !s.checked).map(s => "• " + s.text).join("\n");
    try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); } } catch {}
  },
  signOut: async () => { closeModal(); await sb.auth.signOut(); }
};
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (!el || !actions[el.dataset.act]) return;
  e.preventDefault();
  actions[el.dataset.act](el, e);
});
window.addEventListener("hashchange", () => { closeModal(); render(); });

/* ---------- live updates between family members ---------- */
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const { view } = parseRoute();
    if (view === "edit" || !$("#modal").hidden) return; // never interrupt typing
    await loadRecipes();
    if (view === "plan") { await loadPlan(); renderPlan(); }
    else if (view === "shop") { await loadShopping(); renderShop(); }
    else if (view === "recipe") renderRecipe(parseRoute().id);
    else renderRecipes();
  }, 400);
}
let channel = null;
function subscribeLive() {
  if (channel) return;
  channel = sb.channel("family")
    .on("postgres_changes", { event: "*", schema: "public", table: "recipes" }, scheduleRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "meal_plan" }, scheduleRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "shopping_items" }, scheduleRefresh)
    .subscribe();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && (MODE === "local" || state.user)) scheduleRefresh(); });

/* ---------- start ---------- */
async function afterSignIn() {
  await loadRecipes();
  // Share-sheet shortcut support: ?import=<link>
  const params = new URLSearchParams(location.search);
  const incoming = params.get("import");
  if (incoming) {
    history.replaceState(null, "", location.pathname + "#/edit/new");
    state.draft = null;
    await render();
    const box = $("#impUrl");
    if (box) { box.value = incoming; runImport({ url: incoming }); }
    return;
  }
  render();
}

async function start() {
  $("#appTitle").textContent = CFG.APP_NAME || "Family Recipes";
  document.title = CFG.APP_NAME || "Family Recipes";
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  if (MODE === "local") { state.user = { email: "demo" }; return afterSignIn(); }
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  // Fires once on load (INITIAL_SESSION) and again on sign-in / sign-out.
  // Work is deferred with setTimeout: Supabase advises against awaiting its calls inside this callback.
  sb.auth.onAuthStateChange((_evt, session) => {
    const was = state.user?.id; state.user = session?.user || null;
    if (state.user && was !== state.user.id) setTimeout(() => { subscribeLive(); afterSignIn(); }, 0);
    else if (!state.user) setTimeout(() => { if (channel) sb.removeChannel(channel); channel = null; render(); }, 0);
  });
}
start().catch(e => { $("#view").innerHTML = `<p class="pad center">Couldn't start: ${esc(e.message)}</p>`; });
