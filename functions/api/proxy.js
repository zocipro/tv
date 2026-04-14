const API_BASE = 'https://cj.ffzyapi.com/api.php/provide/vod/at/json/';
const DOUBAN_API = 'https://movie.douban.com/j/search_subjects';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function apiGet(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = API_BASE + (qs ? '?' + qs : '');
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  return res.json();
}

// 拉豆瓣热门榜（type: movie/tv, tag: 热门/动画/...）
async function fetchDoubanHot(type, tag, limit = 20) {
  const qs = new URLSearchParams({
    type, tag, sort: 'recommend',
    page_limit: String(limit), page_start: '0',
  }).toString();
  try {
    const res = await fetch(DOUBAN_API + '?' + qs, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://movie.douban.com/',
        'Accept': 'application/json, text/plain, */*',
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.subjects) ? data.subjects : [];
  } catch (e) {
    return [];
  }
}

async function apiList(tid, pg, wd) {
  if (wd) return apiGet({ ac: 'detail', pg, wd });
  if (tid <= 0) return apiGet({ ac: 'detail', pg });

  const primaryIds = [1, 2, 3, 4];
  let queryTid = tid;
  if (primaryIds.includes(tid)) {
    const clsData = await apiGet({ ac: 'list' });
    if (clsData?.class) {
      for (const c of clsData.class) {
        if (parseInt(c.type_pid || 0) === tid) {
          queryTid = parseInt(c.type_id);
          break;
        }
      }
    }
  }

  const data = await apiGet({ ac: 'detail', t: queryTid, pg });
  if (data?.list?.length) return data;
  return { list: [], total: 0, pagecount: 0 };
}

async function fetchHome() {
  const clsData = await apiGet({ ac: 'list' });
  const classes = clsData?.class || [];

  const subIds = { 1: [], 2: [], 3: [], 4: [] };
  for (const c of classes) {
    const pid = parseInt(c.type_pid) || 0;
    if (subIds[pid]) subIds[pid].push(parseInt(c.type_id));
  }

  // 用豆瓣热门榜去上游搜索匹配。搜到的附上豆瓣评分作为副作用。
  async function homeFromDouban(type, tag, limit = 12) {
    // 拉 14 条：Cloudflare Workers 每次调用 subrequest 上限 50，
    // 1(classes) + 3(douban) + 3*14(ffzy 搜索) = 46，留有余量
    const hot = await fetchDoubanHot(type, tag, 14);
    if (!hot.length) return null; // 豆瓣拉失败 → 触发回退
    const matches = await Promise.all(
      hot.map(async (d) => {
        try {
          const data = await apiGet({ ac: 'detail', wd: d.title });
          const list = data?.list || [];
          if (!list.length) return null;
          // 严格匹配：要么精确相等，要么名称互相包含，避免不相关搜索结果
          const best =
            list.find((v) => v.vod_name === d.title) ||
            list.find((v) => {
              const n = v.vod_name || '';
              return n && (n.includes(d.title) || d.title.includes(n));
            });
          if (!best) return null;
          best.vod_douban_score = d.rate || best.vod_douban_score || '';
          best.vod_douban_id = d.id || '';
          return best;
        } catch {
          return null;
        }
      })
    );
    const picked = [];
    const seen = new Set();
    for (const v of matches) {
      if (!v?.vod_id || seen.has(v.vod_id)) continue;
      seen.add(v.vod_id);
      picked.push(v);
      if (picked.length >= limit) break;
    }
    return picked;
  }

  // 回退方案：上游自带评分排序（若 ffzy 没填则按原顺序）
  const scoreOf = (v) => {
    const db = parseFloat(v?.vod_douban_score);
    if (!isNaN(db) && db > 0) return db;
    const sc = parseFloat(v?.vod_score);
    if (!isNaN(sc) && sc > 0) return sc;
    return 0;
  };
  async function homeFromUpstream(subList, limit = 12) {
    if (!subList.length) return [];
    const fetches = subList.slice(0, 4).map(async (stid) => {
      const d = await apiGet({ ac: 'detail', t: stid, pg: 1 });
      return d?.list || [];
    });
    const results = await Promise.all(fetches);
    const seen = new Set();
    const all = [];
    for (const list of results) {
      for (const v of list) {
        if (!v?.vod_id || seen.has(v.vod_id)) continue;
        seen.add(v.vod_id);
        all.push(v);
      }
    }
    all.sort((a, b) => scoreOf(b) - scoreOf(a));
    return all.slice(0, limit);
  }

  async function pick(doubanType, doubanTag, fallbackSubList) {
    const douban = await homeFromDouban(doubanType, doubanTag);
    if (douban && douban.length) return douban;
    return homeFromUpstream(fallbackSubList);
  }

  const [movies, series, anime] = await Promise.all([
    pick('movie', '热门', subIds[1]),
    pick('tv',    '热门', subIds[2]),
    pick('tv',    '动画', subIds[4]),
  ]);

  return { classes, movies, series, anime };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const action = params.get('do') || '';

  switch (action) {
    case 'list': {
      const tid = parseInt(params.get('tid')) || 0;
      const page = Math.max(1, parseInt(params.get('page')) || 1);
      const data = await apiList(tid, page, '');
      return json(data || { list: [], total: 0, pagecount: 0 });
    }

    case 'search': {
      const wd = (params.get('wd') || '').trim();
      const page = Math.max(1, parseInt(params.get('page')) || 1);
      const data = wd ? await apiList(0, page, wd) : null;
      return json(data || { list: [], total: 0, pagecount: 0 });
    }

    case 'detail': {
      const id = parseInt(params.get('id')) || 0;
      if (id <= 0) return json(null);
      const data = await apiGet({ ac: 'detail', ids: id });
      const vod = data?.list?.[0] || null;
      return json(vod);
    }

    case 'home': {
      const data = await fetchHome();
      return json(data);
    }

    case 'classes': {
      const data = await apiGet({ ac: 'list' });
      return json(data?.class || []);
    }

    default:
      return json({ error: 'invalid action' }, 400);
  }
}
