const TERMINAL_AFFILIATE_STATES = new Set(['submitted', 'failed', 'cancelled']);

export function recoverableAffiliateJob(job) {
  return Boolean(job?.job_id && job?.application_host && job?.application_url
    && !TERMINAL_AFFILIATE_STATES.has(String(job.status || '').toLowerCase()));
}

export function affiliateTabMatches(job, tab) {
  if (!recoverableAffiliateJob(job) || !Number.isInteger(Number(tab?.id))) return false;
  try {
    const url = new URL(String(tab.url || tab.pendingUrl || ''));
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === String(job.application_host).toLowerCase();
  } catch { return false; }
}

export function chooseAffiliateRecoveryTab(job, tabs = []) {
  return [...tabs].filter((tab) => affiliateTabMatches(job, tab)).sort((left, right) => {
    if (Boolean(left.active) !== Boolean(right.active)) return left.active ? -1 : 1;
    return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
  })[0] ?? null;
}

export function recoveredAffiliateState(job, tab, plan = null) {
  if (!affiliateTabMatches(job, tab)) throw new Error('Affiliate job does not match the recovery tab.');
  return {
    affiliate_application_command: job,
    affiliate_application_tab_id: Number(tab.id),
    affiliate_fill_plan: plan || null,
    affiliate_ai_suggestions: [],
    affiliate_auto_fill_pending: true,
    helper_context: {
      mode: 'affiliate', route: '', label: 'Đăng ký Affiliate', source: 'recovery', updated_at: Date.now(),
    },
  };
}
