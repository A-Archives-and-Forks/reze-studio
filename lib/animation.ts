// ─── Math types ──────────────────────────────────────────────────────────
export class Vec3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}
}

export class Quat {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 1,
  ) {}
}

// Quat → Euler YXZ (degrees) — matches MMD convention
export function quatToEuler(q: Quat) {
  const sinX = 2 * (q.w * q.x - q.y * q.z)
  const clamped = Math.max(-1, Math.min(1, sinX))
  const x = Math.asin(clamped)
  const cosX = Math.cos(x)
  let y: number, z: number
  if (Math.abs(cosX) > 0.0001) {
    y = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y))
    z = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.x * q.x + q.z * q.z))
  } else {
    y = Math.atan2(-2 * (q.x * q.z - q.w * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
    z = 0
  }
  const DEG = 180 / Math.PI
  return { x: x * DEG, y: y * DEG, z: z * DEG }
}

export function eulerToQuat(ex: number, ey: number, ez: number): Quat {
  const RAD = Math.PI / 180
  const hx = ex * RAD * 0.5,
    hy = ey * RAD * 0.5,
    hz = ez * RAD * 0.5
  const cx = Math.cos(hx),
    sx = Math.sin(hx)
  const cy = Math.cos(hy),
    sy = Math.sin(hy)
  const cz = Math.cos(hz),
    sz = Math.sin(hz)
  // YXZ order
  return new Quat(
    cy * sx * cz + sy * cx * sz,
    sy * cx * cz - cy * sx * sz,
    cy * cx * sz - sy * sx * cz,
    cy * cx * cz + sy * sx * sz,
  )
}

export function bezierY(cp0: { x: number; y: number }, cp1: { x: number; y: number }, t: number) {
  const x1 = cp0.x / 127,
    y1 = cp0.y / 127,
    x2 = cp1.x / 127,
    y2 = cp1.y / 127
  let lo = 0,
    hi = 1,
    mid = 0.5
  for (let i = 0; i < 15; i++) {
    const x = 3 * (1 - mid) ** 2 * mid * x1 + 3 * (1 - mid) * mid ** 2 * x2 + mid ** 3
    if (Math.abs(x - t) < 0.0001) break
    if (x < t) lo = mid
    else hi = mid
    mid = (lo + hi) / 2
  }
  return 3 * (1 - mid) ** 2 * mid * y1 + 3 * (1 - mid) * mid ** 2 * y2 + mid ** 3
}

// ─── Types ───────────────────────────────────────────────────────────────
export interface InterpPoint {
  x: number
  y: number
}

export interface KeyframeInterpolation {
  rotation: [InterpPoint, InterpPoint]
  translationX: [InterpPoint, InterpPoint]
  translationY: [InterpPoint, InterpPoint]
  translationZ: [InterpPoint, InterpPoint]
}

export interface BoneKeyframe {
  frame: number
  rotation: Quat
  translation: Vec3
  interpolation: KeyframeInterpolation
}

export interface AnimationClip {
  boneTracks: Map<string, BoneKeyframe[]>
  morphTracks: Map<string, unknown[]>
  frameCount: number
}

// ─── Constants ───────────────────────────────────────────────────────────
export const DOPE_H = 34
export const RULER_H = 22
export const LABEL_W = 52
export const DOT_R = 3.5
export const DIAMOND = 5
export const MIN_PX = 2
export const MAX_PX = 20

export const C = {
  bg: "#0d0d11",
  curveBg: "#101016",
  ruler: "#0a0a0d",
  rulerText: "#55555f",
  rulerTick: "#2a2a34",
  rulerMajor: "#3a3a48",
  grid: "#161620",
  axis: "#222233",
  axisZero: "#2c2c44",
  playhead: "#d83838",
  playheadGlow: "rgba(216,56,56,0.18)",
  diamondSel: "#5aa0f0",
  dopeBg: "#0e0e12",
  dopeBorder: "#222230",
  dopeLabel: "#55555f",
  dopeLabelNum: "#444450",
  rotX: "#e25555",
  rotY: "#44bb55",
  rotZ: "#4477dd",
  traX: "#e2a055",
  traY: "#55bba0",
  traZ: "#7755dd",
  label: "#666672",
  tabBg: "#18181e",
  tabActive: "#2a2a36",
  tabText: "#606068",
  tabTextActive: "#ccccdd",
  border: "#222230",
  frameBadge: "#1a1a22",
  frameBadgeText: "#77778a",
  sidebarBg: "#111116",
  sidebarGroup: "#888898",
  sidebarBone: "#666672",
  sidebarActive: "#5aa0f0",
  sidebarGroupBg: "#181820",
  sidebarHover: "#1e1e28",
} as const

export const FONT = "'SF Mono','Cascadia Code','Fira Code','JetBrains Mono',monospace"

// ─── Bone groups ─────────────────────────────────────────────────────────
export const BONE_GROUPS: Record<string, string[] | null> = {
  "All Bones": null,
  "Upper Body": ["首", "頭", "上半身"],
  "Lower Body": ["左ひざ", "右ひざ", "下半身"],
}

// ─── Channel definitions ─────────────────────────────────────────────────
export interface Channel {
  key: string
  label: string
  color: string
  group: "rot" | "tra"
  get: (kf: BoneKeyframe) => number
  set: (kf: BoneKeyframe, v: number) => void
}

export const ROT_CHANNELS: Channel[] = [
  {
    key: "rx",
    label: "Rot.X",
    color: C.rotX,
    group: "rot",
    get: (kf) => quatToEuler(kf.rotation).x,
    set: (kf, v) => {
      const e = quatToEuler(kf.rotation)
      kf.rotation = eulerToQuat(v, e.y, e.z)
    },
  },
  {
    key: "ry",
    label: "Rot.Y",
    color: C.rotY,
    group: "rot",
    get: (kf) => quatToEuler(kf.rotation).y,
    set: (kf, v) => {
      const e = quatToEuler(kf.rotation)
      kf.rotation = eulerToQuat(e.x, v, e.z)
    },
  },
  {
    key: "rz",
    label: "Rot.Z",
    color: C.rotZ,
    group: "rot",
    get: (kf) => quatToEuler(kf.rotation).z,
    set: (kf, v) => {
      const e = quatToEuler(kf.rotation)
      kf.rotation = eulerToQuat(e.x, e.y, v)
    },
  },
]

export const TRA_CHANNELS: Channel[] = [
  {
    key: "tx",
    label: "Tra.X",
    color: C.traX,
    group: "tra",
    get: (kf) => kf.translation.x,
    set: (kf, v) => {
      kf.translation = new Vec3(v, kf.translation.y, kf.translation.z)
    },
  },
  {
    key: "ty",
    label: "Tra.Y",
    color: C.traY,
    group: "tra",
    get: (kf) => kf.translation.y,
    set: (kf, v) => {
      kf.translation = new Vec3(kf.translation.x, v, kf.translation.z)
    },
  },
  {
    key: "tz",
    label: "Tra.Z",
    color: C.traZ,
    group: "tra",
    get: (kf) => kf.translation.z,
    set: (kf, v) => {
      kf.translation = new Vec3(kf.translation.x, kf.translation.y, v)
    },
  },
]

export const ALL_CHANNELS: Channel[] = [...ROT_CHANNELS, ...TRA_CHANNELS]

export function getChannelsForTab(tab: string): Channel[] {
  if (tab === "allRot") return ROT_CHANNELS
  if (tab === "allTra") return TRA_CHANNELS
  const ch = ALL_CHANNELS.find((c) => c.key === tab)
  return ch ? [ch] : ROT_CHANNELS
}

export function getAxisConfig(tab: string) {
  const chans = getChannelsForTab(tab)
  const isRot = chans[0].group === "rot"
  if (isRot) {
    return { min: -90, max: 90, unit: "°", side: "left" as const, step: 30, subStep: 15 }
  } else {
    return { min: -5, max: 20, unit: "", side: "right" as const, step: 5, subStep: 2.5 }
  }
}

export const TABS = [
  { key: "allRot", label: "All Rot", color: null, sep: false },
  { key: "rx", label: "X", color: C.rotX, sep: false },
  { key: "ry", label: "Y", color: C.rotY, sep: false },
  { key: "rz", label: "Z", color: C.rotZ, sep: false },
  { key: "_sep", label: "", color: null, sep: true },
  { key: "allTra", label: "All Tra", color: null, sep: false },
  { key: "tx", label: "X", color: C.traX, sep: false },
  { key: "ty", label: "Y", color: C.traY, sep: false },
  { key: "tz", label: "Z", color: C.traZ, sep: false },
]

// ─── Mock data ───────────────────────────────────────────────────────────
export function makeMockClip(): AnimationClip {
  const boneTracks = new Map<string, BoneKeyframe[]>()
  const bones = [
    { name: "首", kf: [0, 8, 20, 35, 50, 68, 80, 95, 110, 120] },
    { name: "頭", kf: [0, 12, 30, 45, 60, 75, 90, 105, 120] },
    { name: "上半身", kf: [0, 15, 35, 55, 70, 90, 110, 120] },
    { name: "左ひざ", kf: [0, 6, 15, 24, 36, 48, 60, 72, 84, 96, 108, 120] },
    { name: "右ひざ", kf: [0, 10, 25, 40, 55, 70, 85, 100, 115, 120] },
    { name: "下半身", kf: [0, 20, 40, 60, 80, 100, 120] },
  ]

  for (const { name, kf } of bones) {
    const i = bones.findIndex((b) => b.name === name)
    boneTracks.set(
      name,
      kf.map((f) => ({
        frame: f,
        rotation: eulerToQuat(
          Math.sin(f * 0.08 + i) * 25,
          Math.cos(f * 0.06 + i) * 15,
          Math.sin(f * 0.04 + i) * 10,
        ),
        translation: new Vec3(
          Math.sin(f * 0.04) * 2.5,
          Math.cos(f * 0.06) * 4 + 12,
          Math.sin(f * 0.05) * 1.5,
        ),
        interpolation: {
          rotation: [
            { x: 20 + Math.floor(Math.sin(i * 1.1) * 35), y: 20 + Math.floor(Math.cos(i * 1.3) * 35) },
            { x: 107 - Math.floor(Math.sin(i * 1.1) * 35), y: 107 - Math.floor(Math.cos(i * 1.3) * 35) },
          ] as [InterpPoint, InterpPoint],
          translationX: [
            { x: 20, y: 20 },
            { x: 107, y: 107 },
          ] as [InterpPoint, InterpPoint],
          translationY: [
            { x: 20, y: 20 },
            { x: 107, y: 107 },
          ] as [InterpPoint, InterpPoint],
          translationZ: [
            { x: 20, y: 20 },
            { x: 107, y: 107 },
          ] as [InterpPoint, InterpPoint],
        },
      })),
    )
  }
  return { boneTracks, morphTracks: new Map(), frameCount: 120 }
}
