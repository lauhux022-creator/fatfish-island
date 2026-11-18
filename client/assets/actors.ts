import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { WorkerRoleId } from '../../shared/sim/cast';
import { PLAY } from '../../shared/sim/config';
import claudeUrl from '../../assets/dafeiyu/models/claude.glb?url';
import crabUrl from '../../assets/dafeiyu/models/crab.glb?url';
import feiyuUrl from '../../assets/dafeiyu/models/feiyu.glb?url';
import gptUrl from '../../assets/dafeiyu/models/gpt.glb?url';
import grokUrl from '../../assets/dafeiyu/models/grok.glb?url';
import kimiUrl from '../../assets/dafeiyu/models/kimi.glb?url';

const urls = { claude: claudeUrl, crab: crabUrl, feiyu: feiyuUrl, gpt: gptUrl, grok: grokUrl, kimi: kimiUrl };
export type CharacterAsset = WorkerRoleId | 'feiyu' | 'crab';

interface CharacterTemplate {
  scene: T.Group;
  clips: Map<string, T.AnimationClip>;
  bounds: T.Box3;
}

const looping = new Set(['idle', 'walk', 'run', 'box_01']);

function disposeTemplate(scene: T.Group) {
  const geometries = new Set<T.BufferGeometry>();
  const materials = new Set<T.Material>();
  const textures = new Set<T.Texture>();
  scene.traverse(node => {
    if (!(node instanceof T.Mesh)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof T.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close();
  }
}

export function createActorAssets() {
  const loader = new GLTFLoader();
  const requests = new Map<CharacterAsset, Promise<CharacterTemplate | null>>();
  const loaded = new Set<CharacterTemplate>();
  let disposed = false;

  function load(id: CharacterAsset) {
    if (disposed) return Promise.resolve(null);
    const pending = requests.get(id);
    if (pending) return pending;
    const request = loader.loadAsync(urls[id]).then(gltf => {
      if (disposed) {
        disposeTemplate(gltf.scene);
        return null;
      }
      const bounds = new T.Box3().setFromObject(gltf.scene);
      if (bounds.isEmpty()) {
        disposeTemplate(gltf.scene);
        return null;
      }
      const clips = new Map(gltf.animations.map(clip => [clip.name.toLowerCase(), clip]));
      const template = { scene: gltf.scene, clips, bounds };
      loaded.add(template);
      return template;
    }).catch(() => null);
    requests.set(id, request);
    return request;
  }

  function dispose() {
    disposed = true;
    for (const template of loaded) disposeTemplate(template.scene);
    loaded.clear();
    requests.clear();
  }

  return { load, dispose };
}

export type ActorAssets = ReturnType<typeof createActorAssets>;

export function makeActor(parent: T.Object3D, assets: ActorAssets, height: number, facing: number) {
  const pivot = new T.Group();
  pivot.rotation.y = facing;
  parent.add(pivot);
  let requested: CharacterAsset | undefined;
  let sequence = 0;
  let look: CharacterTemplate | undefined;
  let instance: T.Object3D | undefined;
  let mixer: T.AnimationMixer | undefined;
  let active: T.AnimationAction | undefined;
  let activeName = '';
  let hand: T.Object3D | undefined;

  function detach() {
    if (instance) {
      mixer?.stopAllAction();
      mixer?.uncacheRoot(instance);
      instance.removeFromParent();
      const skeletons = new Set<T.Skeleton>();
      instance.traverse(node => {
        if (node instanceof T.SkinnedMesh) skeletons.add(node.skeleton);
      });
      for (const skeleton of skeletons) skeleton.dispose();
    }
    instance = undefined;
    mixer = undefined;
    look = undefined;
    hand = undefined;
    active = undefined;
    activeName = '';
  }

  function use(id: CharacterAsset, after?: Promise<unknown>) {
    if (requested === id) return;
    requested = id;
    const ticket = ++sequence;
    detach();
    const request = after ? after.then(() => assets.load(id)) : assets.load(id);
    void request.then(template => {
      if (!template || ticket !== sequence) return;
      look = template;
      const object = template.clips.size > 0 ? cloneSkeleton(template.scene) : template.scene.clone();
      const { min, max } = template.bounds;
      const scale = height / Math.max(0.01, max.y - min.y);
      object.scale.setScalar(scale);
      object.position.set(-scale * (min.x + max.x) / 2, -scale * min.y, -scale * (min.z + max.z) / 2);
      object.traverse(node => {
        if (node instanceof T.Mesh) {
          node.castShadow = true;
          node.receiveShadow = true;
          if (node instanceof T.SkinnedMesh) node.frustumCulled = false;
        } else if (node instanceof T.Bone && /(?:hand[_.]?r|right[_. ]?hand)$/i.test(node.name)) {
          hand = node;
        }
      });
      pivot.add(object);
      instance = object;
      if (template.clips.size > 0) {
        mixer = new T.AnimationMixer(object);
        play('idle', 0);
      }
    });
  }

  function play(name: string, delta: number, swingSeconds: number = PLAY.swingSeconds) {
    if (!mixer || !look) return;
    const clip = look.clips.get(name) ?? look.clips.get('idle');
    if (clip && activeName !== clip.name) {
      const next = mixer.clipAction(clip);
      const loop = looping.has(clip.name);
      next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).setLoop(loop ? T.LoopRepeat : T.LoopOnce, loop ? Infinity : 1);
      if (name === 'chop') next.setDuration(swingSeconds);
      next.clampWhenFinished = !loop;
      next.play();
      if (active) next.crossFadeFrom(active, name === 'chop' ? 0.04 : 0.13, false);
      active = next;
      activeName = clip.name;
    }
    mixer.update(delta);
  }

  return {
    pivot,
    use,
    play,
    dispose() {
      ++sequence;
      detach();
      pivot.removeFromParent();
    },
    get ready() { return !!instance; },
    get id() { return instance ? requested : undefined; },
    get hand() { return hand; },
  };
}
