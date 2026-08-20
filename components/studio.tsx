"use client"

import {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
  memo,
  forwardRef,
  type ChangeEvent,
  type InputHTMLAttributes,
  type RefObject,
} from "react"
import Link from "next/link"
import Image from "next/image"
import { FilePlus2, FolderOpen, FileMusic, FileDown, RotateCcw, Check, Video, Orbit, Eraser, Music } from "lucide-react"
import { Engine, Model, Vec3, VMDLoader, VMDWriter, parsePmxFolderInput, pmxFileAtRelativePath } from "reze-engine"
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
import { MaterialList } from "@/components/material-list"
import { PropertiesInspector } from "@/components/properties-inspector"
import { Timeline } from "@/components/timeline"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useDefaultLayout } from "react-resizable-panels"
import { BONE_GROUPS, CAMERA_DEFAULT_TAB, isCameraTab, quatToEuler } from "@/lib/animation"
import { autoClassifyMaterials, buildStyleGroups, styleGroupsToPresetMap } from "@/lib/materials"
import type { AnimationClip, CameraKeyframe, MaterialPresetMap, VmdTrackSelection } from "reze-engine"
import { useStudioActions, useStudioSelector } from "@/context/studio-context"
import { usePlayback, usePlaybackFrameRef } from "@/context/playback-context"
import {
  EngineBridge,
  STUDIO_ANIM_NAME,
  MODEL_PATH,
  VMD_PATH,
  BUNDLED_PMX_FILENAME,
  AUDIO_PATH,
  CAMERA_VMD_PATH,
  MORPH_VMD_PATH,
  fileStem,
  sanitizeClipFilenameBase,
} from "@/components/engine-bridge"
import { StudioStatusFooter, useStudioStatusActions } from "@/components/studio-status"
import {
  clipRetainedForModel,
  emptyStudioClip,
  interpolationTemplateForFrame,
  readLocalPoseAfterSeek,
  simplifyBoneTrack,
  upsertMorphKeyframeAtFrame,
  cn,
  DEFAULT_STUDIO_CLIP_FRAMES,
} from "@/lib/utils"
import { clearDraft, flushDraftWrite, saveDraftSoon, type DraftExtras, type StoredTimelineView } from "@/lib/draft"
import { clearModelUpload, saveModelUpload } from "@/lib/model-store"
import { wasKeyboardInput } from "@/lib/last-input"
import { decodeAudioPeaks } from "@/lib/audio"
import { clearAudioUpload, loadAudioUpload, saveAudioUpload } from "@/lib/audio-store"
import { AudioBridge } from "@/components/audio-bridge"
import packageJson from "../package.json"

const APP_VERSION = packageJson.version
const REPO_URL = "https://github.com/AmyangXYZ/reze-studio"
const DOCS_README_URL = `${REPO_URL}/blob/main/README.md`

/**
 * How long the timeline should be once something has been cleared.
 *
 * `commit` only ever GROWS frameCount (clipAfterKeyframeEdit takes a max), which
 * is right for editing — deleting one key should not shorten the export — but
 * wrong after a clear: the length was describing content that no longer exists,
 * so the ruler kept running over an empty timeline. Falls back to the default
 * clip length rather than 0, so an emptied document still has somewhere to work.
 */
function durationAfterClear(clip: AnimationClip): number {
  let last = 0
  for (const t of clip.boneTracks.values()) for (const k of t) last = Math.max(last, k.frame)
  for (const t of clip.morphTracks.values()) for (const k of t) last = Math.max(last, k.frame)
  return last > 0 ? last : DEFAULT_STUDIO_CLIP_FRAMES
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a")
  const url = URL.createObjectURL(blob)
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Canvas + error overlay — playhead updates won’t reconcile this subtree. */
type StudioViewportProps = {
  engineError: string | null
  /** Shown only once a shot exists — with no camera track there is nothing to
   *  follow, and a toggle whose two states look identical is noise. */
  hasCameraTrack: boolean
  cameraVmdEnabled: boolean
  onToggleCameraVmd: () => void
}

const StudioViewport = memo(
  forwardRef<HTMLCanvasElement, StudioViewportProps>(function StudioViewport(
    { engineError, hasCameraTrack, cameraVmdEnabled, onToggleCameraVmd },
    ref,
  ) {
    return (
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <canvas ref={ref} className="block h-full w-full touch-none" />
        {/* Who is driving the view — the loaded shot, or your mouse. It floats
            over the canvas rather than living in the timeline toolbar because
            it is a property of what you are LOOKING at, not of the track you
            happen to be editing, and it has to stay reachable from any tab. */}
        {hasCameraTrack ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onToggleCameraVmd}
            title={
              cameraVmdEnabled
                ? "Following the camera track — click to orbit freely"
                : "Free orbit — click to follow the camera track"
            }
            className={cn(
              // Fixed square, icon only: the two states have to be the same
              // size or the button moves under the cursor as you toggle it.
              "absolute right-3 top-1/2 z-10 size-8 -translate-y-1/2 rounded-surface border p-0",
              cameraVmdEnabled
                ? "border-blue-400/30 bg-blue-400/[0.12] text-blue-400 hover:bg-blue-400/20"
                : "border-line-strong bg-surface-raised text-muted-foreground hover:text-foreground",
            )}
          >
            {cameraVmdEnabled ? <Video className="size-4" /> : <Orbit className="size-4" />}
          </Button>
        ) : null}
        {engineError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 p-4 text-center text-sm text-muted-foreground">
            {engineError}
          </div>
        ) : null}
      </div>
    )
  }),
)

type StudioLeftPanelProps = {
  vmdInputRef: RefObject<HTMLInputElement | null>
  pmxFolderInputRef: RefObject<HTMLInputElement | null>
  onPickVmdFile: (e: ChangeEvent<HTMLInputElement>) => void
  onPickPmxFolder: (e: ChangeEvent<HTMLInputElement>) => void
  menubarValue: string
  onMenubarValueChange: (v: string) => void
  studioReady: boolean
  resetStudioDocument: () => void
  resetToDefaultModel: () => void
  exportClipVmd: (tracks?: VmdTrackSelection) => void
  pmxPickFiles: File[] | null
  pmxPickPaths: string[]
  onPickPmxPath: (path: string) => void
  onCancelPmxPick: () => void
  modelBones: string[]
  selectedGroup: string
  selectedBone: string | null
  onSelectGroup: (g: string) => void
  onSelectBone: (b: string) => void
  boneListReveal: { bone: string; epoch: number } | null
  morphNames: string[]
  selectedMorph: string | null
  onSelectMorph: (name: string) => void
  docsReadmeUrl: string
  repoUrl: string
  appVersion: string
  onToggleIkEnabled: () => void
  cameraTrack: readonly CameraKeyframe[]
  cameraSelected: boolean
  onSelectCamera: () => void
  onPickCameraVmdFile: (e: ChangeEvent<HTMLInputElement>) => void
  cameraVmdInputRef: RefObject<HTMLInputElement | null>
  onPickMorphVmdFile: (e: ChangeEvent<HTMLInputElement>) => void
  morphVmdInputRef: RefObject<HTMLInputElement | null>
  exportCameraVmd: () => void
  clearMotionTracks: () => void
  clearMorphTracks: () => void
  clearCameraTrack: () => void
  onPickMusicFile: (e: ChangeEvent<HTMLInputElement>) => void
  musicInputRef: RefObject<HTMLInputElement | null>
  clearMusic: () => void
  hasMusic: boolean
}

/** File menu + bone/morph lists — lives in page so the shell isn’t a separate layout file. */
const StudioLeftPanel = memo(function StudioLeftPanel({
  vmdInputRef,
  pmxFolderInputRef,
  onPickVmdFile,
  onPickPmxFolder,
  menubarValue,
  onMenubarValueChange,
  studioReady,
  resetStudioDocument,
  resetToDefaultModel,
  exportClipVmd,
  pmxPickFiles,
  pmxPickPaths,
  onPickPmxPath,
  onCancelPmxPick,
  modelBones,
  selectedGroup,
  selectedBone,
  onSelectGroup,
  onSelectBone,
  boneListReveal,
  morphNames,
  selectedMorph,
  onSelectMorph,
  docsReadmeUrl,
  repoUrl,
  appVersion,
  onToggleIkEnabled,
  cameraTrack,
  cameraSelected,
  onSelectCamera,
  onPickCameraVmdFile,
  cameraVmdInputRef,
  onPickMorphVmdFile,
  morphVmdInputRef,
  exportCameraVmd,
  clearMotionTracks,
  clearMorphTracks,
  clearCameraTrack,
  onPickMusicFile,
  musicInputRef,
  clearMusic,
  hasMusic,
}: StudioLeftPanelProps) {
  const clip = useStudioSelector((s) => s.clip)
  const ikEnabled = useStudioSelector((s) => s.ikEnabled)
  const { defaultLayout: boneMorphLayout, onLayoutChanged: onBoneMorphLayoutChanged } = useDefaultLayout({
    id: "reze-studio.left-panel",
    panelIds: ["bones", "morphs"],
  })
  const hasClip = clip != null
  // A split export with nothing on that side would download an empty file —
  // valid VMD, useless download. Grey it out instead.
  const hasMotion = (clip?.boneTracks.size ?? 0) > 0
  const hasMorphs = (clip?.morphTracks.size ?? 0) > 0
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line-strong">
      <div className="shrink-0 border-b border-line">
        <div className="pl-2 pt-0 flex items-center justify-between pb-1">
        <h2 className="scroll-m-20 text-sm font-semibold tracking-tight first:mt-0">
          REZE STUDIO
        </h2>
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
          <input
            ref={morphVmdInputRef}
            type="file"
            accept=".vmd"
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={onPickMorphVmdFile}
          />
          <input
            ref={musicInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={onPickMusicFile}
          />
          <input
            ref={cameraVmdInputRef}
            type="file"
            accept=".vmd"
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={onPickCameraVmdFile}
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
              <MenubarContent sideOffset={4} className="min-w-32 p-0.5 text-xs">
                <MenubarGroup>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady}
                    onSelect={resetStudioDocument}
                  >
                    <FilePlus2 className="size-3.5" />
                    New project
                  </MenubarItem>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady}
                    onSelect={resetToDefaultModel}
                  >
                    <RotateCcw className="size-3.5" />
                    Reset project…
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
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady}
                    onSelect={() => morphVmdInputRef.current?.click()}
                  >
                    <FileMusic className="size-3.5" />
                    Load morph VMD…
                  </MenubarItem>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady}
                    onSelect={() => cameraVmdInputRef.current?.click()}
                  >
                    <Video className="size-3.5" />
                    Load camera VMD…
                  </MenubarItem>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    onSelect={() => musicInputRef.current?.click()}
                  >
                    <Music className="size-3.5" />
                    Import music…
                  </MenubarItem>
                </MenubarGroup>
                <MenubarSeparator className="my-0.5" />
                <MenubarGroup>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady || !hasClip}
                    onSelect={() => exportClipVmd("all")}
                  >
                    <FileDown className="size-3.5" />
                    Export VMD…
                  </MenubarItem>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady || !hasMotion}
                    onSelect={() => exportClipVmd("motion")}
                  >
                    <FileDown className="size-3.5" />
                    Export motion only…
                  </MenubarItem>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady || !hasMorphs}
                    onSelect={() => exportClipVmd("morphs")}
                  >
                    <FileDown className="size-3.5" />
                    Export morphs only…
                  </MenubarItem>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady || cameraTrack.length === 0}
                    onSelect={exportCameraVmd}
                  >
                    <Video className="size-3.5" />
                    Export camera…
                  </MenubarItem>
                </MenubarGroup>
                <MenubarSeparator className="my-0.5" />
                <MenubarGroup>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady || !hasMotion}
                    onSelect={clearMotionTracks}
                  >
                    <Eraser className="size-3.5" />
                    Clear motion
                  </MenubarItem>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady || !hasMorphs}
                    onSelect={clearMorphTracks}
                  >
                    <Eraser className="size-3.5" />
                    Clear morphs
                  </MenubarItem>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!studioReady || cameraTrack.length === 0}
                    onSelect={clearCameraTrack}
                  >
                    <Eraser className="size-3.5" />
                    Clear camera
                  </MenubarItem>
                  <MenubarItem
                    className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!hasMusic}
                    onSelect={clearMusic}
                  >
                    <Eraser className="size-3.5" />
                    Clear music
                  </MenubarItem>
                </MenubarGroup>

              </MenubarContent>
            </MenubarMenu>
            <MenubarMenu value="help">
              <MenubarTrigger className="h-4 rounded-sm px-1.5 py-0 text-xs font-normal text-muted-foreground">
                Help
              </MenubarTrigger>
              <MenubarContent sideOffset={4} className="min-w-32 p-0.5 text-xs">
                <MenubarGroup>
                  <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground" asChild>
                    <Link href={docsReadmeUrl} target="_blank" rel="noreferrer">
                      Tutorial (README)
                    </Link>
                  </MenubarItem>
                  <MenubarSeparator className="my-0.5" />
                  {/* Where an edited clip goes next: Studio makes the motion,
                      Design makes the picture. */}
                  <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground" asChild>
                    <Link href="https://reze.design" target="_blank" rel="noreferrer">
                      Render a scene — Reze Design
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
              <MenubarContent sideOffset={4} className="min-w-32 p-0.5 text-xs">
                <MenubarGroup>
                  <MenubarItem
                    className="justify-between gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground"
                    disabled={!clip}
                    onSelect={onToggleIkEnabled}
                  >
                    <span>IK Enabled</span>
                    {ikEnabled ? (
                      <Check className="size-3 shrink-0 text-blue-400" />
                    ) : (
                      <span className="size-3 shrink-0" />
                    )}
                  </MenubarItem>
                  <MenubarSeparator className="my-0.5" />
                  <MenubarItem className="gap-2 py-1 pl-2 pr-1.5 text-[11px] text-muted-foreground" disabled>
                    Theme…
                  </MenubarItem>
                </MenubarGroup>
              </MenubarContent>
            </MenubarMenu>
          </Menubar>
          <Dialog open={!!pmxPickFiles && pmxPickPaths.length > 1} onOpenChange={(o) => !o && onCancelPmxPick()}>
            <DialogContent className="gap-2">
              <DialogHeader>
                <DialogTitle>Multiple .pmx files found</DialogTitle>
                <DialogDescription>Choose one to load.</DialogDescription>
              </DialogHeader>
              <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                {pmxPickPaths.map((p) => (
                  <button
                    key={p}
                    type="button"
                    title={p}
                    className="truncate rounded-sm px-2 py-1.5 text-left text-[11px] hover:bg-accent hover:text-accent-foreground"
                    onClick={() => onPickPmxPath(p)}
                  >
                    {p.split("/").pop() || p}
                  </button>
                ))}
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <ResizablePanelGroup
        orientation="vertical"
        defaultLayout={boneMorphLayout}
        onLayoutChanged={onBoneMorphLayoutChanged}
        className="min-h-0 flex-1"
      >
        <ResizablePanel id="bones" defaultSize="72" minSize="20" className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            <BoneList
              modelBones={modelBones}
              clip={clip}
              selectedGroup={selectedGroup}
              selectedBone={selectedBone}
              onSelectGroup={onSelectGroup}
              onSelectBone={onSelectBone}
              revealRequest={boneListReveal}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="morphs" defaultSize="28" minSize="12" className="flex min-h-0 flex-col">
          <div className="shrink-0 px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            Morphs
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <MorphList
              morphNames={morphNames}
              clip={clip}
              selectedMorph={selectedMorph}
              onSelectMorph={onSelectMorph}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {/* Camera — a section you click, not a list you pick from. A scene has
          exactly one camera, and its six channels are already the timeline's
          tabs, so there is nothing here to enumerate. */}
      <button
        type="button"
        onClick={onSelectCamera}
        title={
          cameraTrack.length === 0
            ? "No camera motion yet — File › Load camera VMD…"
            : "Edit the camera shot"
        }
        className={cn(
          "flex shrink-0 items-center gap-1 border-t border-line px-3 py-2 text-left text-[11px] font-medium uppercase tracking-widest transition-colors",
          cameraSelected
            ? "bg-blue-400/[0.08] text-blue-400"
            : "text-muted-foreground hover:bg-white/[0.03]",
        )}
      >
        <span className="inline-flex w-1.5 shrink-0 text-[7px] leading-none normal-case" aria-hidden>
          {cameraSelected ? "\u25cf" : ""}
        </span>
        <span className="min-w-0 flex-1 truncate">Camera</span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums normal-case tracking-normal">
          {cameraTrack.length > 0 ? `[${cameraTrack.length}]` : "\u2014"}
        </span>
      </button>
    </aside>
  )
})

export function StudioPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const modelRef = useRef<Model | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)

  // ─── Document + selection live in `<Studio>`; page wires engine + chrome only ──
  // Slice subscriptions so unrelated state changes don't re-render this page.
  const clip = useStudioSelector((s) => s.clip)
  const clipDisplayName = useStudioSelector((s) => s.clipDisplayName)
  const selectedBone = useStudioSelector((s) => s.selectedBone)
  const selectedMorph = useStudioSelector((s) => s.selectedMorph)
  const selectedMaterial = useStudioSelector((s) => s.selectedMaterial)
  const selectedKeyframes = useStudioSelector((s) => s.selectedKeyframes)
  const ikEnabled = useStudioSelector((s) => s.ikEnabled)
  const cameraTrack = useStudioSelector((s) => s.cameraTrack)
  const cameraSelected = useStudioSelector((s) => s.cameraSelected)
  const cameraVmdEnabled = useStudioSelector((s) => s.cameraVmdEnabled)
  const {
    commit,
    replaceClip,
    setClipDisplayName,
    setSelectedBone,
    setSelectedMorph,
    setSelectedMaterial,
    setSelectedKeyframes,
    setIkEnabled,
    commitCamera,
    replaceCameraTrack,
    setCameraSelected,
    setCameraVmdEnabled,
    undo,
    redo,
  } = useStudioActions()
  const { currentFrame, setCurrentFrame, playing, setPlaying } = usePlayback()
  /** Single source of truth for the live playhead — the playback store owns
   *  this ref. EngineBridge's rAF loop writes the per-frame value into it so
   *  non-subscribing consumers (PMX swap, property inspector) see the live
   *  frame without forcing a re-render. */
  const currentFrameRef = usePlaybackFrameRef()
  /** Model finished loading (file menu + export need a live Model instance). */
  const [studioReady, setStudioReady] = useState(false)
  /** A restored draft's timeline view (zoom + scroll) — set once by
   *  EngineBridge's boot restore, handed to <Timeline> as `initialView`. */
  const [restoredTimelineView, setRestoredTimelineView] = useState<StoredTimelineView | undefined>(undefined)
  /** The imported track. `peaks` is what the timeline draws, `url` is what the
   *  audio element plays — kept apart because the peaks survive in the draft
   *  while the object URL is per-session. */
  const [audio, setAudio] = useState<{ name: string; peaks: number[]; duration: number; url: string | null } | null>(
    null,
  )
  const audioRef = useRef(audio)
  useEffect(() => {
    audioRef.current = audio
  }, [audio])
  /** Mirrors for use inside stable callbacks (draft persistence) without
   *  pulling these values into their dependency arrays. More mirrors sit
   *  next to selectedGroup/rightPanelTab/timelineTab below, once those exist. */
  const selectedBoneRef = useRef(selectedBone)
  useEffect(() => {
    selectedBoneRef.current = selectedBone
  }, [selectedBone])
  const selectedMorphRef = useRef(selectedMorph)
  useEffect(() => {
    selectedMorphRef.current = selectedMorph
  }, [selectedMorph])
  const selectedMaterialRef = useRef(selectedMaterial)
  useEffect(() => {
    selectedMaterialRef.current = selectedMaterial
  }, [selectedMaterial])
  const selectedKeyframesRef = useRef(selectedKeyframes)
  useEffect(() => {
    selectedKeyframesRef.current = selectedKeyframes
  }, [selectedKeyframes])
  const ikEnabledRef = useRef(ikEnabled)
  useEffect(() => {
    ikEnabledRef.current = ikEnabled
  }, [ikEnabled])
  const cameraTrackRef = useRef(cameraTrack)
  useEffect(() => {
    cameraTrackRef.current = cameraTrack
  }, [cameraTrack])
  const cameraSelectedRef = useRef(cameraSelected)
  useEffect(() => {
    cameraSelectedRef.current = cameraSelected
  }, [cameraSelected])
  /** Latest timeline view reported by <Timeline> — read fresh at save time,
   *  same reasoning as the camera below (no owning state here, just a mirror). */
  const timelineViewRef = useRef<StoredTimelineView | undefined>(undefined)

  const vmdInputRef = useRef<HTMLInputElement>(null)
  const cameraVmdInputRef = useRef<HTMLInputElement>(null)
  const morphVmdInputRef = useRef<HTMLInputElement>(null)
  const musicInputRef = useRef<HTMLInputElement>(null)
  const pmxFolderInputRef = useRef<HTMLInputElement>(null)
  /** Matches `engine.loadModel` name so `removeModel` can swap uploads without patching the engine. */
  const loadedModelNameRef = useRef("reze")
  /** Folder files from the last pick — kept for multi-PMX selection flow. */
  const pmxFolderFilesRef = useRef<File[] | null>(null)
  const frameCount = clip?.frameCount ?? 0
  /** PMX skeleton bone names; used to hide VMD tracks that do not exist on the loaded model. */
  const [pmxBoneNames, setPmxBoneNames] = useState<ReadonlySet<string>>(new Set())
  /** PMX bone order (skeleton array) — remainder list after clip bones in the sidebar. */
  const [modelBoneOrder, setModelBoneOrder] = useState<string[]>([])
  /** From `model.getMorphing().morphs` (engine has no `getMorphs()` alias yet). */
  const [morphNames, setMorphNames] = useState<string[]>([])
  /** PMX material names + the preset map pushed to the engine. Panel UI reads
   *  presets; user edits round-trip through `applyMaterialPresets`. */
  const [materialNames, setMaterialNames] = useState<string[]>([])
  const [materialPresets, setMaterialPresets] = useState<MaterialPresetMap>({})
  /** Hidden material names — mirror of the engine's `setMaterialVisible` state
   *  so the Materials panel checkbox reflects reality across model swaps. */
  const [hiddenMaterials, setHiddenMaterials] = useState<ReadonlySet<string>>(() => new Set())

  /** Bones with tracks in the current clip (and on the model) — timeline rows + keying. */
  const clipBones = useMemo(() => {
    if (!clip) return []
    const keys = Array.from(clip.boneTracks.keys())
    if (pmxBoneNames.size === 0) return keys
    return keys.filter((k) => pmxBoneNames.has(k))
  }, [clip, pmxBoneNames])

  /** Sidebar list: strict PMX skeleton order (same for new clips and edits). */
  const sidebarBones = modelBoneOrder

  const [selectedGroup, setSelectedGroup] = useState("All Bones")
  /** Viewport raycast → scroll the bone list to the picked bone. `epoch`
   *  bumps per pick so clicking the same bone twice still re-centers it.
   *  `revealBoneInList` below switches `selectedGroup` to one containing
   *  the target (only if the current group doesn't) before bumping, so the
   *  row is rendered by the time BoneList's scroll effect runs. */
  const [boneListReveal, setBoneListReveal] = useState<{ bone: string; epoch: number } | null>(null)
  /** Bumped on new clip load / reset so Timeline can reset its local view state. */
  const [clipVersion, setClipVersion] = useState(0)
  /** Lifted from Timeline so PropertiesInspector sliders + keyframe selection can sync it. */
  const [timelineTab, setTimelineTab] = useState("allRot")
  /** Right aside tab: "properties" (selection-bound) vs "materials" (model-bound). */
  const [rightPanelTab, setRightPanelTab] = useState<"properties" | "materials">("properties")
  // Mirrors of the three above, for draft persistence — see selectedBoneRef.
  const selectedGroupRef = useRef(selectedGroup)
  useEffect(() => {
    selectedGroupRef.current = selectedGroup
  }, [selectedGroup])
  const timelineTabRef = useRef(timelineTab)
  useEffect(() => {
    timelineTabRef.current = timelineTab
  }, [timelineTab])
  const rightPanelTabRef = useRef(rightPanelTab)
  useEffect(() => {
    rightPanelTabRef.current = rightPanelTab
  }, [rightPanelTab])

  /** Folder upload contained multiple `.pmx`; user picks one then clicks Load. */
  const [pmxPickFiles, setPmxPickFiles] = useState<File[] | null>(null)
  const [pmxPickPaths, setPmxPickPaths] = useState<string[]>([])
  /** Radix menubar: which submenu is open (`""` = all closed). */
  const [menubarValue, setMenubarValue] = useState("")
  /** After a File menu action fires, Radix returns focus to the `File` trigger.
   *  A subsequent Space (the user's play/pause reflex) then re-opens the menu
   *  or re-activates the last item ("New" wipes the clip). Drop focus whenever
   *  a menu action completes — on close itself, and again at the end of each
   *  async file handler (native file dialogs steal focus during the await, so
   *  the rAF-on-close blur can't catch the post-dialog focus restore). */
  const blurActiveElement = useCallback(() => {
    const el = document.activeElement as HTMLElement | null
    if (el && el !== document.body && typeof el.blur === "function") el.blur()
  }, [])
  const handleMenubarValueChange = useCallback(
    (v: string) => {
      setMenubarValue(v)
      // Radix's own focus return is now suppressed for pointer input (see
      // lib/last-input.ts), so this only has to catch what that cannot: focus
      // a menu ACTION moved somewhere unhelpful. Never on the keyboard path —
      // blurring there strands the user on <body> with nothing to Tab from.
      if (v === "" && !wasKeyboardInput()) requestAnimationFrame(blurActiveElement)
    },
    [blurActiveElement],
  )
  /** Status bar push actions — footer subscribes to its own store so these
   *  writes do not re-render the page. */
  const { setPmxFileName: setStatusPmxFileName } = useStudioStatusActions()

  /** `playing` mirrored into a ref for use inside async file handlers (PMX swap
   *  captures the value before `await loadModel` and restores it after). */
  const playRef = useRef(false)
  useEffect(() => {
    playRef.current = playing
  }, [playing])
  /** Imperative handle into the timeline canvas — the playback rAF loop uses
   *  this to repaint the playhead at 60Hz without re-rendering React. */
  const playheadDrawRef = useRef<((frame: number) => void) | null>(null)
  /** Snapshotted before async PMX swap so clip/playhead survive `await loadModel`. */
  const clipRef = useRef<AnimationClip | null>(null)
  const clipDisplayNameRef = useRef("clip")
  const visibleBones = useMemo(() => {
    const g = BONE_GROUPS[selectedGroup]
    if (!g) return clipBones
    return g.filter((name) => clipBones.includes(name))
  }, [selectedGroup, clipBones])

  useEffect(() => {
    clipRef.current = clip
  }, [clip])
  useEffect(() => {
    clipDisplayNameRef.current = clipDisplayName
  }, [clipDisplayName])

  // ─── The clip must be at least as long as the camera shot ───────────────
  //     The engine samples the camera off the MODEL's animation clock (see
  //     reze-engine's cameraClockTime), and that clock is clamped to the clip's
  //     own frameCount. A camera VMD carries no bone or morph frames at all, so
  //     a camera-only load leaves the clip at its short default and the shot
  //     freezes there — playhead still travelling, picture stuck.
  //
  //     An effect rather than a step in the load handler: a restored draft, an
  //     undo, and a clip swap all reach this state too, and only one of those
  //     goes through the file picker. Self-limiting — after the commit the
  //     condition is false, so it runs once per genuine shortfall.
  useEffect(() => {
    if (!clip || cameraTrack.length === 0) return
    const lastFrame = cameraTrack[cameraTrack.length - 1].frame
    if (lastFrame <= clip.frameCount) return
    commit({ ...clip, frameCount: lastFrame })
  }, [clip, cameraTrack, commit])

  // ─── Persist the current draft (clip + editor state) to IndexedDB ────────
  //     Covers every edit, undo/redo, "New", playhead scrub, and bone
  //     selection — they all flow through this same state. Debounced inside
  //     saveDraftSoon; `null` only while the engine hasn't produced a clip
  //     yet (first mount, before EngineBridge's boot effect settles).
  //
  //     The camera has no change event of its own (it's driven by raw mouse
  //     handlers inside the engine, not React state), so it can't trigger a
  //     save on its own — it rides along here, read fresh from the engine.
  //     The timeline's view (zoom + scroll) DOES have a change event
  //     (<Timeline>'s onViewChange below) and triggers its own save directly;
  //     it's still included here too so it isn't lost on a save this effect
  //     triggers for some other reason.
  const buildDraftExtras = useCallback((): DraftExtras => {
    const engine = engineRef.current
    return {
      currentFrame: currentFrameRef.current,
      selectedBone: selectedBoneRef.current,
      selectedMorph: selectedMorphRef.current,
      selectedMaterial: selectedMaterialRef.current,
      selectedGroup: selectedGroupRef.current,
      rightPanelTab: rightPanelTabRef.current,
      timelineTab: timelineTabRef.current,
      selectedKeyframes: selectedKeyframesRef.current,
      ikEnabled: ikEnabledRef.current,
      cameraTrack: cameraTrackRef.current,
      cameraSelected: cameraSelectedRef.current,
      camera: engine
        ? { alpha: engine.getCameraAlpha(), beta: engine.getCameraBeta(), distance: engine.getCameraDistance() }
        : undefined,
      timelineView: timelineViewRef.current,
    }
  }, [])

  useEffect(() => {
    if (clip == null) return
    saveDraftSoon(clipDisplayName, clip, buildDraftExtras())
  }, [
    clip,
    clipDisplayName,
    currentFrame,
    selectedBone,
    selectedMorph,
    selectedMaterial,
    selectedGroup,
    rightPanelTab,
    timelineTab,
    selectedKeyframes,
    ikEnabled,
    cameraTrack,
    cameraSelected,
    buildDraftExtras,
  ])

  /** <Timeline>'s onViewChange — the only draft field with no other event to
   *  ride along on, so it schedules its own save directly from refs. */
  const onTimelineViewChange = useCallback(
    (view: StoredTimelineView) => {
      timelineViewRef.current = view
      if (clipRef.current == null) return
      saveDraftSoon(clipDisplayNameRef.current, clipRef.current, buildDraftExtras())
    },
    [buildDraftExtras],
  )

  // Debounced writes can lag up to 150ms behind what's on screen — flush on
  // pagehide so closing the tab mid-edit doesn't drop the last keystroke.
  useEffect(() => {
    const onPageHide = () => flushDraftWrite()
    window.addEventListener("pagehide", onPageHide)
    return () => window.removeEventListener("pagehide", onPageHide)
  }, [])

  // ─── Keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack keys while the user is typing into an input/textarea/contenteditable.
      const t = e.target as HTMLElement | null
      if (t) {
        const tag = t.tagName
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return
      }
      if (e.code === "Space") {
        e.preventDefault()
        setPlaying((p) => !p)
      }
      if (e.code === "ArrowLeft") setCurrentFrame((p) => Math.max(0, Math.round(p) - 1))
      if (e.code === "ArrowRight") setCurrentFrame((p) => Math.min(frameCount, Math.round(p) + 1))
      if (e.code === "Home") setCurrentFrame(0)
      if (e.code === "End") setCurrentFrame(frameCount)
      // Undo / redo. Cmd on macOS, Ctrl elsewhere. Shift+Z (or Ctrl+Y) is redo.
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [frameCount, setCurrentFrame, setPlaying, undo, redo])

  // ─── Bone selection handlers ─────────────────────────────────────────
  const handleSelectGroup = useCallback(
    (g: string) => {
      setSelectedGroup((prev) => (prev === g ? "" : g))
      setSelectedBone(null)
      setSelectedMorph(null)
      setSelectedKeyframes([])
    },
    [setSelectedBone, setSelectedMorph, setSelectedKeyframes],
  )

  const handleSelectBone = useCallback(
    (b: string) => {
      setSelectedMorph(null)
      setSelectedMaterial(null)
      setCameraSelected(false)
      setSelectedBone(b)
      setSelectedKeyframes([])
      // A bone has neither a morph weight nor a camera channel to plot, so any
      // tab from those sets would leave the timeline showing nothing at all —
      // no active tab, no curve. Snap back to the bone default; a tab that is
      // already a bone tab is kept, so switching bones does not lose your view.
      setTimelineTab((t) => (t === "morph" || isCameraTab(t) ? "allRot" : t))
    },
    [setSelectedBone, setSelectedMorph, setSelectedMaterial, setCameraSelected, setSelectedKeyframes, setTimelineTab],
  )

  const revealBoneInList = useCallback(
    (bone: string) => {
      // Respect the user's active group filter when the target is already in
      // it (incl. "All Bones"). Otherwise switch to the first group that
      // contains the bone — "All Bones" is the final fallback and always
      // matches. Bumping `epoch` triggers BoneList's scroll effect, which
      // reads `offsets` for the (possibly new) group after the render commits.
      const groupDef = BONE_GROUPS[selectedGroup]
      const inCurrent =
        selectedGroup === "All Bones" || (groupDef?.includes(bone) ?? false)
      if (!inCurrent) {
        let targetGroup = "All Bones"
        for (const [groupName, def] of Object.entries(BONE_GROUPS)) {
          if (def && def.includes(bone)) {
            targetGroup = groupName
            break
          }
        }
        setSelectedGroup(targetGroup)
      }
      setBoneListReveal((prev) => ({ bone, epoch: (prev?.epoch ?? 0) + 1 }))
    },
    [selectedGroup],
  )

  /** Imperative handle so EngineBridge's raycast callback (created once at
   *  engine init) always calls the latest implementation. */
  const revealBoneInListRef = useRef(revealBoneInList)
  useEffect(() => {
    revealBoneInListRef.current = revealBoneInList
  }, [revealBoneInList])

  const handleSelectMorph = useCallback(
    (name: string) => {
      setSelectedBone(null)
      setSelectedMaterial(null)
      setCameraSelected(false)
      setSelectedMorph(name)
      setSelectedKeyframes([])
      setTimelineTab("morph")
    },
    [setSelectedBone, setSelectedMorph, setSelectedMaterial, setCameraSelected, setSelectedKeyframes],
  )

  // Material selection is mutually exclusive with bone/morph. Click the same
  // row to deselect; clicking blank area in the list calls the same handler.
  const handleToggleSelectMaterial = useCallback(
    (name: string) => {
      setSelectedMaterial((prev) => (prev === name ? null : name))
      setSelectedBone(null)
      setSelectedMorph(null)
      setSelectedKeyframes([])
    },
    [setSelectedMaterial, setSelectedBone, setSelectedMorph, setSelectedKeyframes],
  )

  const handleDeselectMaterial = useCallback(() => {
    setSelectedMaterial(null)
  }, [setSelectedMaterial])

  useEffect(() => {
    if (selectedBone && !pmxBoneNames.has(selectedBone)) setSelectedBone(null)
  }, [selectedBone, pmxBoneNames, setSelectedBone])

  useEffect(() => {
    if (selectedMorph && !morphNames.includes(selectedMorph)) setSelectedMorph(null)
  }, [selectedMorph, morphNames, setSelectedMorph])

  useEffect(() => {
    if (selectedMaterial && !materialNames.includes(selectedMaterial)) setSelectedMaterial(null)
  }, [selectedMaterial, materialNames, setSelectedMaterial])

  useEffect(() => {
    setSelectedKeyframes((prev) => prev.filter((s) => s.type !== "curve" || !s.bone || pmxBoneNames.has(s.bone)))
  }, [pmxBoneNames, setSelectedKeyframes])

  // ─── Material style-group sync ──────────────────────────────────────
  //     Whenever the model's material list changes (boot, PMX upload), guess
  //     style groups and push them to the engine. autoStyleGroups applies the
  //     engine's maintained JP/CN/EN name hints — so an arbitrary standard MMD
  //     upload auto-styles without our local table having to know its names —
  //     with our local keyword pass fed in as overrides (explicit wins). We then
  //     read the installed groups back so the panel Select matches exactly what
  //     the engine rendered (incl. materials the hints inferred that our local
  //     pass missed — otherwise a later edit would wipe them). EngineBridge also
  //     applies groups inline on boot to avoid a one-frame default-shader flash.
  useEffect(() => {
    setHiddenMaterials(new Set())
    if (materialNames.length === 0) {
      setMaterialPresets({})
      return
    }
    const engine = engineRef.current
    const modelName = loadedModelNameRef.current
    // Seed from the local pass immediately so the panel isn't blank while the
    // engine compiles; the readback below reconciles it with the engine's hints.
    const local = autoClassifyMaterials(materialNames)
    setMaterialPresets(local)
    if (!engine) return
    let cancelled = false
    void (async () => {
      await engine.autoStyleGroups(modelName, local)
      if (cancelled) return
      setMaterialPresets(styleGroupsToPresetMap(engine.getStyleGroups(modelName)))
    })()
    return () => {
      cancelled = true
    }
  }, [materialNames])

  const applyMaterialPresets = useCallback((next: MaterialPresetMap) => {
    setMaterialPresets(next)
    void engineRef.current?.applyStyleGroups(loadedModelNameRef.current, buildStyleGroups(next))
  }, [])

  const applyMaterialVisible = useCallback((materialName: string, visible: boolean) => {
    setHiddenMaterials((prev) => {
      const next = new Set(prev)
      if (visible) next.delete(materialName)
      else next.add(materialName)
      return next
    })
    engineRef.current?.setMaterialVisible(loadedModelNameRef.current, materialName, visible)
  }, [])

  // Any selection (bone/morph/keyframe) belongs to the Properties tab — flip
  // back so users don't lose the context when they're focused on Materials.
  useEffect(() => {
    if (selectedBone || selectedMorph || selectedKeyframes.length > 0) {
      setRightPanelTab("properties")
    }
  }, [selectedBone, selectedMorph, selectedKeyframes])

  // Engine init, clip upload, scrub/seek, play/pause, clamp, playback rAF
  // loop all live in <EngineBridge /> below — StudioPage just owns chrome.

  // Timeline key click: jump playhead; curve keys focus bone/morph on the list — tab stays user-controlled.
  useEffect(() => {
    if (selectedKeyframes.length !== 1) return
    const s = selectedKeyframes[0]
    if (s.morph) {
      setSelectedBone(null)
      setSelectedMorph(s.morph)
    } else {
      setSelectedMorph(null)
      if (s.type === "curve" && s.bone) setSelectedBone(s.bone)
    }
    setCurrentFrame(s.frame)
  }, [selectedKeyframes, setSelectedBone, setSelectedMorph, setCurrentFrame])

  const deleteSelectedKeyframes = useCallback(() => {
    if (!clip || selectedKeyframes.length !== 1) return
    const sel = selectedKeyframes[0]
    setSelectedKeyframes([])

    if (sel.type === "curve" && sel.morph) {
      commit((prev) => {
        if (!prev) return prev
        const track = prev.morphTracks.get(sel.morph!)
        if (!track) return prev
        const i = track.findIndex((k) => k.frame === sel.frame)
        if (i < 0) return prev
        const morphTracks = new Map(prev.morphTracks)
        const next = track.filter((_, j) => j !== i)
        if (next.length === 0) morphTracks.delete(sel.morph!)
        else morphTracks.set(sel.morph!, next)
        return { ...prev, morphTracks }
      })
      return
    }
    if (sel.type === "curve" && sel.bone) {
      commit((prev) => {
        if (!prev) return prev
        const track = prev.boneTracks.get(sel.bone!)
        if (!track) return prev
        const i = track.findIndex((k) => k.frame === sel.frame)
        if (i < 0) return prev
        const boneTracks = new Map(prev.boneTracks)
        const next = track.filter((_, j) => j !== i)
        if (next.length === 0) boneTracks.delete(sel.bone!)
        else boneTracks.set(sel.bone!, next)
        return { ...prev, boneTracks }
      })
      return
    }
    if (sel.type !== "dope") return
    const f = sel.frame
    if (timelineTab === "morph" && selectedMorph) {
      commit((prev) => {
        if (!prev) return prev
        const track = prev.morphTracks.get(selectedMorph)
        if (!track) return prev
        const i = track.findIndex((k) => k.frame === f)
        if (i < 0) return prev
        const morphTracks = new Map(prev.morphTracks)
        const next = track.filter((_, j) => j !== i)
        if (next.length === 0) morphTracks.delete(selectedMorph)
        else morphTracks.set(selectedMorph, next)
        return { ...prev, morphTracks }
      })
      return
    }
    commit((prev) => {
      if (!prev) return prev
      const boneTracks = new Map(prev.boneTracks)
      for (const [name, track] of prev.boneTracks) {
        const i = track.findIndex((k) => k.frame === f)
        if (i < 0) continue
        const next = track.filter((_, j) => j !== i)
        if (next.length === 0) boneTracks.delete(name)
        else boneTracks.set(name, next)
      }
      return { ...prev, boneTracks }
    })
  }, [clip, selectedKeyframes, timelineTab, selectedMorph, commit, setSelectedKeyframes])

  const insertKeyframeAtPlayhead = useCallback(() => {
    const model = modelRef.current
    if (!clip || !model) return
    const frame = Math.round(Math.max(0, currentFrame))

    if (selectedMorph && !selectedBone) {
      // Read the current weight straight from the engine — it's the live
      // interpolated value whether we're paused or playing.
      const morphs = model.getMorphing().morphs
      const idx = morphs.findIndex((m) => m.name === selectedMorph)
      const w = idx >= 0 ? (model.getMorphWeights()[idx] ?? 0) : 0
      commit(upsertMorphKeyframeAtFrame(clip, selectedMorph, frame, w))
      setSelectedKeyframes([{ type: "curve", morph: selectedMorph, frame }])
      return
    }

    if (!selectedBone) return
    model.loadClip(STUDIO_ANIM_NAME, clip)
    model.seek(Math.max(0, currentFrame) / 30)
    const pose = readLocalPoseAfterSeek(model, selectedBone)
    if (!pose) return

    const prevTrack = clip.boneTracks.get(selectedBone)
    const ip = interpolationTemplateForFrame(prevTrack, frame)
    const nextTrack = [...(prevTrack ?? [])].filter((k) => k.frame !== frame)
    nextTrack.push({
      boneName: selectedBone,
      frame,
      rotation: pose.rotation,
      translation: pose.translation,
      interpolation: ip,
    })
    nextTrack.sort((a, b) => a.frame - b.frame)
    const boneTracks = new Map(clip.boneTracks)
    boneTracks.set(selectedBone, nextTrack)
    commit({ ...clip, boneTracks })
    setSelectedKeyframes([{ type: "curve", bone: selectedBone, frame, channel: "rx" }])
  }, [clip, selectedBone, selectedMorph, currentFrame, commit, setSelectedKeyframes])

  const simplifySelectedBoneTrack = useCallback(() => {
    if (!clip || !selectedBone) return
    const prev = clip.boneTracks.get(selectedBone)
    if (!prev || prev.length <= 2) return
    const reduced = simplifyBoneTrack(prev)
    if (reduced.length === prev.length) return
    const boneTracks = new Map(clip.boneTracks)
    boneTracks.set(selectedBone, reduced)
    setSelectedKeyframes([])
    const nextClip = { ...clip, boneTracks }
    commit(nextClip)
    // Pre-warm: walk the playhead through every frame once so V8 JITs the
    // freshly-fitted bezier handles and the engine populates any per-segment
    // caches up front. Without this, the first playback through a region
    // stutters while those happen lazily on the rAF clock; replay is fine.
    const model = modelRef.current
    const engine = engineRef.current
    if (model && engine) {
      model.loadClip(STUDIO_ANIM_NAME, nextClip)
      const total = nextClip.frameCount
      for (let f = 0; f <= total; f++) model.seek(f / 30)
      engine.resetPhysics()
    }
  }, [clip, selectedBone, commit, setSelectedKeyframes])

  /** Clears whichever track is selected — bone or morph. Bone takes priority
   *  since the two are meant to be mutually exclusive in the inspector, but
   *  both are checked in case selection state ever drifts out of sync with
   *  what's displayed. */
  const clearSelectedTrack = useCallback(() => {
    if (!clip) return
    if (selectedBone && clip.boneTracks.has(selectedBone)) {
      const boneTracks = new Map(clip.boneTracks)
      boneTracks.delete(selectedBone)
      setSelectedKeyframes([])
      commit({ ...clip, boneTracks })
      return
    }
    if (selectedMorph && clip.morphTracks.has(selectedMorph)) {
      const morphTracks = new Map(clip.morphTracks)
      morphTracks.delete(selectedMorph)
      setSelectedKeyframes([])
      commit({ ...clip, morphTracks })
    }
  }, [clip, selectedBone, selectedMorph, commit, setSelectedKeyframes])

  /** Rewrites the clip's own `ikTracks` to a blanket on/off — the same data a
   *  VMD's IK/display block round-trips through, not the engine-wide switch
   *  (that would suppress IK for every model in the scene, and wouldn't
   *  travel with the clip on export). Disabling writes one `{frame: 0,
   *  enabled: false}` step per IK bone the loaded model actually has;
   *  enabling clears the field back to "leave IK as the host sets it". */
  const toggleIkEnabled = useCallback(() => {
    if (!clip) return
    const next = !ikEnabled
    setIkEnabled(next)
    if (next) {
      commit({ ...clip, ikTracks: undefined })
      return
    }
    const model = modelRef.current
    const ikBoneNames = model ? model.getSkeleton().bones.filter((b) => b.ikLinks?.length).map((b) => b.name) : []
    const ikTracks = new Map(ikBoneNames.map((name) => [name, [{ frame: 0, enabled: false }]]))
    commit({ ...clip, ikTracks })
  }, [clip, ikEnabled, setIkEnabled, commit])

  const syncStudioAfterNewClip = useCallback(
    (model: Model) => {
      setCurrentFrame(0)
      setPlaying(false)
      setSelectedKeyframes([])
      setIkEnabled(true)
      setClipVersion((v) => v + 1)
      model.show(STUDIO_ANIM_NAME)
      model.seek(0)
    },
    [setSelectedKeyframes, setCurrentFrame, setPlaying, setIkEnabled],
  )

  const applyLoadedPmxModel = useCallback(
    (
      model: Model,
      engineInstanceKey: string,
      displayStem: string,
      pmxFileName: string,
      animationSnapshot: {
        clip: AnimationClip | null
        currentFrame: number
        playing: boolean
        clipDisplayName: string
      },
    ) => {
      modelRef.current = model
      loadedModelNameRef.current = engineInstanceKey
      const sk = model.getSkeleton().bones.map((b) => b.name)
      const boneSet = new Set(sk)
      const morphNamesList = model.getMorphing().morphs.map((m) => m.name)
      const morphSet = new Set(morphNamesList)
      const materialNamesList = model.getMaterials().map((m) => m.name)
      setPmxBoneNames(boneSet)
      setModelBoneOrder(sk)
      setMorphNames(morphNamesList)
      setMaterialNames(materialNamesList)
      setStatusPmxFileName(pmxFileName.trim() || `${displayStem}.pmx`)
      setSelectedBone((prev) => (prev && boneSet.has(prev) ? prev : null))
      setSelectedMorph((prev) => (prev && morphSet.has(prev) ? prev : null))
      const materialSet = new Set(materialNamesList)
      setSelectedMaterial((prev) => (prev && materialSet.has(prev) ? prev : null))
      setSelectedKeyframes((prev) => prev.filter((s) => s.type !== "curve" || !s.bone || boneSet.has(s.bone)))

      const prev = animationSnapshot.clip
      const hasPrevTimeline =
        prev != null && (prev.boneTracks.size > 0 || prev.morphTracks.size > 0 || prev.frameCount > 0)

      let nextClip: AnimationClip
      let nextDisplay: string
      let nextFrame: number
      let nextPlaying: boolean

      if (hasPrevTimeline) {
        nextClip = clipRetainedForModel(prev, boneSet, morphSet)
        nextDisplay = animationSnapshot.clipDisplayName
        nextFrame = Math.min(Math.max(0, animationSnapshot.currentFrame), Math.max(0, nextClip.frameCount))
        nextPlaying = animationSnapshot.playing
      } else {
        nextClip = emptyStudioClip()
        nextDisplay = sanitizeClipFilenameBase(displayStem)
        nextFrame = 0
        nextPlaying = false
        // Only a genuinely fresh clip resets the toggle — a retained timeline
        // keeps whatever ikEnabled it already had, same as its ikTracks data.
        setIkEnabled(true)
      }

      model.loadClip(STUDIO_ANIM_NAME, nextClip)
      replaceClip(nextClip)
      setClipDisplayName(nextDisplay)
      setCurrentFrame(nextFrame)
      setPlaying(nextPlaying)
      model.show(STUDIO_ANIM_NAME)
      model.seek(nextFrame / 30)
      if (nextPlaying) model.play()
      else model.pause()
      setEngineError(null)
    },
    [replaceClip, setSelectedBone, setSelectedMorph, setSelectedMaterial, setSelectedKeyframes, setIkEnabled, setClipDisplayName, setCurrentFrame, setPlaying],
  )

  const loadPmxFromFolder = useCallback(
    async (files: File[], pmxFile: File) => {
      const engine = engineRef.current
      if (!engine) {
        window.alert("Viewport is not ready yet. Wait for the model to load, then try again.")
        return
      }
      const stem = fileStem(pmxFile.name)
      const instanceKey = `u_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
      try {
        engine.removeModel(loadedModelNameRef.current)
      } catch {
        /* removeModel is a no-op if the name is stale */
      }
      try {
        const model = await engine.loadModel(instanceKey, { files, pmxFile })
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const sanitizedStem = sanitizeClipFilenameBase(stem)
        model.setName(sanitizedStem)
        applyLoadedPmxModel(model, instanceKey, stem, pmxFile.name, {
          clip: clipRef.current,
          currentFrame: currentFrameRef.current,
          playing: playRef.current,
          clipDisplayName: clipDisplayNameRef.current,
        })
        // Fire-and-forget: persistence is a convenience, not a precondition
        // for the upload succeeding in this session.
        void saveModelUpload(files, pmxFile, sanitizedStem)
      } catch (e) {
        console.error("[pmx-upload] loadModel failed:", e)
        window.alert(e instanceof Error ? e.message : String(e))
      }
    },
    [applyLoadedPmxModel],
  )

  const onPickPmxFolder = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      try {
        const picked = parsePmxFolderInput(e.target.files)
        e.target.value = ""

        if (picked.status === "empty") return
        if (picked.status === "not_directory") {
          window.alert("Please select a folder, not individual files.")
          return
        }
        if (picked.status === "no_pmx") {
          window.alert("No .pmx file in the selected folder.")
          return
        }

        setPmxPickFiles(null)
        setPmxPickPaths([])

        if (picked.status === "single") {
          await loadPmxFromFolder(picked.files, picked.pmxFile)
        } else {
          pmxFolderFilesRef.current = picked.files
          setPmxPickFiles(picked.files)
          setPmxPickPaths(picked.pmxRelativePaths)
        }
      } finally {
        setMenubarValue("")
        blurActiveElement()
      }
    },
    [loadPmxFromFolder, blurActiveElement],
  )

  const onPickPmxPath = useCallback(
    async (path: string) => {
      const files = pmxPickFiles
      if (!files) return
      const pmxFile = pmxFileAtRelativePath(files, path)
      if (!pmxFile) {
        window.alert("Could not find the selected PMX file.")
        return
      }
      setPmxPickFiles(null)
      setPmxPickPaths([])
      await loadPmxFromFolder(files, pmxFile)
    },
    [loadPmxFromFolder, pmxPickFiles],
  )

  const onCancelPmxPick = useCallback(() => {
    setPmxPickFiles(null)
    setPmxPickPaths([])
  }, [])

  /** Load a camera VMD. Separate from "Load VMD…" on purpose: the camera block
   *  lives at the END of the format, past bone/morph/light/self-shadow, and a
   *  motion loader never reads it — a camera file put through the motion path
   *  parses as an empty clip, which is exactly the "nothing appeared" the
   *  camera was invisible for. */
  const onPickCameraVmdFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ""
      if (!file) return
      try {
        const frames = VMDLoader.loadCameraFromBuffer(await file.arrayBuffer())
        if (frames.length === 0) {
          window.alert("No camera track in that VMD — it may be a motion-only file.")
          return
        }
        replaceCameraTrack(frames)
        setCameraSelected(true)
        setSelectedBone(null)
        setSelectedMorph(null)
        setSelectedMaterial(null)
        setSelectedKeyframes([])
        setTimelineTab(CAMERA_DEFAULT_TAB)
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err))
      } finally {
        blurActiveElement()
      }
    },
    [
      replaceCameraTrack,
      setCameraSelected,
      setSelectedBone,
      setSelectedMorph,
      setSelectedMaterial,
      setSelectedKeyframes,
      blurActiveElement,
    ],
  )

  const exportCameraVmd = useCallback(() => {
    if (cameraTrack.length === 0) return
    const base = sanitizeClipFilenameBase(clipDisplayName)
    try {
      const buf = new VMDWriter().writeCamera([...cameraTrack])
      downloadBlob(new Blob([buf], { type: "application/octet-stream" }), `${base}-camera.vmd`)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }, [cameraTrack, clipDisplayName])

  /** Picking a camera channel selects the camera and points the timeline at
   *  that curve — the same "select a thing, timeline follows" contract the bone
   *  and morph lists have. */
  const onSelectCamera = useCallback(
    () => {
      setCameraSelected(true)
      setSelectedBone(null)
      setSelectedMorph(null)
      setSelectedMaterial(null)
      setSelectedKeyframes([])
      setTimelineTab((t) => (isCameraTab(t) ? t : CAMERA_DEFAULT_TAB))
    },
    [setCameraSelected, setSelectedBone, setSelectedMorph, setSelectedMaterial, setSelectedKeyframes],
  )

  /** Load only the expression half of a VMD, laid over whatever clip is open.
   *  The engine's own `tracks: "morphs"` overwrites the morph tracks and grows
   *  frameCount to cover — the bone half of the file is ignored. */
  const onPickMorphVmdFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ""
      const model = modelRef.current
      if (!file || !model) return
      const url = URL.createObjectURL(file)
      try {
        await model.loadVmd(STUDIO_ANIM_NAME, url, { tracks: "morphs" })
        const c = model.getClip(STUDIO_ANIM_NAME)
        if (c) {
          replaceClip(c)
          setSelectedKeyframes([])
          setClipVersion((v) => v + 1)
        }
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err))
      } finally {
        URL.revokeObjectURL(url)
        blurActiveElement()
      }
    },
    [replaceClip, setSelectedKeyframes, blurActiveElement],
  )

  const onPickMusicFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ""
      if (!file) return
      try {
        // Decode from a copy: decodeAudioData DETACHES the buffer it is given,
        // and the same bytes are still needed for the object URL below.
        const bytes = await file.arrayBuffer()
        const decoded = await decodeAudioPeaks(bytes.slice(0))
        if (!decoded) {
          window.alert("Could not decode that audio file.")
          return
        }
        setAudio((prev) => {
          if (prev?.url) URL.revokeObjectURL(prev.url)
          return { name: file.name, peaks: decoded.peaks, duration: decoded.duration, url: URL.createObjectURL(file) }
        })
        void saveAudioUpload(file.name, file)
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err))
      } finally {
        blurActiveElement()
      }
    },
    [blurActiveElement],
  )

  const clearMusic = useCallback(() => {
    setAudio((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url)
      return null
    })
    void clearAudioUpload()
  }, [])

  const onPickVmdFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ""
      const model = modelRef.current
      if (!file || !model) return
      const url = URL.createObjectURL(file)
      try {
        await model.loadVmd(STUDIO_ANIM_NAME, url)
        const c = model.getClip(STUDIO_ANIM_NAME)
        if (c) {
          replaceClip(c)
          setClipDisplayName(sanitizeClipFilenameBase(fileStem(file.name)))
          syncStudioAfterNewClip(model)
        }
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err))
      } finally {
        URL.revokeObjectURL(url)
        blurActiveElement()
      }
    },
    [syncStudioAfterNewClip, replaceClip, setClipDisplayName, blurActiveElement],
  )

  /** Export the clip as VMD bytes. `tracks` splits the file the way MMD users
   *  actually keep them: the dance and the expressions as separate files, or
   *  both together. The suffix names which one you got — three downloads called
   *  "dance-export.vmd" would be indistinguishable in a folder. */
  const exportClipVmd = useCallback(
    (tracks: VmdTrackSelection = "all") => {
      const model = modelRef.current
      if (!model || !clip) return
      const base = sanitizeClipFilenameBase(clipDisplayName)
      const suffix = tracks === "all" ? "export" : tracks
      try {
        model.loadClip(STUDIO_ANIM_NAME, clip)
        const buf = model.exportVmd(STUDIO_ANIM_NAME, { tracks })
        downloadBlob(new Blob([buf], { type: "application/octet-stream" }), `${base}-${suffix}.vmd`)
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err))
      }
    },
    [clip, clipDisplayName],
  )

  /** Clear one half of the clip, or the camera, without touching the others.
   *
   *  Separate from "New", which throws the whole document away: the common case
   *  is keeping a dance and redoing the expressions, or dropping a camera you
   *  imported to try. Undoable, unlike New — these go through `commit`, so a
   *  mis-click is one ctrl-Z rather than a reload. */
  const clearMotionTracks = useCallback(() => {
    if (!clip || clip.boneTracks.size === 0) return
    setSelectedKeyframes([])
    setSelectedBone(null)
    // ikTracks is bone state, so it goes with the motion.
    const next = { ...clip, boneTracks: new Map(), ikTracks: undefined }
    commit({ ...next, frameCount: durationAfterClear(next) })
    // Nothing drives a bone once its track is gone, so the engine would hold
    // the last pose it was given — the timeline empties and the model keeps
    // standing in the deleted motion. Put it back on the bind pose explicitly.
    modelRef.current?.resetAllBones()
  }, [clip, commit, setSelectedKeyframes, setSelectedBone])

  const clearMorphTracks = useCallback(() => {
    if (!clip || clip.morphTracks.size === 0) return
    setSelectedKeyframes([])
    setSelectedMorph(null)
    const next = { ...clip, morphTracks: new Map() }
    commit({ ...next, frameCount: durationAfterClear(next) })
    // Same reasoning as resetAllBones above: an unkeyed morph keeps whatever
    // weight was last written to it, so a cleared expression stays on the face.
    modelRef.current?.resetAllMorphs()
  }, [clip, commit, setSelectedKeyframes, setSelectedMorph])

  const clearCameraTrack = useCallback(() => {
    if (cameraTrack.length === 0) return
    setSelectedKeyframes([])
    // Emptying the track hands the viewport back to orbit control (see
    // EngineBridge's mirror), so the user is not left staring through a camera
    // that no longer exists.
    commitCamera([])
    // The clip may have been stretched purely to cover the shot (see the
    // "clip covers camera" effect); with the shot gone that length is not
    // describing anything any more.
    if (clip) commit({ ...clip, frameCount: durationAfterClear(clip) })
    setCameraSelected(false)
    setTimelineTab((t) => (isCameraTab(t) ? "allRot" : t))
  }, [cameraTrack, clip, commit, commitCamera, setCameraSelected, setSelectedKeyframes])

  const resetStudioDocument = useCallback(() => {
    const model = modelRef.current
    if (!model) return
    const fresh = emptyStudioClip()
    model.loadClip(STUDIO_ANIM_NAME, fresh)
    replaceClip(fresh)
    setClipDisplayName("clip")
    setCurrentFrame(0)
    setPlaying(false)
    setSelectedBone(null)
    setSelectedMorph(null)
    setSelectedMaterial(null)
    setSelectedKeyframes([])
    setIkEnabled(true)
    // The camera is half the document — a "New" that left the previous shot
    // driving the viewport would not be a new project.
    replaceCameraTrack([])
    setCameraSelected(false)
    setTimelineTab("allRot")
    // Bump after clearing selections so downstream effects don't see stale keyframes.
    setClipVersion((v) => v + 1)
    model.show(STUDIO_ANIM_NAME)
    model.seek(0)
    blurActiveElement()
  }, [replaceClip, setClipDisplayName, setSelectedBone, setSelectedMorph, setSelectedMaterial, setSelectedKeyframes, setIkEnabled, replaceCameraTrack, setCameraSelected, setCurrentFrame, setPlaying, blurActiveElement])

  /** Decode a track and install it. Shared by the restore path and the bundled
   *  default so the waveform is produced exactly one way. */
  const installAudio = useCallback(async (name: string, file: Blob, objectUrl: string) => {
    // decodeAudioData DETACHES the buffer it is handed, so it gets a copy — the
    // original bytes are still backing the object URL that plays.
    const decoded = await decodeAudioPeaks((await file.arrayBuffer()).slice(0))
    if (!decoded) {
      URL.revokeObjectURL(objectUrl)
      return false
    }
    setAudio((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url)
      return { name, peaks: decoded.peaks, duration: decoded.duration, url: objectUrl }
    })
    return true
  }, [])

  /** Fetch and install the bundled track, unconditionally. */
  const installDefaultAudio = useCallback(async () => {
    try {
      const res = await fetch(AUDIO_PATH)
      if (!res.ok) return
      const blob = await res.blob()
      await installAudio(AUDIO_PATH.split("/").pop() || "music", blob, URL.createObjectURL(blob))
    } catch {
      // No bundled track in this build — the timeline simply has no lane.
    }
  }, [installAudio])

  /** The harder of the two "start over" actions, and the reason they sit
   *  together in the menu: New project empties the DOCUMENT and keeps whatever
   *  model you loaded, this one throws the model away too and returns to the
   *  bundled default with its demo motion — the state a first visit shows.
   *
   *  Done in place rather than by reloading the page. A reload was the cheap
   *  way to rerun the boot sequence, but it also tore down the WebGPU context
   *  and re-fetched everything to reach a state the engine can just be told to
   *  adopt. Destructive either way, so it is confirmed first. */
  const resetToDefaultModel = useCallback(async () => {
    if (
      !window.confirm(
        "Reset the project? This clears your uploaded model, motion, morphs and camera, and returns to the default model.",
      )
    )
      return
    const engine = engineRef.current
    if (!engine) return

    void clearModelUpload()
    void clearDraft()
    void clearAudioUpload()
    setAudio((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url)
      return null
    })

    setPlaying(false)
    setCurrentFrame(0)
    setSelectedBone(null)
    setSelectedMorph(null)
    setSelectedMaterial(null)
    setSelectedKeyframes([])
    setIkEnabled(true)
    replaceCameraTrack([])
    setCameraSelected(false)
    setSelectedGroup("All Bones")
    setTimelineTab("allRot")

    try {
      engine.removeModel(loadedModelNameRef.current)
    } catch {
      /* removeModel is a no-op if the name is stale */
    }
    try {
      const model = await engine.loadModel("reze", MODEL_PATH)
      await new Promise((resolve) => requestAnimationFrame(resolve))
      model.setName("reze")
      // A null clip in the snapshot is what tells applyLoadedPmxModel not to
      // carry the old timeline across — this is a reset, not a model swap.
      applyLoadedPmxModel(model, "reze", fileStem(MODEL_PATH), BUNDLED_PMX_FILENAME, {
        clip: null,
        currentFrame: 0,
        playing: false,
        clipDisplayName: "clip",
      })
      await model.loadVmd(STUDIO_ANIM_NAME, VMD_PATH)
      const c = model.getClip(STUDIO_ANIM_NAME)
      if (c) {
        replaceClip(c)
        setClipDisplayName(sanitizeClipFilenameBase(fileStem(VMD_PATH)))
        syncStudioAfterNewClip(model)
      }
      // The demo scene is four files, so a reset that stopped at the motion left
      // most of it missing — no expressions, no shot, no music. Each in its own
      // try: one absent file must not cost the others.
      try {
        await model.loadVmd(STUDIO_ANIM_NAME, MORPH_VMD_PATH, { tracks: "morphs" })
        const withMorphs = model.getClip(STUDIO_ANIM_NAME)
        if (withMorphs) replaceClip(withMorphs)
      } catch {
        /* no bundled expressions in this build */
      }
      try {
        const camFrames = await VMDLoader.loadCamera(CAMERA_VMD_PATH)
        if (camFrames.length > 0) replaceCameraTrack(camFrames)
      } catch {
        /* no bundled shot in this build */
      }
      // audioRef trails setAudio by a render; clear it here so the installer
      // below is not looking at the track we just threw away.
      audioRef.current = null
      await installDefaultAudio()
      setEngineError(null)
    } catch (e) {
      console.error("[reset] failed to restore the default model:", e)
      setEngineError(e instanceof Error ? e.message : String(e))
    }
    blurActiveElement()
  }, [
    applyLoadedPmxModel,
    syncStudioAfterNewClip,
    replaceClip,
    setClipDisplayName,
    setSelectedBone,
    setSelectedMorph,
    setSelectedMaterial,
    setSelectedKeyframes,
    setIkEnabled,
    replaceCameraTrack,
    setCameraSelected,
    installDefaultAudio,
    setCurrentFrame,
    setPlaying,
    blurActiveElement,
  ])

  // Restore a previously imported track. Decoding again on every load rather
  // than storing peaks in the draft: the file is already in IndexedDB, decoding
  // is off-thread, and it keeps one source of truth for what the waveform shows.
  const audioRestoredRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const stored = await loadAudioUpload()
      if (cancelled) return
      audioRestoredRef.current = true
      if (!stored) return
      await installAudio(stored.name, stored.file, URL.createObjectURL(stored.file))
    })()
    return () => {
      cancelled = true
    }
  }, [installAudio])

  /** The bundled track, on a first visit only — EngineBridge calls this from the
   *  same branch that loads the demo motion and shot, so the three arrive as one
   *  scene. Never on a return visit: a user who cleared the music must not find
   *  it back after a reload. */
  const loadDefaultAudio = useCallback(() => {
    void (async () => {
      // The restore pass decides whether there is already a track; wait for it
      // rather than racing it and clobbering a real import.
      for (let i = 0; i < 100 && !audioRestoredRef.current; i++) {
        await new Promise((r) => setTimeout(r, 20))
      }
      if (audioRef.current) return
      await installDefaultAudio()
    })()
  }, [installDefaultAudio])

  const { defaultLayout: viewportTimelineLayout, onLayoutChanged: onViewportTimelineLayoutChanged } = useDefaultLayout({
    id: "reze-studio.viewport-timeline",
    panelIds: ["viewport", "timeline"],
  })

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden text-foreground">
      <EngineBridge
        canvasRef={canvasRef}
        engineRef={engineRef}
        modelRef={modelRef}
        loadedModelNameRef={loadedModelNameRef}
        revealBoneInListRef={revealBoneInListRef}
        currentFrameRef={currentFrameRef}
        playheadDrawRef={playheadDrawRef}
        setTimelineView={setRestoredTimelineView}
        setSelectedGroup={setSelectedGroup}
        setRightPanelTab={setRightPanelTab}
        setTimelineTab={setTimelineTab}
        setPmxBoneNames={setPmxBoneNames}
        setModelBoneOrder={setModelBoneOrder}
        setMorphNames={setMorphNames}
        setMaterialNames={setMaterialNames}
        setEngineError={setEngineError}
        setStudioReady={setStudioReady}
        onFreshBoot={loadDefaultAudio}
      />
      <div className="flex min-h-0 flex-1">
        <StudioLeftPanel
          vmdInputRef={vmdInputRef}
          pmxFolderInputRef={pmxFolderInputRef}
          onPickVmdFile={onPickVmdFile}
          onPickPmxFolder={onPickPmxFolder}
          menubarValue={menubarValue}
          onMenubarValueChange={handleMenubarValueChange}
          studioReady={studioReady}
          resetStudioDocument={resetStudioDocument}
          resetToDefaultModel={resetToDefaultModel}
          exportClipVmd={exportClipVmd}
          pmxPickFiles={pmxPickFiles}
          pmxPickPaths={pmxPickPaths}
          onPickPmxPath={onPickPmxPath}
          onCancelPmxPick={onCancelPmxPick}
          modelBones={sidebarBones}
          selectedGroup={selectedGroup}
          selectedBone={selectedBone}
          onSelectGroup={handleSelectGroup}
          onSelectBone={handleSelectBone}
          boneListReveal={boneListReveal}
          morphNames={morphNames}
          selectedMorph={selectedMorph}
          onSelectMorph={handleSelectMorph}
          docsReadmeUrl={DOCS_README_URL}
          repoUrl={REPO_URL}
          appVersion={APP_VERSION}
          onToggleIkEnabled={toggleIkEnabled}
          cameraTrack={cameraTrack}
          cameraSelected={cameraSelected}
          onSelectCamera={onSelectCamera}
          onPickCameraVmdFile={onPickCameraVmdFile}
          cameraVmdInputRef={cameraVmdInputRef}
          onPickMorphVmdFile={onPickMorphVmdFile}
          morphVmdInputRef={morphVmdInputRef}
          exportCameraVmd={exportCameraVmd}
          clearMotionTracks={clearMotionTracks}
          clearMorphTracks={clearMorphTracks}
          clearCameraTrack={clearCameraTrack}
          onPickMusicFile={onPickMusicFile}
          musicInputRef={musicInputRef}
          clearMusic={clearMusic}
          hasMusic={audio != null}
        />

        {/* Center: viewport + timeline, resizable */}
        <ResizablePanelGroup
          orientation="vertical"
          defaultLayout={viewportTimelineLayout}
          onLayoutChanged={onViewportTimelineLayoutChanged}
          className="min-h-0 min-w-0 flex-1"
        >
          <ResizablePanel id="viewport" defaultSize="76" minSize={100} className="flex min-h-0 flex-col">
            <StudioViewport
              ref={canvasRef}
              engineError={engineError}
              hasCameraTrack={cameraTrack.length > 0}
              cameraVmdEnabled={cameraVmdEnabled}
              onToggleCameraVmd={() => setCameraVmdEnabled((v) => !v)}
            />
          </ResizablePanel>
          <ResizableHandle className="bg-line-strong" />
          {/* Timeline with dopesheet + value graph. Gated on studioReady so it
              mounts once boot has fully resolved — currentFrame and
              restoredTimelineView are both already final by then, so
              Timeline's lazy-initialized zoom/scroll state starts correct
              instead of being patched in after a defaults-first mount. */}
          <ResizablePanel id="timeline" defaultSize={220} minSize={220} className="flex min-h-0 flex-col">
            {studioReady && (
              <Timeline
                visibleBones={visibleBones}
                clipVersion={clipVersion}
                tab={timelineTab}
                setTab={setTimelineTab}
                playheadDrawRef={playheadDrawRef}
                audioPeaks={audio?.peaks ?? null}
                audioDuration={audio?.duration ?? 0}
                initialView={restoredTimelineView}
                onViewChange={onTimelineViewChange}
              />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* Right sidebar — Properties (selection) + Materials (per-model) tabs */}
        <aside className="flex w-64 shrink-0 flex-col border-l border-line-strong text-sidebar-foreground">
          <Tabs
            value={rightPanelTab}
            onValueChange={(v) => setRightPanelTab(v as "properties" | "materials")}
            className="min-h-0 flex-1"
          >
            <TabsList className="flex min-h-9 w-full shrink-0 items-center gap-4 border-b border-line px-3">
              <TabsTrigger value="properties">Properties</TabsTrigger>
              <TabsTrigger value="materials">Materials</TabsTrigger>
            </TabsList>
            <TabsContent
              value="properties"
              className="overflow-y-auto overflow-x-hidden px-3 py-2 text-[11px] [scrollbar-width:thin]"
            >
              <PropertiesInspector
                modelRef={modelRef}
                onInsertKeyframeAtPlayhead={insertKeyframeAtPlayhead}
                onDeleteSelectedKeyframes={deleteSelectedKeyframes}
                onSimplifySelectedBoneTrack={simplifySelectedBoneTrack}
                onClearSelectedTrack={clearSelectedTrack}
                onClearCameraTrack={clearCameraTrack}
                timelineTab={timelineTab}
                setTimelineTab={setTimelineTab}
                clipVersion={clipVersion}
              />
            </TabsContent>
            <TabsContent value="materials" className="overflow-hidden">
              <MaterialList
                materialNames={materialNames}
                presets={materialPresets}
                hiddenMaterials={hiddenMaterials}
                selectedMaterial={selectedMaterial}
                onChangePresets={applyMaterialPresets}
                onChangeVisible={applyMaterialVisible}
                onToggleSelect={handleToggleSelectMaterial}
                onDeselect={handleDeselectMaterial}
              />
            </TabsContent>
          </Tabs>
        </aside>
      </div>

      <AudioBridge audioUrl={audio?.url ?? null} />
      <StudioStatusFooter
        clipDisplayName={clipDisplayName}
        hasClip={clip != null}
        ikEnabled={ikEnabled}
        appVersion={APP_VERSION}
      />
    </div>
  )
}

