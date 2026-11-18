import * as T from 'three';
import type { Vec3 } from '../../shared/sim/types';
import type { GeometryKit } from './geometry';

export function makeSalvageCrate(parent: T.Object3D, kit: GeometryKit) {
  const body = kit.group(parent);
  kit.box(body, 0xe57935, 0, 0, 0, 0.82, 0.78, 0.82);
  kit.box(body, 0x186759, 0, 0.385, 0, 0.88, 0.16, 0.88);
  kit.box(body, 0x186759, 0, -0.31, 0, 0.88, 0.15, 0.88);
  for (const x of [-0.33, 0.33]) {
    for (const z of [-0.33, 0.33]) {
      kit.box(body, 0x258272, x, 0.028, z, 0.19, 0.75, 0.19);
    }
  }
  for (const side of [-1, 1]) {
    kit.box(body, 0x175b4e, 0, 0.08, side * 0.418, 0.3, 0.2, 0.05);
    kit.box(body, 0xffdd88, 0, 0.08, side * 0.451, 0.2, 0.1, 0.025);
  }

  kit.tube(body, 0xffedc3, -0.3, 0.82, 0.25, 0.035, 0.76);
  kit.orb(body, 0xffdd78, -0.3, 1.19, 0.25, 0.062, 0.062, 0.062, true);
  const flag = kit.group(body, -0.29, 1.12, 0.25);
  const outline = new T.Shape();
  outline.moveTo(0, 0);
  outline.lineTo(0.56, -0.11);
  outline.lineTo(0.35, -0.2);
  outline.lineTo(0.52, -0.29);
  outline.lineTo(0, -0.32);
  outline.closePath();
  const geometry = new T.ShapeGeometry(outline);
  const material = new T.MeshBasicMaterial({ color: 0xffcf66, side: T.DoubleSide, toneMapped: false });
  flag.add(new T.Mesh(geometry, material));

  return {
    body,
    flag,
    dispose() {
      body.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}

const cueWidth = 98;
const cueHeight = 27;
type CueDirection = 'visible' | 'left' | 'right';

function cueTexture(direction: CueDirection) {
  const canvas = document.createElement('canvas');
  canvas.width = cueWidth * 3;
  canvas.height = cueHeight * 3;
  const context = canvas.getContext('2d')!;
  context.scale(3, 3);
  context.beginPath();
  context.roundRect(2, 2, cueWidth - 4, cueHeight - 4, 7);
  context.fillStyle = '#173e37';
  context.fill();
  context.strokeStyle = '#ffd285';
  context.lineWidth = 1.5;
  context.stroke();
  const nameX = cueWidth / 2 + (direction === 'left' ? 7 : direction === 'right' ? -7 : 0);
  context.fillStyle = '#fff1c7';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = '900 14px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  context.fillText('漂流补给', nameX, (cueHeight + 1) / 2);
  if (direction !== 'visible') {
    const x = direction === 'left' ? 15 : cueWidth - 15;
    const sign = direction === 'left' ? -1 : 1;
    context.beginPath();
    context.moveTo(x + sign * 5, cueHeight / 2);
    context.lineTo(x - sign * 3, cueHeight / 2 - 5);
    context.lineTo(x - sign * 3, cueHeight / 2 + 5);
    context.closePath();
    context.fillStyle = '#ffcf66';
    context.fill();
  }
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  return texture;
}

export function makeSalvageCue(parent: T.Object3D) {
  const textures = { visible: cueTexture('visible'), left: cueTexture('left'), right: cueTexture('right') };
  const material = new T.SpriteMaterial({
    map: textures.visible, sizeAttenuation: false, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const sprite = new T.Sprite(material);
  sprite.renderOrder = 5;
  sprite.visible = false;
  parent.add(sprite);
  const anchor = new T.Vector3();
  const point = new T.Vector3();

  function update(position: Vec3 | undefined, camera: T.PerspectiveCamera, width: number, height: number) {
    sprite.visible = false;
    if (!position || !width || !height) return 'none';
    anchor.set(position.x, position.y + 1.48, position.z);
    point.copy(anchor).project(camera);
    if (point.z <= -1 || point.z >= 1) return 'none';
    const edge = Math.max(0, 1 - (cueWidth + 14) / width);
    const direction = point.x < -edge ? 'left' : point.x > edge ? 'right' : 'visible';
    if (direction === 'visible') sprite.position.copy(anchor);
    else {
      point.x = direction === 'left' ? -edge : edge;
      point.y = T.MathUtils.clamp(point.y + 0.08, -0.22, 0.30);
      sprite.position.copy(point.unproject(camera));
    }
    const unitsPerPixel = 2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2)) / height;
    sprite.scale.set(cueWidth * unitsPerPixel, cueHeight * unitsPerPixel, 1);
    material.map = textures[direction];
    sprite.visible = true;
    return direction;
  }

  return {
    update,
    dispose() {
      sprite.removeFromParent();
      material.dispose();
      Object.values(textures).forEach(texture => texture.dispose());
    },
  };
}
