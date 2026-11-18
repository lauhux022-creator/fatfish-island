import * as T from 'three';

export type Tint = string | number;

export const palette = {
  ink: 0x193d39,
  cream: 0xffe3a0,
  rust: 0x9c4727,
  orange: 0xf39236,
  mustard: 0xfac352,
  teal: 0x327e73,
  darkTeal: 0x2a5f53,
  grass: 0x6f9851,
  plank: 0xb97942,
  sand: 0xd7a661,
} as const;

export function makeGeometryKit() {
  const cube = new T.BoxGeometry(1, 1, 1);
  const ball = new T.SphereGeometry(1, 12, 8);
  const facets = new T.IcosahedronGeometry(1, 0);
  const pebble = new T.IcosahedronGeometry(1, 1);
  const round = new T.CylinderGeometry(1, 1, 1, 12);
  const materials = new Map<Tint, T.MeshStandardMaterial>();

  function material(tint: Tint) {
    const cached = materials.get(tint);
    if (cached) return cached;
    const fresh = new T.MeshStandardMaterial({ color: tint, flatShading: true, roughness: 0.83 });
    materials.set(tint, fresh);
    return fresh;
  }

  function mesh(parent: T.Object3D, geometry: T.BufferGeometry, tint: Tint, x: number, y: number, z: number) {
    const obj = new T.Mesh(geometry, material(tint));
    obj.position.set(x, y, z);
    obj.castShadow = true;
    obj.receiveShadow = true;
    parent.add(obj);
    return obj;
  }

  function group(parent: T.Object3D, x = 0, y = 0, z = 0) {
    const obj = new T.Group();
    obj.position.set(x, y, z);
    parent.add(obj);
    return obj;
  }

  function box(parent: T.Object3D, tint: Tint, x: number, y: number, z: number, w: number, h: number, d: number) {
    const obj = mesh(parent, cube, tint, x, y, z);
    obj.scale.set(w, h, d);
    return obj;
  }

  function orb(parent: T.Object3D, tint: Tint, x: number, y: number, z: number, w: number, h: number, d: number, low = false) {
    const obj = mesh(parent, low ? facets : ball, tint, x, y, z);
    obj.scale.set(w, h, d);
    return obj;
  }

  function rock(parent: T.Object3D, tint: Tint, x: number, y: number, z: number, w: number, h: number, d: number) {
    const obj = mesh(parent, pebble, tint, x, y, z);
    obj.scale.set(w, h, d);
    return obj;
  }

  function tube(parent: T.Object3D, tint: Tint, x: number, y: number, z: number, r: number, h: number, depth = r) {
    const obj = mesh(parent, round, tint, x, y, z);
    obj.scale.set(r, h, depth);
    return obj;
  }

  function beam(parent: T.Object3D, tint: Tint, start: T.Vector3, end: T.Vector3, width: number, depth = width) {
    const direction = new T.Vector3().subVectors(end, start);
    const center = new T.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const obj = box(parent, tint, center.x, center.y, center.z, width, direction.length(), depth);
    obj.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), direction.normalize());
    return obj;
  }

  return { mesh, material, group, box, orb, rock, tube, beam };
}

export type GeometryKit = ReturnType<typeof makeGeometryKit>;

export function seededDecor(seed: number) {
  let n = seed;
  return () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n / 4294967296;
  };
}

/** The board is a procedural texture, drawn once at startup. */
export function label(parent: T.Object3D, words: string, width: number, height: number, x: number, y: number, z: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round(512 * height / width);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#f5d88e';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#254b40';
  context.lineWidth = 8;
  context.strokeRect(13, 13, canvas.width - 26, canvas.height - 26);
  context.fillStyle = '#254b40';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = '900 78px "PingFang SC", "Microsoft YaHei", sans-serif';
  context.fillText(words, canvas.width / 2, canvas.height / 2 + 4, canvas.width - 66);
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  const sign = new T.Mesh(new T.PlaneGeometry(width, height), new T.MeshBasicMaterial({ map: texture }));
  sign.position.set(x, y, z);
  parent.add(sign);
}
