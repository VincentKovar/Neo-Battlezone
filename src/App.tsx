/**
 * NEO BATTLEZONE — retro vector-space combat prototype.
 *
 * One-file game: simulation, input, rendering, HUD.
 * First-person ship (camera IS the ship) flying through a procedural
 * planetoid field. Glowing wireframes via bloom. Warp gates refuel/repair
 * and trigger a Star Raiders-style FOV/speed warp tween.
 *
 * Hostiles:
 *  - Interceptors  — flying enemy ships that maneuver and fire lasers
 *  - Battle stations — floating hulks with a spinning turret that launches
 *                      Battlezone-tank missiles when you're on their facing side
 *  - Solid asteroids — 15% of the field is armored (steel dodecahedra),
 *                      invulnerable to fire; shots deflect off them
 *
 * Controls:
 *  - Drag anywhere       → steer (relative touch-drag, no joystick)
 *  - Tap                 → fire
 *  - Hold (still)        → autofire
 *  - Right-edge drag     → throttle slider
 *  - Desktop: mouse drag / click, arrows steer, W/S throttle, Space fire
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame } from '@react-three/fiber'
import type { RootState } from '@react-three/fiber'
import { EffectComposer, Bloom } from '@react-three/postprocessing'

// ---------------------------------------------------------------- tuning ---
const MAX_SPEED = 95            // units/s at full throttle, no warp
const TURN_SENS = 0.0042        // radians per pixel of drag
const PLANETOID_COUNT = 44
const SOLID_FRACTION = 0.15     // fraction of asteroids that are armored/invulnerable
const FIELD_NEAR = 240          // respawn distance band ahead of ship
const FIELD_FAR = 720
const PROJECTILE_SPEED = 460
const PROJECTILE_LIFE = 2.0
const PROJECTILE_POOL = 12
const EXPLOSION_POOL = 12
const RADAR_RANGE = 520
const WARP_DURATION = 2.8       // seconds
const WARP_SPEED_MULT = 5       // added at warp peak
const THROTTLE_ZONE = 0.86      // touches right of this fraction = throttle
const FUEL_BURN = 1.15          // fuel/s at full throttle
const BASE_FOV = 62

// --- hostiles (eased — fewer at once, must be visible before they fire) ---
const ENEMY_COUNT = 3
const ENEMY_HP = 3
const ENEMY_R = 11             // collision/hit radius — larger = easier to shoot down
const ENEMY_MESH_SCALE = 1.7   // visual scale of the interceptor wireframe (base geo ~±7 units)
const ENEMY_SPEED = 46
const ENEMY_STANDOFF = 170      // preferred distance the interceptor holds
const ENEMY_RANGE = 300         // won't fire beyond this — keeps shots in view, not off-screen
const ENEMY_FIRE_CD = 2.6       // base seconds between shots
const ENEMY_RESPAWN = 5         // seconds after death before a new one warps in

const STATION_COUNT = 1
const STATION_HP = 12
const STATION_R = 22
const STATION_RANGE = 380
const STATION_FIRE_CD = 3.4
const STATION_CONE = 0.25       // cos threshold — player must be within the frontal hemisphere
const STATION_RESPAWN = 10

const ENEMY_SHOT_POOL = 22
const LASER_SPEED = 300
const MISSILE_SPEED = 185
const LASER_DMG = 5
const MISSILE_DMG = 12
const ENEMY_RAM_DMG = 18
const STATION_RAM_DMG = 30
const ASTEROID_DMG = 15

const COL_BG = '#000006'
const COL_WARP_FOG = '#00ff55'
const COL_WIRE = '#dfe6ff'
const COL_GREEN = '#37ff85'
const COL_SOLID = '#8fb9d6'     // steel — armored asteroids
const COL_ENEMY = '#ff5a4d'     // hostile red
const COL_STATION = '#ffb020'   // amber
const COL_LASER = '#ff5252'
const COL_MISSILE = '#ff9a3c'

// ------------------------------------------------------------- game state ---
type Planetoid = { pos: THREE.Vector3; r: number; rot: THREE.Euler; spin: THREE.Vector3; solid: boolean }
type Projectile = { pos: THREE.Vector3; vel: THREE.Vector3; life: number }
type EnemyShot = { pos: THREE.Vector3; vel: THREE.Vector3; life: number; missile: boolean }
type Enemy = {
  pos: THREE.Vector3
  vel: THREE.Vector3
  quat: THREE.Quaternion
  hp: number
  alive: boolean
  fireCd: number
  respawnT: number
  phase: number
}
type Station = {
  pos: THREE.Vector3
  facing: THREE.Vector3   // fixed frontal direction (horizontal)
  turretYaw: number       // visual spin
  hp: number
  alive: boolean
  fireCd: number
  respawnT: number
}
type Explosion = { pos: THREE.Vector3; t: number; r: number; color: THREE.Color }

const G = {
  running: false,
  gameOver: false,
  yaw: 0,
  pitch: 0,
  roll: 0,
  dYaw: 0, // accumulated drag pixels this frame
  dPitch: 0,
  throttle: 0.45,
  speed: 0,
  pos: new THREE.Vector3(),
  shields: 100,
  fuel: 100,
  score: 0,
  best: Number(localStorage.getItem('neobz-best') || 0),
  gates: 0,
  kills: 0,
  fireQueue: 0,
  hit: 0, // 0..1 damage flash / camera shake
  hitCooldown: 0,
  msg: '',
  msgT: 0,
  warpT: -1, // -1 idle, else 0..1 progress
  gate: { pos: new THREE.Vector3(0, 0, -950), taken: false },
  planetoids: [] as Planetoid[],
  projectiles: [] as Projectile[],
  enemyShots: [] as EnemyShot[],
  enemies: [] as Enemy[],
  stations: [] as Station[],
  explosions: [] as Explosion[],
}

type Ptr = {
  x0: number
  y0: number
  x: number
  y: number
  t0: number
  moved: boolean
  throttle: boolean
  lastFire: number
}
const INPUT = { ptrs: new Map<number, Ptr>(), keys: new Set<string>() }

// dev-only console access for debugging: __G.score, __G.enemies, …
if (import.meta.env.DEV) Object.assign(window, { __G: G, __INPUT: INPUT })

function say(msg: string, secs = 2.4) {
  G.msg = msg
  G.msgT = secs
}

function scatterPlanetoid(p: Planetoid) {
  // Initial scatter: shell around origin, biased ahead (-Z).
  const d = 140 + Math.random() * 560
  tmpA
    .set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 1.2, -(Math.random() * 1.6 + 0.25))
    .normalize()
  p.pos.copy(tmpA).multiplyScalar(d)
  p.r = 4 + Math.random() * 12
  p.solid = Math.random() < SOLID_FRACTION
}

function reset() {
  G.running = true
  G.gameOver = false
  G.yaw = 0
  G.pitch = 0
  G.roll = 0
  G.dYaw = 0
  G.dPitch = 0
  G.throttle = 0.45
  G.speed = 0
  G.pos.set(0, 0, 0)
  G.shields = 100
  G.fuel = 100
  G.score = 0
  G.gates = 0
  G.kills = 0
  G.fireQueue = 0
  G.hit = 0
  G.hitCooldown = 0
  G.msg = ''
  G.msgT = 0
  G.warpT = -1
  G.gate.pos.set((Math.random() - 0.5) * 300, (Math.random() - 0.5) * 140, -950)
  G.gate.taken = false
  G.projectiles.length = 0
  G.enemyShots.length = 0
  G.explosions.length = 0

  G.planetoids.length = 0
  for (let i = 0; i < PLANETOID_COUNT; i++) {
    const p: Planetoid = {
      pos: new THREE.Vector3(),
      r: 8,
      rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, 0),
      spin: new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, 0),
      solid: false,
    }
    scatterPlanetoid(p)
    G.planetoids.push(p)
  }

  G.enemies.length = 0
  for (let i = 0; i < ENEMY_COUNT; i++) {
    const e: Enemy = {
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      hp: ENEMY_HP,
      alive: true,
      fireCd: 1 + Math.random() * 2,
      respawnT: 0,
      phase: Math.random() * Math.PI * 2,
    }
    spawnEnemyAhead(e)
    G.enemies.push(e)
  }

  G.stations.length = 0
  for (let i = 0; i < STATION_COUNT; i++) {
    const s: Station = {
      pos: new THREE.Vector3(),
      facing: new THREE.Vector3(),
      turretYaw: Math.random() * Math.PI * 2,
      hp: STATION_HP,
      alive: true,
      fireCd: 2 + Math.random() * 2,
      respawnT: 0,
    }
    spawnStationAhead(s)
    G.stations.push(s)
  }

  say('ENGAGE — HOSTILES IN SECTOR', 3)
}

// ------------------------------------------------------------------ audio ---
let actx: AudioContext | null = null
function audio(): AudioContext {
  if (!actx) actx = new AudioContext()
  if (actx.state === 'suspended') actx.resume()
  return actx
}
function blip(freq0: number, freq1: number, dur: number, type: OscillatorType, gain = 0.12) {
  try {
    const ctx = audio()
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq0, t)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq1), t + dur)
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(g).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + dur)
  } catch {
    /* audio unavailable — play on silently */
  }
}

// Shared 1s white-noise buffer for percussive/explosive sounds.
let noiseBuf: AudioBuffer | null = null
function noise(ctx: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    const n = ctx.sampleRate
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate)
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
  }
  return noiseBuf
}

const sndZap = () => blip(880, 90, 0.14, 'square', 0.09)
const sndBoom = () => blip(220, 30, 0.45, 'sawtooth', 0.2)
const sndThud = () => blip(120, 35, 0.25, 'triangle', 0.3)
const sndWarp = () => blip(70, 950, 1.4, 'sawtooth', 0.14)
const sndEnemyLaser = () => blip(1250, 320, 0.13, 'sawtooth', 0.05)
const sndClink = () => blip(1500, 900, 0.05, 'square', 0.05)
const sndEnemyDie = () => blip(320, 40, 0.4, 'sawtooth', 0.16)

// Battlezone-tank-style cannon: filtered noise burst + a low sine thump.
function sndTankFire() {
  try {
    const ctx = audio()
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = noise(ctx)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(650, t)
    lp.frequency.exponentialRampToValueAtTime(70, t + 0.38)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.32, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42)
    src.connect(lp).connect(g).connect(ctx.destination)
    src.start(t)
    src.stop(t + 0.42)

    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(95, t)
    o.frequency.exponentialRampToValueAtTime(38, t + 0.32)
    const g2 = ctx.createGain()
    g2.gain.setValueAtTime(0.5, t)
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.36)
    o.connect(g2).connect(ctx.destination)
    o.start(t)
    o.stop(t + 0.36)
  } catch {
    /* audio unavailable */
  }
}

// Big filtered-noise explosion for station kills.
function sndBigBoom() {
  try {
    const ctx = audio()
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = noise(ctx)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(900, t)
    lp.frequency.exponentialRampToValueAtTime(60, t + 0.7)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.4, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8)
    src.connect(lp).connect(g).connect(ctx.destination)
    src.start(t)
    src.stop(t + 0.8)
  } catch {
    /* audio unavailable */
  }
}

// ------------------------------------------------------------- simulation ---
const tmpA = new THREE.Vector3()
const tmpB = new THREE.Vector3()
const tmpC = new THREE.Vector3()
const tmpD = new THREE.Vector3()
const tmpFwd = new THREE.Vector3()
const tmpQ = new THREE.Quaternion()
const tmpM = new THREE.Matrix4()
const tmpS = new THREE.Vector3()
const tmpE = new THREE.Euler()
const UP = new THREE.Vector3(0, 1, 0)
const fogBase = new THREE.Color(COL_BG)
const fogWarp = new THREE.Color(COL_WARP_FOG)

function respawnPlanetoid(p: Planetoid, fwd: THREE.Vector3) {
  const d = FIELD_NEAR + Math.random() * (FIELD_FAR - FIELD_NEAR)
  tmpB.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
    .normalize()
    .multiplyScalar(Math.random() * d * 0.55)
  p.pos.copy(G.pos).addScaledVector(fwd, d).add(tmpB)
  p.r = 4 + Math.random() * 12
  p.solid = Math.random() < SOLID_FRACTION
}

// Place ahead of the ship along its current heading, offset to the side.
function spawnAhead(out: THREE.Vector3, minD: number, maxD: number, spread: number) {
  const fwd = tmpFwd.lengthSq() > 0 ? tmpFwd : tmpA.set(0, 0, -1)
  const d = minD + Math.random() * (maxD - minD)
  tmpB.set(Math.random() - 0.5, (Math.random() - 0.5) * 0.7, Math.random() - 0.5)
    .normalize()
    .multiplyScalar(spread * (0.4 + Math.random() * 0.6))
  out.copy(G.pos).addScaledVector(fwd, d).add(tmpB)
}

function spawnEnemyAhead(e: Enemy) {
  spawnAhead(e.pos, 220, 480, 260)
  e.vel.set(0, 0, 0)
  e.hp = ENEMY_HP
  e.alive = true
  e.fireCd = 0.8 + Math.random() * ENEMY_FIRE_CD
  e.respawnT = 0
  e.phase = Math.random() * Math.PI * 2
}

function spawnStationAhead(s: Station) {
  spawnAhead(s.pos, 420, 820, 320)
  const a = Math.random() * Math.PI * 2
  s.facing.set(Math.sin(a), 0, Math.cos(a)).normalize()
  s.turretYaw = Math.random() * Math.PI * 2
  s.hp = STATION_HP
  s.alive = true
  s.fireCd = 1.5 + Math.random() * 2
  s.respawnT = 0
}

function respawnGate(fwd: THREE.Vector3) {
  tmpB.set(Math.random() - 0.5, (Math.random() - 0.5) * 0.6, Math.random() - 0.5).multiplyScalar(260)
  G.gate.pos.copy(G.pos).addScaledVector(fwd, 850 + Math.random() * 450).add(tmpB)
  G.gate.taken = false
}

// color-codes the flash so the player can read what hit them at a glance:
// white = asteroid, steel = armor spark, red = interceptor, amber = station
function addExplosion(pos: THREE.Vector3, r: number, color = '#ffffff') {
  if (G.explosions.length >= EXPLOSION_POOL) G.explosions.shift()
  G.explosions.push({ pos: pos.clone(), t: 0, r, color: new THREE.Color(color) })
}

function fireProjectile(fwd: THREE.Vector3) {
  if (G.projectiles.length >= PROJECTILE_POOL) G.projectiles.shift()
  G.projectiles.push({
    pos: G.pos.clone().addScaledVector(fwd, 5),
    vel: fwd.clone().multiplyScalar(G.speed + PROJECTILE_SPEED),
    life: PROJECTILE_LIFE,
  })
  sndZap()
}

function fireEnemyShot(from: THREE.Vector3, dir: THREE.Vector3, missile: boolean) {
  if (G.enemyShots.length >= ENEMY_SHOT_POOL) G.enemyShots.shift()
  G.enemyShots.push({
    pos: from.clone(),
    vel: dir.clone().normalize().multiplyScalar(missile ? MISSILE_SPEED : LASER_SPEED),
    life: missile ? 5 : 2.6,
    missile,
  })
}

function damagePlayer(amount: number) {
  if (!G.running || G.gameOver) return
  G.shields = Math.max(0, G.shields - amount)
  G.hit = 1
  if (G.shields <= 0) {
    G.gameOver = true
    G.best = Math.max(G.best, G.score)
    localStorage.setItem('neobz-best', String(G.best))
    addExplosion(G.pos.clone().addScaledVector(tmpFwd, 10), 12)
    sndBigBoom()
  }
}

function killEnemy(e: Enemy) {
  e.alive = false
  e.respawnT = ENEMY_RESPAWN
  addExplosion(e.pos, 9, COL_ENEMY)
  G.score += 300
  G.kills++
  sndEnemyDie()
}

function killStation(s: Station) {
  s.alive = false
  s.respawnT = STATION_RESPAWN
  addExplosion(s.pos, STATION_R, COL_STATION)
  G.score += 1500
  G.kills++
  sndBigBoom()
}

function simulate(state: RootState, dt: number) {
  const cam = state.camera as THREE.PerspectiveCamera
  const now = performance.now()
  const t = now / 1000
  const live = G.running && !G.gameOver

  // --- input: keyboard steering/throttle ---
  if (live) {
    const K = INPUT.keys
    if (K.has('ArrowLeft')) G.dYaw -= 260 * dt
    if (K.has('ArrowRight')) G.dYaw += 260 * dt
    if (K.has('ArrowUp')) G.dPitch -= 260 * dt
    if (K.has('ArrowDown')) G.dPitch += 260 * dt
    if (K.has('KeyW')) G.throttle = Math.min(1, G.throttle + 0.7 * dt)
    if (K.has('KeyS')) G.throttle = Math.max(0, G.throttle - 0.7 * dt)

    // hold-to-autofire on stationary touches
    for (const p of INPUT.ptrs.values()) {
      if (!p.throttle && !p.moved && now - p.t0 > 350 && now - p.lastFire > 170) {
        p.lastFire = now
        G.fireQueue++
      }
    }
  }

  // --- orientation ---
  const iy = G.dYaw
  const ip = G.dPitch
  G.dYaw = 0
  G.dPitch = 0
  if (live) {
    G.yaw -= iy * TURN_SENS
    G.pitch = THREE.MathUtils.clamp(G.pitch - ip * TURN_SENS, -1.35, 1.35)
  }
  const yawRate = dt > 0 ? (iy * TURN_SENS) / dt : 0
  const targetRoll = THREE.MathUtils.clamp(-yawRate * 0.22, -0.55, 0.55)
  G.roll += (targetRoll - G.roll) * Math.min(1, dt * 6)

  tmpE.set(G.pitch, G.yaw, 0, 'YXZ')
  tmpQ.setFromEuler(tmpE)
  tmpFwd.set(0, 0, -1).applyQuaternion(tmpQ)

  // --- warp progress ---
  let warp = 0
  if (G.warpT >= 0) {
    G.warpT += dt / WARP_DURATION
    if (G.warpT >= 1) {
      G.warpT = -1
      respawnGate(tmpFwd)
    } else {
      warp = Math.sin(Math.PI * G.warpT)
    }
  }

  // --- speed, fuel, position ---
  if (live) {
    const maxThr = G.fuel > 0 ? 1 : 0.25
    const thr = Math.min(G.throttle, maxThr)
    const target = thr * MAX_SPEED * (1 + warp * WARP_SPEED_MULT)
    G.speed += (target - G.speed) * Math.min(1, dt * 2.5)
    const hadFuel = G.fuel > 0
    G.fuel = Math.max(0, G.fuel - thr * FUEL_BURN * dt)
    if (hadFuel && G.fuel === 0) say('FUEL RESERVE — REACH A WARP GATE', 4)
    G.pos.addScaledVector(tmpFwd, G.speed * dt)
  } else {
    G.speed *= 1 - Math.min(1, dt * 2)
  }

  // --- camera ---
  cam.position.copy(G.pos)
  if (G.hit > 0) {
    cam.position.x += (Math.random() - 0.5) * G.hit * 1.4
    cam.position.y += (Math.random() - 0.5) * G.hit * 1.4
  }
  cam.rotation.set(G.pitch, G.yaw, G.roll, 'YXZ')
  const fov = BASE_FOV + warp * 42 + (Math.min(G.speed, MAX_SPEED) / MAX_SPEED) * 5
  if (Math.abs(cam.fov - fov) > 0.01) {
    cam.fov = fov
    cam.updateProjectionMatrix()
  }

  // --- fog: black → neon green tunnel during warp ---
  const fog = state.scene.fog as THREE.Fog | null
  if (fog) {
    fog.color.lerpColors(fogBase, fogWarp, warp * 0.85)
    fog.near = 60 - warp * 40
    fog.far = 760 - warp * 320
  }

  // --- planetoids: spin, recycle, ship collision ---
  G.hitCooldown = Math.max(0, G.hitCooldown - dt)
  for (const p of G.planetoids) {
    p.rot.x += p.spin.x * dt
    p.rot.y += p.spin.y * dt
    tmpA.copy(p.pos).sub(G.pos)
    const dist = tmpA.length()
    if (dist > 950 || (dist > 280 && tmpA.dot(tmpFwd) < 0)) {
      respawnPlanetoid(p, tmpFwd)
      continue
    }
    if (live && dist < p.r + 5 && G.hitCooldown <= 0) {
      G.hitCooldown = 1
      addExplosion(p.pos, p.r, p.solid ? COL_SOLID : '#ffffff')
      // Solid asteroids are immovable — you bounce off and take the hit; they stay.
      if (!p.solid) respawnPlanetoid(p, tmpFwd)
      sndThud()
      damagePlayer(ASTEROID_DMG)
      if (!G.gameOver) {
        say((p.solid ? 'ASTEROID COLLISION — SHIELDS ' : 'HULL IMPACT — SHIELDS ') + Math.round(G.shields) + '%')
      }
    }
  }

  // --- interceptors: maneuver, fire, recycle, ram ---
  if (live) {
    for (const e of G.enemies) {
      if (!e.alive) {
        e.respawnT -= dt
        if (e.respawnT <= 0) spawnEnemyAhead(e)
        continue
      }
      tmpC.copy(e.pos).sub(G.pos) // enemy → player offset (relative pos)
      const dist = tmpC.length() || 0.001
      // recycle if far away or well behind the ship
      if (dist > 1250 || (dist > 460 && tmpC.dot(tmpFwd) > 0)) {
        spawnEnemyAhead(e)
        continue
      }
      // desired velocity: hold standoff radius, strafe tangentially
      tmpA.copy(tmpC).multiplyScalar(-1 / dist) // unit dir toward player
      const approach = dist > ENEMY_STANDOFF ? 1 : -1
      tmpB.crossVectors(tmpA, UP).normalize() // horizontal tangent
      const strafe = Math.sin(t * 1.1 + e.phase) * 0.6
      const bob = Math.sin(t * 0.8 + e.phase * 1.7) * 0.25
      tmpD
        .copy(tmpA)
        .multiplyScalar(approach * ENEMY_SPEED)
        .addScaledVector(tmpB, strafe * ENEMY_SPEED)
        .addScaledVector(UP, bob * ENEMY_SPEED)
      e.vel.lerp(tmpD, Math.min(1, dt * 1.6))
      e.pos.addScaledVector(e.vel, dt)
      // face the player (mesh nose is -Z)
      tmpM.lookAt(e.pos, G.pos, UP)
      e.quat.setFromRotationMatrix(tmpM)
      // fire lasers
      e.fireCd -= dt
      if (dist < ENEMY_RANGE && e.fireCd <= 0) {
        e.fireCd = ENEMY_FIRE_CD * (0.7 + Math.random() * 0.7)
        tmpA.copy(G.pos).sub(e.pos)
        fireEnemyShot(tmpB.copy(e.pos).addScaledVector(tmpA.normalize(), ENEMY_R), tmpA, false)
        sndEnemyLaser()
      }
      // ram
      if (dist < ENEMY_R + 5 && G.hitCooldown <= 0) {
        G.hitCooldown = 1
        damagePlayer(ENEMY_RAM_DMG)
        killEnemy(e)
        if (!G.gameOver) say('COLLISION — INTERCEPTOR DOWN')
      }
    }
  }

  // --- battle stations: spin turret, fire from facing side, recycle, ram ---
  if (live) {
    for (const s of G.stations) {
      if (!s.alive) {
        s.respawnT -= dt
        if (s.respawnT <= 0) spawnStationAhead(s)
        continue
      }
      s.turretYaw += 0.8 * dt
      tmpC.copy(s.pos).sub(G.pos)
      const dist = tmpC.length() || 0.001
      if (dist > 1500 || (dist > 640 && tmpC.dot(tmpFwd) > 0)) {
        spawnStationAhead(s)
        continue
      }
      // fire when the player is within the station's frontal hemisphere
      tmpA.copy(G.pos).sub(s.pos) // station → player
      tmpB.set(tmpA.x, 0, tmpA.z).normalize()
      const onFace = tmpB.dot(s.facing) > STATION_CONE
      s.fireCd -= dt
      if (dist < STATION_RANGE && onFace && s.fireCd <= 0) {
        s.fireCd = STATION_FIRE_CD
        fireEnemyShot(tmpD.copy(s.pos).addScaledVector(s.facing, STATION_R), tmpA, true)
        sndTankFire()
      }
      // ram — stations are big and hurt
      if (dist < STATION_R + 6 && G.hitCooldown <= 0) {
        G.hitCooldown = 1
        addExplosion(G.pos.clone().addScaledVector(tmpFwd, 8), 6, COL_STATION)
        sndThud()
        damagePlayer(STATION_RAM_DMG)
        if (!G.gameOver) say('WARNING — STATION HULL')
      }
    }
  }

  // --- player projectiles ---
  if (live) {
    while (G.fireQueue > 0) {
      G.fireQueue--
      fireProjectile(tmpFwd)
    }
  } else {
    G.fireQueue = 0
  }
  for (let i = G.projectiles.length - 1; i >= 0; i--) {
    const pr = G.projectiles[i]
    pr.life -= dt
    pr.pos.addScaledVector(pr.vel, dt)
    let dead = pr.life <= 0

    // vs asteroids
    if (!dead) {
      for (const p of G.planetoids) {
        if (pr.pos.distanceTo(p.pos) < p.r + 4) {
          if (p.solid) {
            addExplosion(pr.pos, 2, COL_SOLID) // deflect spark — armor holds
            sndClink()
          } else {
            addExplosion(p.pos, p.r)
            respawnPlanetoid(p, tmpFwd)
            G.score += 100
            sndBoom()
          }
          dead = true
          break
        }
      }
    }
    // vs interceptors
    if (!dead) {
      for (const e of G.enemies) {
        if (e.alive && pr.pos.distanceTo(e.pos) < ENEMY_R + 3) {
          addExplosion(pr.pos, 3, COL_ENEMY)
          if (--e.hp <= 0) killEnemy(e)
          else sndClink()
          dead = true
          break
        }
      }
    }
    // vs stations
    if (!dead) {
      for (const s of G.stations) {
        if (s.alive && pr.pos.distanceTo(s.pos) < STATION_R + 3) {
          addExplosion(pr.pos, 4, COL_STATION)
          if (--s.hp <= 0) killStation(s)
          else sndClink()
          dead = true
          break
        }
      }
    }
    if (dead) G.projectiles.splice(i, 1)
  }

  // --- enemy shots: travel, hit the player ---
  for (let i = G.enemyShots.length - 1; i >= 0; i--) {
    const sh = G.enemyShots[i]
    sh.life -= dt
    sh.pos.addScaledVector(sh.vel, dt)
    let dead = sh.life <= 0
    if (!dead && live && sh.pos.distanceTo(G.pos) < 6) {
      addExplosion(
        G.pos.clone().addScaledVector(tmpFwd, 6),
        sh.missile ? 5 : 3,
        sh.missile ? COL_MISSILE : COL_LASER
      )
      sndThud()
      damagePlayer(sh.missile ? MISSILE_DMG : LASER_DMG)
      if (!G.gameOver) {
        say((sh.missile ? 'MISSILE IMPACT — SHIELDS ' : 'LASER HIT — SHIELDS ') + Math.round(G.shields) + '%')
      }
      dead = true
    }
    if (dead) G.enemyShots.splice(i, 1)
  }

  // --- warp gate ---
  if (live && !G.gate.taken) {
    tmpA.copy(G.gate.pos).sub(G.pos)
    const gd = tmpA.length()
    if (gd < 16) {
      G.gate.taken = true
      G.warpT = 0
      G.gates++
      G.score += 500
      G.fuel = Math.min(100, G.fuel + 40)
      G.shields = Math.min(100, G.shields + 25)
      sndWarp()
      say('WARP ENGAGED — SYSTEMS RESTORED', 3)
    } else if (gd > 120 && tmpA.dot(tmpFwd) < 0) {
      respawnGate(tmpFwd)
      say('GATE MISSED — RECALCULATING')
    }
  }

  // --- explosions, timers ---
  for (let i = G.explosions.length - 1; i >= 0; i--) {
    G.explosions[i].t += dt * 1.5
    if (G.explosions[i].t >= 1) G.explosions.splice(i, 1)
  }
  G.hit = Math.max(0, G.hit - dt * 1.6)
  G.msgT = Math.max(0, G.msgT - dt)
}

// ------------------------------------------------------- scene components ---
function Sim() {
  useFrame((state, dt) => simulate(state, Math.min(dt, 0.05)), -10)
  return null
}

function Stars() {
  const ref = useRef<THREE.Points>(null!)
  const geo = useMemo(() => {
    const n = 700
    const arr = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      tmpA.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(1100 + Math.random() * 300)
      arr[i * 3] = tmpA.x
      arr[i * 3 + 1] = tmpA.y
      arr[i * 3 + 2] = tmpA.z
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    return g
  }, [])
  const mat = useMemo(
    () => new THREE.PointsMaterial({ color: '#8fa8e8', size: 2, sizeAttenuation: false }),
    []
  )
  // Stars ride along with the ship → parallax-free "infinite distance" backdrop.
  useFrame(() => ref.current.position.copy(G.pos))
  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} />
}

// Normal asteroids (icosahedra) + armored solids (dodecahedra with a dark fill
// so they read as opaque rock). Three instanced meshes, packed each frame via count.
function Planetoids() {
  const normalRef = useRef<THREE.InstancedMesh>(null!)
  const solidWireRef = useRef<THREE.InstancedMesh>(null!)
  const solidFillRef = useRef<THREE.InstancedMesh>(null!)
  const icoGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 0), [])
  // Dense triangulated lattice (detail 2) so armored asteroids read as reinforced,
  // vs the chunky low-poly icosahedra of the destructible rocks.
  const latticeGeo = useMemo(() => new THREE.DodecahedronGeometry(1, 2), [])
  const normalMat = useMemo(() => new THREE.MeshBasicMaterial({ color: COL_WIRE, wireframe: true }), [])
  const solidWireMat = useMemo(() => new THREE.MeshBasicMaterial({ color: COL_SOLID, wireframe: true }), [])
  const solidFillMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#04070c' }), [])
  useFrame(() => {
    let n = 0
    let s = 0
    for (let i = 0; i < G.planetoids.length; i++) {
      const p = G.planetoids[i]
      tmpQ.setFromEuler(p.rot)
      if (p.solid) {
        tmpM.compose(p.pos, tmpQ, tmpS.setScalar(p.r))
        solidWireRef.current.setMatrixAt(s, tmpM)
        tmpM.compose(p.pos, tmpQ, tmpS.setScalar(p.r * 0.94))
        solidFillRef.current.setMatrixAt(s, tmpM)
        s++
      } else {
        tmpM.compose(p.pos, tmpQ, tmpS.setScalar(p.r))
        normalRef.current.setMatrixAt(n, tmpM)
        n++
      }
    }
    normalRef.current.count = n
    solidWireRef.current.count = s
    solidFillRef.current.count = s
    normalRef.current.instanceMatrix.needsUpdate = true
    solidWireRef.current.instanceMatrix.needsUpdate = true
    solidFillRef.current.instanceMatrix.needsUpdate = true
  })
  return (
    <>
      <instancedMesh ref={normalRef} args={[icoGeo, normalMat, PLANETOID_COUNT]} frustumCulled={false} />
      <instancedMesh ref={solidFillRef} args={[latticeGeo, solidFillMat, PLANETOID_COUNT]} frustumCulled={false} />
      <instancedMesh ref={solidWireRef} args={[latticeGeo, solidWireMat, PLANETOID_COUNT]} frustumCulled={false} />
    </>
  )
}

function useLineSegments(points: number[][]) {
  return useMemo(() => {
    const arr = new Float32Array(points.length * 3)
    points.forEach((p, i) => {
      arr[i * 3] = p[0]
      arr[i * 3 + 1] = p[1]
      arr[i * 3 + 2] = p[2]
    })
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    return g
  }, [points])
}

// Interceptor: swept-wing arrow, nose along -Z (so lookAt aims it at the player).
function Enemies() {
  const refs = useRef<(THREE.Group | null)[]>([])
  const geo = useLineSegments([
    [0, 0, -7], [-7, 0, 4], // nose → left wingtip
    [0, 0, -7], [7, 0, 4],  // nose → right wingtip
    [0, 0, -7], [0, 2.5, 3], // nose → dorsal fin
    [-7, 0, 4], [7, 0, 4],  // trailing edge
    [-7, 0, 4], [0, 0, 2],  // wing → tail
    [7, 0, 4], [0, 0, 2],
    [0, 2.5, 3], [0, 0, 2],
  ])
  const mat = useMemo(() => new THREE.LineBasicMaterial({ color: COL_ENEMY }), [])
  useFrame(() => {
    for (let i = 0; i < ENEMY_COUNT; i++) {
      const grp = refs.current[i]
      if (!grp) continue
      const e = G.enemies[i]
      if (e && e.alive) {
        grp.visible = true
        grp.position.copy(e.pos)
        grp.quaternion.copy(e.quat)
      } else {
        grp.visible = false
      }
    }
  })
  return (
    <>
      {Array.from({ length: ENEMY_COUNT }, (_, i) => (
        <group
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          visible={false}
          scale={ENEMY_MESH_SCALE}
        >
          <lineSegments geometry={geo} material={mat} frustumCulled={false} />
        </group>
      ))}
    </>
  )
}

// Battle station: icosa core + twin gyroscope rings + a spinning turret cannon.
function Stations() {
  const refs = useRef<(THREE.Group | null)[]>([])
  const coreRefs = useRef<(THREE.Mesh | null)[]>([])
  const turretRefs = useRef<(THREE.Group | null)[]>([])
  const coreGeo = useMemo(() => new THREE.IcosahedronGeometry(STATION_R * 0.55, 0), [])
  const coreMat = useMemo(() => new THREE.MeshBasicMaterial({ color: COL_STATION, wireframe: true }), [])
  const ringA = useMemo(() => circleGeometry(STATION_R), [])
  const ringB = useMemo(() => circleGeometry(STATION_R * 0.8), [])
  const ringMat = useMemo(() => new THREE.LineBasicMaterial({ color: COL_STATION }), [])
  // cannon: square base tapering to a muzzle along -Z (the turret's aim axis)
  const barrelGeo = useLineSegments([
    [-2, -2, 0], [2, -2, 0], [2, -2, 0], [2, 2, 0], [2, 2, 0], [-2, 2, 0], [-2, 2, 0], [-2, -2, 0],
    [-2, -2, 0], [0, 0, -STATION_R], [2, -2, 0], [0, 0, -STATION_R],
    [2, 2, 0], [0, 0, -STATION_R], [-2, 2, 0], [0, 0, -STATION_R],
  ])
  const barrelMat = useMemo(() => new THREE.LineBasicMaterial({ color: '#ffd27a' }), [])
  useFrame((_, dt) => {
    for (let i = 0; i < STATION_COUNT; i++) {
      const grp = refs.current[i]
      if (!grp) continue
      const s = G.stations[i]
      if (s && s.alive) {
        grp.visible = true
        grp.position.copy(s.pos)
        const core = coreRefs.current[i]
        if (core) core.rotation.y += dt * 0.3
        const turret = turretRefs.current[i]
        if (turret) turret.rotation.y = s.turretYaw
      } else {
        grp.visible = false
      }
    }
  })
  return (
    <>
      {Array.from({ length: STATION_COUNT }, (_, i) => (
        <group
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          visible={false}
        >
          <mesh
            ref={(el) => {
              coreRefs.current[i] = el
            }}
            geometry={coreGeo}
            material={coreMat}
            frustumCulled={false}
          />
          <lineLoop geometry={ringA} material={ringMat} rotation={[Math.PI / 2, 0, 0]} />
          <lineLoop geometry={ringB} material={ringMat} rotation={[0, 0, Math.PI / 2]} />
          <group
            ref={(el) => {
              turretRefs.current[i] = el
            }}
          >
            <lineSegments geometry={barrelGeo} material={barrelMat} frustumCulled={false} />
          </group>
        </group>
      ))}
    </>
  )
}

const AXIS_Z = new THREE.Vector3(0, 0, 1)
function Projectiles() {
  const refs = useRef<(THREE.Mesh | null)[]>([])
  const geo = useMemo(() => new THREE.OctahedronGeometry(0.9, 0), [])
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#9dffbd', wireframe: true }), [])
  useFrame(() => {
    for (let i = 0; i < PROJECTILE_POOL; i++) {
      const mesh = refs.current[i]
      if (!mesh) continue
      const pr = G.projectiles[i]
      if (pr) {
        mesh.visible = true
        mesh.position.copy(pr.pos)
        tmpA.copy(pr.vel).normalize()
        mesh.quaternion.setFromUnitVectors(AXIS_Z, tmpA)
        mesh.scale.set(0.7, 0.7, 2.6)
      } else {
        mesh.visible = false
      }
    }
  })
  return (
    <>
      {Array.from({ length: PROJECTILE_POOL }, (_, i) => (
        <mesh
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          geometry={geo}
          material={mat}
          visible={false}
          frustumCulled={false}
        />
      ))}
    </>
  )
}

// Enemy shots: red laser bolts + fatter orange missiles (color set per-frame).
function EnemyShots() {
  const refs = useRef<(THREE.Mesh | null)[]>([])
  const geo = useMemo(() => new THREE.OctahedronGeometry(1, 0), [])
  const mats = useMemo(
    () =>
      Array.from(
        { length: ENEMY_SHOT_POOL },
        () => new THREE.MeshBasicMaterial({ color: COL_LASER, wireframe: true })
      ),
    []
  )
  const laser = useMemo(() => new THREE.Color(COL_LASER), [])
  const missile = useMemo(() => new THREE.Color(COL_MISSILE), [])
  useFrame(() => {
    for (let i = 0; i < ENEMY_SHOT_POOL; i++) {
      const mesh = refs.current[i]
      if (!mesh) continue
      const sh = G.enemyShots[i]
      if (sh) {
        mesh.visible = true
        mesh.position.copy(sh.pos)
        tmpA.copy(sh.vel).normalize()
        mesh.quaternion.setFromUnitVectors(AXIS_Z, tmpA)
        if (sh.missile) {
          mesh.scale.set(1.4, 1.4, 3)
          mats[i].color.copy(missile)
        } else {
          mesh.scale.set(0.6, 0.6, 3)
          mats[i].color.copy(laser)
        }
      } else {
        mesh.visible = false
      }
    }
  })
  return (
    <>
      {mats.map((m, i) => (
        <mesh
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          geometry={geo}
          material={m}
          visible={false}
          frustumCulled={false}
        />
      ))}
    </>
  )
}

function Explosions() {
  const refs = useRef<(THREE.Mesh | null)[]>([])
  const geo = useMemo(() => new THREE.IcosahedronGeometry(1, 1), [])
  const mats = useMemo(
    () =>
      Array.from(
        { length: EXPLOSION_POOL },
        () => new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true, transparent: true })
      ),
    []
  )
  useFrame(() => {
    for (let i = 0; i < EXPLOSION_POOL; i++) {
      const mesh = refs.current[i]
      if (!mesh) continue
      const ex = G.explosions[i]
      if (ex) {
        mesh.visible = true
        mesh.position.copy(ex.pos)
        mesh.scale.setScalar(ex.r * (0.4 + ex.t * 2.6))
        mats[i].opacity = 1 - ex.t
        mats[i].color.copy(ex.color)
      } else {
        mesh.visible = false
      }
    }
  })
  return (
    <>
      {mats.map((m, i) => (
        <mesh
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          geometry={geo}
          material={m}
          visible={false}
          frustumCulled={false}
        />
      ))}
    </>
  )
}

function circleGeometry(r: number, segments = 48) {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2
    pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0))
  }
  return new THREE.BufferGeometry().setFromPoints(pts)
}

function Gate() {
  const outer = useRef<THREE.Group>(null!)
  const inner = useRef<THREE.Group>(null!)
  const mat = useMemo(() => new THREE.LineBasicMaterial({ color: COL_GREEN }), [])
  const ringA = useMemo(() => circleGeometry(12), [])
  const ringB = useMemo(() => circleGeometry(9), [])
  const spokes = useMemo(() => {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      pts.push(new THREE.Vector3(Math.cos(a) * 9, Math.sin(a) * 9, 0))
      pts.push(new THREE.Vector3(Math.cos(a) * 12, Math.sin(a) * 12, 0))
    }
    return new THREE.BufferGeometry().setFromPoints(pts)
  }, [])
  useFrame((_, dt) => {
    outer.current.visible = !G.gate.taken
    outer.current.position.copy(G.gate.pos)
    outer.current.lookAt(G.pos)
    inner.current.rotation.z += dt * 0.9
  })
  return (
    <group ref={outer}>
      <group ref={inner}>
        <lineLoop geometry={ringA} material={mat} />
        <lineLoop geometry={ringB} material={mat} />
        <lineSegments geometry={spokes} material={mat} />
      </group>
    </group>
  )
}

// -------------------------------------------------------------------- HUD ---
export default function App() {
  const [phase, setPhase] = useState<'title' | 'play' | 'over'>('title')
  const [statsOpen, setStatsOpen] = useState(true)
  const [isFs, setIsFs] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null!)

  const shieldsBar = useRef<HTMLDivElement>(null)
  const fuelBar = useRef<HTMLDivElement>(null)
  const scoreEl = useRef<HTMLDivElement>(null)
  const thrFill = useRef<HTMLDivElement>(null)
  const thrPct = useRef<HTMLDivElement>(null)
  const radar = useRef<HTMLCanvasElement>(null)
  const msgEl = useRef<HTMLDivElement>(null)
  const hitEl = useRef<HTMLDivElement>(null)
  const warpEl = useRef<HTMLDivElement>(null)
  const speedEl = useRef<HTMLSpanElement>(null)
  const headEl = useRef<HTMLSpanElement>(null)
  const gatesEl = useRef<HTMLSpanElement>(null)
  const hostEl = useRef<HTMLSpanElement>(null)
  const fpsEl = useRef<HTMLSpanElement>(null)

  // ---- HUD refresh + radar paint loop (imperative: zero React re-renders) ----
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let fps = 60
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const now = performance.now()
      fps = fps * 0.95 + (1000 / Math.max(1, now - last)) * 0.05
      last = now

      if (G.gameOver && phase === 'play') setPhase('over')

      if (shieldsBar.current) {
        shieldsBar.current.style.width = `${G.shields}%`
        shieldsBar.current.style.background = G.shields < 30 ? '#ff5a4d' : '#62ff9a'
      }
      if (fuelBar.current) {
        fuelBar.current.style.width = `${G.fuel}%`
        fuelBar.current.style.background = G.fuel < 25 ? '#ff5a4d' : '#ffd24d'
      }
      if (scoreEl.current) scoreEl.current.textContent = String(G.score).padStart(6, '0')
      if (thrFill.current) thrFill.current.style.height = `${G.throttle * 100}%`
      if (thrPct.current) thrPct.current.textContent = `${Math.round(G.throttle * 100)}`
      if (msgEl.current) {
        msgEl.current.textContent = G.msg
        msgEl.current.style.opacity = String(Math.min(1, G.msgT))
      }
      if (hitEl.current) hitEl.current.style.opacity = String(G.hit * 0.55)
      if (warpEl.current)
        warpEl.current.style.opacity = String(G.warpT >= 0 ? Math.sin(Math.PI * G.warpT) * 0.5 : 0)
      if (speedEl.current) speedEl.current.textContent = String(Math.round(G.speed * 10))
      if (headEl.current) {
        const deg = ((-G.yaw * 180) / Math.PI + 360000) % 360
        headEl.current.textContent = `${String(Math.round(deg)).padStart(3, '0')}°`
      }
      if (gatesEl.current) gatesEl.current.textContent = String(G.gates)
      if (hostEl.current) {
        let h = 0
        for (const e of G.enemies) if (e.alive) h++
        for (const s of G.stations) if (s.alive) h++
        hostEl.current.textContent = String(h)
      }
      if (fpsEl.current) fpsEl.current.textContent = String(Math.round(fps))

      // ---- radar: top-down, ship-relative, ahead = up ----
      const cv = radar.current
      const ctx = cv?.getContext('2d')
      if (cv && ctx) {
        const w = cv.width
        const cx = w / 2
        const rad = w / 2 - 6
        ctx.clearRect(0, 0, w, w)
        ctx.strokeStyle = 'rgba(55,255,133,0.8)'
        ctx.fillStyle = 'rgba(0,20,8,0.55)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(cx, cx, rad, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.strokeStyle = 'rgba(55,255,133,0.25)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(cx, cx, rad * 0.5, 0, Math.PI * 2)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(cx, 6)
        ctx.lineTo(cx, w - 6)
        ctx.moveTo(6, cx)
        ctx.lineTo(w - 6, cx)
        ctx.stroke()
        // rotating sweep
        const sw = (now / 900) % (Math.PI * 2)
        const grad = ctx.createLinearGradient(cx, cx, cx + Math.cos(sw) * rad, cx + Math.sin(sw) * rad)
        grad.addColorStop(0, 'rgba(55,255,133,0)')
        grad.addColorStop(1, 'rgba(55,255,133,0.5)')
        ctx.strokeStyle = grad
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(cx, cx)
        ctx.lineTo(cx + Math.cos(sw) * rad, cx + Math.sin(sw) * rad)
        ctx.stroke()

        const cos = Math.cos(G.yaw)
        const sin = Math.sin(G.yaw)
        const plot = (dx: number, dz: number) => {
          // world → ship-local (yaw only): ahead = -z' = up on radar
          const lx = cos * dx - sin * dz
          const lz = sin * dx + cos * dz
          return { px: cx + (lx / RADAR_RANGE) * rad, py: cx + (lz / RADAR_RANGE) * rad, lx, lz }
        }
        const inRange = (lx: number, lz: number) => lx * lx + lz * lz <= RADAR_RANGE * RADAR_RANGE
        // asteroids (steel = solid, white = normal)
        for (const p of G.planetoids) {
          const { px, py, lx, lz } = plot(p.pos.x - G.pos.x, p.pos.z - G.pos.z)
          if (!inRange(lx, lz)) continue
          ctx.fillStyle = p.solid ? 'rgba(143,185,214,0.95)' : 'rgba(230,238,255,0.85)'
          const s = Math.max(1.5, p.r * 0.22)
          ctx.fillRect(px - s / 2, py - s / 2, s, s)
        }
        // interceptors (red)
        ctx.fillStyle = '#ff5a4d'
        for (const e of G.enemies) {
          if (!e.alive) continue
          const { px, py, lx, lz } = plot(e.pos.x - G.pos.x, e.pos.z - G.pos.z)
          if (!inRange(lx, lz)) continue
          ctx.beginPath()
          ctx.arc(px, py, 2.6, 0, Math.PI * 2)
          ctx.fill()
        }
        // stations (amber diamonds)
        ctx.fillStyle = '#ffb020'
        for (const s of G.stations) {
          if (!s.alive) continue
          const { px, py, lx, lz } = plot(s.pos.x - G.pos.x, s.pos.z - G.pos.z)
          if (!inRange(lx, lz)) continue
          ctx.save()
          ctx.translate(px, py)
          ctx.rotate(Math.PI / 4)
          ctx.fillRect(-3, -3, 6, 6)
          ctx.restore()
        }
        // gate blip: clamp to rim when out of range (acts as a compass)
        if (!G.gate.taken) {
          const { px, py, lx, lz } = plot(G.gate.pos.x - G.pos.x, G.gate.pos.z - G.pos.z)
          const d = Math.hypot(lx, lz)
          let gx = px
          let gy = py
          if (d > RADAR_RANGE) {
            gx = cx + ((px - cx) / ((d / RADAR_RANGE) * rad)) * rad
            gy = cx + ((py - cx) / ((d / RADAR_RANGE) * rad)) * rad
          }
          ctx.fillStyle = '#37ff85'
          ctx.beginPath()
          ctx.arc(gx, gy, 3.5, 0, Math.PI * 2)
          ctx.fill()
        }
        // own ship
        ctx.fillStyle = '#62ff9a'
        ctx.beginPath()
        ctx.moveTo(cx, cx - 5)
        ctx.lineTo(cx - 4, cx + 4)
        ctx.lineTo(cx + 4, cx + 4)
        ctx.closePath()
        ctx.fill()
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [phase])

  // ---- keyboard ----
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      INPUT.keys.add(e.code)
      if (e.code === 'Space' && !e.repeat && G.running && !G.gameOver) G.fireQueue++
    }
    const up = (e: KeyboardEvent) => INPUT.keys.delete(e.code)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // ---- touch / pointer input ----
  const setThrottleFromY = (clientY: number) => {
    const h = wrapRef.current.clientHeight
    G.throttle = THREE.MathUtils.clamp((h * 0.85 - clientY) / (h * 0.7), 0, 1)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (phase !== 'play') return
    audio()
    try {
      wrapRef.current.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic or already-released pointer — capture is best-effort */
    }
    const isThrottle = e.clientX > wrapRef.current.clientWidth * THROTTLE_ZONE
    INPUT.ptrs.set(e.pointerId, {
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      t0: performance.now(),
      moved: false,
      throttle: isThrottle,
      lastFire: 0,
    })
    if (isThrottle) setThrottleFromY(e.clientY)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const p = INPUT.ptrs.get(e.pointerId)
    if (!p) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    p.x = e.clientX
    p.y = e.clientY
    if (p.throttle) {
      setThrottleFromY(e.clientY)
      return
    }
    if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 12) p.moved = true
    G.dYaw += dx
    G.dPitch += dy
  }
  const onPointerEnd = (e: React.PointerEvent) => {
    const p = INPUT.ptrs.get(e.pointerId)
    INPUT.ptrs.delete(e.pointerId)
    if (!p || p.throttle || p.moved) return
    if (performance.now() - p.t0 < 300 && G.running && !G.gameOver) G.fireQueue++
  }

  const begin = () => {
    audio()
    reset()
    setPhase('play')
  }

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await wrapRef.current.requestFullscreen()
        // best-effort: lock to landscape once fullscreen (mobile Chrome/Android)
        const so = screen.orientation as ScreenOrientation & {
          lock?: (o: string) => Promise<void>
        }
        so.lock?.('landscape').catch(() => {})
      } else {
        await document.exitFullscreen()
      }
    } catch {
      /* iOS Safari: no element fullscreen — installed PWA runs fullscreen anyway */
    }
  }

  return (
    <div
      ref={wrapRef}
      className="fixed inset-0 touch-none overflow-hidden bg-black"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Canvas
        dpr={[1, 1.75]}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{ fov: BASE_FOV, near: 0.5, far: 1600 }}
      >
        <color attach="background" args={[COL_BG]} />
        <fog attach="fog" args={[COL_BG, 60, 760]} />
        <Sim />
        <Stars />
        <Planetoids />
        <Enemies />
        <Stations />
        <Projectiles />
        <EnemyShots />
        <Explosions />
        <Gate />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={1.25} luminanceThreshold={0.12} luminanceSmoothing={0.3} radius={0.75} />
        </EffectComposer>
      </Canvas>

      {/* ------- HUD (all pointer-events-none except buttons) ------- */}
      <div className="pointer-events-none absolute inset-0 text-[#7dffb0]">
        {/* damage / warp overlays */}
        <div
          ref={hitEl}
          className="absolute inset-0 opacity-0"
          style={{ background: 'radial-gradient(ellipse at center, transparent 40%, rgba(255,60,40,0.7) 100%)' }}
        />
        <div
          ref={warpEl}
          className="absolute inset-0 opacity-0"
          style={{ background: 'radial-gradient(ellipse at center, transparent 35%, rgba(0,255,90,0.55) 100%)' }}
        />
        <div className="scanlines absolute inset-0 opacity-60" />
        <div className="vignette absolute inset-0" />

        {phase === 'play' && (
          <>
            {/* crosshair */}
            <div className="crt-text absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-xl">
              ┼
            </div>

            {/* top-left: shields + fuel */}
            <div className="absolute top-2 left-2 w-40 space-y-1 text-[10px] tracking-widest" style={{ paddingLeft: 'env(safe-area-inset-left)' }}>
              <div className="crt-text">SHIELDS</div>
              <div className="crt-box h-2.5 border border-[#2a5] bg-black/40">
                <div ref={shieldsBar} className="h-full w-full" style={{ background: '#62ff9a' }} />
              </div>
              <div className="crt-text pt-1">FUEL</div>
              <div className="crt-box h-2.5 border border-[#2a5] bg-black/40">
                <div ref={fuelBar} className="h-full w-full" style={{ background: '#ffd24d' }} />
              </div>
            </div>

            {/* top-center: score */}
            <div ref={scoreEl} className="crt-text absolute top-2 left-1/2 -translate-x-1/2 text-2xl tracking-[0.3em]">
              000000
            </div>

            {/* center message line */}
            <div
              ref={msgEl}
              className="crt-text absolute top-[24%] left-1/2 w-full -translate-x-1/2 text-center text-sm tracking-[0.25em] opacity-0"
            />

            {/* right edge: throttle slider (visual — input handled by zone) */}
            <div className="absolute top-1/2 right-3 flex -translate-y-1/2 flex-col items-center gap-1" style={{ marginRight: 'env(safe-area-inset-right)' }}>
              <div className="crt-text text-[9px] tracking-widest">THR</div>
              <div className="crt-box relative h-[38vh] w-3 border border-[#2a5] bg-black/40">
                <div
                  ref={thrFill}
                  className="absolute bottom-0 w-full"
                  style={{ background: 'linear-gradient(0deg,#1c8f4e,#62ff9a)', height: '45%' }}
                />
              </div>
              <div ref={thrPct} className="crt-text text-[9px]">45</div>
            </div>

            {/* bottom-left: scanner */}
            <div className="absolute bottom-2 left-2" style={{ paddingLeft: 'env(safe-area-inset-left)' }}>
              <div className="crt-text mb-0.5 text-[9px] tracking-widest">SCANNER</div>
              <canvas ref={radar} width={220} height={220} className="h-[120px] w-[120px]" />
            </div>

            {/* collapsible stats panel */}
            {statsOpen && (
              <div className="crt-box absolute right-2 bottom-2 border border-[#2a5] bg-black/50 px-3 py-2 text-[10px] leading-relaxed tracking-widest">
                <div>VEL <span ref={speedEl} className="text-white">0</span></div>
                <div>HDG <span ref={headEl} className="text-white">000°</span></div>
                <div>GATES <span ref={gatesEl} className="text-white">0</span></div>
                <div>HOSTILES <span ref={hostEl} className="text-[#ff8a80]">0</span></div>
                <div>FPS <span ref={fpsEl} className="text-white">60</span></div>
              </div>
            )}
          </>
        )}

        {/* title / game-over overlays */}
        {phase !== 'play' && (
          <div
            className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/70"
            onClick={begin}
          >
            {phase === 'title' ? (
              <>
                <div className="crt-text text-4xl tracking-[0.35em] text-white sm:text-5xl">
                  NEO&nbsp;BATTLEZONE
                </div>
                <div className="crt-text text-xs tracking-[0.3em] text-[#7dffb0]">
                  VECTOR-SPACE COMBAT PROTOTYPE
                </div>
                <div className="mt-4 max-w-md px-6 text-center text-[11px] leading-relaxed tracking-wider text-[#9fe8c0]">
                  DRAG TO STEER &nbsp;·&nbsp; TAP TO FIRE &nbsp;·&nbsp; HOLD FOR AUTOFIRE
                  <br />
                  DESTROY <span className="text-[#ff8a80]">INTERCEPTORS</span> &amp;{' '}
                  <span className="text-[#ffcf7a]">STATIONS</span> &nbsp;·&nbsp; STEEL ROCKS ARE ARMORED
                  <br />
                  RIGHT EDGE = THROTTLE &nbsp;·&nbsp; FLY THE GREEN GATES TO WARP + REFUEL
                </div>
                <div className="crt-text mt-6 animate-pulse text-lg tracking-[0.3em] text-white">
                  TAP TO LAUNCH
                </div>
              </>
            ) : (
              <>
                <div className="crt-text text-4xl tracking-[0.3em] text-[#ff5a4d]">SHIP DESTROYED</div>
                <div className="crt-text text-sm tracking-[0.3em]">
                  SCORE {G.score} &nbsp;·&nbsp; KILLS {G.kills} &nbsp;·&nbsp; BEST {G.best}
                </div>
                <div className="crt-text mt-6 animate-pulse text-lg tracking-[0.3em] text-white">
                  TAP TO REINITIALIZE
                </div>
              </>
            )}
          </div>
        )}

        {/* portrait blocker — force landscape */}
        <div className="pointer-events-auto absolute inset-0 z-50 hidden flex-col items-center justify-center gap-3 bg-black portrait:flex">
          <div className="crt-text animate-pulse text-3xl">⟳</div>
          <div className="crt-text text-sm tracking-[0.3em]">ROTATE DEVICE</div>
          <div className="text-[10px] tracking-widest text-[#9fe8c0]">LANDSCAPE REQUIRED</div>
        </div>
      </div>

      {/* buttons (outside pointer-events-none tree) */}
      <div className="absolute top-2 right-2 flex gap-2" style={{ marginRight: 'env(safe-area-inset-right)' }}>
        {phase === 'play' && (
          <button
            aria-label="Toggle stats panel"
            className="crt-box crt-text h-8 w-8 border border-[#2a5] bg-black/50 text-[#7dffb0]"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setStatsOpen((s) => !s)}
          >
            {statsOpen ? '▾' : '▸'}
          </button>
        )}
        <button
          aria-label="Toggle fullscreen"
          className="crt-box crt-text h-8 w-8 border border-[#2a5] bg-black/50 text-[#7dffb0]"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggleFullscreen}
        >
          {isFs ? '✕' : '⛶'}
        </button>
      </div>
    </div>
  )
}
