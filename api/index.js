// ============================================================
//  Stremio Addon – Anime Catalog (via AniList API)
//  Vercel Serverless Function — v1.2 diagnostic fix
// ============================================================

const MANIFEST = {
  id: "community.animecrunchyroll.catalog",
  version: "1.2.0",
  name: "Crunchyroll Anime",
  description: "Katalog anime – tytuły, okładki i odcinki.",
  logo: "https://www.crunchyroll.com/build/assets/img/favicons/favicon-96x96.png",
  resources: [
    "catalog",
    {
      name: "meta",
      types: ["series"],
      idPrefixes: ["al:"],
    },
  ],
  types: ["series"],
  idPrefixes: ["al:"],
  catalogs: [
    {
      type: "series",
      id: "anime-popular",
      name: "🔥 Popularne Anime",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip",   isRequired: false },
      ],
    },
    {
      type: "series",
      id: "anime-seasonal",
      name: "📅 Sezonowe Anime",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "anime-toprated",
      name: "⭐ Najwyżej Oceniane",
      extra: [{ name: "skip", isRequired: false }],
    },
  ],
  behaviorHints: { adult: false },
};

// ── AniList ──────────────────────────────────────────────────
const ANILIST_URL = "https://graphql.anilist.co";

async function anilistQuery(query, variables) {
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

const FIELDS = `
  id
  title { romaji english native }
  coverImage { large extraLarge }
  bannerImage
  genres
  startDate { year month day }
  averageScore
  episodes
  status
`;

// ── toMeta — ID prefix zmieniony na "al:" ───────────────────
function toMeta(media) {
  return {
    id: `al:${media.id}`,
    type: "series",
    name: media.title.english || media.title.romaji || media.title.native || "Unknown",
    poster: media.coverImage?.extraLarge || media.coverImage?.large || null,
    posterShape: "poster",
    background: media.bannerImage || null,
    genres: media.genres || [],
    releaseInfo: media.startDate?.year?.toString() || "",
  };
}

// ── Catalog fetchers ─────────────────────────────────────────
async function fetchPopular(page, search) {
  if (search) {
    const d = await anilistQuery(
      `query($s:String,$p:Int){Page(page:$p,perPage:20){media(search:$s,type:ANIME,isAdult:false,sort:POPULARITY_DESC){${FIELDS}}}}`,
      { s: search, p: page }
    );
    return d.Page.media;
  }
  const d = await anilistQuery(
    `query($p:Int){Page(page:$p,perPage:20){media(type:ANIME,isAdult:false,sort:POPULARITY_DESC){${FIELDS}}}}`,
    { p: page }
  );
  return d.Page.media;
}

async function fetchSeasonal(page) {
  const m = new Date().getMonth() + 1;
  const year = new Date().getFullYear();
  const season = m <= 3 ? "WINTER" : m <= 6 ? "SPRING" : m <= 9 ? "SUMMER" : "FALL";
  const d = await anilistQuery(
    `query($p:Int,$s:MediaSeason,$y:Int){Page(page:$p,perPage:20){media(type:ANIME,isAdult:false,season:$s,seasonYear:$y,sort:POPULARITY_DESC){${FIELDS}}}}`,
    { p: page, s: season, y: year }
  );
  return d.Page.media;
}

async function fetchTopRated(page) {
  const d = await anilistQuery(
    `query($p:Int){Page(page:$p,perPage:20){media(type:ANIME,isAdult:false,sort:SCORE_DESC,averageScore_greater:70){${FIELDS}}}}`,
    { p: page }
  );
  return d.Page.media;
}

// ── buildMeta ────────────────────────────────────────────────
async function buildMeta(rawId) {
  // rawId = "al:12345"
  const anilistId = parseInt(rawId.replace("al:", ""), 10);
  if (isNaN(anilistId)) throw new Error("Invalid ID: " + rawId);

  const d = await anilistQuery(
    `query($id:Int){Media(id:$id,type:ANIME){
      ${FIELDS}
      description(asHtml:false)
      streamingEpisodes { title thumbnail url site }
      airingSchedule(notYetAired:false,perPage:150){ nodes{ episode airingAt } }
    }}`,
    { id: anilistId }
  );

  const media = d.Media;
  const meta = toMeta(media);

  if (media.description) {
    meta.description = media.description.replace(/<[^>]*>/g, "").slice(0, 400);
  }

  // airing date map
  const airMap = {};
  (media.airingSchedule?.nodes || []).forEach((n) => {
    airMap[n.episode] = new Date(n.airingAt * 1000).toISOString();
  });

  const baseDate = media.startDate?.year
    ? new Date(`${media.startDate.year}-${String(media.startDate.month || 1).padStart(2,"0")}-${String(media.startDate.day || 1).padStart(2,"0")}`)
    : new Date("2000-01-01");

  function epDate(num) {
    if (airMap[num]) return airMap[num];
    const d2 = new Date(baseDate);
    d2.setDate(d2.getDate() + (num - 1) * 7);
    return d2.toISOString();
  }

  const videos = [];
  const seList = media.streamingEpisodes || [];

  if (seList.length > 0) {
    seList.forEach((ep, idx) => {
      const num = idx + 1;
      videos.push({
        id:       `al:${media.id}:1:${num}`,
        title:    ep.title || `Odcinek ${num}`,
        season:   1,
        episode:  num,      // Stremio spec używa "episode" nie "number"
        released: epDate(num),
        thumbnail: ep.thumbnail || undefined,
        ...(ep.site === "Crunchyroll" ? { externalUrl: ep.url } : {}),
      });
    });
  } else if (media.episodes > 0) {
    for (let i = 1; i <= media.episodes; i++) {
      videos.push({
        id:       `al:${media.id}:1:${i}`,
        title:    `Odcinek ${i}`,
        season:   1,
        episode:  i,
        released: epDate(i),
      });
    }
  } else {
    // still airing / unknown count
    videos.push({
      id:       `al:${media.id}:1:1`,
      title:    "Odcinek 1",
      season:   1,
      episode:  1,
      released: baseDate.toISOString(),
    });
  }

  meta.videos = videos;
  return meta;
}

// ── Routing helpers ──────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "max-age=300, stale-while-revalidate=600");
}

function parseExtra(segment) {
  if (!segment) return {};
  const clean = segment.replace(/\.json$/, "");
  const out = {};
  new URLSearchParams(clean).forEach((v, k) => { out[k] = decodeURIComponent(v); });
  return out;
}

// ── Main handler ─────────────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const path = ((req.url || "/").split("?")[0]).replace(/^\/api/, "") || "/";
  console.log("[addon]", req.method, path);

  // manifest
  if (path === "/" || path === "/manifest.json") {
    return res.status(200).json(MANIFEST);
  }

  // /catalog/:type/:id[/:extra].json
  const catM = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/(.+))?\.json$/);
  if (catM) {
    const [, , catalogId, extraSeg] = catM;
    const extra = parseExtra(extraSeg || "");
    const page  = Math.floor((parseInt(extra.skip || "0", 10) || 0) / 20) + 1;
    const search = extra.search || null;

    try {
      let items = [];
      if      (catalogId === "anime-popular")  items = await fetchPopular(page, search);
      else if (catalogId === "anime-seasonal") items = await fetchSeasonal(page);
      else if (catalogId === "anime-toprated") items = await fetchTopRated(page);
      return res.status(200).json({ metas: (items || []).filter(Boolean).map(toMeta) });
    } catch (e) {
      console.error("[catalog error]", e.message);
      return res.status(200).json({ metas: [] });
    }
  }

  // /meta/:type/:id.json
  const metaM = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
  if (metaM) {
    const id = decodeURIComponent(metaM[2]);
    console.log("[meta requested]", id);
    if (!id.startsWith("al:")) {
      console.log("[meta] skipping — not our prefix");
      return res.status(200).json({ meta: null });
    }
    try {
      const meta = await buildMeta(id);
      console.log("[meta ok]", meta.name, "videos:", meta.videos?.length);
      return res.status(200).json({ meta });
    } catch (e) {
      console.error("[meta error]", e.message);
      return res.status(200).json({ meta: null });
    }
  }

  return res.status(404).json({ error: "Not found", path });
};
