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

export interface World {
  /** Average distance between trail tiles. */
  spacing: number;
  sun: DirectionalLight;
  shadows: ShadowGenerator;
  /** Surface height at a world x/z (terrain only). */
  groundY(x: number, z: number): number;
  setTurnColor(color: Color | null): void;
  update(dt: number, t: number): void;
  dispose(): void;
}

/** Builds the 3D world for a map: terrain, water, trail, camps, temple, scenery and ambient life. */
export async function buildWorld(scene: Scene, layout: BoardLayout, assets: AssetLoader, quality: 'high' | 'medium'): Promise<World> {
  const data = layout.data;
  const rand = mulberry32(data.id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  const root = new TransformNode('world', scene);
  const wilds = data.theme === 'wilds';
  const bounds = data.bounds;

  // ------------------------------------------------------------------ sky & light
  scene.clearColor = new Color4(0.55, 0.7, 0.9, 1);
  scene.ambientColor = new Color3(0.25, 0.25, 0.3);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = wilds ? 0.0085 : 0.012;
  scene.fogColor = new Color3(0.62, 0.74, 0.86);

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

  const groundY = (x: number, z: number) => {
    const r = Math.hypot(x, z);
    let h = noise2(x, z) * (wilds ? 0.9 : 0.4);
    // Gentle rise towards the horizon so the board sits in a valley.
    h += Math.max(0, r - bounds * 0.95) * 0.35;
    const rd = riverDist(x, z);
    if (rd < 1.6) h = Math.min(h, -0.75 + Math.max(0, rd) * 0.4);
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
    const a = Math.atan2(-z, x);
    // Rough biome by angle around the loop, matching map zones.
    const idx = Math.floor(((Math.PI * 0.75 - a + Math.PI * 4) % (Math.PI * 2)) / (Math.PI * 2) * data.loop.length);
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
      [r, g, b] = [r + (0.55 - r) * k, g + (0.48 - g) * k, b + (0.33 - b) * k]; // sandy banks
    }
    const pd = pathDist(x, z);
    if (pd < 1.1) {
      const k = 1 - pd / 1.1;
      [r, g, b] = [r + (0.45 - r) * k * 0.8, g + (0.36 - g) * k * 0.8, b + (0.24 - b) * k * 0.8]; // trodden dirt
    }
    if (y > 2.5) {
      const k = Math.min(1, (y - 2.5) / 3);
      [r, g, b] = [r + (0.5 - r) * k, g + (0.5 - g) * k, b + (0.48 - b) * k];
    }
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
    ribbon.material = waterMat;
    ribbon.isPickable = false;
    ribbon.parent = root;
    waterMeshes.push(ribbon);
  }
  // A moat-like lake ring is implied by the rivers meeting the temple plateau.

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
    const loop = data.loop.map((id) => layout.nodes.get(id)!);
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
    for (const id of data.routes[c] ?? []) {
      const n = layout.nodes.get(id)!;
      if (n.kind === 'home' || n.kind === 'goal') routeOwner.set(id, c);
      if (n.kind === 'start' && data.routes[c][0] === id) routeOwner.set(id, c);
    }
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
  for (const n of data.nodes) {
    const [x, y, z] = n.pos;
    let mesh: AbstractMesh;
    if (n.bridge) {
      const deck = MeshBuilder.CreateBox(`plank_${n.id}`, { width: tileScale * 1.05, height: 0.12, depth: tileScale * 0.9 }, scene);
      deck.material = plank;
      mesh = deck;
      mesh.position.set(x, y - 0.06, z);
      const next = layout.nodes.get(data.loop[(data.loop.indexOf(n.id) + 1) % data.loop.length]);
      if (next) mesh.lookAt(new Vector3(next.pos[0], y - 0.06, next.pos[2]));
      // Rope posts.
      for (const side of [-1, 1]) {
        const post = MeshBuilder.CreateCylinder(`post_${n.id}_${side}`, { height: 0.7, diameter: 0.09 }, scene);
        post.material = plank;
        post.parent = mesh;
        post.position.set(side * tileScale * 0.55, 0.3, 0);
        shadows.addShadowCaster(post);
      }
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
    inSightline(x, z);

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

  const treeSet = wilds ? [...ENV.trees['jungle'], ...ENV.trees['forest']] : ENV.trees['arena'];
  const treeCount = quality === 'high' ? (wilds ? 260 : 90) : wilds ? 150 : 60;
  await Promise.all([
    ...pedestalTasks,
    placeModel(wilds ? ENV.ruins : ENV.stage, new Vector3(0, goalY - 0.05, 0), wilds ? 1.0 : 0.7, 0),
    scatter(treeSet, treeCount, wilds ? 6 : 9, bounds * 1.25, [1.0, 1.8], 1.4),
    scatter(ENV.rocks, wilds ? 70 : 30, 4, bounds * 1.2, [0.8, 2.0], 1.2),
    scatter(ENV.hills, wilds ? 14 : 6, bounds * 1.5, bounds * 1.9, [2.0, 3.2], 3, false),
    scatter(ENV.mountains, wilds ? 16 : 10, bounds * 1.9, bounds * 2.4, [4, 7], 4, false),
  ]);
  // Water plants along the banks.
  for (const r of rivers) {
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
  motes.color1 = new Color4(1, 1, 0.7, 0.8);
  motes.color2 = new Color4(0.7, 1, 0.6, 0.6);
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
  motes.start();

  // ------------------------------------------------------------------ api
  let turnColor = new Color3(1, 1, 1);
  const heartTarget = new Color3(1, 1, 1);

  return {
    spacing,
    sun,
    shadows,
    groundY,
    setTurnColor(color) {
      const rgb = color ? TEAM_RGB[color] : [1, 1, 1];
      heartTarget.set(rgb[0], rgb[1], rgb[2]);
    },
    update(dt, t) {
      (waterMat.bumpTexture as Texture).uOffset += dt * 0.05;
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
      root.dispose(false, true);
      hemi.dispose();
      sun.dispose();
      shadows.dispose();
    },
  };
}

export type { MapNode };
