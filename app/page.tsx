"use client"

import { useEffect, useRef, useState } from "react"
import { Engine, Model, Vec3 } from "reze-engine"
import { Button } from "@/components/ui/button"
import {
  Menubar,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar"
import Link from "next/link"
import Image from "next/image"

const MODEL_PATH = "/models/reze/reze.pmx"

/** Studio shell + WebGPU viewport; keep engineRef/modelRef here for panels/transport later. */
export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const modelRef = useRef<Model | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const el = canvas

    let disposed = false

    async function initEngine() {
      try {
        const engine = new Engine(el, {
          ambientColor: new Vec3(0.86, 0.84, 0.88),
          cameraDistance: 31.5,
          cameraTarget: new Vec3(0, 11.5, 0),
        })

        await engine.init()
        if (disposed) return

        engine.setPhysicsEnabled(false)
        engine.addGround({
          diffuseColor: new Vec3(0.14, 0.12, 0.16),
        })

        try {
          const model = await engine.loadModel("reze", MODEL_PATH)
          if (disposed) return
          modelRef.current = model
          model.setMorphWeight("抗穿模", 0.5)
        } catch {
          setEngineError(`Add model at public${MODEL_PATH}`)
        }

        engine.runRenderLoop()
        engineRef.current = engine
      } catch (e) {
        console.error(e)
        setEngineError(e instanceof Error ? e.message : String(e))
      }
    }

    void initEngine()

    return () => {
      disposed = true
      modelRef.current = null
      engineRef.current?.stopRenderLoop()
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [])

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden text-foreground">
      <div className="flex min-h-0 flex-1">
        {/* Left 240px */}
        <aside className="flex w-[270px] shrink-0 flex-col border-r border-border">
          <div className="shrink-0 border-b">
            <div className="pl-2 pt-0 flex items-center justify-between pb-1">
              <h1 className="scroll-m-20 text-center text-md font-extrabold tracking-tight text-balance">
                REZE STUDIO
              </h1>
              <Button variant="ghost" size="sm" asChild className="hover:bg-black hover:text-white rounded-full">
                <Link href="https://github.com/AmyangXYZ/reze-studio" target="_blank">
                  <Image src="/github-mark-white.svg" alt="GitHub" width={16} height={16} />
                </Link>
              </Button>
            </div>

            <div className="px-3 pb-2">
              <Menubar className="h-4 gap-0 rounded-none border-0 bg-transparent p-0 shadow-none">
                <MenubarMenu>
                  <MenubarTrigger className="h-4 rounded-sm px-1.5 py-0 text-xs font-normal text-muted-foreground">
                    File
                  </MenubarTrigger>
                  <MenubarContent
                    sideOffset={4}
                    className="min-w-[10.5rem] p-0.5 text-xs"
                  >
                    <MenubarGroup>
                      <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-xs">
                        Load model…
                      </MenubarItem>
                      <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-xs">
                        Load animation…
                      </MenubarItem>
                    </MenubarGroup>
                    <MenubarSeparator className="my-0.5" />
                    <MenubarGroup>
                      <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-xs">
                        Export…
                      </MenubarItem>
                    </MenubarGroup>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger className="h-4 rounded-sm px-1.5 py-0 text-xs font-normal text-muted-foreground">
                    Edit
                  </MenubarTrigger>
                  <MenubarContent sideOffset={4} className="min-w-[9rem] p-0.5 text-xs">
                    <MenubarGroup>
                      <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-xs" disabled>
                        Undo
                        <MenubarShortcut className="text-[10px] tracking-wide">⌘Z</MenubarShortcut>
                      </MenubarItem>
                      <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-xs" disabled>
                        Redo
                        <MenubarShortcut className="text-[10px] tracking-wide">⇧⌘Z</MenubarShortcut>
                      </MenubarItem>
                    </MenubarGroup>
                  </MenubarContent>
                </MenubarMenu>
                <MenubarMenu>
                  <MenubarTrigger className="h-4 rounded-sm px-1.5 py-0 text-xs font-normal text-muted-foreground">
                    Preferences
                  </MenubarTrigger>
                  <MenubarContent sideOffset={4} className="min-w-[10rem] p-0.5 text-xs">
                    <MenubarGroup>
                      <MenubarItem className="py-1 pl-2 pr-1.5 text-xs" disabled>
                        Theme…
                      </MenubarItem>
                      <MenubarItem className="py-1 pl-2 pr-1.5 text-xs" disabled>
                        Keyboard shortcuts…
                      </MenubarItem>
                    </MenubarGroup>
                  </MenubarContent>
                </MenubarMenu>
              </Menubar>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
            <div className="rounded-md border border-dashed border-border bg-muted/30 p-2.5 text-[10px] text-muted-foreground">
              Bones list (scroll)
            </div>
          </div>
          <div className="shrink-0 space-y-2 border-t border-border px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Morphs
            </div>
            <div className="h-24 rounded-md border border-dashed border-border bg-muted/30 p-2.5 text-[10px] text-muted-foreground">
              Sliders area
            </div>
          </div>
        </aside>

        {/* Center: viewport + graph */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <canvas ref={canvasRef} className="block h-full w-full touch-none" />
            {engineError ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 p-4 text-center text-sm text-muted-foreground">
                {engineError}
              </div>
            ) : null}
          </div>
          <div className="flex h-[200px] shrink-0 flex-col border-t border-border ">
            <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-3 text-[10px] text-muted-foreground">
              <span>Graph / Dope sheet toolbar</span>
            </div>
            <div className="min-h-0 flex-1 px-3 py-2">
              <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border bg-muted/30 text-[10px] text-muted-foreground">
                Value graph area
              </div>
            </div>
          </div>
        </div>

        {/* Right 240px */}
        <aside className="flex w-[240px] shrink-0 flex-col border-l border-border ">
          <div className="flex min-h-9 shrink-0 items-center border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
            Selection / props
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2">
            <div className="rounded-md border border-dashed border-border bg-muted/30 p-2.5 text-[10px] text-muted-foreground">
              Rotation / position
            </div>
            <div className="rounded-md border border-dashed border-border bg-muted/30 p-2.5 text-[10px] text-muted-foreground">
              Interpolation
            </div>
            <div className="rounded-md border border-dashed border-border bg-muted/30 p-2.5 text-[10px] text-muted-foreground">
              Actions
            </div>
          </div>
        </aside>
      </div>

      <footer className="flex h-12 shrink-0 items-center gap-2 border-t border-border  px-3">
        <div className="flex items-center gap-1">
          <Button type="button" variant="secondary" size="icon" className="size-8" aria-label="First frame">
            ⏮
          </Button>
          <Button type="button" variant="secondary" size="icon" className="size-8" aria-label="Previous frame">
            ◀
          </Button>
          <Button type="button" size="icon" className="size-9" aria-label="Play">
            ▶
          </Button>
        </div>
        <div className="rounded-md border border-border bg-muted/50 px-2 py-1 font-mono text-xs tabular-nums text-muted-foreground">
          F000 / 120
        </div>
        <div className="h-6 min-w-0 flex-1 rounded-md border border-dashed border-border bg-muted/30" />
        <span className="shrink-0 text-[10px] text-muted-foreground">30 fps</span>
      </footer>
    </div>
  )
}
