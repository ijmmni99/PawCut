/// <reference lib="webworker" />
// MediaPipe ObjectDetector (EfficientDet-Lite0, COCO) used to find cats, dogs and people. Lazy-loaded inside the
// analysis worker; the runtime and model are served same-origin from /mediapipe and /models.
import type { ObjectDetector } from '@mediapipe/tasks-vision';
import { type Box, boxMovement } from './features';

const WEIGHTS: Record<string, number> = { cat: 1, dog: 0.9, person: 0.7 };

export type Subject = { box: Box; weight: number };

export type SubjectDetector = {
  /** Best cat/dog/person in the frame, or null. Boxes are normalised to 0..1. */
  detect(image: OffscreenCanvas | HTMLCanvasElement): Subject | null;
  close(): void;
};

export async function loadDetector(): Promise<SubjectDetector | null> {
  try {
    const { FilesetResolver, ObjectDetector } = await import('@mediapipe/tasks-vision');
    const origin = self.location.origin;
    const fileset = await FilesetResolver.forVisionTasks(`${origin}/mediapipe`, true);
    const detector: ObjectDetector = await ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${origin}/models/efficientdet_lite0_int8.tflite`, delegate: 'CPU' },
      runningMode: 'IMAGE',
      scoreThreshold: 0.3,
      maxResults: 5,
      categoryAllowlist: Object.keys(WEIGHTS),
    });
    return {
      detect(image) {
        const { width, height } = image;
        let best: Subject | null = null;
        let bestValue = 0;
        for (const d of detector.detect(image).detections) {
          const cat = d.categories[0];
          const bb = d.boundingBox;
          if (!cat || !bb) continue;
          const weight = WEIGHTS[cat.categoryName] ?? 0;
          const value = weight * cat.score;
          if (value > bestValue) {
            bestValue = value;
            best = {
              box: { x: bb.originX / width, y: bb.originY / height, w: bb.width / width, h: bb.height / height },
              weight,
            };
          }
        }
        return best;
      },
      close: () => detector.close(),
    };
  } catch (err) {
    console.warn('Object detector unavailable; scoring without it.', err);
    return null;
  }
}

/** Subject score 0..1: present (weighted by class) plus how much it moved since the last detection. */
export function subjectScore(prev: Subject | null, cur: Subject | null): number {
  if (!cur) return 0;
  const movement = prev ? Math.min(1, boxMovement(prev.box, cur.box) * 2) : 0;
  return cur.weight * (0.4 + 0.6 * movement);
}
