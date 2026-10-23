# Neo Battlezone

A retro vector-space combat prototype for the browser — first-person ship combat through a procedural planetoid field, rendered as glowing wireframes with bloom, in the spirit of *Battlezone* and *Star Raiders*.

**[Play it live →](https://vincentkovar.github.io/Neo-Battlezone/)**

## What it is

You're flying inside a procedurally generated asteroid field. The camera *is* the ship. Hostiles include:

- **Interceptors** — enemy ships that maneuver and fire lasers
- **Battle stations** — floating hulks with a spinning turret that launches tank-style missiles when you're on their facing side
- **Armored asteroids** — ~15% of the field is invulnerable steel dodecahedra; shots deflect off them instead of destroying them

Warp gates refuel and repair your ship, and trigger a Star Raiders-style FOV/speed warp tween when you fly through one.

## Controls

| Input | Action |
|---|---|
| Drag anywhere | Steer (relative touch-drag, no joystick) |
| Tap | Fire |
| Hold still | Autofire |
| Right-edge drag | Throttle slider |
| Mouse drag / click (desktop) | Steer / fire |
| Arrow keys (desktop) | Steer |
| W / S (desktop) | Throttle |
| Space (desktop) | Fire |

Built as an installable PWA — works offline once loaded, and supports touch on mobile.

## Stack

- [Vite](https://vitejs.dev/) + React + TypeScript
- [Three.js](https://threejs.org/) via [`@react-three/fiber`](https://docs.pmnd.rs/react-three-fiber)
- [`@react-three/postprocessing`](https://github.com/pmndrs/react-postprocessing) for bloom
- Tailwind CSS for HUD chrome

## Development

```bash
npm install
npm run dev        # start dev server
npm run build       # typecheck + production build
npm run preview     # preview the production build locally
npm run typecheck   # type-check only
```

## Deployment

Pushes to `main` build and deploy automatically to GitHub Pages via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## License

MIT — see [LICENSE](LICENSE).
