# Reze Studio

Web-native MMD animation editor in the browser (WebGPU).

![Screenshot](./screenshot.png)

## Features

- [x] PMX model and VMD animation loading and rendering with IK and physics
- [x] Timeline with dope sheet and per-channel curve editor
- [x] Bézier interpolation curve editing
- [x] Keyframe insert / delete at playhead
- [ ] Bone list with grouped hierarchy
- [ ] GPU picking selection
- [ ] Morph list with weight control
- [ ] Animation layers with blend weights and bone masks
- [ ] Rotation / translation sliders with direct numeric input
- [ ] Visual Bézier curve editor widget for interpolation handles
- [ ] Custom bone groups with mute / solo toggle
- [ ] Clip operations: cut, copy, paste, mirrored paste (左↔右), import, time stretch
- [ ] VMD export
- [ ] Undo / redo
- [ ] Keyboard shortcuts
- [ ] Project persistence (localStorage auto-save + cloud sync via Clerk / Supabase)
- [ ] 3D transform gizmos in viewport
- [ ] Mocap import (video → VMD)
- [ ] Overleaf style real-time collaboration
- [ ] AI-assisted animation (generative infill, motion retargeting)

## Tech Stack

- **Engine**: [reze-engine](https://github.com/AmyangXYZ/reze-engine) — WebGPU, Ammo.js physics
- **Editor**: Next.js, shadcn/ui

## Development

```bash
npm install
npm run dev     # http://localhost:4000
```

## License

GPLv3
