import * as cheerio from "cheerio";
import { shopFromUrl } from "./shops";
export { shopFromUrl };

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

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
  if (typeof v === "number") return isFinite(v) && v > 0 ? v : null;
  let s = String(v).replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // "1.299,00" or "299,00"
    s = s.slice(lastComma + 1).length <= 2 ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function asArray(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }

function hasType(node, type) {
  return asArray(node && node["@type"]).some((t) => String(t).toLowerCase() === type.toLowerCase());
}

function findProducts(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => findProducts(n, out)); return out; }
  if (hasType(node, "Product") || hasType(node, "ProductGroup")) out.push(node);
  for (const key of ["@graph", "mainEntity", "itemListElement", "hasVariant", "item"]) {
    if (node[key]) findProducts(node[key], out);
  }
  return out;
}

function imageFrom(x) {
  for (const i of asArray(x)) {
    if (typeof i === "string" && i) return i;
    if (i && typeof i === "object") {
      const u = i.url || i.contentUrl || i["@id"];
      if (typeof u === "string" && u) return u;
    }
  }
  return null;
}

function offerFrom(offers) {
  for (const o of asArray(offers)) {
    if (!o || typeof o !== "object") continue;
    const price =
      parsePrice(o.price) ??
      parsePrice(o.lowPrice) ??
      parsePrice(asArray(o.priceSpecification)[0]?.price) ??
      (o.offers ? offerFrom(o.offers)?.price : null);
    if (price != null) {
      return {
        price,
        currency: o.priceCurrency || asArray(o.priceSpecification)[0]?.priceCurrency || null,
      };
    }
  }
  return null;
}

function absolute(src, base) {
  if (!src) return null;
  try { return new URL(src.trim(), base).toString(); } catch { return null; }
}

function cleanTitle(t, shop) {
  if (!t) return "";
  let s = t.replace(/\s+/g, " ").trim();
  // Drop " | Shop name" and similar endings.
  s = s.replace(/\s*[|–—-]\s*(buy|shop)?\s*[^|–—-]{0,40}$/i, (m) =>
    shop && m.toLowerCase().includes(shop.toLowerCase().split(" ")[0]) ? "" : m
  );
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

export function extractFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const meta = (...names) => {
    for (const n of names) {
      const v =
        $(`meta[property="${n}"]`).attr("content") ||
        $(`meta[name="${n}"]`).attr("content") ||
        $(`meta[itemprop="${n}"]`).attr("content");
      if (v && v.trim()) return v.trim();
    }
    return null;
  };

  let product = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return;
    try {
      const data = JSON.parse($(el).contents().text());
      const found = findProducts(data);
      product = found.find((p) => p.offers) || found[0] || null;
    } catch { /* ignore broken JSON */ }
  });

  const offer = product ? offerFrom(product.offers) || (product.hasVariant ? offerFrom(asArray(product.hasVariant).map((v) => v.offers).flat()) : null) : null;

  const shop = meta("og:site_name") || shopFromUrl(pageUrl);
  const rawTitle =
    (product && product.name) || meta("og:title", "twitter:title") || $("title").first().text();

  const price =
    offer?.price ??
    parsePrice(meta("product:price:amount", "og:price:amount", "product:sale_price:amount")) ??
    parsePrice($('[itemprop="price"]').first().attr("content")) ??
    null;

  const currency =
    offer?.currency ||
    meta("product:price:currency", "og:price:currency", "priceCurrency") ||
    $('[itemprop="priceCurrency"]').first().attr("content") ||
    null;

  const image = absolute(
    imageFrom(product && product.image) ||
      meta("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src") ||
      $('link[rel="image_src"]').attr("href"),
    pageUrl
  );

  return {
    title: cleanTitle(rawTitle, shop),
    shop,
    image,
    price,
    currency: currency ? String(currency).toUpperCase().slice(0, 3) : null,
  };
}

async function viaMicrolink(url) {
  try {
    const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status !== "success") return null;
    return {
      title: j.data?.title || "",
      shop: j.data?.publisher || shopFromUrl(url),
      image: j.data?.image?.url || null,
      price: null,
      currency: null,
    };
  } catch {
    return null;
  }
}

export async function readProduct(url) {
  let result = null;
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok && (res.headers.get("content-type") || "").includes("html")) {
      const html = (await res.text()).slice(0, 3_000_000);
      result = extractFromHtml(html, res.url || url);
    }
  } catch {
    /* blocked or timed out; try the backup below */
  }

  // Some shops block direct visits. A backup reader can usually still get the photo and name.
  if (!result || (!result.image && !result.price)) {
    const backup = await viaMicrolink(url);
    if (backup) {
      result = {
        title: result?.title || backup.title,
        shop: result?.shop || backup.shop,
        image: result?.image || backup.image,
        price: result?.price ?? null,
        currency: result?.currency ?? null,
      };
    }
  }

  return result || { title: "", shop: shopFromUrl(url), image: null, price: null, currency: null };
}
