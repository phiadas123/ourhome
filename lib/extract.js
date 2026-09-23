import * as cheerio from "cheerio";
import { shopFromUrl } from "./shops";
export { shopFromUrl };

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const HEADERS = {
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "upgrade-insecure-requests": "1",
  "cache-control": "no-cache",
};

// Refuse links to private or local addresses.
export function isSafePublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\[?(::1|fc|fd|fe80)/i.test(h)) return false;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}

export function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  let s = String(v).replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    s = s.slice(lastComma + 1).length <= 2 ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const hasType = (node, type) => asArray(node && node["@type"]).some((t) => String(t).toLowerCase() === type.toLowerCase());

/* Pages often list "you may also like" products too. Only products that are the page's
   main subject count; anything inside a list or "related" block is ignored. */
function mainProducts(node, out = [], nested = false) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => mainProducts(n, out, nested)); return out; }
  if (!nested && (hasType(node, "Product") || hasType(node, "ProductGroup"))) out.push(node);
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage"]) if (node[key]) mainProducts(node[key], out, nested);
  return out;
}

function imageFrom(x) {
  for (const i of asArray(x)) {
    if (typeof i === "string" && i && !isBadImage(i)) return i;
    if (i && typeof i === "object") {
      const u = i.url || i.contentUrl || i["@id"];
      if (typeof u === "string" && u && !isBadImage(u)) return u;
    }
  }
  return null;
}

function offerFrom(offers, variantId) {
  const list = asArray(offers).flatMap((o) => (o && o.offers ? asArray(o.offers) : [o]));
  const pick = (variantId && list.find((o) => o && String(o.url || o.sku || "").includes(variantId))) || null;
  for (const o of pick ? [pick, ...list] : list) {
    if (!o || typeof o !== "object") continue;
    const spec = asArray(o.priceSpecification)[0];
    const price = parsePrice(o.price) ?? parsePrice(o.lowPrice) ?? parsePrice(spec?.price);
    if (price != null) return { price, currency: o.priceCurrency || spec?.priceCurrency || null };
  }
  return null;
}

function isBadImage(src) {
  if (!src) return true;
  const s = src.toLowerCase();
  return /\.(svg|ico)(\?|$)/.test(s) || /(logo|favicon|sprite|placeholder|no[-_]?image|default[-_]?(og|share|image)|social[-_]?share|apple-touch-icon|blank\.gif)/.test(s);
}

function absolute(src, base) {
  if (!src) return null;
  try { return new URL(String(src).trim(), base).toString(); } catch { return null; }
}

const BLOCKED = /(access denied|attention required|just a moment|are you a (robot|human)|captcha|robot check|pardon our interruption|request unsuccessful|forbidden|verify you are human|page not found|404|something went wrong|sorry, we just need to make sure)/i;

function tidyTitle(t, shop) {
  if (!t) return "";
  let s = String(t).replace(/\s+/g, " ").trim();
  // Drop " | Shop name" style endings.
  const parts = s.split(/\s+[|–—]\s+|\s+-\s+(?=[^-]*$)/);
  if (parts.length > 1) {
    const last = parts[parts.length - 1].toLowerCase();
    const shopWord = (shop || "").toLowerCase().split(" ")[0];
    if ((shopWord && last.includes(shopWord)) || last.length < 25) s = parts.slice(0, -1).join(" | ");
  }
  s = s.replace(/^buy\s+/i, "");
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

export function extractFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const page = new URL(pageUrl);
  const variantId = page.searchParams.get("variant") || page.searchParams.get("sku") || null;
  const meta = (...names) => {
    for (const n of names) {
      const v = $(`meta[property="${n}"]`).attr("content") || $(`meta[name="${n}"]`).attr("content") || $(`meta[itemprop="${n}"]`).attr("content");
      if (v && v.trim()) return v.trim();
    }
    return null;
  };

  const pageTitle = $("title").first().text().trim();
  const blocked = BLOCKED.test(pageTitle) && !$('meta[property="og:type"][content*="product"]').length;

  // 1. Structured product data (most accurate).
  let products = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { products.push(...mainProducts(JSON.parse($(el).contents().text()))); } catch { /* broken JSON */ }
  });
  const samePage = (p) => {
    const u = p.url || p["@id"];
    if (!u) return false;
    try { return new URL(u, pageUrl).pathname.replace(/\/$/, "") === page.pathname.replace(/\/$/, ""); } catch { return false; }
  };
  const product = products.find(samePage) || products.find((p) => p.offers && p.name) || products.find((p) => p.name) || null;
  const offer = product ? offerFrom(product.offers, variantId) || offerFrom(asArray(product.hasVariant).map((v) => v.offers), variantId) : null;

  // 2. Shop-specific layouts.
  let special = {};
  if (/(^|\.)amazon\./.test(page.hostname)) {
    let dyn = null;
    try { dyn = Object.keys(JSON.parse($("#landingImage").attr("data-a-dynamic-image") || "{}"))[0]; } catch {}
    special = {
      title: $("#productTitle").text().trim(),
      image: $("#landingImage").attr("data-old-hires") || dyn || $("#imgTagWrapperId img").attr("src"),
      price: parsePrice($("#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, .priceToPay .a-offscreen, #price_inside_buybox").first().text()),
    };
  }

  // 3. Sharing tags that shops add for social media.
  const shop = meta("og:site_name") || shopFromUrl(pageUrl);
  const ogImage = [meta("og:image:secure_url"), meta("og:image"), meta("twitter:image"), meta("twitter:image:src")].find((i) => i && !isBadImage(i));

  const title = tidyTitle(
    special.title || (product && product.name) || meta("og:title", "twitter:title") || $("h1").first().text() || pageTitle,
    shop
  );
  const price =
    special.price ?? offer?.price ??
    parsePrice(meta("product:price:amount", "og:price:amount", "product:sale_price:amount")) ??
    parsePrice($('[itemprop="price"]').first().attr("content") || $('[itemprop="price"]').first().text()) ?? null;
  const currency =
    offer?.currency || meta("product:price:currency", "og:price:currency", "priceCurrency") ||
    $('[itemprop="priceCurrency"]').first().attr("content") || null;
  const image = absolute(special.image || imageFrom(product && product.image) || ogImage || $('link[rel="image_src"]').attr("href"), pageUrl);

  return {
    blocked,
    isShopify: /cdn\.shopify\.com|Shopify\.theme|shopify-section/.test(html),
    title, shop, image, price,
    currency: currency ? String(currency).toUpperCase().slice(0, 3) : null,
    shopifyCurrency: (html.match(/Shopify\.currency\s*=\s*\{[^}]*"active"\s*:\s*"([A-Z]{3})"/) || [])[1] || null,
  };
}

/* Shopify shops (many smaller homeware brands) publish each product's exact details at <link>.js */
async function viaShopify(pageUrl, currencyHint) {
  try {
    const u = new URL(pageUrl);
    if (!/\/products\/[^/]+/.test(u.pathname)) return null;
    const path = u.pathname.replace(/\/$/, "").replace(/\.(js|json)$/, "");
    const r = await fetch(`${u.origin}${path}.js`, { headers: { ...HEADERS, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const p = await r.json();
    const variantId = u.searchParams.get("variant");
    const v = (variantId && p.variants?.find((x) => String(x.id) === variantId)) || p.variants?.find((x) => x.available) || p.variants?.[0];
    const pence = v?.price ?? p.price;
    const img = v?.featured_image?.src || p.featured_image || p.images?.[0];
    return {
      title: p.title || "",
      image: img ? absolute(img.startsWith("//") ? "https:" + img : img, pageUrl) : null,
      price: typeof pence === "number" ? Math.round(pence) / 100 : null,
      currency: currencyHint || null,
    };
  } catch { return null; }
}

async function viaMicrolink(url) {
  try {
    const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status !== "success" || BLOCKED.test(j.data?.title || "")) return null;
    const img = j.data?.image?.url;
    return { title: j.data?.title || "", shop: j.data?.publisher || null, image: img && !isBadImage(img) ? img : null };
  } catch { return null; }
}

export async function readProduct(url) {
  let page = null;
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(10000) });
    if ((res.headers.get("content-type") || "").includes("html")) {
      const html = (await res.text()).slice(0, 4_000_000);
      page = extractFromHtml(html, res.url || url);
      if (!res.ok && !page.price) page.blocked = true;
    }
  } catch { /* blocked or timed out */ }

  let result = page && !page.blocked ? { title: page.title, shop: page.shop, image: page.image, price: page.price, currency: page.currency } : null;

  // Shopify: exact product details, including the chosen colour or size.
  if (!page || page.isShopify || page.blocked) {
    const s = await viaShopify(url, page?.currency || page?.shopifyCurrency);
    if (s) {
      result = {
        title: s.title || result?.title || "",
        shop: result?.shop || page?.shop || shopFromUrl(url),
        image: s.image || result?.image || null,
        price: s.price ?? result?.price ?? null,
        currency: s.currency || result?.currency || null,
      };
    }
  }

  // Last resort when the shop blocks direct visits: a backup reader for the photo and name.
  if (!result || !result.image || !result.title) {
    const m = await viaMicrolink(url);
    if (m) {
      result = {
        title: result?.title || m.title,
        shop: result?.shop || m.shop || shopFromUrl(url),
        image: result?.image || m.image,
        price: result?.price ?? null,
        currency: result?.currency ?? null,
      };
    }
  }

  return result || { title: "", shop: shopFromUrl(url), image: null, price: null, currency: null };
}
