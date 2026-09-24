/*
 * valuation.js — the math behind the screener. No DOM, no network.
 *
 * Three independent estimates of what one share is worth, blended by median:
 *   1. Graham number          sqrt(22.5 × EPS × book value per share)
 *   2. Discounted cash flow   10 years of free cash flow per share, growth fading to a terminal rate
 *   3. Graham growth formula  EPS × (8.5 + 2g) × 4.4 / AAA bond yield
 *
 * Margin of safety = (estimated value − price) / estimated value.
 */
(function (root) {
  'use strict';

  // Finnhub /stock/metric fields this file reads. The page stores only these per ticker.
  const METRIC_KEYS = [
    'epsTTM', 'epsBasicExclExtraItemsTTM', 'epsInclExtraItemsTTM', 'epsExclExtraItemsTTM', 'epsAnnual',
    'bookValuePerShareQuarterly', 'bookValuePerShareAnnual',
    'freeCashFlowPerShareTTM', 'freeCashFlowPerShareAnnual', 'pfcfShareTTM', 'pfcfShareAnnual',
    'peTTM', 'peBasicExclExtraTTM',
    'epsGrowth5Y', 'revenueGrowth5Y', 'revenueGrowthTTMYoy', 'revenueGrowthQuarterlyYoy',
    'roeTTM', 'roeRfy',
    'totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual',
    'marketCapitalization', '52WeekHigh', '52WeekLow',
    'dividendYieldIndicatedAnnual', 'currentDividendYieldTTM'
  ];

  const DEFAULT_GROWTH = 0.03; // used when the data provider has no growth figures
  const GROWTH_DISAGREE_PTS = 10; // flag when 5-year EPS and revenue growth differ by more than this many points

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const first = (m, keys) => {
    for (const k of keys) {
      const v = num(m[k]);
      if (v !== null) return v;
    }
    return null;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const median = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  /** Present value per share of free cash flow, growth fading linearly from g0 to gT over `years`. */
  function dcfPerShare(fcf0, g0, gT, r, years) {
    years = years || 10;
    if (!(fcf0 > 0) || !(r > gT + 0.005)) return null;
    let f = fcf0;
    let pv = 0;
    for (let t = 1; t <= years; t++) {
      const g = g0 + ((gT - g0) * (t - 1)) / (years - 1);
      f *= 1 + g;
      pv += f / Math.pow(1 + r, t);
    }
    pv += (f * (1 + gT)) / (r - gT) / Math.pow(1 + r, years);
    return pv;
  }

  function grahamNumber(eps, bvps) {
    return eps > 0 && bvps > 0 ? Math.sqrt(22.5 * eps * bvps) : null;
  }

  /** g0Pct is the growth rate in percent (e.g. 8 for 8%); aaaPct is the AAA yield in percent. */
  function grahamGrowth(eps, g0Pct, aaaPct) {
    if (!(eps > 0) || !(aaaPct > 0)) return null;
    return (eps * (8.5 + 2 * Math.max(0, g0Pct)) * 4.4) / aaaPct;
  }

  /**
   * Turn a price and a raw metric map into everything the table needs.
   * A = { discount, terminal, growthCap, aaa } — discount/terminal/growthCap as decimals, aaa in percent.
   */
  function analyze(price, m, A) {
    if (!(price > 0)) return null;
    m = m || {};

    const eps = first(m, ['epsTTM', 'epsBasicExclExtraItemsTTM', 'epsInclExtraItemsTTM', 'epsExclExtraItemsTTM', 'epsAnnual']);
    const bvps = first(m, ['bookValuePerShareQuarterly', 'bookValuePerShareAnnual']);

    let fcfps = first(m, ['freeCashFlowPerShareTTM', 'freeCashFlowPerShareAnnual']);
    if (fcfps === null) {
      const pf = first(m, ['pfcfShareTTM', 'pfcfShareAnnual']);
      if (pf !== null && pf !== 0) fcfps = price / pf;
    }

    // Growth: average of 5-year EPS and revenue growth; fall back to latest revenue growth.
    const epsG = num(m.epsGrowth5Y);
    const revG = num(m.revenueGrowth5Y);
    let parts = [epsG, revG].filter((v) => v !== null);
    if (!parts.length) parts = [num(m.revenueGrowthTTMYoy)].filter((v) => v !== null);
    const growth = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length / 100 : null;
    const growthAssumed = growth === null;
    const g0 = clamp(growthAssumed ? DEFAULT_GROWTH : growth, -0.03, A.growthCap);

    // Latest-quarter revenue growth versus the same quarter a year earlier; falls back to trailing twelve months.
    const revGrowthPct = first(m, ['revenueGrowthQuarterlyYoy', 'revenueGrowthTTMYoy']);

    const roePct = first(m, ['roeTTM', 'roeRfy']);
    const debtEq = first(m, ['totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual']);
    const divPct = first(m, ['dividendYieldIndicatedAnnual', 'currentDividendYieldTTM']);
    const hi52 = num(m['52WeekHigh']);
    const lo52 = num(m['52WeekLow']);

    // Ratios use the live price so they stay consistent with the quote.
    let pe = eps > 0 ? price / eps : null;
    if (pe === null && eps === null) pe = first(m, ['peTTM', 'peBasicExclExtraTTM']);
    const pb = bvps > 0 ? price / bvps : null;

    const models = {
      graham: grahamNumber(eps, bvps),
      dcf: dcfPerShare(fcfps, g0, A.terminal, A.discount, 10),
      growthFormula: grahamGrowth(eps, g0 * 100, A.aaa)
    };
    const modelNotes = {
      graham: 'Needs positive EPS and book value per share.',
      dcf: 'Needs positive free cash flow per share and a discount rate above terminal growth.',
      growthFormula: 'Needs positive EPS.'
    };
    const available = Object.values(models).filter((v) => v !== null && v > 0);
    const value = available.length ? median(available) : null;
    const mos = value ? (value - price) / value : null;

    const flags = [];
    if (eps !== null && eps <= 0) flags.push('Negative earnings, so P/E and two of the three models are unavailable.');
    if (fcfps !== null && fcfps <= 0) flags.push('Negative free cash flow.');
    if (growthAssumed) flags.push('No growth data; assumed ' + DEFAULT_GROWTH * 100 + '% growth.');
    if (available.length === 0) flags.push('No valuation model could run, so there is no value estimate or margin of safety.');
    if (available.length === 1) flags.push('Only one model could run, so treat the value estimate with extra caution.');
    if (available.length > 1) {
      const hi = Math.max.apply(null, available);
      const lo = Math.min.apply(null, available);
      if (hi / lo > 2) flags.push('The models disagree by more than 2×; the median may not mean much.');
    }
    if (hi52 && lo52 && hi52 > lo52 && (price - lo52) / (hi52 - lo52) < 0.1) {
      flags.push('Trading near its 52-week low. Cheap for a reason? Check for a value trap.');
    }
    if (epsG !== null && revG !== null && Math.abs(epsG - revG) > GROWTH_DISAGREE_PTS) {
      flags.push('EPS growth (' + epsG.toFixed(1) + '%) and revenue growth (' + revG.toFixed(1) + '%) differ a lot, so the blended growth rate is less reliable.');
    }
    if (growth !== null && growth > A.growthCap) flags.push('Reported growth was capped at ' + Math.round(A.growthCap * 10000) / 100 + '%.');

    return {
      price, eps, bvps, fcfps, pe, pb,
      fcfYield: fcfps !== null ? fcfps / price : null,
      earningsYield: eps !== null ? eps / price : null,
      bookYield: bvps !== null ? bvps / price : null,
      roe: roePct !== null ? roePct / 100 : null,
      debtEq,
      dividendYield: divPct !== null ? divPct / 100 : null,
      marketCap: num(m.marketCapitalization), // millions of USD
      hi52, lo52,
      growth, growthAssumed, g0,
      revGrowth: revGrowthPct !== null ? revGrowthPct / 100 : null,
      models, modelNotes, value, mos, flags,
      score: null
    };
  }

  /** Percentile of v within the non-null values of `all` (0 to 1). Missing values score 0. */
  function percentile(all, v) {
    if (v === null || v === undefined) return 0;
    const xs = all.filter((x) => x !== null && x !== undefined);
    if (xs.length < 2) return 0.5;
    let below = 0;
    for (const x of xs) if (x < v) below++;
    return below / (xs.length - 1);
  }

  const WEIGHTS = { mos: 0.4, fcfYield: 0.2, earningsYield: 0.2, bookYield: 0.1, roe: 0.1 };

  /** Adds a 0–100 composite value score to each row, relative to the other rows loaded. */
  function score(rows) {
    const cols = {};
    Object.keys(WEIGHTS).forEach((k) => { cols[k] = rows.map((r) => r[k]); });
    rows.forEach((r) => {
      let s = 0;
      Object.keys(WEIGHTS).forEach((k) => { s += WEIGHTS[k] * percentile(cols[k], r[k]); });
      r.score = Math.round(s * 100);
    });
    return rows;
  }

  /**
   * Filters use the units shown in the page: mos and roe in percent, pe and de as plain numbers.
   * A blank (null) filter is ignored. If a filter is set and the row lacks that metric, the row is hidden.
   */
  function passes(r, F) {
    return filterChecks(r, F).every((c) => c.pass);
  }

  /**
   * One entry per active filter, saying whether the row passes and by how much.
   *   kind 'pts': actual and threshold are percentages; delta is percentage points (positive = better than the limit).
   *   kind 'pct': delta is a percent of the limit (positive = better: above a minimum, or under a maximum).
   *   kind 'flag': a yes/no test with no margin.
   * A row missing the metric fails with missing: true and delta: null. Market cap is in millions of USD.
   * key marks the growth-screen filters that the page highlights.
   */
  function filterChecks(r, F) {
    const out = [];
    const minPts = (id, label, actual, limit, key) => {
      const missing = actual === null || actual === undefined;
      out.push({ id, label, kind: 'pts', dir: 'min', key: !!key, actual: missing ? null : actual, limit, missing,
        pass: !missing && actual >= limit, delta: missing ? null : actual - limit });
    };
    const rel = (id, label, actual, limit, dir, key, usable) => {
      const missing = actual === null || actual === undefined;
      const ok = !missing && (usable === undefined || usable);
      const under = dir === 'max';
      out.push({ id, label, kind: 'pct', dir, key: !!key, actual: missing ? null : actual, limit, missing,
        pass: ok && (under ? actual <= limit : actual >= limit),
        delta: ok && limit !== 0 ? ((under ? limit - actual : actual - limit) / limit) * 100 : null });
    };
    const on = (v) => v !== null && v !== undefined;
    if (on(F.mos)) minPts('mos', 'Margin of safety', r.mos === null ? null : r.mos * 100, F.mos);
    if (on(F.pe)) rel('pe', 'P/E', r.pe, F.pe, 'max', false, r.pe > 0);
    if (on(F.roe)) minPts('roe', 'ROE', r.roe === null ? null : r.roe * 100, F.roe);
    if (on(F.de)) rel('de', 'Debt/equity', r.debtEq, F.de, 'max');
    if (F.fcf) {
      const missing = r.fcfps === null || r.fcfps === undefined;
      out.push({ id: 'fcf', label: 'Free cash flow', kind: 'flag', dir: 'min', key: false, actual: missing ? null : r.fcfps,
        limit: 0, missing, pass: !missing && r.fcfps > 0, delta: null });
    }
    if (on(F.capMin)) rel('capMin', 'Market cap (min)', r.marketCap, F.capMin, 'min', true);
    if (on(F.capMax)) rel('capMax', 'Market cap (max)', r.marketCap, F.capMax, 'max', true);
    if (on(F.rev)) minPts('rev', 'Revenue growth', r.revGrowth === null ? null : r.revGrowth * 100, F.rev, true);
    return out;
  }

  /**
   * Fixed-fractional position sizing for a long position: risk a set percent of the account
   * between the entry and a stop. Returns null for unusable inputs (stop must be below entry).
   * The result is capped so the position never costs more than the account.
   */
  function positionSize(account, riskPct, entry, stop) {
    if (![account, riskPct, entry, stop].every((v) => typeof v === 'number' && isFinite(v) && v > 0)) return null;
    if (stop >= entry) return null;
    const perShare = entry - stop;
    let shares = Math.floor((account * riskPct / 100) / perShare);
    let capped = false;
    if (shares * entry > account) { shares = Math.floor(account / entry); capped = true; }
    return {
      shares,
      value: shares * entry,
      pctOfAccount: (shares * entry) / account,
      dollarRisk: shares * perShare,
      riskPctOfAccount: (shares * perShare) / account,
      stopDistance: perShare / entry,
      capped
    };
  }

  const api = { METRIC_KEYS, WEIGHTS, dcfPerShare, grahamNumber, grahamGrowth, analyze, score, passes, filterChecks, positionSize, median };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Valuation = api;
})(typeof window !== 'undefined' ? window : globalThis);
