const API_BASE = 'https://cj.ffzyapi.com/api.php/provide/vod/at/json/';

async function apiGet(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = API_BASE + (qs ? '?' + qs : '');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) return null;
  return res.json();
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

  // 优先用豆瓣评分排序，上游未返回时回退到站内评分
  const scoreOf = (v) => {
    const db = parseFloat(v?.vod_douban_score);
    if (!isNaN(db) && db > 0) return db;
    const sc = parseFloat(v?.vod_score);
    if (!isNaN(sc) && sc > 0) return sc;
    return 0;
  };

  async function homeFetch(subList, limit = 12) {
    if (!subList.length) return [];
    // 扩大候选池：取前 4 个子分类，各拉一页详情（直接带评分字段）
    const fetches = subList.slice(0, 4).map(async (stid) => {
      const d = await apiGet({ ac: 'detail', t: stid, pg: 1 });
      return d?.list || [];
    });
    const results = await Promise.all(fetches);

    // 合并去重
    const seen = new Set();
    const all = [];
    for (const list of results) {
      for (const v of list) {
        if (!v?.vod_id || seen.has(v.vod_id)) continue;
        seen.add(v.vod_id);
        all.push(v);
      }
    }

    // 按豆瓣评分降序；优先取评分 >= 6 的，不够时放宽到全部
    all.sort((a, b) => scoreOf(b) - scoreOf(a));
    const good = all.filter((v) => scoreOf(v) >= 6);
    return (good.length >= limit ? good : all).slice(0, limit);
  }

  const [movies, series, anime] = await Promise.all([
    homeFetch(subIds[1]),
    homeFetch(subIds[2]),
    homeFetch(subIds[4]),
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
