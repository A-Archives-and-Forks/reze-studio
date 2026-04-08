"use client"

import { Studio } from "@/context/studio-context"
import { Playback } from "@/context/playback-context"
import { StudioPage } from "@/components/studio"

export default function Home() {
  return (
    <Studio>
      <Playback>
        <StudioPage />
      </Playback>
    </Studio>
  )
}
