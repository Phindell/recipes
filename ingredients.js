// Ingredient parsing, scaling and combining (used for servings + shopping list)

const FRAC = { "¼":"1/4","½":"1/2","¾":"3/4","⅓":"1/3","⅔":"2/3","⅛":"1/8","⅜":"3/8","⅝":"5/8","⅞":"7/8","⅕":"1/5","⅙":"1/6" };
const UNITS = {
  cup:["cup","cups","c"], tbsp:["tbsp","tbs","tbl","tbsps","tablespoon","tablespoons"],
  tsp:["tsp","tsps","teaspoon","teaspoons"], oz:["oz","ounce","ounces"], lb:["lb","lbs","pound","pounds"],
  g:["g","gr","gram","grams"], kg:["kg","kgs","kilogram","kilograms"], ml:["ml","milliliter","milliliters","millilitre","millilitres"],
  l:["l","liter","liters","litre","litres"], clove:["clove","cloves"], can:["can","cans","tin","tins"],
  pinch:["pinch","pinches"], slice:["slice","slices"], bunch:["bunch","bunches"], stick:["stick","sticks"],
  package:["package","packages","pkg","packet","packets"], handful:["handful","handfuls"]
};
const PLURAL = { cup:"cups", clove:"cloves", can:"cans", pinch:"pinches", slice:"slices", bunch:"bunches", stick:"sticks", package:"packages", handful:"handfuls" };
const UNIT_LOOKUP = {};
for (const [k, arr] of Object.entries(UNITS)) arr.forEach(a => (UNIT_LOOKUP[a] = k));

const NUM = "(\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?|\\.\\d+)";
const LEAD = new RegExp("^" + NUM + "(?:\\s*(?:-|–|to)\\s*" + NUM + ")?\\s*(.*)$", "i");

function toNum(s) {
  s = s.trim();
  if (/^\d+\s+\d+\/\d+$/.test(s)) { const [w, f] = s.split(/\s+/); return +w + toNum(f); }
  if (/^\d+\/\d+$/.test(s)) { const [a, b] = s.split("/"); return +b ? +a / +b : NaN; }
  return parseFloat(s);
}

function normalise(line) {
  return String(line ?? "")
    .replace(/(\d)?\s*([¼½¾⅓⅔⅛⅜⅝⅞⅕⅙])/g, (m, d, f) => (d ? d + " " : "") + FRAC[f])
    .replace(/\s+/g, " ").trim();
}

export function isHeading(line) {
  const s = String(line ?? "").trim();
  return !s || (/:$/.test(s) && s.length < 50 && !/\d/.test(s));
}

export function parseIngredient(line) {
  const s = normalise(line);
  const m = s.match(LEAD);
  if (!m) return { qty: null, unit: "", name: s, afterQty: s };
  let qty = toNum(m[1]);
  if (m[2]) qty = toNum(m[2]);                 // ranges like 2-3 → buy the upper amount
  if (!isFinite(qty)) return { qty: null, unit: "", name: s, afterQty: s };
  let rest = m[3].trim(), unit = "";
  const um = rest.match(/^([A-Za-z]+)\.?(?:\s+|$)(.*)$/);
  if (um && UNIT_LOOKUP[um[1].toLowerCase()]) { unit = UNIT_LOOKUP[um[1].toLowerCase()]; rest = um[2].trim(); }
  rest = rest.replace(/^of\s+/i, "");
  return { qty, unit, name: rest, afterQty: m[3].trim() };
}

export function formatQty(n) {
  if (n == null || !isFinite(n)) return "";
  if (n >= 10) return String(Math.round(n));
  const whole = Math.floor(n), frac = n - whole;
  const opts = [[0,""],[1/8,"1/8"],[1/4,"1/4"],[1/3,"1/3"],[3/8,"3/8"],[1/2,"1/2"],[5/8,"5/8"],[2/3,"2/3"],[3/4,"3/4"],[7/8,"7/8"],[1,""]];
  let best = opts[0];
  for (const o of opts) if (Math.abs(o[0] - frac) < Math.abs(best[0] - frac)) best = o;
  const w = best[0] === 1 ? whole + 1 : whole;
  if (!best[1]) return String(w || (n > 0 ? "1/8" : "0"));
  return w ? `${w} ${best[1]}` : best[1];
}

export function scaleLine(line, factor) {
  if (!factor || factor === 1 || isHeading(line)) return line;
  const p = parseIngredient(line);
  if (p.qty == null) return line;
  return `${formatQty(p.qty * factor)} ${p.afterQty}`.trim();
}

function cleanName(name) {
  return name.split(",")[0].trim() || name.trim();
}
export function nameKey(name) {
  return cleanName(name).toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(fresh|freshly|large|medium|small|chopped|minced|diced|sliced|grated|ground|finely|roughly|about|approx\.?)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
    .split(" ").map(w => w.length > 3 ? w.replace(/(oes|es|s)$/, m => (m === "oes" ? "o" : "")) : w).join(" ");
}
function unitLabel(unit, qty) { return qty > 1 && PLURAL[unit] ? PLURAL[unit] : unit; }

function fmt(item) {
  return [item.qty != null ? formatQty(item.qty) : "", item.unit ? unitLabel(item.unit, item.qty) : "", item.name].filter(Boolean).join(" ");
}

/** entries: [{ line, factor, recipe }] → [{ text, key, recipes }] combined by ingredient + unit */
export function combineIngredients(entries) {
  const map = new Map();
  for (const e of entries) {
    if (isHeading(e.line)) continue;
    const p = parseIngredient(e.line);
    const name = cleanName(p.name);
    if (!name) continue;
    const key = p.unit + "|" + nameKey(name);
    const q = p.qty != null ? p.qty * (e.factor || 1) : null;
    const hit = map.get(key);
    if (hit) {
      if (q != null) hit.qty = (hit.qty || 0) + q;
      if (e.recipe) hit.recipes.add(e.recipe);
      if (name.length > hit.name.length && name.toLowerCase().startsWith(hit.name.toLowerCase())) hit.name = name; // prefer "onions" over "onion"
    } else {
      map.set(key, { qty: q, unit: p.unit, name, recipes: new Set(e.recipe ? [e.recipe] : []) });
    }
  }
  return [...map.entries()].map(([key, x]) => ({ key, text: fmt(x), recipes: [...x.recipes] }));
}

export function itemKey(text) {
  const p = parseIngredient(text);
  return p.unit + "|" + nameKey(p.name);
}
/** Add two shopping-list lines that share a key, e.g. "2 onions" + "1 onion" → "3 onions" */
export function mergeLines(a, b) {
  const pa = parseIngredient(a), pb = parseIngredient(b);
  if (pa.qty == null || pb.qty == null) return a;
  const na = cleanName(pa.name), nb = cleanName(pb.name);
  return fmt({ qty: pa.qty + pb.qty, unit: pa.unit, name: nb.length > na.length && nb.toLowerCase().startsWith(na.toLowerCase()) ? nb : na });
}
