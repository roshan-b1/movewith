// Anonymous usage counts: how many different people visit and upload. One tiny row per
// event, sent to Supabase over plain REST (no SDK, no cookies). The whole "identity" is
// a random id in localStorage — nothing personal, and the videos themselves never leave
// the device. No-ops entirely when the env vars are unset (local dev, forks).

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** Stable random id for "different people" counts. Not tied to anything real. */
function anonId(): string {
  const key = 'movewith.anonId'
  try {
    let id = localStorage.getItem(key)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(key, id)
    }
    return id
  } catch {
    return 'no-storage'
  }
}

/** Fire-and-forget event. Analytics must never throw, block, or break the app. */
export function trackEvent(event: string, props?: Record<string, unknown>): void {
  if (!SUPABASE_URL || !SUPABASE_KEY) return
  try {
    void fetch(`${SUPABASE_URL}/rest/v1/events`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ event, anon_id: anonId(), props: props ?? null }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* never let analytics surface an error */
  }
}

let visitSent = false
/** One 'visit' per page load, however many times init runs. */
export function trackVisitOnce(): void {
  if (visitSent) return
  visitSent = true
  trackEvent('visit')
}
