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

  async function homeFetch(subList, limit = 12) {
    if (!subList.length) return [];
    const perSub = Math.ceil(limit / Math.min(2, subList.length));
    let allIds = [];
    const fetches = subList.slice(0, 2).map(async (stid) => {
      const ld = await apiGet({ ac: 'list', t: stid, page: 1 });
      if (ld?.list) return ld.list.slice(0, perSub).map((v) => v.vod_id);
      return [];
    });
    const results = await Promise.all(fetches);
    for (const ids of results) allIds.push(...ids);
    allIds = [...new Set(allIds)].slice(0, limit);
    if (!allIds.length) return [];
    const dd = await apiGet({ ac: 'detail', ids: allIds.join(',') });
    return dd?.list || [];
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
