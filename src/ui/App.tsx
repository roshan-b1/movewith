import { useEffect } from 'react'
import { useSession } from '../state/sessionStore'
import { Library } from './screens/Library'
import { Practice } from './screens/Practice'

export function App() {
  const screen = useSession((s) => s.screen)
  const init = useSession((s) => s.init)
  const status = useSession((s) => s.status)
  const activeTrack = useSession((s) => s.activeTrack)

  useEffect(() => {
    void init()
  }, [init])

  if (screen === 'practice' && activeTrack) return <Practice />

  if (status === 'loading' && useSession.getState().tracks.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
      </div>
    )
  }

  return <Library />
}
