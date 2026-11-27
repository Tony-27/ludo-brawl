import { Camera, Color4, DefaultRenderingPipeline, ImageProcessingConfiguration, SSAO2RenderingPipeline, Scene } from '@babylonjs/core';
import { Animator } from '../core/tween';

/** Post-processing: tone mapping, bloom, AO, vignette, and depth of field for cinematic moments. */
export class PostFx {
  private pipeline: DefaultRenderingPipeline;
  private ssao: SSAO2RenderingPipeline | null = null;

  constructor(
    scene: Scene,
    camera: Camera,
    quality: 'high' | 'medium',
    private tween: Animator,
  ) {
    const p = new DefaultRenderingPipeline('post', true, scene, [camera]);
    p.samples = quality === 'high' ? 4 : 1;
    p.fxaaEnabled = quality !== 'high';
    p.bloomEnabled = true;
    p.bloomThreshold = 0.9;
    p.bloomWeight = 0.22;
    p.bloomKernel = 64;
    p.bloomScale = 0.5;
    p.imageProcessingEnabled = true;
    p.imageProcessing.toneMappingEnabled = true;
    p.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    p.imageProcessing.exposure = 0.92;
    p.imageProcessing.contrast = 1.12;
    p.imageProcessing.vignetteEnabled = true;
    p.imageProcessing.vignetteWeight = 2.2;
    p.imageProcessing.vignetteColor = new Color4(0.05, 0.03, 0.1, 0);
    p.sharpenEnabled = quality === 'high';
    if (p.sharpenEnabled) p.sharpen.edgeAmount = 0.15;
    p.depthOfFieldEnabled = false;
    this.pipeline = p;

    if (quality === 'high' && SSAO2RenderingPipeline.IsSupported) {
      this.ssao = new SSAO2RenderingPipeline('ssao', scene, { ssaoRatio: 0.5, blurRatio: 1 }, [camera]);
      this.ssao.radius = 1.2;
      this.ssao.totalStrength = 0.9;
      this.ssao.samples = 16;
      this.ssao.maxZ = 120;
    }
  }

  /** Soft focus on a subject at `distance` from the camera, for a short dramatic beat. */
  focus(distance: number, seconds = 1.2) {
    const p = this.pipeline;
    p.depthOfFieldEnabled = true;
    p.depthOfField.focusDistance = distance * 1000;
    p.depthOfField.fStop = 1.8;
    p.depthOfField.focalLength = 60;
    void this.tween.wait(seconds).then(() => (p.depthOfFieldEnabled = false));
  }

  dispose() {
    this.ssao?.dispose();
    this.pipeline.dispose();
  }
}
