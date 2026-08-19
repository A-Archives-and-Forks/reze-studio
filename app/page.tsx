"use client"

import dynamic from "next/dynamic"
import { Studio } from "@/context/studio-context"
import { Playback } from "@/context/playback-context"
import { StudioStatusProvider } from "@/components/studio-status"

/** Resizable panels (Bones/Morphs split) read localStorage on first render via
 *  `useDefaultLayout` — fine in the browser, but Next still executes client
 *  components once during static prerendering, where there is no localStorage
 *  to read. This app has no SSR-able content anyway, so skip that pass entirely. */
const StudioPage = dynamic(() => import("@/components/studio").then((m) => m.StudioPage), { ssr: false })

export default function Home() {
  return (
    <Studio>
      <Playback>
        <StudioStatusProvider>
          <StudioPage />
        </StudioStatusProvider>
      </Playback>
    </Studio>
  )
}
