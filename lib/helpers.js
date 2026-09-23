import { shopFromUrl } from "./shops";
export { shopFromUrl };

export const DEFAULT_SECTIONS = ["Furniture", "Appliances", "Storage", "Decor", "Miscellaneous"];

const KEYWORDS = [
  ["Appliances", /\b(fridge|freezer|oven|hob|microwave|kettle|toaster|dishwasher|washing machine|washer|dryer|vacuum|hoover|coffee machine|espresso|blender|air ?fryer|mixer|extractor|tv|television|soundbar|speaker|fan|heater|dehumidifier|humidifier|iron|range cooker|cooker|purifier)\b/i],
  ["Decor", /\b(vase|rug|cushion|throw|lamp|lighting|light|pendant|chandelier|sconce|mirror|art|artwork|print|frame|candle|plant|planter|curtain|curtains|blind|sculpture|bowl|tray|poster|wallpaper|ornament|diffuser|bedding|duvet|pillowcase)\b/i],
  ["Storage", /\b(basket|storage|box|boxes|shelf|shelves|shelving|organiser|organizer|hook|hooks|rack|drawer organiser|bin|hamper|crate|trunk|caddy|jar|jars)\b/i],
  ["Furniture", /\b(sofa|couch|chair|chairs|armchair|table|desk|bed|bench|stool|stools|sideboard|wardrobe|dresser|chest of drawers|bookcase|cabinet|headboard|mattress|ottoman|console|footstool|daybed|bedside|nightstand|dining)\b/i],
];

export function guessSection(text, sections) {
  const available = sections && sections.length ? sections : DEFAULT_SECTIONS;
  for (const [section, re] of KEYWORDS) {
    if (re.test(text || "") && available.includes(section)) return section;
  }
  return available.includes("Miscellaneous") ? "Miscellaneous" : available[available.length - 1];
}

export function titleFromUrl(url) {
  try {
    const segs = new URL(url).pathname.split("/").map((s) => decodeURIComponent(s)).filter(Boolean);
    let best = "", score = 0;
    for (const s of segs) {
      const clean = s.replace(/\.(html?|aspx?|php)$/i, "");
      if (!/[a-z]/i.test(clean) || /^(dp|p|product|products|item|items|gp|en|en-gb|en-us|uk|us|shop|catalog|c)$/i.test(clean)) continue;
      const words = clean.split(/[-_+ ]+/).filter((w) => /[a-z]/i.test(w) && !/^\d+$/.test(w) && !/^[A-Z0-9]{8,}$/.test(w));
      if (words.length > score) { score = words.length; best = words.join(" "); }
    }
    if (!best) return "";
    best = best.charAt(0).toUpperCase() + best.slice(1).toLowerCase();
    return best.length > 70 ? best.slice(0, 70) + "…" : best;
  } catch {
    return "";
  }
}

export function normalizeUrl(u) {
  u = (u || "").trim().replace(/[)\],.]+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).toString(); } catch { return null; }
}

export function findUrls(text) {
  const matches = (text || "").match(/https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/gi) || [];
  return [...new Set(matches.map(normalizeUrl).filter(Boolean))];
}

const formatters = {};
export function money(n, currency = "GBP") {
  const c = (currency || "GBP").toUpperCase();
  try {
    formatters[c] ||= new Intl.NumberFormat({ USD: "en-US", EUR: "en-IE", GBP: "en-GB" }[c] || "en-US", { style: "currency", currency: c, minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return formatters[c].format(Math.round((Number(n) || 0) * 100) / 100);
  } catch {
    return `${c} ${(Number(n) || 0).toFixed(2)}`;
  }
}

export const lineTotal = (it) => (Number(it.price) || 0) * Math.max(1, Number(it.qty) || 1);

export function totals(items) {
  let included = 0, all = 0, count = 0, includedCount = 0;
  for (const it of items) {
    const t = lineTotal(it);
    all += t; count++;
    if (it.included !== false) { included += t; includedCount++; }
  }
  return { included, all, count, includedCount };
}
