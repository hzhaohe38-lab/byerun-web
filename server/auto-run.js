// ============================================================
// Auto-run pure helpers (server side)
//
// This module is a faithful COPY of the browser run pipeline
// (app/src/utils/map.js, app/src/utils/track.js, app/src/utils/run.js,
// app/src/composables/useRunSubmission.js) so the very same "one click
// run" payload can be produced from Node without a browser.
//
// The frontend files above are intentionally left untouched — the
// manual run flow keeps running through them, this is a parallel copy.
// ============================================================

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------
// Map loading (Node fs) — mirrors app/src/utils/map.js
// ------------------------------------------------------------

const MAP_DIR = path.join(__dirname, '..', 'app', 'src', 'assets', 'maps');

let _mapDataCollection = null;
let _mapNameCollection = null;

function loadMaps() {
  if (_mapDataCollection) return _mapDataCollection;

  _mapDataCollection = {};
  _mapNameCollection = {};

  let files = [];
  try {
    files = fs.readdirSync(MAP_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch (e) {
    files = [];
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(MAP_DIR, file), 'utf-8');
      const parsed = JSON.parse(raw);
      const mapId = String(parsed?.mapId || '').trim();
      const mapData = parsed?.mapData;
      if (!mapId || !Array.isArray(mapData)) continue;
      _mapDataCollection[mapId] = mapData;
      _mapNameCollection[mapId] = String(parsed?.mapName || mapId).trim() || mapId;
    } catch (e) {
      // skip malformed map file
    }
  }

  const firstMapId = Object.keys(_mapDataCollection)[0];
  _mapDataCollection.default = firstMapId ? _mapDataCollection[firstMapId] : [];

  return _mapDataCollection;
}

function getAvailableMapIds() {
  loadMaps();
  return Object.keys(_mapDataCollection).filter((id) => id !== 'default');
}

function getMapNames() {
  loadMaps();
  return { ..._mapNameCollection };
}

function getMapData(mapChoice = 'default') {
  loadMaps();
  const mapId = String(mapChoice || 'default').trim() || 'default';
  return _mapDataCollection[mapId] || _mapDataCollection.default || [];
}

// ------------------------------------------------------------
// Haversine — mirrors app/src/utils/map.js getDistance
// ------------------------------------------------------------

function getDistance(start, end) {
  const toRad = (d) => (d * Math.PI) / 180;
  const [lng1, lat1] = start;
  const [lng2, lat2] = end;
  const R = 6378137;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// ------------------------------------------------------------
// Track generation — copy of app/src/utils/track.js genTrackPoints
// ------------------------------------------------------------

const clampValue = (v, a, b) => {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.max(lo, Math.min(v, hi));
};

const arePointsEqual = (p1, p2, epsilon = 1e-9) =>
  Math.abs(p1[0] - p2[0]) <= epsilon && Math.abs(p1[1] - p2[1]) <= epsilon;

function genTrackPoints(distance, mapChoice = 'default', durationMinutes) {
  const targetDistance = Number(distance);
  if (!Number.isFinite(targetDistance) || targetDistance <= 0) return '[]';

  const locations = getMapData(mapChoice);
  if (!locations || locations.length === 0) return '[]';

  const coords = locations
    .map((point) => point.split(',').map(Number))
    .filter((pair) => pair.length === 2 && pair.every((num) => !Number.isNaN(num)));
  if (coords.length < 2) return '[]';

  const sanitized = [];
  coords.forEach((pt, idx) => {
    if (idx === 0 || !arePointsEqual(pt, coords[idx - 1])) {
      sanitized.push(pt);
    }
  });
  if (sanitized.length > 1 && arePointsEqual(sanitized[0], sanitized[sanitized.length - 1])) {
    sanitized.pop();
  }
  if (sanitized.length < 2) return '[]';

  const bounds = sanitized.reduce(
    (acc, [lng, lat]) => {
      acc.minLng = Math.min(acc.minLng, lng);
      acc.maxLng = Math.max(acc.maxLng, lng);
      acc.minLat = Math.min(acc.minLat, lat);
      acc.maxLat = Math.max(acc.maxLat, lat);
      return acc;
    },
    { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity }
  );

  const segments = [];
  for (let i = 0; i < sanitized.length; i++) {
    const from = sanitized[i];
    const to = sanitized[(i + 1) % sanitized.length];
    const len = getDistance(from, to);
    if (len >= 0.5) {
      segments.push({ from, to, length: len });
    }
  }
  if (segments.length === 0) return '[]';

  const minPace = 6;
  const maxPace = 10;
  const inferredPace = Number(durationMinutes) > 0
    ? durationMinutes / (targetDistance / 1000)
    : 7.6 + Math.random() * 1.2;
  const pace = clampValue(inferredPace, minPace, maxPace);
  const durationMs = Math.round((targetDistance / 1000) * pace * 60 * 1000);
  const baseSpeed = 1000 / (pace * 60);

  const baseSpacing = clampValue(targetDistance / 1200, 4, 8);
  const maxTotalPoints = 4000;
  const jitter = 0.000003;
  const bboxPad = 0.00005;

  const addJitter = ([lng, lat]) => [
    clampValue(lng + (Math.random() - 0.5) * 2 * jitter, bounds.minLng - bboxPad, bounds.maxLng + bboxPad),
    clampValue(lat + (Math.random() - 0.5) * 2 * jitter, bounds.minLat - bboxPad, bounds.maxLat + bboxPad),
  ];

  const projectOnSegment = (seg, offsetMeters) => {
    const t = clampValue(offsetMeters / seg.length, 0, 1);
    const lng = seg.from[0] + (seg.to[0] - seg.from[0]) * t;
    const lat = seg.from[1] + (seg.to[1] - seg.from[1]) * t;
    return [lng, lat];
  };

  let segIndex = Math.floor(Math.random() * segments.length);
  let segOffset = Math.random() * Math.max(1, segments[segIndex].length * 0.6);
  let lastPoint = addJitter(projectOnSegment(segments[segIndex], segOffset));

  const startTime = Date.now() - durationMs - Math.floor(Math.random() * 60000 + 20000);
  let currentTime = startTime;
  let elapsedMs = 0;
  let generatedDistance = 0;
  let currentSpeed = baseSpeed;

  const result = [`${lastPoint[0]}-${lastPoint[1]}`];

  while (generatedDistance < targetDistance && result.length < maxTotalPoints) {
    const remainingDistance = targetDistance - generatedDistance;
    const stepTarget = Math.min(remainingDistance, baseSpacing * (0.9 + Math.random() * 0.35));
    let advance = stepTarget;

    while (advance > 0) {
      const seg = segments[segIndex];
      const remainingOnSeg = seg.length - segOffset;
      const stepThisSeg = Math.min(advance, remainingOnSeg);
      segOffset += stepThisSeg;
      advance -= stepThisSeg;

      if (segOffset >= seg.length - 1e-6) {
        segIndex = (segIndex + 1) % segments.length;
        segOffset = 0;
      }
    }

    const rawPoint = projectOnSegment(segments[segIndex], segOffset);
    const point = addJitter(rawPoint);

    const traveled = getDistance(lastPoint, point);
    generatedDistance += traveled;

    const remainingTime = Math.max(2000, durationMs - elapsedMs);
    const neededSpeed = remainingDistance > 0 ? remainingDistance / (remainingTime / 1000) : baseSpeed;
    const targetSpeed = clampValue(
      (baseSpeed * 0.6 + neededSpeed * 0.4) * (0.95 + Math.random() * 0.1),
      baseSpeed * 0.8,
      baseSpeed * 1.2
    );
    currentSpeed = clampValue(currentSpeed * 0.65 + targetSpeed * 0.35, baseSpeed * 0.75, baseSpeed * 1.25);

    const stepTime = (traveled / Math.max(0.5, currentSpeed)) * 1000;
    elapsedMs += stepTime;

    result.push(`${point[0]}-${point[1]}`);
    lastPoint = point;
  }

  return JSON.stringify(result);
}

// ------------------------------------------------------------
// Run bounds / duration — copy of app/src/utils/run.js
// ------------------------------------------------------------

const DEFAULT_DISTANCE_MIN = 1001;
const DEFAULT_DISTANCE_MAX = 9000;
const MIN_PACE_MINUTES_PER_KM = 6;
const MAX_PACE_MINUTES_PER_KM = 10;

const toFiniteNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const toPositiveNumber = (value) => {
  const num = toFiniteNumber(value, 0);
  return num > 0 ? num : 0;
};

const toInteger = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

const getRandom = (rng) => {
  if (typeof rng === 'function') {
    const v = Number(rng());
    if (Number.isFinite(v) && v >= 0 && v < 1) return v;
  }
  return Math.random();
};

const randomInt = (min, max, rng) => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(getRandom(rng) * (hi - lo + 1));
};

function normalizeGender(raw) {
  const gender = String(raw ?? '').trim().toLowerCase();
  if (['1', 'male', 'man', 'm', 'boy', 'nan'].includes(gender)) return 'male';
  if (['2', 'female', 'woman', 'f', 'girl', 'nv'].includes(gender)) return 'female';
  return '';
}

const maxFloat = (a, b) => (a > b ? a : b);

const minPositive = (a, b) => {
  const aPos = toPositiveNumber(a);
  const bPos = toPositiveNumber(b);

  if (aPos > 0 && bPos > 0) return Math.min(aPos, bPos);
  if (aPos > 0) return aPos;
  if (bPos > 0) return bPos;
  return 0;
};

const selectOnceRunDistanceMin = (gender, runStandard = {}) => {
  const normalized = normalizeGender(gender);
  const boy = toPositiveNumber(runStandard?.boyOnceDistanceMin);
  const girl = toPositiveNumber(runStandard?.girlOnceDistanceMin);

  if (normalized === 'male') return boy;
  if (normalized === 'female') return girl;
  return maxFloat(boy, girl);
};

const selectOnceRunDistanceMax = (gender, runStandard = {}) => {
  const normalized = normalizeGender(gender);
  const boy = toPositiveNumber(runStandard?.boyOnceDistanceMax);
  const girl = toPositiveNumber(runStandard?.girlOnceDistanceMax);

  if (normalized === 'male') return boy;
  if (normalized === 'female') return girl;
  return maxFloat(boy, girl);
};

function calculateDistanceBounds(gender, runStandard = {}, defaults = {}) {
  const defaultMin = Math.max(1, Math.trunc(toFiniteNumber(defaults?.min, DEFAULT_DISTANCE_MIN)));
  const defaultMax = Math.max(defaultMin, Math.trunc(toFiniteNumber(defaults?.max, DEFAULT_DISTANCE_MAX)));

  const onceDistanceMin = selectOnceRunDistanceMin(gender, runStandard);
  const onceDistanceMax = selectOnceRunDistanceMax(gender, runStandard);
  let minDistance = defaultMin;
  let maxDistance = defaultMax;

  if (onceDistanceMin > 0 || onceDistanceMax > 0) {
    if (onceDistanceMin > 0) {
      minDistance = Math.max(1, Math.trunc(onceDistanceMin) + 1);
    }
    if (onceDistanceMax > 0) {
      maxDistance = Math.max(minDistance, Math.trunc(onceDistanceMax) + 1001);
    }
  }

  if (maxDistance < minDistance) {
    maxDistance = minDistance;
  }

  return { min: minDistance, max: maxDistance };
}

function calculateTimeBounds(gender, runStandard = {}) {
  const normalized = normalizeGender(gender);

  const boyMin = toPositiveNumber(runStandard?.boyOnceTimeMin);
  const boyMax = toPositiveNumber(runStandard?.boyOnceTimeMax);
  const girlMin = toPositiveNumber(runStandard?.girlOnceTimeMin);
  const girlMax = toPositiveNumber(runStandard?.girlOnceTimeMax);

  let minTime = 0;
  let maxTime = 0;

  if (normalized === 'male') {
    minTime = boyMin;
    maxTime = boyMax;
  } else if (normalized === 'female') {
    minTime = girlMin;
    maxTime = girlMax;
  } else {
    minTime = minPositive(boyMin, girlMin);
    maxTime = maxFloat(boyMax, girlMax);
  }

  if (minTime > 0 && maxTime > 0 && minTime > maxTime) {
    return { min: maxTime, max: minTime };
  }

  return { min: minTime, max: maxTime };
}

function resolveRunBoundsFromStandard(userInfo = {}, runStandard = {}, defaults = {}) {
  const fallbackGender = userInfo?.gender ?? userInfo?.sex;
  const gender = normalizeGender(fallbackGender);
  const distance = calculateDistanceBounds(gender, runStandard, defaults);
  const time = calculateTimeBounds(gender, runStandard);

  return {
    gender,
    distanceMin: distance.min,
    distanceMax: distance.max,
    timeMin: time.min,
    timeMax: time.max,
  };
}

function avoidRoundedTenValue(value, min, max, rng) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const current = clamp(Math.trunc(value), lo, hi);

  if (current % 10 !== 0) return current;

  let bestDelta = hi - lo + 1;
  const candidates = [];

  for (let v = lo; v <= hi; v += 1) {
    if (v % 10 === 0) continue;
    const delta = Math.abs(v - current);
    if (delta < bestDelta) {
      bestDelta = delta;
      candidates.length = 0;
      candidates.push(v);
    } else if (delta === bestDelta) {
      candidates.push(v);
    }
  }

  if (!candidates.length) return current;
  return candidates[randomInt(0, candidates.length - 1, rng)];
}

function randomIntNonThousand(min = DEFAULT_DISTANCE_MIN, max = DEFAULT_DISTANCE_MAX, rng) {
  let lo = toInteger(min, DEFAULT_DISTANCE_MIN);
  let hi = toInteger(max, DEFAULT_DISTANCE_MAX);

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = DEFAULT_DISTANCE_MIN;
    hi = DEFAULT_DISTANCE_MAX;
  }

  if (lo > hi) {
    const tmp = lo;
    lo = hi;
    hi = tmp;
  }

  if (lo === hi) {
    return avoidRoundedTenValue(lo, lo, hi, rng);
  }

  const span = hi - lo + 1;
  for (let i = 0; i < 64; i += 1) {
    const v = lo + Math.floor(getRandom(rng) * span);
    if (v % 10 !== 0) return v;
  }

  return avoidRoundedTenValue(lo + Math.floor(getRandom(rng) * span), lo, hi, rng);
}

function avoidMultipleOf(value, modulus = 1000, opts = {}) {
  const current = Number(value) || 0;
  if (!modulus || current % modulus !== 0) return current;

  const minOffset = toInteger(opts?.min, 1);
  const maxOffset = toInteger(opts?.max, 59);
  const lo = Math.min(minOffset, maxOffset);
  const hi = Math.max(minOffset, maxOffset);
  const offset = randomInt(lo, hi, opts?.rng);

  return current + offset;
}

const resolvePaceBounds = (distanceMeters, minMinutes, maxMinutes) => {
  const km = distanceMeters / 1000;
  let minPace = MIN_PACE_MINUTES_PER_KM;
  let maxPace = MAX_PACE_MINUTES_PER_KM;

  if (km > 0 && minMinutes > 0) {
    minPace = Math.max(minPace, minMinutes / km);
  }
  if (km > 0 && maxMinutes > 0) {
    maxPace = Math.min(maxPace, maxMinutes / km);
  }

  return { minPace, maxPace };
};

function computeDurationFromDistance(distanceMeters, opts = {}) {
  const dist = toFiniteNumber(distanceMeters, 0);
  if (dist <= 0) return 0;

  let minMinutes = toPositiveNumber(opts?.minMinutes);
  let maxMinutes = toPositiveNumber(opts?.maxMinutes);

  if (minMinutes > 0 && maxMinutes > 0 && minMinutes > maxMinutes) {
    const tmp = minMinutes;
    minMinutes = maxMinutes;
    maxMinutes = tmp;
  }

  const randomFn = opts?.rng;
  const km = dist / 1000;
  const { minPace, maxPace } = resolvePaceBounds(dist, minMinutes, maxMinutes);

  let seconds;
  if (minPace <= maxPace) {
    const pace = minPace + (maxPace - minPace) * getRandom(randomFn);
    seconds = Math.round(km * pace * 60);
  } else {
    const pace = MIN_PACE_MINUTES_PER_KM + (MAX_PACE_MINUTES_PER_KM - MIN_PACE_MINUTES_PER_KM) * getRandom(randomFn);
    seconds = Math.round(km * pace * 60);
  }

  if (seconds % 1000 === 0) {
    seconds = avoidMultipleOf(seconds, 1000, { min: 5, max: 59, rng: randomFn });
  }

  let duration = Math.max(1, seconds / 60);
  if (minMinutes > 0 && duration < minMinutes) duration = minMinutes;
  if (maxMinutes > 0 && duration > maxMinutes) duration = maxMinutes;

  return Number(duration.toFixed(1));
}

function deriveRoundedRunTimeBounds(distanceMeters, minMinutes = 0, maxMinutes = 0) {
  const dist = toPositiveNumber(distanceMeters);
  let minRounded = minMinutes > 0 ? Math.ceil(minMinutes) : 1;
  let maxRounded = maxMinutes > 0 ? Math.floor(maxMinutes) : 0;

  if (dist > 0) {
    const km = dist / 1000;
    const paceMinRounded = Math.ceil(km * MIN_PACE_MINUTES_PER_KM);
    if (paceMinRounded > minRounded) minRounded = paceMinRounded;

    const paceMaxRounded = Math.floor(km * MAX_PACE_MINUTES_PER_KM);
    if (paceMaxRounded > 0 && (maxRounded === 0 || paceMaxRounded < maxRounded)) {
      maxRounded = paceMaxRounded;
    }
  }

  if (maxRounded > 0 && maxRounded < minRounded) {
    maxRounded = minRounded;
  }
  if (minRounded < 1) minRounded = 1;

  return { minRounded, maxRounded };
}

function avoidRoundedTenMinute(value, minBound = 1, maxBound = 0, rng) {
  let current = Math.max(1, Math.trunc(value));
  const lowerBound = Math.max(1, Math.trunc(minBound));
  let upperBound = Math.trunc(maxBound);

  if (upperBound > 0 && upperBound < lowerBound) {
    upperBound = lowerBound;
  }

  if (current % 10 !== 0) return current;

  if (upperBound > 0) {
    const adjusted = avoidRoundedTenValue(current, lowerBound, upperBound, rng);
    if (adjusted % 10 !== 0) return adjusted;
  }

  for (let step = 1; step <= 9; step += 1) {
    const up = current + step;
    if (up >= lowerBound && up % 10 !== 0) return up;

    const down = current - step;
    if (down >= lowerBound && down % 10 !== 0) return down;
  }

  current += 1;
  if (current < lowerBound) current = lowerBound;
  if (current % 10 === 0) current += 1;
  return current;
}

function normalizeRoundedRunTime(runTimeMinutes, distanceMeters, opts = {}) {
  const randomFn = opts?.rng;
  const minMinutes = toPositiveNumber(opts?.minMinutes);
  const maxMinutes = toPositiveNumber(opts?.maxMinutes);

  let rounded = Math.round(toFiniteNumber(runTimeMinutes, 0));
  if (rounded < 1) rounded = 1;

  const { minRounded, maxRounded } = deriveRoundedRunTimeBounds(distanceMeters, minMinutes, maxMinutes);
  if (rounded < minRounded) rounded = minRounded;
  if (maxRounded > 0 && rounded > maxRounded) rounded = maxRounded;

  rounded = avoidRoundedTenMinute(rounded, minRounded, maxRounded, randomFn);
  if (rounded < minRounded) rounded = minRounded;
  if (maxRounded > 0 && rounded > maxRounded) rounded = maxRounded;
  if (rounded < 1) rounded = 1;

  return rounded;
}

function calculatePaceMinutesPerKm(distanceMeters, durationMinutes) {
  const distance = toFiniteNumber(distanceMeters, 0);
  const duration = toFiniteNumber(durationMinutes, 0);

  if (distance <= 0 || duration <= 0) return 0;

  const pace = duration / (distance / 1000);
  return Number.isFinite(pace) ? Number(pace.toFixed(2)) : 0;
}

// copy of app/src/composables/useRunSubmission.js
function buildYearSemester(date) {
  const year = date.getFullYear();
  const semester = date.getMonth() + 1 < 8 ? '1' : '2';
  return `${year}${semester}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// ------------------------------------------------------------
// Daily plan — deterministic per calendar day
//
// Seeded by `${studentId}:${dateKey}` so that a server restart in the
// middle of a day reproduces the exact same planned time+距离 instead of
// rolling new dice (which would risk a second run the same day).
// ------------------------------------------------------------

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseHm(value, fallback) {
  const raw = String(value ?? '').trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return fallback;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return fallback;
  return h * 60 + mi;
}

/**
 * Deterministically plan today's run.
 * @returns {{ hour:number, minute:number, distance:number, targetTimestamp:number }}
 */
function pickDailyPlan(opts = {}) {
  const studentId = String(opts.studentId || 'anon');
  const date = opts.date instanceof Date ? opts.date : new Date();
  const dateKey = opts.dateKey || localDateKey(date);
  const windowStart = parseHm(opts.windowStart, 8 * 60);
  const windowEnd = parseHm(opts.windowEnd, 22 * 60);
  const lo = Math.min(windowStart, windowEnd);
  const hi = Math.max(windowStart, windowEnd);

  const rng = mulberry32(hashSeed(`${studentId}:${dateKey}`));

  // Random minute inside [lo, hi); avoid landing exactly on the boundary.
  const span = Math.max(1, hi - lo);
  const minutesOfDay = Math.min(hi - 1 >= lo ? hi - 1 : hi, lo + Math.floor(rng() * span));
  const hour = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;

  const distanceMin = toInteger(opts.distanceMin, 1500);
  const distanceMax = toInteger(opts.distanceMax, 4500);
  const distance = randomIntNonThousand(distanceMin, distanceMax, rng);

  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);

  return { hour, minute, distance, targetTimestamp: target.getTime(), dateKey };
}

// ------------------------------------------------------------
// Record body — copy of app/src/composables/useApi.js saveNewRecord
// ------------------------------------------------------------

const DEFAULT_DEVICE = { brand: 'Apple', mobileType: 'iPhone', sysVersion: '18.6', deviceType: '2' };

function buildRecordBody({ trackPoints, distance, runTime, userId, recordDate, yearSemester, device, appVersion }) {
  const dev = device || DEFAULT_DEVICE;
  return {
    againRunStatus: '0',
    againRunTime: 0,
    appVersions: appVersion || '3.6.0',
    brand: dev.brand,
    mobileType: dev.mobileType,
    sysVersions: dev.sysVersion,
    trackPoints,
    distanceTimeStatus: '1',
    innerSchool: '1',
    runDistance: Math.round(distance),
    runTime: Math.round(runTime),
    userId: Number(userId),
    vocalStatus: '1',
    yearSemester,
    recordDate,
  };
}

/**
 * Build a complete run payload (distance + duration + track) from a plan.
 * Same math as the browser submitRun() path.
 */
function buildRunPayload({ distance, mapId = 'default', bounds = {} }) {
  const { distanceMin, distanceMax } = bounds;
  void distanceMin; void distanceMax;

  const resolvedDistance = Number(distance);
  if (!Number.isFinite(resolvedDistance) || resolvedDistance <= 0) return null;

  const opts = { minMinutes: bounds.timeMin, maxMinutes: bounds.timeMax };
  const duration = computeDurationFromDistance(resolvedDistance, opts);
  const runTime = normalizeRoundedRunTime(duration, resolvedDistance, opts);
  const trackPoints = genTrackPoints(resolvedDistance, mapId, runTime);

  if (!trackPoints || trackPoints === '[]') return null;

  return {
    distance: Math.round(resolvedDistance),
    runTime,
    trackPoints,
    mapId,
    pace: calculatePaceMinutesPerKm(resolvedDistance, runTime),
  };
}

module.exports = {
  // maps
  getAvailableMapIds,
  getMapNames,
  getMapData,
  getDistance,
  // track
  genTrackPoints,
  // run math
  DEFAULT_DISTANCE_MIN,
  DEFAULT_DISTANCE_MAX,
  normalizeGender,
  calculateDistanceBounds,
  calculateTimeBounds,
  resolveRunBoundsFromStandard,
  randomIntNonThousand,
  computeDurationFromDistance,
  normalizeRoundedRunTime,
  calculatePaceMinutesPerKm,
  buildYearSemester,
  localDateKey,
  // planning
  parseHm,
  hashSeed,
  mulberry32,
  pickDailyPlan,
  buildRecordBody,
  buildRunPayload,
};
