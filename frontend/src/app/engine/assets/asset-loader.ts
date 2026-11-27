import { AssetContainer, LoadAssetContainerAsync, Scene } from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import { ASSET_ROOT } from './catalog';

/**
 * Loads glTF files once into AssetContainers and hands out instances.
 * Progress is reported as files finish, for the loading screen.
 */
export class AssetLoader {
  private containers = new Map<string, Promise<AssetContainer>>();
  private total = 0;
  private done = 0;
  onProgress: (fraction: number, label: string) => void = () => {};

  constructor(private scene: Scene) {}

  load(path: string): Promise<AssetContainer> {
    let p = this.containers.get(path);
    if (!p) {
      this.total++;
      p = LoadAssetContainerAsync(ASSET_ROOT + path, this.scene).then((c) => {
        this.done++;
        this.onProgress(this.done / Math.max(1, this.total), path);
        return c;
      });
      this.containers.set(path, p);
    }
    return p;
  }

  async preload(paths: string[]): Promise<void> {
    await Promise.all([...new Set(paths)].map((p) => this.load(p).catch((e) => console.warn('asset failed', p, e))));
  }

  dispose() {
    for (const p of this.containers.values()) void p.then((c) => c.dispose()).catch(() => {});
    this.containers.clear();
  }
}
