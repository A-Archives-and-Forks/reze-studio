"use client"

import {
  memo,
  forwardRef,
  type ChangeEvent,
  type InputHTMLAttributes,
  type RefObject,
} from "react"
import Link from "next/link"
import Image from "next/image"
import { FilePlus2, FolderOpen, FileMusic, FileDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Menubar,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
} from "@/components/ui/menubar"
import { BoneList } from "@/components/bone-list"
import { MorphList } from "@/components/morph-list"
import type { AnimationClip } from "reze-engine"

/** Canvas + error overlay — playhead updates won’t reconcile this subtree. */
export const EditorViewport = memo(
  forwardRef<
    HTMLCanvasElement,
    { engineError: string | null }
  >(function EditorViewport({ engineError }, ref) {
    return (
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <canvas ref={ref} className="block h-full w-full touch-none" />
        {engineError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 p-4 text-center text-sm text-muted-foreground">
            {engineError}
          </div>
        ) : null}
      </div>
    )
  }),
)

export type EditorLeftPanelProps = {
  vmdInputRef: RefObject<HTMLInputElement | null>
  pmxFolderInputRef: RefObject<HTMLInputElement | null>
  onPickVmdFile: (e: ChangeEvent<HTMLInputElement>) => void
  onPickPmxFolder: (e: ChangeEvent<HTMLInputElement>) => void
  menubarValue: string
  onMenubarValueChange: (v: string) => void
  studioReady: boolean
  resetEditorState: () => void
  exportClipVmd: () => void
  hasClip: boolean
  pmxPickFiles: File[] | null
  pmxPickPaths: string[]
  pmxPickSelected: string
  onPmxPickSelectedChange: (path: string) => void
  onConfirmPmxPick: () => void
  modelBones: string[]
  clip: AnimationClip | null
  selectedGroup: string
  activeBone: string | null
  onSelectGroup: (g: string) => void
  onSelectBone: (b: string) => void
  morphNames: string[]
  activeMorph: string | null
  onSelectMorph: (name: string) => void
  docsReadmeUrl: string
  repoUrl: string
  appVersion: string
}

/** File menu + bone/morph lists — no dependency on playhead. */
export const EditorLeftPanel = memo(function EditorLeftPanel({
  vmdInputRef,
  pmxFolderInputRef,
  onPickVmdFile,
  onPickPmxFolder,
  menubarValue,
  onMenubarValueChange,
  studioReady,
  resetEditorState,
  exportClipVmd,
  hasClip,
  pmxPickFiles,
  pmxPickPaths,
  pmxPickSelected,
  onPmxPickSelectedChange,
  onConfirmPmxPick,
  modelBones,
  clip,
  selectedGroup,
  activeBone,
  onSelectGroup,
  onSelectBone,
  morphNames,
  activeMorph,
  onSelectMorph,
  docsReadmeUrl,
  repoUrl,
  appVersion,
}: EditorLeftPanelProps) {
  return (
    <aside className="flex w-[225px] shrink-0 flex-col border-r border-border">
      <div className="shrink-0 border-b">
        <div className="pl-2 pt-0 flex items-center justify-between pb-1">
          <h1 className="scroll-m-20 max-w-[11rem] text-md font-extrabold leading-tight tracking-tight text-balance">
            REZE STUDIO
          </h1>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button variant="ghost" size="sm" asChild className="hover:bg-black hover:text-white rounded-full">
              <Link href="https://github.com/AmyangXYZ/reze-studio" target="_blank">
                <Image src="/github-mark-white.svg" alt="GitHub" width={16} height={16} />
              </Link>
            </Button>
          </div>
        </div>

        <div className="px-3 pb-2">
          <input
            ref={vmdInputRef}
            type="file"
            accept=".vmd"
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={onPickVmdFile}
          />
          <input
            ref={pmxFolderInputRef}
            type="file"
            className="fixed left-0 top-0 -z-10 h-px w-px opacity-0"
            multiple
            {...({ webkitdirectory: "", mozdirectory: "" } as InputHTMLAttributes<HTMLInputElement>)}
            onChange={onPickPmxFolder}
          />
          <Menubar
            value={menubarValue}
            onValueChange={onMenubarValueChange}
            className="h-4 gap-0 rounded-none border-0 bg-transparent p-0 shadow-none"
          >
            <MenubarMenu value="file">
              <MenubarTrigger className="h-4 rounded-sm px-1.5 py-0 text-xs font-normal text-muted-foreground">
                File
              </MenubarTrigger>
              <MenubarContent sideOffset={4} className="min-w-[10.5rem] p-0.5 text-xs">
                <MenubarGroup>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady}
                    onSelect={resetEditorState}
                  >
                    <FilePlus2 className="size-3.5" />
                    New
                  </MenubarItem>
                  <MenubarSeparator className="my-0.5" />
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    onSelect={(e) => {
                      e.preventDefault()
                      pmxFolderInputRef.current?.click()
                    }}
                  >
                    <FolderOpen className="size-3.5" />
                    Load PMX folder…
                  </MenubarItem>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady}
                    onSelect={() => vmdInputRef.current?.click()}
                  >
                    <FileMusic className="size-3.5" />
                    Load VMD…
                  </MenubarItem>
                </MenubarGroup>
                <MenubarSeparator className="my-0.5" />
                <MenubarGroup>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady || !hasClip}
                    onSelect={exportClipVmd}
                  >
                    <FileDown className="size-3.5" />
                    Export VMD…
                  </MenubarItem>
                </MenubarGroup>
              </MenubarContent>
            </MenubarMenu>
            <MenubarMenu value="help">
              <MenubarTrigger className="h-4 rounded-sm px-1.5 py-0 text-xs font-normal text-muted-foreground">
                Help
              </MenubarTrigger>
              <MenubarContent sideOffset={4} className="min-w-[11rem] p-0.5 text-xs">
                <MenubarGroup>
                  <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground" asChild>
                    <Link href={docsReadmeUrl} target="_blank" rel="noreferrer">
                      Tutorial (README)
                    </Link>
                  </MenubarItem>
                  <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground" disabled>
                    Keyboard shortcuts…
                  </MenubarItem>
                  <MenubarSeparator className="my-0.5" />
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    onSelect={() => {
                      window.alert(`Reze Studio ${appVersion}\nWebGPU MMD editor — ${repoUrl}`)
                    }}
                  >
                    About Reze Studio
                  </MenubarItem>
                  <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground" asChild>
                    <Link href={`${repoUrl}/issues`} target="_blank" rel="noreferrer">
                      Report an issue
                    </Link>
                  </MenubarItem>
                </MenubarGroup>
              </MenubarContent>
            </MenubarMenu>
            <MenubarMenu value="settings">
              <MenubarTrigger className="h-4 rounded-sm px-1.5 py-0 text-xs font-normal text-muted-foreground">
                Settings
              </MenubarTrigger>
              <MenubarContent sideOffset={4} className="min-w-[10rem] p-0.5 text-xs">
                <MenubarGroup>
                  <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground" disabled>
                    Theme…
                  </MenubarItem>
                </MenubarGroup>
              </MenubarContent>
            </MenubarMenu>
          </Menubar>
          {pmxPickFiles && pmxPickPaths.length > 1 ? (
            <div className="mt-2 flex flex-col gap-1.5 rounded border border-border bg-muted/30 p-2 text-[10px]">
              <span className="text-muted-foreground">Multiple .pmx files — choose one:</span>
              <select
                className="w-full rounded border border-border bg-background px-1 py-0.5 text-[11px]"
                value={pmxPickSelected}
                onChange={(e) => onPmxPickSelectedChange(e.target.value)}
              >
                {pmxPickPaths.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => void onConfirmPmxPick()}
              >
                Load selected PMX
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-hidden">
          <BoneList
            modelBones={modelBones}
            clip={clip}
            selectedGroup={selectedGroup}
            activeBone={activeBone}
            onSelectGroup={onSelectGroup}
            onSelectBone={onSelectBone}
          />
        </div>
        <div className="flex max-h-[168px] shrink-0 flex-col border-t border-border">
          <div className="shrink-0 px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            Morphs
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <MorphList morphNames={morphNames} activeMorph={activeMorph} onSelectMorph={onSelectMorph} />
          </div>
        </div>
      </div>
    </aside>
  )
})

export type EditorStatusFooterProps = {
  statusPmxFileName: string
  clipDisplayName: string
  hasClip: boolean
  statusMessage: string
  statusFps: number | null
  appVersion: string
}

/** Status line — isolates FPS tick from timeline/properties reconciliation. */
export const EditorStatusFooter = memo(function EditorStatusFooter({
  statusPmxFileName,
  clipDisplayName,
  hasClip,
  statusMessage,
  statusFps,
  appVersion,
}: EditorStatusFooterProps) {
  return (
    <footer
      className="flex h-6 shrink-0 items-center gap-2 border-t border-border px-2 text-[10.5px] text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 shrink-0 items-center gap-x-2 [overflow-wrap:anywhere]">
        <span>
          Model:{" "}
          <span className="font-medium text-foreground" title={statusPmxFileName}>
            {statusPmxFileName}
          </span>
        </span>
        <span className="text-border" aria-hidden>
          ·
        </span>
        <span>
          Animation:{" "}
          <span className="font-medium text-foreground" title={hasClip ? `${clipDisplayName}.vmd` : undefined}>
            {hasClip ? `${clipDisplayName}.vmd` : "—"}
          </span>
        </span>
      </div>
      <div className="min-w-0 flex-1 truncate px-2 text-left text-[10px] text-muted-foreground/90">{statusMessage}</div>
      <div className="flex shrink-0 items-center gap-x-2 tabular-nums">
        <span title="Main-thread / compositor frame rate">
          {statusFps != null ? `${statusFps} FPS` : "— FPS"}
        </span>
        <span className="text-border" aria-hidden>
          ·
        </span>
        <span>v{appVersion}</span>
      </div>
    </footer>
  )
})
