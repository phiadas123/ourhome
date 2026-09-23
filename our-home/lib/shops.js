const SHOPS = {
  ikea: "IKEA", johnlewis: "John Lewis", hm: "H&M", zarahome: "Zara Home", ao: "AO",
  maisonsdumonde: "Maisons du Monde", swooneditions: "Swoon", cultfurniture: "Cult Furniture",
  loaf: "Loaf", dunelm: "Dunelm", wayfair: "Wayfair", amazon: "Amazon", argos: "Argos",
  currys: "Currys", etsy: "Etsy", habitat: "Habitat", made: "Made", next: "Next",
  westelm: "West Elm", potterybarn: "Pottery Barn", homebase: "Homebase", diy: "B&Q",
  marksandspencer: "M&S", laredoute: "La Redoute", oliverbonas: "Oliver Bonas", heals: "Heal's",
  sofa: "Sofa.com", dusk: "Dusk", lakeland: "Lakeland", ebay: "eBay", soho: "Soho Home",
  sohohome: "Soho Home", anthropologie: "Anthropologie", liberty: "Liberty", selfridges: "Selfridges",
};

export function shopFromUrl(url) {
  try {
    let host = new URL(url).hostname.replace(/^www\d?\./, "");
    if (host.split(".").length > 2) host = host.replace(/^(m|uk|shop|store)\./, "");
    const key = host.split(".")[0];
    return SHOPS[key] || SHOPS[key.replace(/-/g, "")] || key.charAt(0).toUpperCase() + key.slice(1);
  } catch {
    return "";
  }
}

