(function () {
  'use strict';

  const V = window.Valuation;
  const $ = (id) => document.getElementById(id);

  const API = 'https://finnhub.io/api/v1';
  const CACHE_KEY = 'mos.cache.v2'; // v2: adds revenueGrowthQuarterlyYoy to the stored metrics
  const SETTINGS_KEY = 'mos.settings.v1';
  const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  const CALL_GAP_MS = 1300; // keeps us under the free plan's per-minute limit

  const STARTER = (
    'AAPL MSFT GOOGL AMZN META NVDA JPM V MA UNH JNJ PG XOM CVX HD KO PEP WMT COST ' +
    'MRK ABBV LLY PFE CSCO ORCL INTC IBM QCOM TXN CAT DE HON MMM GE BA LMT UPS FDX MCD SBUX ' +
    'NKE DIS CMCSA VZ T TMUS BAC WFC C GS MS AXP COP KHC GIS MO PM CVS CI F GM'
  ).split(' ');

  // Snapshot from a research pass on 2026-09-18: small-cap growth candidates, plus large names that show up in
  // several small-cap ETF top-10 lists. Market caps and growth change, so the screen decides who passes.
  const GROWTH_WATCHLIST = 'INOD QUBT AGIO GSHD BLBD GCT TIC CDNA OUST PENG PGEN PTGX FROG GKOS KRYS EAT'.split(' ');

  // Invented companies, only for previewing the layout without an API key.
  const DEMO = {
    'DEMO-A': { price: 42.1, m: { epsTTM: 6.2, bookValuePerShareQuarterly: 38, freeCashFlowPerShareTTM: 5.1, epsGrowth5Y: 7, revenueGrowth5Y: 5, roeTTM: 17, 'totalDebt/totalEquityQuarterly': 0.5, marketCapitalization: 18400, '52WeekHigh': 55, '52WeekLow': 39 } },
    'DEMO-B': { price: 118.5, m: { epsTTM: 4.1, bookValuePerShareQuarterly: 21, freeCashFlowPerShareTTM: 3.2, epsGrowth5Y: 9, revenueGrowth5Y: 8, roeTTM: 22, 'totalDebt/totalEquityQuarterly': 1.1, marketCapitalization: 95000, '52WeekHigh': 125, '52WeekLow': 80 } },
    'DEMO-C': { price: 23.4, m: { epsTTM: 2.9, bookValuePerShareQuarterly: 19, freeCashFlowPerShareTTM: 2.4, epsGrowth5Y: 3, revenueGrowth5Y: 2, roeTTM: 15, 'totalDebt/totalEquityQuarterly': 0.9, marketCapitalization: 7200, '52WeekHigh': 33, '52WeekLow': 22.5 } },
    'DEMO-D': { price: 67.8, m: { epsTTM: 3.3, bookValuePerShareQuarterly: 30, freeCashFlowPerShareTTM: 3.9, epsGrowth5Y: 5, revenueGrowth5Y: 6, roeTTM: 11, 'totalDebt/totalEquityQuarterly': 0.3, marketCapitalization: 31000, '52WeekHigh': 72, '52WeekLow': 51 } },
    'DEMO-E': { price: 15.2, m: { epsTTM: -0.4, bookValuePerShareQuarterly: 9, freeCashFlowPerShareTTM: 0.6, epsGrowth5Y: -2, revenueGrowth5Y: 1, roeTTM: -4, 'totalDebt/totalEquityQuarterly': 2.6, marketCapitalization: 1900, '52WeekHigh': 21, '52WeekLow': 14.9 } },
    'DEMO-F': { price: 310, m: { epsTTM: 8.5, bookValuePerShareQuarterly: 44, freeCashFlowPerShareTTM: 7.1, epsGrowth5Y: 20, revenueGrowth5Y: 18, roeTTM: 31, 'totalDebt/totalEquityQuarterly': 0.4, marketCapitalization: 240000, '52WeekHigh': 330, '52WeekLow': 190 } }
  };

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } }
  };

  let data = store.get(CACHE_KEY) || {}; // ticker -> { t, price, m }
  let failures = {};                     // ticker -> message
  let demo = false;
  let sort = { key: 'score', dir: -1 };
  const open = new Set();
  let runner = null;

  /* ---------- formatting ---------- */
  const dash = '–';
  const fmt = {
    usd: (v) => (v == null ? dash : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
    pct: (v, d) => (v == null ? dash : (v * 100).toFixed(d == null ? 1 : d) + '%'),
    x: (v) => (v == null ? dash : v.toFixed(1) + '×'),
    n1: (v) => (v == null ? dash : v.toFixed(2)),
    cap: (mm) => {
      if (mm == null) return dash;
      if (mm >= 1e6) return '$' + (mm / 1e6).toFixed(2) + 'T';
      if (mm >= 1e3) return '$' + (mm / 1e3).toFixed(1) + 'B';
      return '$' + mm.toFixed(0) + 'M';
    }
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- inputs ---------- */
  function num(id, fallback) {
    const v = parseFloat($(id).value);
    return isFinite(v) ? v : fallback;
  }
  function optional(id) {
    const raw = $(id).value.trim();
    if (raw === '') return null;
    const v = parseFloat(raw);
    return isFinite(v) ? v : null;
  }
  function readAssumptions() {
    return {
      discount: num('discount', 10) / 100,
      terminal: num('termG', 2.5) / 100,
      growthCap: num('gCap', 15) / 100,
      aaa: num('aaa', 5)
    };
  }
  function readFilters() {
    return {
      mos: optional('fMos'), pe: optional('fPe'), roe: optional('fRoe'), de: optional('fDe'), fcf: $('fFcf').checked,
      capMin: optional('fCapMin'), capMax: optional('fCapMax'), rev: optional('fRev')
    };
  }
  function parseTickers(text) {
    const seen = new Set();
    text.toUpperCase().split(/[\s,;]+/).forEach((t) => { if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) seen.add(t); });
    return Array.from(seen);
  }

  const SAVED_FIELDS = ['tickers', 'discount', 'termG', 'gCap', 'aaa', 'fMos', 'fPe', 'fRoe', 'fDe', 'fCapMin', 'fCapMax', 'fRev'];
  function saveSettings() {
    const s = { fFcf: $('fFcf').checked, showMisses: $('showMisses').checked, remember: $('remember').checked };
    SAVED_FIELDS.forEach((id) => { s[id] = $(id).value; });
    if ($('remember').checked) s.key = $('key').value;
    store.set(SETTINGS_KEY, s);
  }
  function loadSettings() {
    const s = store.get(SETTINGS_KEY) || {};
    SAVED_FIELDS.forEach((id) => { if (s[id] != null) $(id).value = s[id]; });
    if (!$('tickers').value.trim()) $('tickers').value = STARTER.join(' ');
    if (s.fFcf != null) $('fFcf').checked = s.fFcf;
    if (s.showMisses != null) $('showMisses').checked = s.showMisses;
    if (s.remember) { $('remember').checked = true; if (s.key) $('key').value = s.key; }
  }

  /* ---------- Finnhub ---------- */
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

  async function finnhub(path, params, key, signal) {
    const url = new URL(API + path);
    Object.keys(params).forEach((k) => url.searchParams.set(k, params[k]));
    url.searchParams.set('token', key);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url.toString(), { signal });
      if (res.status === 429) { setStatus('Finnhub rate limit reached. Waiting 15 seconds…'); await sleep(15000, signal); continue; }
      if (res.status === 401 || res.status === 403) throw new Error('auth');
      if (!res.ok) throw new Error('Finnhub returned HTTP ' + res.status + '.');
      return res.json();
    }
    throw new Error('Rate limited by Finnhub. Try again in a minute.');
  }

  const isFresh = (t) => data[t] && Date.now() - data[t].t < CACHE_TTL_MS;

  async function run() {
    const key = $('key').value.trim();
    if (!key) { setStatus('Add your Finnhub API key first.', true); $('key').focus(); return; }
    const list = parseTickers($('tickers').value);
    if (!list.length) { setStatus('Add at least one ticker.', true); $('tickers').focus(); return; }

    if (demo) { demo = false; data = store.get(CACHE_KEY) || {}; $('banner').hidden = true; }
    saveSettings();
    failures = {};
    const todo = list.filter((t) => !isFresh(t));
    runner = new AbortController();
    const signal = runner.signal;
    setRunning(true);
    render();

    let done = 0;
    try {
      for (const t of todo) {
        setStatus('Loading ' + t + ' (' + (done + 1) + ' of ' + todo.length + ')…');
        setProgress(done / todo.length);
        try {
          const quote = await finnhub('/quote', { symbol: t }, key, signal);
          await sleep(CALL_GAP_MS, signal);
          if (!(quote && quote.c > 0)) throw new Error('No price returned. Check the ticker.');
          const metric = await finnhub('/stock/metric', { symbol: t, metric: 'all' }, key, signal);
          await sleep(CALL_GAP_MS, signal);
          const m = {};
          V.METRIC_KEYS.forEach((k) => { if (metric && metric.metric && metric.metric[k] != null) m[k] = metric.metric[k]; });
          data[t] = { t: Date.now(), price: quote.c, m: m };
          store.set(CACHE_KEY, data);
        } catch (e) {
          if (e.name === 'AbortError' || e.message === 'auth') throw e;
          failures[t] = e.message;
        }
        done++;
        render();
      }
      const failed = Object.keys(failures).length;
      setStatus(todo.length
        ? 'Done. ' + (todo.length - failed) + ' loaded' + (failed ? ', ' + failed + ' failed.' : '.')
        : 'Everything was already saved from the last 12 hours. Nothing new to load.');
    } catch (e) {
      if (e.name === 'AbortError') setStatus('Stopped. Stocks already loaded are shown below.');
      else if (e.message === 'auth') setStatus('Finnhub rejected the request. Check that your API key is correct and active.', true);
      else setStatus(e.message, true);
    } finally {
      setRunning(false);
      $('progress').hidden = true;
      render();
    }
  }

  /* ---------- status helpers ---------- */
  function setStatus(msg, isError) {
    const el = $('status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }
  function setProgress(frac) {
    const p = $('progress');
    p.hidden = false;
    p.value = frac;
  }
  function setRunning(on) {
    $('run').disabled = on;
    $('stop').hidden = !on;
    $('demo').disabled = on;
  }

  /* ---------- table ---------- */
  const COLUMNS = [
    { key: 'ticker', label: 'Stock', first: true },
    { key: 'price', label: 'Price' },
    { key: 'marketCap', label: 'Mkt cap' },
    { key: 'revGrowth', label: 'Rev growth' },
    { key: 'value', label: 'Est. value' },
    { key: 'mos', label: 'Margin of safety', gauge: true },
    { key: 'pe', label: 'P/E' },
    { key: 'pb', label: 'P/B' },
    { key: 'fcfYield', label: 'FCF yield' },
    { key: 'roe', label: 'ROE' },
    { key: 'debtEq', label: 'Debt/equity' },
    { key: 'score', label: 'Score' }
  ];
  const ASC_FIRST = { ticker: 1, pe: 1, pb: 1, debtEq: 1 };

  function compare(a, b) {
    const av = a[sort.key], bv = b[sort.key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * sort.dir;
    return (av - bv) * sort.dir;
  }

  function buildRows() {
    const A = readAssumptions();
    const universe = demo ? Object.keys(data) : parseTickers($('tickers').value);
    const rows = [];
    universe.forEach((t) => {
      const rec = data[t];
      if (!rec) return;
      const a = V.analyze(rec.price, rec.m, A);
      if (a) rows.push(Object.assign({ ticker: t }, a));
    });
    V.score(rows);
    return { rows, A };
  }

  function gauge(r) {
    if (r.mos == null) return '<span class="mos-text">' + dash + '</span>';
    const ratio = Math.min(r.price / r.value, 1.5);
    const cls = r.mos >= 0 ? 'under' : 'over';
    const words = Math.abs(r.mos * 100).toFixed(0) + '% ' + (r.mos >= 0 ? 'below' : 'above') + ' value';
    return '<div class="mos"><div class="gauge" role="img" aria-label="' + words + '">' +
      '<div class="gauge-fill ' + cls + '" style="width:' + ((ratio / 1.5) * 100).toFixed(1) + '%"></div>' +
      '<div class="gauge-mark"></div></div><span class="mos-text ' + cls + '">' + words + '</span></div>';
  }

  /* ---------- filter footnotes: how far each stock beats or misses each active filter ---------- */
  function checkValue(c, v) {
    if (v == null) return dash;
    if (c.id === 'capMin' || c.id === 'capMax') return fmt.cap(v);
    if (c.kind === 'pts') return v.toFixed(1) + '%';
    if (c.id === 'pe') return v.toFixed(1) + '×';
    if (c.id === 'fcf') return fmt.usd(v);
    return v.toFixed(2);
  }
  function checkMargin(c) {
    if (c.missing) return 'no data';
    if (c.kind === 'flag') return c.pass ? 'positive' : 'not positive';
    if (c.delta == null) return c.pass ? 'passes' : 'fails';
    const size = c.kind === 'pts' ? Math.abs(c.delta).toFixed(1) + ' pts' : Math.abs(c.delta).toFixed(0) + '%';
    return (c.pass ? 'beats by ' : 'misses by ') + size;
  }
  function checkText(c) {
    if (c.kind === 'flag') return c.label + ': ' + checkValue(c, c.actual) + ', ' + checkMargin(c);
    return c.label + ': ' + checkValue(c, c.actual) + ' vs ' + c.dir + ' ' + checkValue(c, c.limit) + ', ' + checkMargin(c);
  }
  // The line under the ticker: what it misses, or how much it beats the key (or, failing that, all) active filters.
  function checkNote(r) {
    if (!r.checks.length) return '';
    const bit = (c) => c.label + (c.missing ? ': ' : ' ') + checkMargin(c);
    const fails = r.checks.filter((c) => !c.pass);
    if (fails.length) return '<span class="fn bad">' + esc(fails.map(bit).join(' · ')) + '</span>';
    // A market cap window is a range test, so say "in range" rather than a meaningless margin above the floor.
    const isCap = (c) => c.id === 'capMin' || c.id === 'capMax';
    const keys = r.checks.filter((c) => c.key);
    const shownChecks = keys.length ? keys : r.checks;
    const parts = shownChecks.filter((c) => !isCap(c)).map(bit);
    if (shownChecks.some(isCap)) parts.unshift('Market cap in range');
    return '<span class="fn ok">' + esc(parts.join(' · ')) + '</span>';
  }
  function checkClass(r, ids) {
    const cs = r.checks.filter((c) => ids.indexOf(c.id) !== -1);
    if (!cs.length) return '';
    return cs.every((c) => c.pass) ? ' class="ok"' : ' class="bad"';
  }
  function checksBlock(r) {
    if (!r.checks.length) return '';
    return '<div class="checks"><h3>Filter check</h3><ul>' + r.checks.map((c) =>
      '<li class="' + (c.pass ? 'ok' : 'bad') + '"><span aria-hidden="true">' + (c.pass ? '✓' : '✗') + '</span> ' +
      '<span class="sr">' + (c.pass ? 'Pass: ' : 'Fail: ') + '</span>' + esc(checkText(c)) + (c.key ? ' <em>key</em>' : '') + '</li>').join('') + '</ul></div>';
  }

  function detail(r) {
    const models = [
      ['Graham number', r.models.graham, r.modelNotes.graham],
      ['Discounted cash flow', r.models.dcf, r.modelNotes.dcf],
      ['Graham growth formula', r.models.growthFormula, r.modelNotes.growthFormula]
    ].map((m) => '<dt>' + m[0] + '</dt><dd>' + fmt.usd(m[1]) + '</dd>' + (m[1] == null ? '<div class="na">' + m[2] + '</div>' : '')).join('');

    const hasRange = r.hi52 && r.lo52 && r.hi52 > r.lo52;
    const range = hasRange ? fmt.usd(r.lo52) + ' – ' + fmt.usd(r.hi52) : dash;
    const position = hasRange ? Math.round(((r.price - r.lo52) / (r.hi52 - r.lo52)) * 100) + '%' : dash;
    const flags = r.flags.length ? '<ul class="flags">' + r.flags.map((f) => '<li>' + esc(f) + '</li>').join('') + '</ul>' : '<p class="hint">No warnings for this stock.</p>';

    return '<tr class="detail"><td colspan="' + COLUMNS.length + '"><div class="detail-grid">' +
      '<div><h3>Value estimates</h3><dl>' + models + '<dt><strong>Median (used)</strong></dt><dd class="strong">' + fmt.usd(r.value) + '</dd></dl></div>' +
      '<div><h3>Inputs</h3><dl>' +
      '<dt>Earnings per share (TTM)</dt><dd>' + fmt.usd(r.eps) + '</dd>' +
      '<dt>Book value per share</dt><dd>' + fmt.usd(r.bvps) + '</dd>' +
      '<dt>Free cash flow per share</dt><dd>' + fmt.usd(r.fcfps) + '</dd>' +
      '<dt>Revenue growth (YoY)</dt><dd>' + fmt.pct(r.revGrowth, 1) + '</dd>' +
      '<dt>Growth used</dt><dd>' + fmt.pct(r.g0, 1) + '</dd>' +
      '<dt>52-week range</dt><dd>' + range + '</dd>' +
      '<dt>Position in 52-week range</dt><dd>' + position + '</dd>' +
      '<dt>Market cap</dt><dd>' + fmt.cap(r.marketCap) + '</dd>' +
      '<dt>Dividend yield</dt><dd>' + fmt.pct(r.dividendYield, 2) + '</dd></dl></div>' +
      '<div><h3>Things to check</h3>' + flags + '</div>' + checksBlock(r) + '</div></td></tr>';
  }

  // Every row with its filter checks attached, and the rows to display (misses included only if asked for).
  function visibleRows() {
    const { rows } = buildRows();
    const F = readFilters();
    rows.forEach((r) => {
      r.checks = V.filterChecks(r, F);
      r.pass = r.checks.every((c) => c.pass);
      r.meets = r.pass ? 'yes' : 'no';
    });
    const passing = rows.filter((r) => r.pass);
    const shown = ($('showMisses').checked ? rows : passing).slice().sort(compare);
    return { rows, passing, shown };
  }

  function render() {
    const { rows, passing, shown } = visibleRows();

    const wrap = $('tablewrap');
    const hasAny = rows.length > 0;
    $('empty').hidden = hasAny;
    wrap.hidden = !hasAny;
    $('footnote').hidden = !hasAny;
    $('export').hidden = !shown.length;
    $('count').textContent = hasAny ? passing.length + ' of ' + rows.length + ' stocks pass your filters' +
      ($('showMisses').checked && shown.length > passing.length ? ' (the rest are dimmed)' : '') : '';

    if (hasAny) {
      const head = COLUMNS.map((c) => {
        const active = sort.key === c.key;
        const aria = active ? ' aria-sort="' + (sort.dir === 1 ? 'ascending' : 'descending') + '"' : '';
        return '<th scope="col"' + aria + (c.gauge ? ' class="gaugecol"' : '') + '><button type="button" data-sort="' + c.key + '">' + c.label + '</button></th>';
      }).join('');

      const body = shown.length ? shown.map((r) => {
        const isOpen = open.has(r.ticker);
        return '<tr class="row' + (r.pass ? '' : ' miss') + '"><td><button type="button" class="tick" data-toggle="' + esc(r.ticker) + '" aria-expanded="' + isOpen + '">' + esc(r.ticker) + '</button>' + checkNote(r) + '</td>' +
          '<td>' + fmt.usd(r.price) + '</td><td' + checkClass(r, ['capMin', 'capMax']) + '>' + fmt.cap(r.marketCap) + '</td><td' + checkClass(r, ['rev']) + '>' + fmt.pct(r.revGrowth, 1) + '</td><td>' + fmt.usd(r.value) + '</td>' +
          '<td class="gaugecol">' + gauge(r) + '</td>' +
          '<td>' + fmt.x(r.pe) + '</td><td>' + fmt.x(r.pb) + '</td><td>' + fmt.pct(r.fcfYield) + '</td>' +
          '<td>' + fmt.pct(r.roe, 0) + '</td><td>' + fmt.n1(r.debtEq) + '</td><td class="score">' + r.score + '</td></tr>' +
          (isOpen ? detail(r) : '');
      }).join('') : '<tr><td colspan="' + COLUMNS.length + '" style="text-align:left;white-space:normal">No stocks pass the current filters. Loosen a filter on the left to see more.</td></tr>';

      wrap.innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
    }

    const failed = Object.keys(failures);
    const fEl = $('failures');
    fEl.hidden = !failed.length;
    if (failed.length) fEl.textContent = 'Could not load: ' + failed.map((t) => t + ' (' + failures[t] + ')').join('; ');
  }

  /* ---------- export ---------- */
  function exportCsv() {
    const { shown } = visibleRows();
    const cols = [
      ['ticker', 'Ticker'], ['price', 'Price'], ['marketCap', 'Market cap ($M)'], ['revGrowth', 'Revenue growth YoY'],
      ['value', 'Estimated value'], ['mos', 'Margin of safety'],
      ['pe', 'P/E'], ['pb', 'P/B'], ['fcfYield', 'FCF yield'], ['roe', 'ROE'], ['debtEq', 'Debt/equity'], ['score', 'Score'],
      ['meets', 'Meets filters']
    ];
    const cell = (v) => (v == null ? '' : typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : '"' + String(v).replace(/"/g, '""') + '"');
    const lines = [cols.map((c) => c[1]).join(',')].concat(shown.map((r) => cols.map((c) => cell(r[c[0]])).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'margin-of-safety-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  /* ---------- events ---------- */
  $('run').addEventListener('click', run);
  $('stop').addEventListener('click', () => { if (runner) runner.abort(); });
  $('export').addEventListener('click', exportCsv);

  $('demo').addEventListener('click', () => {
    demo = true;
    data = JSON.parse(JSON.stringify(DEMO));
    Object.keys(data).forEach((t) => { data[t].t = Date.now(); });
    failures = {};
    $('banner').hidden = false;
    setStatus('Showing sample data.');
    render();
  });

  $('clear').addEventListener('click', () => {
    store.del(CACHE_KEY);
    data = {};
    failures = {};
    if (demo) { demo = false; $('banner').hidden = true; }
    setStatus('Saved stock data cleared.');
    render();
  });

  document.addEventListener('input', (e) => {
    if (!e.target.closest('.controls')) return;
    if (e.target.id === 'key' && !$('remember').checked) return;
    saveSettings();
    renderCalc();
    if (e.target.id !== 'key') render();
  });

  /* ---------- presets ---------- */
  function setFields(values) {
    Object.keys(values).forEach((id) => { $(id).value = values[id]; });
    saveSettings();
    render();
  }
  $('presetGrowth').addEventListener('click', () => {
    // Value-style filters would hide growth stocks, so the preset turns them off.
    $('fFcf').checked = false;
    $('showMisses').checked = true; // so near-misses stay visible, dimmed, with how far they miss by
    setFields({ fMos: '', fPe: '', fRoe: '', fDe: '', fCapMin: '300', fCapMax: '2000', fRev: '17' });
    setStatus('Small-cap growth preset: market cap $300M to $2B, revenue growth 17% or more. Margin of safety filters are off.');
  });
  $('loadWatchlist').addEventListener('click', () => {
    $('tickers').value = GROWTH_WATCHLIST.join(' ');
    saveSettings();
    setStatus('Growth watchlist loaded (a 2026-09-18 snapshot). Press Run screen to fetch current numbers.');
  });

  /* ---------- position size calculator ---------- */
  function renderCalc() {
    const out = $('calcOut');
    const r = V.positionSize(optional('pAcct'), optional('pRisk'), optional('pEntry'), optional('pStop'));
    if (!r) { out.textContent = 'Enter account size, risk %, entry price and a stop price below the entry.'; return; }
    const pct = (v) => (v * 100).toFixed(1) + '%';
    out.textContent = r.shares + ' shares. Position ' + fmt.usd(r.value) + ' (' + pct(r.pctOfAccount) + ' of account). ' +
      'If the stop fills at ' + fmt.usd(optional('pStop')) + ', the loss is ' + fmt.usd(r.dollarRisk) + ' (' + pct(r.riskPctOfAccount) +
      ' of account); the stop is ' + pct(r.stopDistance) + ' below entry.' +
      (r.capped ? ' The position was capped at your account size, so the risk is below your limit.' : '') +
      (r.shares === 0 ? ' The stop is too wide for this risk limit to buy even one share.' : '');
  }
  $('remember').addEventListener('change', () => {
    saveSettings();
    if (!$('remember').checked) { const s = store.get(SETTINGS_KEY) || {}; delete s.key; store.set(SETTINGS_KEY, s); }
  });

  $('tablewrap').addEventListener('click', (e) => {
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      const k = sortBtn.getAttribute('data-sort');
      if (sort.key === k) sort.dir = -sort.dir;
      else sort = { key: k, dir: ASC_FIRST[k] || -1 };
      render();
      const sb = document.querySelector('[data-sort="' + k + '"]');
      if (sb) sb.focus();
      return;
    }
    const tog = e.target.closest('[data-toggle]');
    if (tog) {
      const t = tog.getAttribute('data-toggle');
      if (open.has(t)) open.delete(t); else open.add(t);
      render();
      const again = document.querySelector('[data-toggle="' + t + '"]');
      if (again) again.focus();
    }
  });

  /* ---------- start ---------- */
  loadSettings();
  renderCalc();
  render();
})();
