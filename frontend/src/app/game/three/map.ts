import * as THREE from 'three';
import { Color } from '../../core/models';
import { HOME_COLUMN, SAFE_SQUARES, START_SQUARE, TRACK, YARD_ORIGIN } from '../geometry';
import { TEAM_HEX } from './pawn';

/** Grid (col,row) centre → world x/z. The board spans -7.5..7.5. */
export const toWorld = (gx: number, gy: number) => new THREE.Vector3(gx - 7.5, 0, gy - 7.5);

const COLORS: Color[] = ['red', 'green', 'yellow', 'blue'];
const TILE_H = 0.22;
const YARD_H = 0.34;
export const ALTAR_TOP = 0.62;

/** Seeded random so the map looks identical for everyone, every time. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, size: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function stoneTexture(seed: number) {
  const r = rng(seed);
  return canvasTexture(128, (g, s) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      const v = 200 + Math.floor(r() * 55);
      g.fillStyle = `rgba(${v},${v},${v},0.5)`;
      g.fillRect(r() * s, r() * s, 2 + r() * 5, 2 + r() * 5);
    }
    g.strokeStyle = 'rgba(80,70,60,0.35)';
    g.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      let x = r() * s;
      let y = r() * s;
      g.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        x += (r() - 0.5) * 40;
        y += (r() - 0.5) * 40;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.strokeStyle = 'rgba(60,50,40,0.5)';
    g.lineWidth = 6;
    g.strokeRect(0, 0, s, s);
  });
}

function grassTexture() {
  const r = rng(7);
  const tex = canvasTexture(256, (g, s) => {
    g.fillStyle = '#3d6b35';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 4000; i++) {
      const v = r();
      g.fillStyle = v < 0.5 ? 'rgba(90,140,70,0.5)' : v < 0.8 ? 'rgba(40,80,35,0.5)' : 'rgba(120,110,60,0.35)';
      g.fillRect(r() * s, r() * s, 1 + r() * 3, 1 + r() * 3);
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 10);
  return tex;
}

function runeTexture(glyph: string, color: string) {
  return canvasTexture(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    g.shadowColor = color;
    g.shadowBlur = 18;
    g.fillStyle = color;
    g.font = 'bold 84px serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(glyph, s / 2, s / 2 + 6);
  });
}

export interface BoardMap {
  group: THREE.Group;
  /** Height of the walkable surface under a grid cell. */
  topAt(col: number, row: number): number;
  yardTop: number;
  setTurn(color: Color | null): void;
  setNames(names: Partial<Record<Color, string>>): void;
  update(t: number): void;
}

export function buildMap(): BoardMap {
  const group = new THREE.Group();
  const r = rng(42);
  const tops = new Map<string, number>();
  const key = (c: number, rr: number) => `${c},${rr}`;

  // ---------------------------------------------------------------- ground
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40, 64),
    new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.62;
  ground.receiveShadow = true;
  group.add(ground);

  // Board slab with a wooden rim, like a tabletop dungeon tile set.
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(15.6, 0.5, 15.6),
    new THREE.MeshStandardMaterial({ color: 0x4a4038, map: stoneTexture(3), roughness: 0.95 }),
  );
  slab.position.y = -0.37;
  slab.receiveShadow = true;
  slab.castShadow = true;
  group.add(slab);
  const rim = new THREE.Mesh(
    new THREE.BoxGeometry(16.2, 0.4, 16.2),
    new THREE.MeshStandardMaterial({ color: 0x5a3820, roughness: 0.8 }),
  );
  rim.position.y = -0.5;
  rim.receiveShadow = true;
  group.add(rim);

  // ---------------------------------------------------------------- tiles
  const stoneTex = stoneTexture(11);
  const tileGeo = new THREE.BoxGeometry(0.93, TILE_H, 0.93);
  const plainMats = [0xd8cfbd, 0xcfc4ae, 0xc6bca7, 0xded6c6].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, map: stoneTex, roughness: 0.9 }),
  );
  const teamMats = Object.fromEntries(
    COLORS.map((c) => [c, new THREE.MeshStandardMaterial({ color: TEAM_HEX[c], map: stoneTex, roughness: 0.75 })]),
  ) as Record<Color, THREE.MeshStandardMaterial>;

  const addTile = (col: number, row: number, mat: THREE.Material, top: number) => {
    const m = new THREE.Mesh(tileGeo, mat);
    m.position.set(col - 7, top - TILE_H / 2, row - 7);
    m.receiveShadow = true;
    m.castShadow = true;
    group.add(m);
    tops.set(key(col, row), top);
    return m;
  };

  const runeGeo = new THREE.PlaneGeometry(0.7, 0.7);
  const starRune = new THREE.MeshBasicMaterial({
    map: runeTexture('✦', '#ffd76a'),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const runes: THREE.Mesh[] = [];

  TRACK.forEach(([col, row], i) => {
    const startOf = COLORS.find((c) => START_SQUARE[c] === i);
    const top = 0.02 + r() * 0.03;
    addTile(col, row, startOf ? teamMats[startOf] : plainMats[Math.floor(r() * plainMats.length)], top);
    if (SAFE_SQUARES.has(i)) {
      const rune = new THREE.Mesh(runeGeo, startOf ? runeMaterial(startOf) : starRune);
      rune.rotation.x = -Math.PI / 2;
      rune.position.set(col - 7, top + 0.005, row - 7);
      group.add(rune);
      runes.push(rune);
    }
  });

  // Home columns climb like stairs towards the central altar.
  for (const color of COLORS) {
    HOME_COLUMN[color].forEach(([col, row], i) => {
      const mat = teamMats[color].clone();
      mat.emissive = new THREE.Color(TEAM_HEX[color]);
      mat.emissiveIntensity = 0.08 + i * 0.04;
      addTile(col, row, mat, 0.08 + i * 0.1);
    });
  }

  // ---------------------------------------------------------------- yards
  const banners: Partial<Record<Color, { sprite: THREE.Sprite; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; flag: THREE.Mesh }>> = {};
  for (const color of COLORS) {
    const [ox, oy] = YARD_ORIGIN[color];
    const cx = ox + 3 - 7.5;
    const cz = oy + 3 - 7.5;
    const yard = new THREE.Group();
    yard.position.set(cx, 0, cz);
    group.add(yard);

    const plateau = new THREE.Mesh(
      new THREE.BoxGeometry(5.7, YARD_H, 5.7),
      new THREE.MeshStandardMaterial({ color: TEAM_HEX[color], map: stoneTex, roughness: 0.85 }),
    );
    plateau.position.y = YARD_H / 2 - 0.02;
    plateau.receiveShadow = plateau.castShadow = true;
    yard.add(plateau);
    const lawn = new THREE.Mesh(
      new THREE.BoxGeometry(4.3, 0.06, 4.3),
      new THREE.MeshStandardMaterial({ color: 0xe9e0c9, map: stoneTex, roughness: 0.9 }),
    );
    lawn.position.y = YARD_H + 0.01;
    lawn.receiveShadow = true;
    yard.add(lawn);

    // Pedestals for the four pieces.
    const pedGeo = new THREE.CylinderGeometry(0.36, 0.42, 0.12, 24);
    const pedMat = new THREE.MeshStandardMaterial({ color: TEAM_HEX[color], roughness: 0.5 });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const p = new THREE.Mesh(pedGeo, pedMat);
      p.position.set(sx, YARD_H + 0.06, sz);
      p.receiveShadow = true;
      yard.add(p);
    }

    // Corner towers.
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x8d8478, map: stoneTex, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: TEAM_HEX[color], roughness: 0.6 });
    // Three outer towers; the corner facing the centre stays open so the towers
    // never hide the action on the track.
    const inner = [-Math.sign(cx), -Math.sign(cz)];
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      if (sx === inner[0] && sz === inner[1]) continue;
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.45, 1.3, 10), towerMat);
      tower.position.set(sx * 2.55, YARD_H + 0.6, sz * 2.55);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.8, 10), roofMat);
      roof.position.set(sx * 2.55, YARD_H + 1.65, sz * 2.55);
      tower.castShadow = roof.castShadow = true;
      tower.receiveShadow = true;
      yard.add(tower, roof);
    }

    // Banner with the player's name, floating over the yard.
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sprite.scale.set(3.2, 0.8, 1);
    // Hover over a side tower: it never hides a piece and stays on screen from any angle.
    sprite.position.set(Math.sign(cx) * 2.55, 2.75, -Math.sign(cz) * 2.55);
    yard.add(sprite);

    // A flag on the tower nearest the centre.
    const toCentre = new THREE.Vector3(-Math.sign(cx), 0, -Math.sign(cz));
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.0, 6), new THREE.MeshStandardMaterial({ color: 0x3a2a1a }));
    pole.position.set(toCentre.x * 2.45, YARD_H + 0.5, toCentre.z * 2.45);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.38, 6, 1),
      new THREE.MeshStandardMaterial({ color: TEAM_HEX[color], side: THREE.DoubleSide, roughness: 0.7 }),
    );
    flag.position.set(0.3, 0.3, 0);
    pole.add(flag);
    yard.add(pole);

    banners[color] = { sprite, canvas, tex, flag };
  }

  // ---------------------------------------------------------------- altar
  const altar = new THREE.Group();
  group.add(altar);
  const step1 = new THREE.Mesh(new THREE.BoxGeometry(2.96, 0.3, 2.96), new THREE.MeshStandardMaterial({ color: 0x6e655b, map: stoneTex }));
  step1.position.y = 0.15;
  const step2 = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.25, 2.4), new THREE.MeshStandardMaterial({ color: 0x857b70, map: stoneTex }));
  step2.position.y = 0.42;
  step1.castShadow = step1.receiveShadow = step2.castShadow = step2.receiveShadow = true;
  altar.add(step1, step2);
  // Four coloured wedges meeting in the middle.
  const tri = new THREE.Shape([new THREE.Vector2(-1.2, -1.2), new THREE.Vector2(1.2, -1.2), new THREE.Vector2(0, 0)]);
  const wedgeGeo = new THREE.ExtrudeGeometry(tri, { depth: 0.08, bevelEnabled: false });
  // Unrotated, the wedge's base faces +z (south = blue's side).
  const wedgeRot: Record<Color, number> = { blue: 0, yellow: Math.PI / 2, green: Math.PI, red: -Math.PI / 2 };
  for (const color of COLORS) {
    const w = new THREE.Mesh(
      wedgeGeo,
      new THREE.MeshStandardMaterial({ color: TEAM_HEX[color], emissive: TEAM_HEX[color], emissiveIntensity: 0.15 }),
    );
    w.rotation.x = -Math.PI / 2;
    w.rotation.z = wedgeRot[color];
    w.position.y = 0.545;
    w.receiveShadow = true;
    altar.add(w);
  }
  const crystalMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 1.2,
    roughness: 0.2,
    metalness: 0.3,
    transparent: true,
    opacity: 0.9,
  });
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.32, 0), crystalMat);
  crystal.position.y = 1.45;
  crystal.scale.y = 1.6;
  altar.add(crystal);
  const crystalLight = new THREE.PointLight(0xffffff, 6, 6, 1.6);
  crystalLight.position.y = 1.5;
  altar.add(crystalLight);

  // ---------------------------------------------------------------- torches
  const flames: { flame: THREE.Mesh; light: THREE.PointLight; seed: number }[] = [];
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
  // On the corners of the altar's lower step.
  const torchPos: [number, number][] = [[-1.3, -1.3], [1.3, -1.3], [1.3, 1.3], [-1.3, 1.3]];
  for (const [x, z] of torchPos) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.1, 6), new THREE.MeshStandardMaterial({ color: 0x4a3020 }));
    post.position.set(x, 0.85, z);
    post.castShadow = true;
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.08, 0.12, 8), shared_iron());
    bowl.position.set(x, 1.42, z);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.32, 8), flameMat);
    flame.position.set(x, 1.62, z);
    const light = new THREE.PointLight(0xff8a2a, 4, 5, 1.8);
    light.position.set(x, 1.8, z);
    group.add(post, bowl, flame, light);
    flames.push({ flame, light, seed: r() * 10 });
  }

  // ---------------------------------------------------------------- scenery
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 1 });
  const leafMats = [0x2f6b3a, 0x3c7d3f, 0x285c33].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true }));
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x7d7a78, roughness: 1, flatShading: true });
  for (let i = 0; i < 70; i++) {
    const a = r() * Math.PI * 2;
    const d = 11.5 + r() * 14;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (r() < 0.65) {
      const tree = new THREE.Group();
      const s = 0.8 + r() * 0.9;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 0.8, 6), trunkMat);
      trunk.position.y = 0.4;
      tree.add(trunk);
      for (let k = 0; k < 3; k++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.9 - k * 0.22, 1.1, 7), leafMats[Math.floor(r() * 3)]);
        cone.position.y = 1.1 + k * 0.6;
        cone.castShadow = true;
        tree.add(cone);
      }
      tree.scale.setScalar(s);
      tree.position.set(x, -0.62, z);
      tree.rotation.y = r() * 6;
      group.add(tree);
    } else {
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3 + r() * 0.6, 0), rockMat);
      rock.position.set(x, -0.5, z);
      rock.rotation.set(r() * 3, r() * 3, r() * 3);
      rock.castShadow = true;
      group.add(rock);
    }
  }

  // ---------------------------------------------------------------- api
  let turn: Color | null = null;
  const names: Partial<Record<Color, string>> = {};
  const drawBanner = (color: Color) => {
    const b = banners[color]!;
    const g = b.canvas.getContext('2d')!;
    g.clearRect(0, 0, 512, 128);
    const name = names[color];
    if (!name) {
      b.tex.needsUpdate = true;
      return;
    }
    const active = turn === color;
    g.font = '800 56px "Segoe UI", system-ui, sans-serif';
    const w = Math.min(500, g.measureText(name).width + 60);
    g.fillStyle = active ? '#fff7d6' : 'rgba(20,16,36,0.75)';
    g.beginPath();
    g.roundRect((512 - w) / 2, 18, w, 92, 46);
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = '#' + TEAM_HEX[color].toString(16).padStart(6, '0');
    g.stroke();
    g.fillStyle = active ? '#1d1630' : '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, 256, 66, 460);
    b.tex.needsUpdate = true;
  };

  return {
    group,
    yardTop: YARD_H + 0.12,
    topAt: (col, row) => tops.get(key(col, row)) ?? 0.05,
    setTurn(color) {
      turn = color;
      const c = new THREE.Color(color ? TEAM_HEX[color] : 0xffffff);
      crystalMat.emissive.copy(c);
      crystalLight.color.copy(c);
      COLORS.forEach(drawBanner);
    },
    setNames(n) {
      COLORS.forEach((c) => (names[c] = n[c]));
      COLORS.forEach(drawBanner);
    },
    update(t) {
      crystal.rotation.y = t * 0.8;
      crystal.position.y = 1.45 + Math.sin(t * 1.6) * 0.1;
      crystalLight.intensity = 5 + Math.sin(t * 3) * 1.2;
      for (const f of flames) {
        const k = Math.sin(t * 13 + f.seed) * 0.5 + Math.sin(t * 7.3 + f.seed * 2) * 0.5;
        f.light.intensity = 3.6 + k * 0.9;
        f.flame.scale.set(1 + k * 0.08, 1 + k * 0.2, 1 + k * 0.08);
      }
      for (const rune of runes) {
        (rune.material as THREE.MeshBasicMaterial).opacity = 0.65 + Math.sin(t * 2 + rune.position.x) * 0.3;
      }
      for (const color of COLORS) {
        const b = banners[color]!;
        b.flag.rotation.y = Math.sin(t * 2.4 + b.flag.id) * 0.25;
        b.sprite.position.y = 2.75 + Math.sin(t * 1.5 + b.flag.id) * 0.06;
      }
    },
  };
}

const iron = new THREE.MeshStandardMaterial({ color: 0x2b2b30, metalness: 0.7, roughness: 0.5 });
function shared_iron() {
  return iron;
}

const runeMats = new Map<Color, THREE.MeshBasicMaterial>();
function runeMaterial(color: Color) {
  if (!runeMats.has(color)) {
    runeMats.set(
      color,
      new THREE.MeshBasicMaterial({
        map: runeTexture('⛨', '#ffffff'),
        transparent: true,
        depthWrite: false,
        opacity: 0.8,
      }),
    );
  }
  return runeMats.get(color)!;
}
