import * as T from 'three';

export type BadgeStatus = '' | '当饵中' | '待优化' | '幽灵';

const textureWidth = 272;
const textureHeight = 76;
const pixelWidth = 112;
const pixelHeight = pixelWidth * textureHeight / textureWidth;

export function crewBadge(parent: T.Object3D, name: string, accent: string) {
  const canvas = document.createElement('canvas');
  canvas.width = textureWidth;
  canvas.height = textureHeight;
  const context = canvas.getContext('2d')!;
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  const material = new T.SpriteMaterial({
    map: texture, depthTest: false, depthWrite: false, toneMapped: false, sizeAttenuation: false,
  });
  const sprite = new T.Sprite(material);
  sprite.renderOrder = 4;
  sprite.center.set(0.5, 0);
  parent.add(sprite);

  let current: BadgeStatus | undefined;
  let bodyWidth = 0;

  function draw(status: BadgeStatus) {
    bodyWidth = status ? 254 : 135;
    const left = (textureWidth - bodyWidth) / 2;

    context.clearRect(0, 0, textureWidth, textureHeight);
    context.beginPath();
    context.roundRect(left, 7, bodyWidth, 56, 14);
    context.fillStyle = '#102c29';
    context.fill();
    context.beginPath();
    context.moveTo(125, 60);
    context.lineTo(147, 60);
    context.lineTo(136, 72);
    context.closePath();
    context.fill();

    context.beginPath();
    context.roundRect(left + 9, 19, 21, 31, 7);
    context.fillStyle = accent;
    context.fill();
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '900 35px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    context.fillStyle = '#fff0ce';
    context.fillText(name, left + 82, 35, 90);
    if (status) {
      context.beginPath();
      context.roundRect(left + 133, 13, 114, 43, 9);
      context.fillStyle = status === '幽灵' ? '#83dece' : status === '当饵中' ? '#f49c6e' : '#ffcf74';
      context.fill();
      context.fillStyle = '#37281b';
      context.font = '900 31px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
      context.fillText(status, left + 190, 35, 103);
    }
    texture.needsUpdate = true;
  }

  function setStatus(status: BadgeStatus) {
    if (status === current) return;
    current = status;
    draw(status);
  }

  function setName(next: string) {
    if (name === next) return;
    name = next;
    draw(current ?? '');
  }

  function resize(unitsPerPixel: number) {
    sprite.scale.set(pixelWidth * unitsPerPixel, pixelHeight * unitsPerPixel, 1);
  }

  return {
    sprite, setName, setStatus, resize, pixelHeight,
    get pixelWidth() { return pixelWidth * bodyWidth / textureWidth; },
  };
}
