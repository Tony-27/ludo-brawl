import {
  AbstractMesh,
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core';
import { SkyMaterial } from '@babylonjs/materials';
import type { Color } from '../../core/protocol';
import { AssetLoader } from '../assets/asset-loader';
import { ENV, TEAM_RGB } from '../assets/catalog';
import { BoardLayout, MapNode } from './map-data';

const TEAMS: Color[] = ['red', 'green', 'yellow', 'blue'];

export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap smooth value noise for terrain. */
function noise2(x: number, z: number): number {
  const s = Math.sin(x * 0.37 + z * 0.11) * 0.5 + Math.sin(x * 0.13 - z * 0.29) * 0.7 + Math.sin(x * 0.71 + z * 0.53) * 0.25;
  return s / 1.45;
}

function distToSegment2(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  const cx = ax + dx * t;
  const cz = az + dz * t;
  return Math.hypot(px - cx, pz - cz);
}

export type TileFx = 'broken' | 'cracked' | 'crater' | 'fire' | 'trap' | 'warning' | 'water' | 'none';

export interface World {
  /** Average distance between trail tiles. */
  spacing: number;
  sun: DirectionalLight;
  shadows: ShadowGenerator;
  /** Surface height at a world x/z (terrain only). */
  groundY(x: number, z: number): number;
  setTurnColor(color: Color | null): void;
  /** Show or clear a live tile effect (crater, fire, trap, collapsed bridge). */
  setTileEffect(nodeId: string, effect: TileFx, visible?: boolean): void;
  /** Conveyors point forwards (1) or backwards (-1). */
  setConveyor(direction: number): void;
  /** Glowing, clickable markers on tiles (spell targets, lane choices). */
  highlightTiles(nodeIds: string[], rgb: [number, number, number]): void;
  /** Thin, non-clickable rings: tiles a spell would hit or a move would walk. */
  previewTiles(nodeIds: string[], rgb: [number, number, number]): void;
  update(dt: number, t: number): void;
  dispose(): void;
}

/** Builds the 3D world for a map: terrain, water, trail, camps, temple, scenery and ambient life. */
export async function buildWorld(scene: Scene, layout: BoardLayout, assets: AssetLoader, quality: 'high' | 'medium'): Promise<World> {
  const data = layout.data;
  const rand = mulberry32(data.id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  const root = new TransformNode('world', scene);
  const forge = data.theme === 'forge';
  const frost = data.theme === 'frost';
  const wilds = data.theme !== 'arena'; // the big outdoor maps
  const bounds = data.bounds;

  // ------------------------------------------------------------------ sky & light
  scene.clearColor = new Color4(0.55, 0.7, 0.9, 1);
  scene.ambientColor = new Color3(0.25, 0.25, 0.3);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = wilds ? 0.0085 : 0.012;
  scene.fogColor = new Color3(0.62, 0.74, 0.86);
  if (forge) {
    scene.clearColor = new Color4(0.25, 0.1, 0.07, 1);
    scene.fogDensity = 0.011;
    scene.fogColor = new Color3(0.33, 0.16, 0.11);
  }
  if (frost) {
    scene.clearColor = new Color4(0.16, 0.22, 0.36, 1);
    scene.fogDensity = 0.0095;
    scene.fogColor = new Color3(0.5, 0.6, 0.76);
    scene.ambientColor = new Color3(0.3, 0.34, 0.42);
  }

  const sky = MeshBuilder.CreateBox('sky', { size: 900 }, scene);
  const skyMat = new SkyMaterial('skyMat', scene);
  skyMat.backFaceCulling = false;
  skyMat.turbidity = 6;
  skyMat.luminance = 1.0;
  skyMat.rayleigh = 1.6;
  skyMat.inclination = 0.32;
  skyMat.azimuth = 0.28;
  skyMat.mieDirectionalG = 0.85;
  skyMat.fogEnabled = false;
  if (forge) {
    // A smoky, burning sunset.
    skyMat.turbidity = 20;
    skyMat.luminance = 0.55;
    skyMat.rayleigh = 3.5;
    skyMat.inclination = 0.47;
  }
  if (frost) {
    // Polar twilight: a deep blue sky for the aurora to glow in.
    skyMat.turbidity = 2.5;
    skyMat.luminance = 0.75;
    skyMat.rayleigh = 2.8;
    skyMat.inclination = 0.488;
    skyMat.azimuth = 0.2;
  }
  sky.material = skyMat;
  sky.infiniteDistance = true;
  sky.isPickable = false;
  sky.parent = root;

  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.55;
  hemi.diffuse = new Color3(0.95, 0.97, 1);
  hemi.groundColor = new Color3(0.32, 0.3, 0.22);
  hemi.specular = Color3.Black();

  const sun = new DirectionalLight('sun', new Vector3(-0.55, -1, -0.35).normalize(), scene);
  sun.position = new Vector3(30, 60, 20);
  sun.intensity = 1.55;
  sun.diffuse = new Color3(1, 0.93, 0.8);
  if (forge) {
    sun.diffuse = new Color3(1, 0.62, 0.38);
    sun.intensity = 1.25;
    hemi.diffuse = new Color3(1, 0.75, 0.6);
    hemi.groundColor = new Color3(0.45, 0.16, 0.08);
  }
  if (frost) {
    sun.diffuse = new Color3(0.86, 0.9, 1);
    sun.intensity = 1.2;
    hemi.diffuse = new Color3(0.78, 0.86, 1);
    hemi.groundColor = new Color3(0.55, 0.6, 0.72); // light bouncing off the snow
    hemi.intensity = 0.62;
  }
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 160;
  const shadows = new ShadowGenerator(quality === 'high' ? 4096 : 2048, sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = quality === 'high' ? ShadowGenerator.QUALITY_HIGH : ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = 0.0008;
  shadows.normalBias = 0.02;
  shadows.darkness = 0.25;
  sun.autoUpdateExtends = false;
  sun.orthoLeft = sun.orthoBottom = -bounds * 1.05;
  sun.orthoRight = sun.orthoTop = bounds * 1.05;

  // ------------------------------------------------------------------ terrain
  const pathNodes = data.nodes;
  const rivers = data.rivers;
  const campCenters = TEAMS.filter((c) => data.camps[c]).map((c) => data.camps[c].center);

  const riverDist = (x: number, z: number) => {
    let best = Infinity;
    for (const r of rivers) {
      for (let i = 0; i < r.points.length - 1; i++) {
        const [ax, az] = r.points[i];
        const [bx, bz] = r.points[i + 1];
        best = Math.min(best, distToSegment2(x, z, ax, az, bx, bz) - r.width / 2);
      }
    }
    return best;
  };
  const pathDist = (x: number, z: number) => {
    let best = Infinity;
    for (const n of pathNodes) best = Math.min(best, Math.hypot(x - n.pos[0], z - n.pos[2]));
    return best;
  };
  const campDist = (x: number, z: number) => Math.min(...campCenters.map((c) => Math.hypot(x - c[0], z - c[2])));
  const lakes = data.lakes ?? [];
  const lakeDist = (x: number, z: number) =>
    lakes.reduce((best, l) => Math.min(best, Math.hypot(x - l.center[0], z - l.center[1]) - l.radius), Infinity);

  const groundY = (x: number, z: number) => {
    const r = Math.hypot(x, z);
    let h = noise2(x, z) * (wilds ? 0.9 : 0.4);
    // Gentle rise towards the horizon so the board sits in a valley.
    h += Math.max(0, r - bounds * 0.95) * 0.35;
    const rd = riverDist(x, z);
    if (rd < 1.6) h = Math.min(h, -0.75 + Math.max(0, rd) * 0.4);
    const ld = lakeDist(x, z);
    if (ld < 1.2) h = Math.min(h, -0.35 + Math.max(0, ld) * 0.3);
    const pd = pathDist(x, z);
    if (pd < 1.3) h = h * (pd / 1.3) - 0.12 * (1 - pd / 1.3);
    const cd = campDist(x, z);
    if (cd < 4.5) h = h * (cd / 4.5) + 0.1 * (1 - cd / 4.5);
    if (r < 5) h = h * (r / 5);
    return h;
  };

  const size = bounds * 5;
  const subdiv = quality === 'high' ? 220 : 150;
  const ground = MeshBuilder.CreateGround('ground', { width: size, height: size, subdivisions: subdiv, updatable: true }, scene);
  const pos = ground.getVerticesData(VertexBuffer.PositionKind)!;
  const colors: number[] = [];
  const biomeColor = (x: number, z: number): [number, number, number] => {
    if (!wilds) return [0.36, 0.55, 0.26];
    if (forge) return [0.16, 0.13, 0.12];
    if (frost) return [0.84, 0.89, 0.96];
    const a = Math.atan2(-z, x);
    // Rough biome by angle around the loop, matching map zones.
    const idx = Math.floor(((Math.PI * 0.75 - a + Math.PI * 4) % (Math.PI * 2)) / (Math.PI * 2) * layout.loopLength);
    const biome = layout.biomeAt(idx);
    return biome === 'forest' ? [0.3, 0.5, 0.24] : biome === 'ruins' ? [0.52, 0.55, 0.3] : [0.2, 0.5, 0.22];
  };
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const z = pos[i + 2];
    const y = groundY(x, z);
    pos[i + 1] = y;
    let [r, g, b] = biomeColor(x, z);
    const n = noise2(x * 2.3, z * 2.3) * 0.08;
    r += n;
    g += n * 1.4;
    b += n * 0.5;
    const rd = riverDist(x, z);
    if (rd < 1.2) {
      const k = Math.max(0, 1 - Math.max(0, rd) / 1.2);
      const bank = forge ? [0.55, 0.2, 0.06] : [0.55, 0.48, 0.33]; // glowing lava edge / sandy banks
      [r, g, b] = [r + (bank[0] - r) * k, g + (bank[1] - g) * k, b + (bank[2] - b) * k];
    }
    const pd = pathDist(x, z);
    if (pd < 1.1) {
      const k = 1 - pd / 1.1;
      const dirt = forge ? [0.3, 0.27, 0.25] : frost ? [0.66, 0.72, 0.82] : [0.45, 0.36, 0.24]; // ash, packed snow or dirt
      [r, g, b] = [r + (dirt[0] - r) * k * 0.8, g + (dirt[1] - g) * k * 0.8, b + (dirt[2] - b) * k * 0.8];
    }
    if (y > 2.5 && !frost) {
      const k = Math.min(1, (y - 2.5) / 3);
      [r, g, b] = [r + (0.5 - r) * k, g + (0.5 - g) * k, b + (0.48 - b) * k];
    }
    if (frost && lakeDist(x, z) < 0.8) [r, g, b] = [0.42, 0.6, 0.76];
    colors.push(r, g, b, 1);
  }
  ground.updateVerticesData(VertexBuffer.PositionKind, pos);
  ground.setVerticesData(VertexBuffer.ColorKind, colors);
  const normals: number[] = [];
  VertexData.ComputeNormals(pos, ground.getIndices()!, normals);
  ground.updateVerticesData(VertexBuffer.NormalKind, normals);
  const groundMat = new StandardMaterial('groundMat', scene);
  groundMat.specularColor = Color3.Black();
  ground.material = groundMat;
  ground.receiveShadows = true;
  ground.isPickable = false;
  ground.parent = root;
  ground.freezeWorldMatrix();

  // ------------------------------------------------------------------ water
  const waterTex = new DynamicTexture('waterNoise', { width: 256, height: 256 }, scene, true);
  {
    const g = waterTex.getContext() as CanvasRenderingContext2D;
    const img = g.createImageData(256, 256);
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const v = 128 + 60 * Math.sin(x * 0.18 + Math.sin(y * 0.11) * 2) * Math.cos(y * 0.15 + Math.sin(x * 0.07) * 2);
        const o = (y * 256 + x) * 4;
        img.data[o] = img.data[o + 1] = 128 + (v - 128) * 0.6;
        img.data[o + 2] = 255;
        img.data[o + 3] = 255;
      }
    g.putImageData(img, 0, 0);
    waterTex.update();
    waterTex.wrapU = waterTex.wrapV = Texture.WRAP_ADDRESSMODE;
  }
  const waterMat = new StandardMaterial('water', scene);
  waterMat.diffuseColor = new Color3(0.16, 0.46, 0.62);
  waterMat.specularColor = new Color3(0.8, 0.9, 1);
  waterMat.specularPower = 64;
  waterMat.emissiveColor = new Color3(0.03, 0.12, 0.18);
  waterMat.alpha = 0.86;
  waterMat.bumpTexture = waterTex;
  waterMat.bumpTexture.level = 0.35;
  (waterMat.bumpTexture as Texture).uScale = 6;
  (waterMat.bumpTexture as Texture).vScale = 1.5;
  const lavaMat = new StandardMaterial('lava', scene);
  lavaMat.diffuseColor = new Color3(0.9, 0.3, 0.05);
  lavaMat.emissiveColor = new Color3(1, 0.38, 0.06);
  lavaMat.specularColor = Color3.Black();
  lavaMat.bumpTexture = waterTex.clone();
  lavaMat.bumpTexture.level = 0.6;
  (lavaMat.bumpTexture as Texture).uScale = 3;
  const waterMeshes: Mesh[] = [];
  for (const r of rivers) {
    const paths = r.points.map(([x, z], i) => {
      const [nx, nz] = r.points[Math.min(i + 1, r.points.length - 1)];
      const [px, pz] = r.points[Math.max(i - 1, 0)];
      const dx = nx - px;
      const dz = nz - pz;
      const len = Math.hypot(dx, dz) || 1;
      const ox = (-dz / len) * (r.width / 2 + 0.4);
      const oz = (dx / len) * (r.width / 2 + 0.4);
      return [new Vector3(x - ox, -0.42, z - oz), new Vector3(x + ox, -0.42, z + oz)];
    });
    const ribbon = MeshBuilder.CreateRibbon('river', { pathArray: [paths.map((p) => p[0]), paths.map((p) => p[1])] }, scene);
    ribbon.material = r.kind === 'lava' ? lavaMat : waterMat;
    ribbon.isPickable = false;
    ribbon.parent = root;
    waterMeshes.push(ribbon);
  }
  // Frozen lakes: a glossy ice sheet that turns to open water when it thaws (per tile, see 'water').
  const iceMat = new StandardMaterial('ice', scene);
  iceMat.diffuseColor = new Color3(0.72, 0.86, 0.96);
  iceMat.specularColor = new Color3(0.9, 0.95, 1);
  iceMat.specularPower = 96;
  iceMat.emissiveColor = new Color3(0.05, 0.08, 0.12);
  const lakeMat = new StandardMaterial('lakeIce', scene);
  lakeMat.diffuseColor = new Color3(0.32, 0.55, 0.74);
  lakeMat.specularColor = new Color3(0.7, 0.8, 0.9);
  lakeMat.specularPower = 128;
  lakeMat.emissiveColor = new Color3(0.02, 0.05, 0.09);
  lakeMat.bumpTexture = waterTex.clone();
  lakeMat.bumpTexture.level = 0.15;
  for (const l of lakes) {
    const disc = MeshBuilder.CreateDisc('lake', { radius: l.radius, tessellation: 48 }, scene);
    disc.material = lakeMat;
    disc.rotation.x = Math.PI / 2;
    disc.position.set(l.center[0], -0.2, l.center[1]);
    disc.isPickable = false;
    disc.receiveShadows = true;
    disc.parent = root;
  }

  // ------------------------------------------------------------------ trail tiles
  const stoneColors = [new Color3(0.62, 0.6, 0.56), new Color3(0.56, 0.55, 0.52), new Color3(0.68, 0.65, 0.58)];
  const rockVariants: Mesh[] = [];
  for (let v = 0; v < 6; v++) {
    const rock = MeshBuilder.CreateIcoSphere(`rockTile${v}`, { radius: 0.5, subdivisions: 2, flat: true, updatable: true }, scene);
    const rp = rock.getVerticesData(VertexBuffer.PositionKind)!;
    const jitter = new Map<string, number>();
    for (let i = 0; i < rp.length; i += 3) {
      const key = `${rp[i].toFixed(3)},${rp[i + 1].toFixed(3)},${rp[i + 2].toFixed(3)}`;
      if (!jitter.has(key)) jitter.set(key, 0.86 + rand() * 0.26);
      const j = jitter.get(key)!;
      rp[i] *= j * 1.08;
      rp[i + 2] *= j * 1.08;
      // Flatten the top into a walkable surface, keep a chunky underside.
      rp[i + 1] = rp[i + 1] > 0.05 ? 0.13 + rp[i + 1] * 0.08 : rp[i + 1] * 0.55;
    }
    rock.updateVerticesData(VertexBuffer.PositionKind, rp);
    const rn: number[] = [];
    VertexData.ComputeNormals(rp, rock.getIndices()!, rn);
    rock.updateVerticesData(VertexBuffer.NormalKind, rn);
    const m = new StandardMaterial(`stone${v}`, scene);
    m.diffuseColor = stoneColors[v % stoneColors.length].scale(0.82);
    m.specularColor = new Color3(0.08, 0.08, 0.08);
    rock.material = m;
    rock.isVisible = false;
    rock.parent = root;
    rockVariants.push(rock);
  }

  const spacing = (() => {
    const loop = layout.loopNodes();
    let sum = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i].pos;
      const b = loop[(i + 1) % loop.length].pos;
      sum += Math.hypot(a[0] - b[0], a[2] - b[2]);
    }
    return sum / loop.length;
  })();
  const tileScale = Math.min(1.25, spacing * 0.92);

  const teamStone: Record<string, StandardMaterial> = {};
  for (const c of TEAMS) {
    const m = new StandardMaterial(`stone_${c}`, scene);
    const [r, g, b] = TEAM_RGB[c];
    m.diffuseColor = new Color3(r * 0.85 + 0.1, g * 0.85 + 0.1, b * 0.85 + 0.1);
    m.emissiveColor = new Color3(r * 0.12, g * 0.12, b * 0.12);
    m.specularColor = new Color3(0.1, 0.1, 0.1);
    teamStone[c] = m;
  }
  const routeOwner = new Map<string, Color>();
  for (const c of TEAMS) {
    layout.mainPath(c).forEach((id, i) => {
      const n = layout.nodes.get(id)!;
      if (n.kind === 'home' || n.kind === 'goal' || (n.kind === 'start' && i === 0)) routeOwner.set(id, c);
    });
  }

  const plank = new StandardMaterial('plank', scene);
  plank.diffuseColor = new Color3(0.5, 0.33, 0.18);
  plank.specularColor = Color3.Black();

  const runeTexture = (glyph: string, color: string) => {
    const t = new DynamicTexture(`rune_${glyph}`, { width: 128, height: 128 }, scene, true);
    t.hasAlpha = true;
    const g = t.getContext() as CanvasRenderingContext2D;
    g.clearRect(0, 0, 128, 128);
    g.shadowColor = color;
    g.shadowBlur = 16;
    g.fillStyle = color;
    g.font = 'bold 92px serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(glyph, 64, 70);
    t.update();
    return t;
  };
  const starMat = new StandardMaterial('starRune', scene);
  starMat.diffuseTexture = runeTexture('✦', '#ffd76a');
  starMat.opacityTexture = starMat.diffuseTexture;
  starMat.emissiveColor = new Color3(1, 0.85, 0.4);
  starMat.disableLighting = true;
  const runes: Mesh[] = [];

  const shrineMat = new StandardMaterial('shrineCrystal', scene);
  shrineMat.emissiveColor = new Color3(0.45, 0.75, 1);
  shrineMat.diffuseColor = new Color3(0.3, 0.5, 0.9);
  shrineMat.alpha = 0.9;
  const shrines: Mesh[] = [];

  const tileMeshes: AbstractMesh[] = [];
  const tileByNode = new Map<string, AbstractMesh>();
  for (const n of data.nodes) {
    const [x, y, z] = n.pos;
    let mesh: AbstractMesh;
    if (n.bridge) {
      const deck = MeshBuilder.CreateBox(`plank_${n.id}`, { width: tileScale * 1.05, height: 0.12, depth: tileScale * 0.9 }, scene);
      deck.material = plank;
      mesh = deck;
      mesh.position.set(x, y - 0.06, z);
      const next = layout.next(n.id);
      if (next) mesh.lookAt(new Vector3(next.pos[0], y - 0.06, next.pos[2]));
      // Rope posts.
      for (const side of [-1, 1]) {
        const post = MeshBuilder.CreateCylinder(`post_${n.id}_${side}`, { height: 0.7, diameter: 0.09 }, scene);
        post.material = plank;
        post.parent = mesh;
        post.position.set(side * tileScale * 0.55, 0.3, 0);
        shadows.addShadowCaster(post);
      }
    } else if (n.lake) {
      // Lake tiles are slabs of ice.
      const slab = MeshBuilder.CreateCylinder(`ice_${n.id}`, { diameter: tileScale * 1.05, height: 0.14, tessellation: 7 }, scene);
      slab.material = iceMat;
      mesh = slab;
      mesh.position.set(x, y - 0.05, z);
      mesh.rotation.y = rand() * Math.PI;
    } else {
      const variant = rockVariants[Math.floor(rand() * rockVariants.length)];
      const owner = routeOwner.get(n.id);
      if (owner && (n.kind === 'home' || n.kind === 'start' || n.kind === 'goal')) {
        const clone = variant.clone(`tile_${n.id}`, root)!;
        clone.isVisible = true;
        clone.material = teamStone[owner];
        mesh = clone;
      } else {
        mesh = variant.createInstance(`tile_${n.id}`);
      }
      mesh.position.set(x, y - 0.16, z);
      mesh.rotation.y = rand() * Math.PI * 2;
      const s = tileScale * (0.95 + rand() * 0.1);
      mesh.scaling.set(s, 1 + rand() * 0.25, s);
    }
    mesh.parent = root;
    mesh.receiveShadows = true;
    mesh.isPickable = true;
    mesh.metadata = { nodeId: n.id };
    shadows.addShadowCaster(mesh);
    tileMeshes.push(mesh);
    tileByNode.set(n.id, mesh);

    if (n.kind === 'safe') {
      const rune = MeshBuilder.CreatePlane(`rune_${n.id}`, { size: tileScale * 0.8 }, scene);
      rune.material = starMat;
      rune.rotation.x = Math.PI / 2;
      rune.position.set(x, y + 0.01, z);
      rune.isPickable = false;
      rune.parent = root;
      runes.push(rune);
    }
    if (n.kind === 'shrine') {
      const crystal = MeshBuilder.CreatePolyhedron(`shrine_${n.id}`, { type: 1, size: 0.22 }, scene);
      crystal.material = shrineMat;
      crystal.scaling.y = 1.8;
      crystal.position.set(x, y + 1.1, z);
      crystal.isPickable = false;
      crystal.parent = root;
      shrines.push(crystal);
      const ring = MeshBuilder.CreateTorus(`shrineRing_${n.id}`, { diameter: tileScale * 0.85, thickness: 0.05, tessellation: 32 }, scene);
      ring.material = shrineMat;
      ring.position.set(x, y + 0.02, z);
      ring.isPickable = false;
      ring.parent = root;
    }
  }

  const ambientSystems: ParticleSystem[] = [];
  // ------------------------------------------------------------------ hazards
  const glowTex = new DynamicTexture('hazardGlow', { width: 64, height: 64 }, scene, false);
  {
    const g = glowTex.getContext() as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    glowTex.update();
  }
  const chevronTex = (rgb: string) => {
    const t = new DynamicTexture(`chevron_${rgb}`, { width: 128, height: 128 }, scene, true);
    t.hasAlpha = true;
    const g = t.getContext() as CanvasRenderingContext2D;
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = rgb;
    g.lineWidth = 14;
    g.lineCap = 'round';
    g.shadowColor = rgb;
    g.shadowBlur = 10;
    for (const x of [30, 70]) {
      g.beginPath();
      g.moveTo(x, 28);
      g.lineTo(x + 28, 64);
      g.lineTo(x, 100);
      g.stroke();
    }
    t.update();
    t.wrapU = Texture.WRAP_ADDRESSMODE;
    return t;
  };
  const neighbour = (n: MapNode, delta: number) => (delta >= 0 ? layout.next(n.id) : layout.prev(n.id));
  const animated: { mesh: Mesh; spin?: number; scroll?: number; pulse?: number }[] = [];
  const makeMat = (name: string, rgb: [number, number, number], emissive = 1, alpha = 1) => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = new Color3(...rgb);
    m.emissiveColor = new Color3(rgb[0] * emissive, rgb[1] * emissive, rgb[2] * emissive);
    m.specularColor = Color3.Black();
    m.alpha = alpha;
    return m;
  };
  const pitRgb: [number, number, number] = forge ? [1, 0.35, 0.05] : [0.5, 0.25, 0.9];
  const pitHole = makeMat('pitHole', [0.02, 0.01, 0.01], 0);
  const pitRim = makeMat('pitRim', pitRgb, 0.9);
  const makePit = (name: string, x: number, y: number, z: number) => {
    const node = new TransformNode(name, scene);
    node.parent = root;
    node.position.set(x, y, z);
    const hole = MeshBuilder.CreateCylinder(`${name}_hole`, { diameter: tileScale * 0.95, height: 0.05, tessellation: 28 }, scene);
    hole.material = pitHole;
    hole.parent = node;
    hole.position.y = -0.1;
    const rim = MeshBuilder.CreateTorus(`${name}_rim`, { diameter: tileScale * 0.95, thickness: 0.09, tessellation: 32 }, scene);
    rim.material = pitRim;
    rim.parent = node;
    rim.position.y = -0.05;
    animated.push({ mesh: rim, pulse: 1 });
    for (const m of [hole, rim]) m.isPickable = false;
    return node;
  };
  const conveyors: { plane: Mesh; base: number }[] = [];
  const glossy = (tile: AbstractMesh, name: string, rgb: [number, number, number]) => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = new Color3(...rgb);
    m.specularColor = new Color3(0.9, 0.95, 1);
    m.specularPower = 80;
    m.emissiveColor = new Color3(rgb[0] * 0.18, rgb[1] * 0.22, rgb[2] * 0.28);
    if (tile instanceof Mesh || 'sourceMesh' in tile) {
      // Instances share their source's material: swap in a dedicated clone.
      const src = (tile as unknown as { sourceMesh?: Mesh }).sourceMesh;
      if (src) {
        const clone = src.clone(`${name}_tile`, root)!;
        clone.isVisible = true;
        clone.position.copyFrom(tile.position);
        clone.rotation.copyFrom(tile.rotation);
        clone.scaling.copyFrom(tile.scaling);
        clone.metadata = tile.metadata;
        clone.receiveShadows = true;
        clone.material = m;
        tileByNode.set(tile.metadata.nodeId, clone);
        tileMeshes.push(clone);
        tile.dispose();
        return clone;
      }
    }
    tile.material = m;
    return tile;
  };
  for (const n of data.nodes) {
    const hz = n.hazard;
    if (!hz) continue;
    const tile = tileByNode.get(n.id);
    const [x, y, z] = n.pos;
    if (hz.type === 'pit') {
      tile?.setEnabled(false);
      makePit(`pit_${n.id}`, x, y, z);
    } else if (hz.type === 'slide' || hz.type === 'current') {
      const sign = (hz.steps ?? 1) >= 0 ? 1 : -1;
      const toward = neighbour(n, sign);
      const rgb = hz.type === 'current' ? '#5fd0ff' : sign > 0 ? '#7dffb0' : '#ff6a5a';
      const plane = MeshBuilder.CreatePlane(`slide_${n.id}`, { width: tileScale * 0.85, height: tileScale * 0.6 }, scene);
      const mat = new StandardMaterial(`slideMat_${n.id}`, scene);
      mat.diffuseTexture = chevronTex(rgb);
      mat.opacityTexture = mat.diffuseTexture;
      mat.emissiveColor = Color3.FromHexString(rgb);
      mat.disableLighting = true;
      plane.material = mat;
      plane.position.set(x, y + 0.02, z);
      plane.rotation.x = Math.PI / 2;
      if (toward) plane.rotation.y = Math.atan2(toward.pos[0] - x, toward.pos[2] - z) - Math.PI / 2;
      plane.isPickable = false;
      plane.parent = root;
      animated.push({ mesh: plane, scroll: -0.8 });
    } else if (hz.type === 'conveyor') {
      const toward = neighbour(n, 1);
      const plane = MeshBuilder.CreatePlane(`conveyor_${n.id}`, { width: tileScale * 0.85, height: tileScale * 0.6 }, scene);
      const mat = new StandardMaterial(`conveyorMat_${n.id}`, scene);
      mat.diffuseTexture = chevronTex('#ffb347');
      mat.opacityTexture = mat.diffuseTexture;
      mat.emissiveColor = Color3.FromHexString('#ffb347');
      mat.disableLighting = true;
      plane.material = mat;
      plane.position.set(x, y + 0.03, z);
      plane.rotation.x = Math.PI / 2;
      const base = toward ? Math.atan2(toward.pos[0] - x, toward.pos[2] - z) - Math.PI / 2 : 0;
      plane.rotation.y = base;
      plane.isPickable = false;
      plane.parent = root;
      conveyors.push({ plane, base });
      animated.push({ mesh: plane, scroll: -1.2 });
      if (tile) glossy(tile, `belt_${n.id}`, [0.28, 0.26, 0.25]);
    } else if (hz.type === 'ice' && tile) {
      glossy(tile, `iceTile_${n.id}`, [0.74, 0.88, 1]);
    } else if (hz.type === 'thin_ice' && tile && !n.lake) {
      glossy(tile, `thinIce_${n.id}`, [0.82, 0.92, 1]);
    } else if (hz.type === 'spring') {
      const pool = MeshBuilder.CreateDisc(`spring_${n.id}`, { radius: tileScale * 0.4, tessellation: 28 }, scene);
      pool.material = makeMat(`springMat_${n.id}`, [0.25, 0.85, 0.8], 0.55, 0.85);
      pool.rotation.x = Math.PI / 2;
      pool.position.set(x, y + 0.03, z);
      pool.isPickable = false;
      pool.parent = root;
      animated.push({ mesh: pool, pulse: 1 });
      const steam = new ParticleSystem(`steam_${n.id}`, 40, scene);
      steam.particleTexture = glowTex;
      steam.emitter = new Vector3(x, y + 0.1, z);
      steam.minEmitBox = new Vector3(-0.25, 0, -0.25);
      steam.maxEmitBox = new Vector3(0.25, 0, 0.25);
      steam.color1 = new Color4(1, 1, 1, 0.35);
      steam.color2 = new Color4(0.85, 0.95, 1, 0.25);
      steam.colorDead = new Color4(1, 1, 1, 0);
      steam.minSize = 0.3;
      steam.maxSize = 0.7;
      steam.minLifeTime = 1.2;
      steam.maxLifeTime = 2.4;
      steam.emitRate = 14;
      steam.direction1 = new Vector3(-0.1, 1, -0.1);
      steam.direction2 = new Vector3(0.1, 1.4, 0.1);
      steam.minEmitPower = 0.3;
      steam.maxEmitPower = 0.6;
      steam.blendMode = ParticleSystem.BLENDMODE_STANDARD;
      steam.start();
      ambientSystems.push(steam);
    } else if (hz.type === 'anvil') {
      const anvil = new TransformNode(`anvil_${n.id}`, scene);
      anvil.parent = root;
      anvil.position.set(x, y + 0.02, z);
      const metal = makeMat(`anvilMat_${n.id}`, [0.2, 0.2, 0.22], 0.1);
      metal.specularColor = new Color3(0.6, 0.6, 0.6);
      const foot = MeshBuilder.CreateBox(`anvilFoot_${n.id}`, { width: 0.34, height: 0.16, depth: 0.22 }, scene);
      const top = MeshBuilder.CreateBox(`anvilTop_${n.id}`, { width: 0.6, height: 0.12, depth: 0.26 }, scene);
      const horn = MeshBuilder.CreateCylinder(`anvilHorn_${n.id}`, { height: 0.24, diameterTop: 0, diameterBottom: 0.12, tessellation: 8 }, scene);
      foot.position.y = 0.08;
      top.position.y = 0.22;
      horn.position.set(0.4, 0.22, 0);
      horn.rotation.z = -Math.PI / 2;
      for (const m of [foot, top, horn]) {
        m.material = metal;
        m.parent = anvil;
        m.isPickable = false;
        shadows.addShadowCaster(m);
      }
      const glow = MeshBuilder.CreateTorus(`anvilGlow_${n.id}`, { diameter: tileScale * 0.85, thickness: 0.05, tessellation: 32 }, scene);
      glow.material = makeMat(`anvilGlowMat_${n.id}`, [1, 0.55, 0.15], 1);
      glow.position.set(x, y + 0.02, z);
      glow.isPickable = false;
      glow.parent = root;
      animated.push({ mesh: glow, pulse: 1 });
      anvil.position.x += tileScale * 0.22;
      anvil.position.z += tileScale * 0.1;
    } else if (hz.type === 'portal') {
      const ring = MeshBuilder.CreateTorus(`portal_${n.id}`, { diameter: tileScale * 0.9, thickness: 0.1, tessellation: 40 }, scene);
      ring.material = makeMat(`portalMat_${n.id}`, [0.7, 0.35, 1], 1);
      ring.position.set(x, y + 0.06, z);
      ring.isPickable = false;
      ring.parent = root;
      const disc = MeshBuilder.CreateDisc(`portalDisc_${n.id}`, { radius: tileScale * 0.42, tessellation: 32 }, scene);
      disc.material = makeMat(`portalDiscMat_${n.id}`, [0.45, 0.2, 0.9], 0.9, 0.7);
      disc.rotation.x = Math.PI / 2;
      disc.position.set(x, y + 0.04, z);
      disc.isPickable = false;
      disc.parent = root;
      animated.push({ mesh: ring, spin: 2, pulse: 1 });
    } else if (hz.type === 'crumble' && tile) {
      // Cracked, darker planks.
      const m = (tile.material as StandardMaterial).clone(`crumble_${n.id}`);
      m.diffuseColor = new Color3(0.32, 0.2, 0.12);
      m.emissiveColor = forge ? new Color3(0.25, 0.06, 0.0) : Color3.Black();
      tile.material = m;
    }
  }

  // Live tile effects (craters, fire, traps, collapsed bridges, warnings, thawed ice).
  const crackTex = new DynamicTexture('cracks', { width: 128, height: 128 }, scene, true);
  {
    const g = crackTex.getContext() as CanvasRenderingContext2D;
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 3;
    const crack = (x: number, y: number, a: number, len: number, depth: number) => {
      const x2 = x + Math.cos(a) * len;
      const y2 = y + Math.sin(a) * len;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x2, y2);
      g.stroke();
      if (depth > 0) {
        crack(x2, y2, a + 0.6, len * 0.6, depth - 1);
        crack(x2, y2, a - 0.5, len * 0.7, depth - 1);
      }
    };
    for (let k = 0; k < 5; k++) crack(64, 64, (k / 5) * Math.PI * 2 + 0.3, 22, 2);
    crackTex.hasAlpha = true;
    crackTex.update();
  }
  const crackMat = new StandardMaterial('crackMat', scene);
  crackMat.diffuseTexture = crackTex;
  crackMat.opacityTexture = crackTex;
  crackMat.emissiveColor = forge ? new Color3(1, 0.45, 0.1) : new Color3(0.9, 0.95, 1);
  crackMat.disableLighting = true;
  const warnRgb: [number, number, number] = frost ? [0.85, 0.95, 1] : [1, 0.3, 0.08];
  const warnMat = makeMat('warnMat', warnRgb, 1, 0.85);
  const bangTex = new DynamicTexture('bang', { width: 128, height: 128 }, scene, true);
  {
    const g = bangTex.getContext() as CanvasRenderingContext2D;
    g.clearRect(0, 0, 128, 128);
    g.fillStyle = frost ? '#e6f6ff' : '#ff5a1f';
    g.shadowColor = g.fillStyle;
    g.shadowBlur = 18;
    g.font = 'bold 110px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('!', 64, 70);
    bangTex.hasAlpha = true;
    bangTex.update();
  }
  const bangMat = new StandardMaterial('bangMat', scene);
  bangMat.diffuseTexture = bangTex;
  bangMat.opacityTexture = bangTex;
  bangMat.emissiveColor = new Color3(1, 1, 1);
  bangMat.disableLighting = true;
  const openWater = makeMat('openWater', [0.1, 0.35, 0.5], 0.25, 0.92);
  const overlays = new Map<string, { node: TransformNode; ps?: ParticleSystem }>();
  const fireAt = (x: number, y: number, z: number, smoke = false) => {
    const ps = new ParticleSystem('tileFire', smoke ? 60 : 120, scene);
    ps.particleTexture = glowTex;
    ps.emitter = new Vector3(x, y + 0.05, z);
    ps.minEmitBox = new Vector3(-0.35, 0, -0.35);
    ps.maxEmitBox = new Vector3(0.35, 0, 0.35);
    ps.color1 = smoke ? new Color4(0.3, 0.25, 0.22, 0.6) : new Color4(1, 0.55, 0.1, 1);
    ps.color2 = smoke ? new Color4(0.2, 0.18, 0.16, 0.4) : new Color4(1, 0.25, 0.05, 1);
    ps.colorDead = new Color4(0.1, 0.05, 0.05, 0);
    ps.minSize = smoke ? 0.3 : 0.15;
    ps.maxSize = smoke ? 0.7 : 0.4;
    ps.minLifeTime = 0.3;
    ps.maxLifeTime = smoke ? 1.6 : 0.8;
    ps.emitRate = smoke ? 25 : 80;
    ps.direction1 = new Vector3(-0.1, 1, -0.1);
    ps.direction2 = new Vector3(0.1, 1.6, 0.1);
    ps.minEmitPower = 0.5;
    ps.maxEmitPower = 1.2;
    ps.blendMode = smoke ? ParticleSystem.BLENDMODE_STANDARD : ParticleSystem.BLENDMODE_ADD;
    ps.start();
    return ps;
  };
  const trapMat = makeMat('trap', [0.75, 0.75, 0.8], 0.15);
  const clearOverlay = (id: string) => {
    const o = overlays.get(id);
    if (!o) return;
    o.ps?.dispose();
    for (let i = animated.length - 1; i >= 0; i--) if (animated[i].mesh.isDescendantOf(o.node)) animated.splice(i, 1);
    o.node.dispose(false, false);
    overlays.delete(id);
  };
  const setTileEffect: World['setTileEffect'] = (id, effect, visible = true) => {
    const n = layout.nodes.get(id);
    if (!n) return;
    const tile = tileByNode.get(id);
    clearOverlay(id);
    const staticPit = n.hazard?.type === 'pit';
    tile?.setEnabled(!staticPit);
    if (effect === 'none' || !visible) return;
    const [x, y, z] = n.pos;
    if (effect === 'water') {
      tile?.setEnabled(false);
      const node = new TransformNode(`water_${id}`, scene);
      node.parent = root;
      const pool = MeshBuilder.CreateDisc(`waterDisc_${id}`, { radius: tileScale * 0.6, tessellation: 24 }, scene);
      pool.material = openWater;
      pool.rotation.x = Math.PI / 2;
      pool.position.set(x, y - 0.12, z);
      pool.isPickable = false;
      pool.parent = node;
      overlays.set(id, { node });
    } else if (effect === 'cracked') {
      const node = new TransformNode(`cracked_${id}`, scene);
      node.parent = root;
      const decal = MeshBuilder.CreatePlane(`crack_${id}`, { size: tileScale * 0.9 }, scene);
      decal.material = crackMat;
      decal.rotation.x = Math.PI / 2;
      decal.position.set(x, y + 0.04, z);
      decal.isPickable = false;
      decal.parent = node;
      overlays.set(id, { node });
    } else if (effect === 'warning') {
      const node = new TransformNode(`warn_${id}`, scene);
      node.parent = root;
      const ring = MeshBuilder.CreateTorus(`warnRing_${id}`, { diameter: tileScale * 1.1, thickness: 0.08, tessellation: 32 }, scene);
      ring.material = warnMat;
      ring.position.set(x, y + 0.05, z);
      ring.isPickable = false;
      ring.parent = node;
      animated.push({ mesh: ring, pulse: 3 });
      const bang = MeshBuilder.CreatePlane(`bang_${id}`, { size: 0.7 }, scene);
      bang.material = bangMat;
      bang.billboardMode = Mesh.BILLBOARDMODE_ALL;
      bang.position.set(x, y + 1.3, z);
      bang.isPickable = false;
      bang.parent = node;
      overlays.set(id, { node, ps: forge ? fireAt(x, y - 0.1, z, true) : undefined });
    } else if (effect === 'crater' || effect === 'broken') {
      tile?.setEnabled(false);
      const pit = makePit(`fx_${id}`, x, y, z);
      overlays.set(id, { node: pit, ps: fireAt(x, y - 0.1, z, true) });
    } else if (effect === 'fire') {
      const node = new TransformNode(`fire_${id}`, scene);
      overlays.set(id, { node, ps: fireAt(x, y, z) });
    } else if (effect === 'trap') {
      const node = new TransformNode(`trap_${id}`, scene);
      node.position.set(x, y + 0.02, z);
      for (let k = 0; k < 6; k++) {
        const spike = MeshBuilder.CreateCylinder(`spike_${id}_${k}`, { height: 0.22, diameterTop: 0, diameterBottom: 0.08, tessellation: 4 }, scene);
        spike.material = trapMat;
        spike.parent = node;
        const a = (k / 6) * Math.PI * 2;
        spike.position.set(Math.cos(a) * 0.3, 0.1, Math.sin(a) * 0.3);
        spike.isPickable = false;
      }
      overlays.set(id, { node });
    }
  };

  // Clickable highlight rings for targeting.
  let highlights: Mesh[] = [];
  const highlightMat = makeMat('highlight', [1, 0.85, 0.3], 1, 0.9);
  const highlightTiles: World['highlightTiles'] = (ids, rgb) => {
    for (const h of highlights) h.dispose();
    highlights = [];
    highlightMat.emissiveColor = new Color3(...rgb);
    for (const id of ids) {
      const n = layout.nodes.get(id);
      if (!n) continue;
      const ring = MeshBuilder.CreateCylinder(`hl_${id}`, { diameter: tileScale * 1.05, height: 0.08, tessellation: 32 }, scene);
      ring.material = highlightMat;
      ring.position.set(n.pos[0], n.pos[1] + 0.06, n.pos[2]);
      ring.isPickable = true;
      ring.metadata = { nodeId: id, highlight: true };
      highlights.push(ring);
    }
  };

  let previews: Mesh[] = [];
  const previewMat = makeMat('preview', [1, 0.45, 0.3], 1, 0.75);
  const previewTiles: World['previewTiles'] = (ids, rgb) => {
    for (const h of previews) h.dispose();
    previews = [];
    previewMat.emissiveColor = new Color3(...rgb);
    for (const id of new Set(ids)) {
      const n = layout.nodes.get(id);
      if (!n) continue;
      const ring = MeshBuilder.CreateTorus(`pv_${id}`, { diameter: tileScale * 0.8, thickness: 0.06, tessellation: 24 }, scene);
      ring.material = previewMat;
      ring.position.set(n.pos[0], n.pos[1] + 0.09, n.pos[2]);
      ring.isPickable = false;
      previews.push(ring);
    }
  };

  // ------------------------------------------------------------------ temple
  const templeStone = new StandardMaterial('templeStone', scene);
  templeStone.diffuseColor = new Color3(0.58, 0.56, 0.5);
  templeStone.specularColor = new Color3(0.05, 0.05, 0.05);
  const goalY = data.goal[1];
  const tiers = wilds ? [5.2, 4.1, 3.0] : [2.2, 1.7];
  tiers.forEach((r, i) => {
    const h = (goalY + 0.2) / tiers.length;
    const tier = MeshBuilder.CreateCylinder(`templeTier${i}`, { height: h, diameter: r * 2, tessellation: 8 }, scene);
    tier.material = templeStone;
    tier.position.y = h * i + h / 2 - 0.25;
    tier.rotation.y = Math.PI / 8;
    tier.receiveShadows = true;
    tier.parent = root;
    tier.isPickable = false;
    shadows.addShadowCaster(tier);
  });
  if (wilds) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const pillar = MeshBuilder.CreateCylinder(`pillar${i}`, { height: 3.2 - (i % 3) * 0.7, diameter: 0.45, tessellation: 8 }, scene);
      pillar.material = templeStone;
      pillar.position.set(Math.cos(a) * 4.6, 1.1, Math.sin(a) * 4.6);
      pillar.parent = root;
      pillar.isPickable = false;
      pillar.receiveShadows = true;
      shadows.addShadowCaster(pillar);
    }
  }
  const heartMat = new StandardMaterial('heart', scene);
  heartMat.emissiveColor = new Color3(1, 1, 1);
  heartMat.diffuseColor = new Color3(1, 1, 1);
  heartMat.alpha = 0.92;
  const heart = MeshBuilder.CreatePolyhedron('templeHeart', { type: 1, size: wilds ? 0.75 : 0.45 }, scene);
  heart.material = heartMat;
  heart.position.y = goalY + (wilds ? 2.6 : 1.4);
  heart.scaling.y = 1.6;
  heart.isPickable = false;
  heart.parent = root;

  // ------------------------------------------------------------------ camps
  const snowy = new Map<string, StandardMaterial>();
  const snowTint = (m: AbstractMesh) => {
    const mat = m.material as StandardMaterial | null;
    if (!mat || !('diffuseColor' in mat)) return;
    let s2 = snowy.get(mat.uniqueId.toString());
    if (!s2) {
      s2 = mat.clone(`${mat.name}_snow`) as StandardMaterial;
      const pbr = s2 as unknown as { albedoColor?: Color3 };
      const base = pbr.albedoColor ?? s2.diffuseColor;
      if (base) Color3.LerpToRef(base, new Color3(0.93, 0.96, 1), 0.62, base);
      snowy.set(mat.uniqueId.toString(), s2);
    }
    m.material = s2;
  };
  const placeModel = async (path: string, at: Vector3, scale: number, rotY = 0, castShadow = true) => {
    try {
      const container = await assets.load(path);
      const inst = container.instantiateModelsToScene((n) => n, false);
      const node = inst.rootNodes[0] as TransformNode;
      node.position.copyFrom(at);
      // glTF roots carry a (1, 1, -1) handedness flip: scale it, don't replace it.
      node.scaling.scaleInPlace(scale);
      node.rotationQuaternion = null;
      node.rotation.y = rotY;
      node.parent = root;
      for (const m of node.getChildMeshes()) {
        if (frost) snowTint(m);
        m.isPickable = false;
        m.receiveShadows = true;
        if (castShadow) shadows.addShadowCaster(m);
        m.freezeWorldMatrix();
      }
      return node;
    } catch {
      return null;
    }
  };

  const pedestalTasks: Promise<unknown>[] = [];
  for (const c of TEAMS) {
    const camp = data.camps[c];
    if (!camp) continue;
    const center = Vector3.FromArray(camp.center);
    const out = center.clone().normalize();
    const facing = Math.atan2(-out.x, -out.z);
    // Castle and towers flank the camp; the space behind it stays open for the camera.
    const side = new Vector3(-out.z, 0, out.x);
    if (wilds) {
      const castleAt = center.add(side.scale(4.6)).add(out.scale(0.6));
      castleAt.y = groundY(castleAt.x, castleAt.z);
      pedestalTasks.push(placeModel(ENV.castle(c), castleAt, 1.5, facing));
      for (const [s2, o2] of [[-1, 0.4], [-1, -2.6]] as const) {
        const towerAt = center.add(side.scale(s2 * 4.0)).add(out.scale(o2));
        towerAt.y = groundY(towerAt.x, towerAt.z);
        pedestalTasks.push(placeModel(ENV.tower(c), towerAt, 1.0, facing));
      }
    } else {
      // Arena yards are tight: one small keep in the outer corner, off the camera's line.
      const keepAt = center.add(out.scale(2.0)).add(side.scale(2.0));
      keepAt.y = groundY(keepAt.x, keepAt.z);
      pedestalTasks.push(placeModel(ENV.tower(c), keepAt, 0.6, facing));
    }
    const [r, g, b] = TEAM_RGB[c];
    const pedMat = new StandardMaterial(`ped_${c}`, scene);
    pedMat.diffuseColor = new Color3(r, g, b);
    pedMat.emissiveColor = new Color3(r * 0.25, g * 0.25, b * 0.25);
    for (const slot of camp.slots) {
      const ped = MeshBuilder.CreateCylinder(`ped_${c}`, { height: 0.25, diameterTop: 0.95, diameterBottom: 1.1, tessellation: 20 }, scene);
      ped.material = pedMat;
      ped.position.set(slot[0], slot[1] - 0.12, slot[2]);
      ped.receiveShadows = true;
      ped.isPickable = false;
      ped.parent = root;
    }
  }

  // ------------------------------------------------------------------ scenery
  // Keep a clear corridor behind each camp: that's where the camera sits for that player.
  const inSightline = (x: number, z: number) =>
    campCenters.some((c) => {
      const len = Math.hypot(c[0], c[2]) || 1;
      const ox = c[0] / len;
      const oz = c[2] / len;
      const along = (x - c[0]) * ox + (z - c[2]) * oz;
      if (along < -2 || along > 26) return false;
      const across = Math.abs((x - c[0]) * -oz + (z - c[2]) * ox);
      return across < 4 + along * 0.45;
    });
  const nearSomething = (x: number, z: number, clear: number) =>
    pathDist(x, z) < clear ||
    riverDist(x, z) < 0.6 ||
    campDist(x, z) < 5 ||
    Math.hypot(x, z) < (wilds ? 6.5 : 3.2) ||
    lakeDist(x, z) < 0.8 ||
    inSightline(x, z);

  // Snowy pines, built procedurally and instanced.
  function scatterPines(count: number) {
    const bark = makeMat('pineBark', [0.3, 0.2, 0.13], 0);
    const needles = makeMat('pineNeedles', [0.1, 0.27, 0.2], 0.02);
    const snowMat = makeMat('pineSnow', [0.93, 0.96, 1], 0.08);
    const parts: Mesh[] = [];
    const trunk = MeshBuilder.CreateCylinder('pineTrunk', { height: 0.9, diameter: 0.22, tessellation: 6 }, scene);
    trunk.position.y = 0.45;
    trunk.material = bark;
    parts.push(trunk);
    for (let k = 0; k < 3; k++) {
      const h = 1.3 - k * 0.25;
      const d = 1.7 - k * 0.45;
      const cone = MeshBuilder.CreateCylinder(`pineCone${k}`, { height: h, diameterTop: 0, diameterBottom: d, tessellation: 7 }, scene);
      cone.position.y = 0.9 + k * 0.62 + h / 2;
      cone.material = needles;
      const cap = MeshBuilder.CreateCylinder(`pineCap${k}`, { height: h * 0.45, diameterTop: 0, diameterBottom: d * 0.52, tessellation: 7 }, scene);
      cap.position.y = cone.position.y + h * 0.3;
      cap.material = snowMat;
      parts.push(cone, cap);
    }
    const pine = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
    pine.name = 'pine';
    pine.isPickable = false;
    pine.parent = root;
    pine.isVisible = false;
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 12; tries++) {
      const a = rand() * Math.PI * 2;
      const d = 6 + Math.sqrt(rand()) * (bounds * 1.3 - 6);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (nearSomething(x, z, 1.5)) continue;
      placed++;
      const inst = pine.createInstance(`pine${placed}`);
      const sc = 0.8 + rand() * 0.9;
      inst.position.set(x, groundY(x, z) - 0.05, z);
      inst.scaling.set(sc, sc * (0.9 + rand() * 0.3), sc);
      inst.rotation.y = rand() * Math.PI * 2;
      inst.parent = root;
      inst.isPickable = false;
      shadows.addShadowCaster(inst);
      inst.freezeWorldMatrix();
    }
  }

  const scatter = async (paths: string[], count: number, minR: number, maxR: number, scale: [number, number], clear: number, shadow = true) => {
    const jobs: Promise<unknown>[] = [];
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 12; tries++) {
      const a = rand() * Math.PI * 2;
      const d = minR + Math.sqrt(rand()) * (maxR - minR);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (nearSomething(x, z, clear)) continue;
      placed++;
      const path = paths[Math.floor(rand() * paths.length)];
      const s = scale[0] + rand() * (scale[1] - scale[0]);
      jobs.push(placeModel(path, new Vector3(x, groundY(x, z) - 0.05, z), s, rand() * Math.PI * 2, shadow));
    }
    await Promise.all(jobs);
  };

  const treeSet = forge ? ENV.rocks : wilds ? [...ENV.trees['jungle'], ...ENV.trees['forest']] : ENV.trees['arena'];
  const treeCount = quality === 'high' ? (wilds ? 260 : 90) : wilds ? 150 : 60;
  if (frost) scatterPines(quality === 'high' ? 320 : 180);
  await Promise.all([
    ...pedestalTasks,
    placeModel(wilds ? ENV.ruins : ENV.stage, new Vector3(0, goalY - 0.05, 0), wilds ? 1.0 : 0.7, 0),
    frost ? Promise.resolve() : scatter(treeSet, treeCount, wilds ? 6 : 9, bounds * 1.25, [1.0, 1.8], 1.4),
    scatter(ENV.rocks, wilds ? 70 : 30, 4, bounds * 1.2, [0.8, 2.0], 1.2),
    scatter(ENV.hills, wilds ? 14 : 6, bounds * 1.5, bounds * 1.9, [2.0, 3.2], 3, false),
    scatter(ENV.mountains, wilds ? 16 : 10, bounds * 1.9, bounds * 2.4, [4, 7], 4, false),
  ]);
  // Water plants along the banks.
  for (const r of frost ? [] : rivers) {
    for (const [x, z] of r.points) {
      if (rand() < 0.6 && pathDist(x, z) > 2) {
        void placeModel(ENV.waterPlants[Math.floor(rand() * ENV.waterPlants.length)], new Vector3(x + (rand() - 0.5) * r.width * 0.6, -0.42, z + (rand() - 0.5) * r.width * 0.6), 0.9, rand() * 6, false);
      }
    }
  }

  // ------------------------------------------------------------------ ambient life
  const clouds: TransformNode[] = [];
  for (let i = 0; i < (wilds ? 10 : 6); i++) {
    const a = rand() * Math.PI * 2;
    const d = rand() * bounds * 1.4;
    const node = await placeModel(ENV.clouds[i % ENV.clouds.length], new Vector3(Math.cos(a) * d, 26 + rand() * 8, Math.sin(a) * d), 0.9 + rand() * 0.6, rand() * 6, false);
    if (node) {
      for (const m of node.getChildMeshes()) m.unfreezeWorldMatrix();
      clouds.push(node);
    }
  }

  // Birds: little flapping V shapes circling over the board.
  const birdMat = new StandardMaterial('bird', scene);
  birdMat.diffuseColor = new Color3(0.12, 0.12, 0.14);
  birdMat.backFaceCulling = false;
  const birds: { node: TransformNode; left: Mesh; right: Mesh; r: number; h: number; speed: number; phase: number }[] = [];
  const birdCount = wilds ? 14 : 6;
  for (let i = 0; i < birdCount; i++) {
    const node = new TransformNode(`bird${i}`, scene);
    node.parent = root;
    const mk = (side: number) => {
      const wing = MeshBuilder.CreatePlane(`wing${i}${side}`, { width: 0.45, height: 0.16 }, scene);
      wing.material = birdMat;
      wing.parent = node;
      wing.setPivotPoint(new Vector3(-side * 0.225, 0, 0));
      wing.position.x = side * 0.225;
      wing.rotation.x = Math.PI / 2;
      wing.isPickable = false;
      return wing;
    };
    birds.push({ node, left: mk(-1), right: mk(1), r: 8 + rand() * bounds, h: 7 + rand() * 7, speed: 0.15 + rand() * 0.2, phase: rand() * Math.PI * 2 });
  }

  // Aurora: glowing curtains of light high in the polar sky.
  const auroras: Mesh[] = [];
  if (frost) {
    const tex = new DynamicTexture('aurora', { width: 256, height: 128 }, scene, true);
    const g = tex.getContext() as CanvasRenderingContext2D;
    const grad = g.createLinearGradient(0, 128, 0, 0);
    grad.addColorStop(0, 'rgba(80,255,170,0)');
    grad.addColorStop(0.15, 'rgba(80,255,170,0.85)');
    grad.addColorStop(0.55, 'rgba(70,200,255,0.45)');
    grad.addColorStop(1, 'rgba(170,90,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 128);
    // Vertical rays.
    g.globalCompositeOperation = 'destination-out';
    for (let x = 0; x < 256; x += 3) {
      g.fillStyle = `rgba(0,0,0,${0.15 + 0.5 * Math.abs(Math.sin(x * 0.21) * Math.sin(x * 0.047))})`;
      g.fillRect(x, 0, 2, 128);
    }
    tex.hasAlpha = true;
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.update();
    for (let k = 0; k < 3; k++) {
      const mat = new StandardMaterial(`auroraMat${k}`, scene);
      mat.diffuseTexture = tex;
      mat.opacityTexture = tex;
      mat.emissiveColor = new Color3(1, 1, 1);
      mat.disableLighting = true;
      mat.backFaceCulling = false;
      mat.fogEnabled = false;
      mat.alpha = 0.7;
      const bottom: Vector3[] = [];
      const top: Vector3[] = [];
      const R = 170 + k * 35;
      const a0 = -0.4 + k * 1.9;
      for (let i = 0; i <= 40; i++) {
        const a = a0 + (i / 40) * 2.2;
        const wave = Math.sin(i * 0.45 + k) * 14;
        const x = Math.cos(a) * (R + wave);
        const z = Math.sin(a) * (R + wave);
        bottom.push(new Vector3(x, 55 + k * 8, z));
        top.push(new Vector3(x * 1.05, 105 + k * 10 + Math.sin(i * 0.3) * 8, z * 1.05));
      }
      const ribbon = MeshBuilder.CreateRibbon(`aurora${k}`, { pathArray: [bottom, top] }, scene);
      ribbon.material = mat;
      ribbon.isPickable = false;
      ribbon.infiniteDistance = false;
      ribbon.parent = root;
      auroras.push(ribbon);
    }
  }

  // Drifting pollen / fireflies.
  const motes = new ParticleSystem('motes', quality === 'high' ? 600 : 300, scene);
  const moteTex = new DynamicTexture('moteTex', { width: 32, height: 32 }, scene, false);
  {
    const g = moteTex.getContext() as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,220,1)');
    grad.addColorStop(1, 'rgba(255,255,200,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    moteTex.update();
  }
  motes.particleTexture = moteTex;
  motes.emitter = new Vector3(0, 1.5, 0);
  motes.minEmitBox = new Vector3(-bounds, -1, -bounds);
  motes.maxEmitBox = new Vector3(bounds, 3, bounds);
  motes.color1 = forge ? new Color4(1, 0.5, 0.1, 0.9) : new Color4(1, 1, 0.7, 0.8);
  motes.color2 = forge ? new Color4(1, 0.25, 0.05, 0.8) : new Color4(0.7, 1, 0.6, 0.6);
  motes.colorDead = new Color4(1, 1, 1, 0);
  motes.minSize = 0.04;
  motes.maxSize = 0.1;
  motes.minLifeTime = 4;
  motes.maxLifeTime = 8;
  motes.emitRate = quality === 'high' ? 70 : 35;
  motes.direction1 = new Vector3(-0.15, 0.08, -0.15);
  motes.direction2 = new Vector3(0.15, 0.2, 0.15);
  motes.minEmitPower = 0.1;
  motes.maxEmitPower = 0.3;
  motes.blendMode = ParticleSystem.BLENDMODE_ADD;
  if (frost) {
    // Falling snow instead of pollen.
    motes.emitter = new Vector3(0, 16, 0);
    motes.minEmitBox = new Vector3(-bounds * 1.3, 0, -bounds * 1.3);
    motes.maxEmitBox = new Vector3(bounds * 1.3, 4, bounds * 1.3);
    motes.color1 = new Color4(1, 1, 1, 0.95);
    motes.color2 = new Color4(0.85, 0.92, 1, 0.8);
    motes.minSize = 0.05;
    motes.maxSize = 0.14;
    motes.minLifeTime = 7;
    motes.maxLifeTime = 11;
    motes.emitRate = quality === 'high' ? 260 : 130;
    motes.direction1 = new Vector3(-0.35, -1, -0.2);
    motes.direction2 = new Vector3(0.35, -1.4, 0.2);
    motes.minEmitPower = 1.1;
    motes.maxEmitPower = 1.6;
    motes.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  }
  motes.start();

  // ------------------------------------------------------------------ api
  let turnColor = new Color3(1, 1, 1);
  const heartTarget = new Color3(1, 1, 1);

  return {
    spacing,
    sun,
    shadows,
    groundY,
    setTileEffect,
    highlightTiles,
    previewTiles,
    setConveyor(direction) {
      for (const c of conveyors) c.plane.rotation.y = c.base + (direction < 0 ? Math.PI : 0);
    },
    setTurnColor(color) {
      const rgb = color ? TEAM_RGB[color] : [1, 1, 1];
      heartTarget.set(rgb[0], rgb[1], rgb[2]);
    },
    update(dt, t) {
      (waterMat.bumpTexture as Texture).uOffset += dt * 0.05;
      (lavaMat.bumpTexture as Texture).uOffset += dt * 0.015;
      lavaMat.emissiveColor.g = 0.34 + Math.sin(t * 1.3) * 0.05;
      for (const a of animated) {
        if (a.spin) a.mesh.rotation.y += dt * a.spin;
        if (a.scroll) ((a.mesh.material as StandardMaterial).diffuseTexture as Texture).uOffset += dt * a.scroll;
        if (a.pulse) a.mesh.scaling.setAll(1 + Math.sin(t * 3 * a.pulse + a.mesh.position.x) * 0.06 * a.pulse);
      }
      const hs = 1 + Math.sin(t * 6) * 0.08;
      for (const h of highlights) h.scaling.set(hs, 1, hs);
      (waterMat.bumpTexture as Texture).vOffset += dt * 0.02;
      Color3.LerpToRef(turnColor, heartTarget, Math.min(1, dt * 3), turnColor);
      heartMat.emissiveColor.copyFrom(turnColor);
      heart.rotation.y += dt * 0.6;
      heart.position.y = goalY + (wilds ? 2.6 : 1.4) + Math.sin(t * 1.4) * 0.15;
      for (const s of shrines) {
        s.rotation.y += dt * 1.2;
        s.position.y += Math.sin(t * 2 + s.position.x) * dt * 0.15;
      }
      for (const r of runes) (r.material as StandardMaterial).alpha = 0.75 + Math.sin(t * 2.2) * 0.25;
      auroras.forEach((a, k) => {
        const m = a.material as StandardMaterial;
        (m.diffuseTexture as Texture).uOffset += dt * (0.008 + k * 0.004);
        m.alpha = 0.45 + 0.3 * Math.sin(t * 0.35 + k * 1.7);
      });
      for (const c of clouds) {
        c.position.x += dt * 0.25;
        if (c.position.x > bounds * 1.6) c.position.x = -bounds * 1.6;
      }
      for (const b of birds) {
        const a = t * b.speed + b.phase;
        b.node.position.set(Math.cos(a) * b.r, b.h + Math.sin(t * 0.7 + b.phase) * 0.6, Math.sin(a) * b.r);
        b.node.rotation.y = -a;
        const flap = Math.sin(t * 9 + b.phase) * 0.7;
        b.left.rotation.z = flap;
        b.right.rotation.z = -flap;
      }
    },
    dispose() {
      motes.dispose();
      for (const ps of ambientSystems) ps.dispose();
      root.dispose(false, true);
      hemi.dispose();
      sun.dispose();
      shadows.dispose();
    },
  };
}

export type { MapNode };
