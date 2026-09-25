import { api } from '@/composables/useApi';
import { useDataStore } from '@/composables/useDataStore';
import { genTrackPoints } from '@/utils/track';
import {
  computeDurationFromDistance,
  normalizeRoundedRunTime,
  resolveRunBoundsFromStandard,
} from '@/utils/run';

const buildYearSemester = (date) => {
  const year = date.getFullYear();
  const semester = date.getMonth() + 1 < 8 ? '1' : '2';
  return `${year}${semester}`;
};

const resolveSubmissionRoute = (route, fallbackRoute) => {
  const picked = String(route || fallbackRoute || 'default').trim();
  return picked || 'default';
};

/**
 * 提交跑步记录
 * @param {{ distance: number, route?: string }} payload
 * @returns {Promise<{ok:true,data:any}|{ok:false,msg?:string,data?:any,error?:any,bounds?:{min:number,max:number}}>}
 */
export async function submitRun(payload = {}) {
  const dist = Number(payload?.distance);

  const { userId, studentId, schoolId, submitRunRoute, runStandard, userInfo } = useDataStore();
  const bounds = resolveRunBoundsFromStandard(userInfo.value || {}, runStandard.value || {});

  if (!Number.isInteger(dist) || dist <= 0) {
    return {
      ok: false,
      msg: 'distance_invalid',
      bounds: { min: 1, max: 0 },
    };
  }

  if (!userId.value || !studentId.value || !schoolId.value) {
    return { ok: false, msg: 'not_login' };
  }

  const route = resolveSubmissionRoute(payload?.route, submitRunRoute.value);

  let runTime = 0;
  let trackPoints = '';

  if (!runTime || !trackPoints) {
    const duration = computeDurationFromDistance(dist, {
      minMinutes: bounds.timeMin,
      maxMinutes: bounds.timeMax,
    });

    runTime = normalizeRoundedRunTime(duration, dist, {
      minMinutes: bounds.timeMin,
      maxMinutes: bounds.timeMax,
    });

    trackPoints = genTrackPoints(dist, route, runTime);
  }

  if (!trackPoints || trackPoints === '[]') {
    return { ok: false, msg: 'track_invalid' };
  }

  const now = new Date();
  const recordDate = now.toISOString().split('T')[0];
  const yearSemester = buildYearSemester(now);

  try {
    const { data } = await api.saveNewRecord(
      trackPoints,
      dist,
      runTime,
      userId.value,
      recordDate,
      yearSemester,
    );

    if (data?.code === 10000) {
      return { ok: true, data };
    }

    return { ok: false, data };
  } catch (error) {
    console.error('submitRun api error:', error);
    return { ok: false, error };
  }
}
