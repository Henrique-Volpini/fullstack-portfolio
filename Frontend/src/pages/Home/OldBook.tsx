import { useEffect, useLayoutEffect, useMemo } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { AnimationMixer, Box3, LoopOnce, Mesh, Plane, Raycaster, Vector2, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import bookUrl from "../../assets/models/old-book.glb?url";

const bookAngle = Math.PI / 18;
const up = new Vector3(0, 1, 0);

// Old Book by cyberhirsch, CC BY 4.0. Attribution is retained in the GLB metadata.
function OldBook() {
  const { scene, animations } = useLoader(GLTFLoader, bookUrl, (loader) => {
    loader.setMeshoptDecoder(MeshoptDecoder);
  });
  const camera = useThree((state) => state.camera);
  const { width, height } = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);
  const framingCamera = useMemo(() => {
    const reference = camera.clone();
    // Retain the requested zoom as a cap when the viewport changes.
    reference.zoom = 1;
    reference.updateProjectionMatrix();
    return { reference, maxZoom: camera.zoom };
  }, [camera]);

  const model = useMemo(() => {
    const object = scene.clone(true);
    const motionBounds = new Box3().setFromObject(object, true);
    const closedSize = motionBounds.getSize(new Vector3());
    const opening = animations[0]?.clone();
    if (!opening) throw new Error("O modelo do livro não contém a animação de abertura.");

    // The source clip continues into page turns and closing; keep only its opening.
    opening.duration = Math.min(2, opening.duration);
    const mixer = new AnimationMixer(object);
    const action = mixer.clipAction(opening);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    // Reserve space for the raised cover throughout the opening.
    for (let sample = 1; sample <= 8; sample++) {
      mixer.setTime((opening.duration * sample) / 8);
      motionBounds.union(new Box3().setFromObject(object, true));
    }

    // Frame the final spread, then restore the closed pose before displaying it.
    const bounds = new Box3().setFromObject(object, true);
    const center = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    const offset = new Vector3(center.x, motionBounds.min.y, center.z);
    const points: Vector3[] = [];
    object.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      for (let index = 0; index < child.geometry.attributes.position.count; index++) {
        points.push(
          child.getVertexPosition(index, new Vector3())
            .applyMatrix4(child.matrixWorld).sub(offset).applyAxisAngle(up, bookAngle),
        );
      }
    });
    action.stop();
    mixer.setTime(0);

    object.position.sub(offset);
    object.traverse((child) => {
      child.castShadow = true;
      child.receiveShadow = true;
    });

    const motionCorners: Vector3[] = [];
    for (const x of [motionBounds.min.x, motionBounds.max.x]) {
      for (const y of [motionBounds.min.y, motionBounds.max.y]) {
        for (const z of [motionBounds.min.z, motionBounds.max.z]) {
          motionCorners.push(new Vector3(x, y, z).sub(offset).applyAxisAngle(up, bookAngle));
        }
      }
    }

    return { object, size, closedSize, points, motionCorners, mixer, action };
  }, [scene, animations]);

  useEffect(() => {
    model.action.reset().play();
    invalidate();

    return () => {
      model.action.stop();
    };
  }, [model, invalidate]);

  useFrame((_state, delta) => {
    if (!model.action.isRunning()) return;

    model.mixer.update(Math.min(delta, 0.05));
    if (model.action.isRunning()) invalidate();
  });

  const placement = useMemo(() => {
    const view = framingCamera.reference.clone();
    const aspect = width / height;
    if ("aspect" in view && Number.isFinite(aspect) && aspect > 0) view.aspect = aspect;
    view.updateProjectionMatrix();
    view.updateMatrixWorld(true);

    let scale = 4 / Math.max(model.closedSize.x, model.closedSize.z);
    const position = new Vector3(0, 0.015, 0);
    const ray = new Raycaster();

    // Keep the opening in view and center the final spread on the table.
    const point = new Vector3();
    for (let step = 0; step < 8; step++) {
      const projected = new Box3();
      for (const vertex of model.points) {
        projected.expandByPoint(point.copy(vertex).multiplyScalar(scale).add(position).project(view));
      }
      const size = projected.getSize(new Vector3());
      const spreadFit = Math.min(1, 1.6 / size.x, 1.24 / size.y);
      if (spreadFit < 0.999) {
        scale *= spreadFit;
        continue;
      }

      const center = projected.getCenter(new Vector3());
      const plane = new Plane(up, -(position.y + (model.size.y * scale) / 2));
      ray.setFromCamera(new Vector2(center.x, center.y), view);
      const current = ray.ray.intersectPlane(plane, new Vector3());
      ray.setFromCamera(new Vector2(0, 0), view);
      const target = ray.ray.intersectPlane(plane, new Vector3());
      if (current && target) position.add(target.sub(current));

      const motion = new Box3().setFromPoints(
        model.motionCorners.map((corner) => corner.clone().multiplyScalar(scale).add(position).project(view)),
      );
      const fit = Math.min(
        1,
        0.96 / Math.max(Math.abs(motion.min.x), Math.abs(motion.max.x)),
        0.96 / Math.max(Math.abs(motion.min.y), Math.abs(motion.max.y)),
      );
      if (fit < 0.999) scale *= fit;
      else if (Math.abs(center.x) + Math.abs(center.y) < 0.00001) break;
    }

    const spread = new Box3();
    for (const vertex of model.points) {
      spread.expandByPoint(point.copy(vertex).multiplyScalar(scale).add(position).project(view));
    }
    // Leave a small margin around the entire open book at every aspect ratio.
    const zoom = Math.min(
      framingCamera.maxZoom,
      0.68 / Math.max(Math.abs(spread.min.x), Math.abs(spread.max.x)),
      0.68 / Math.max(Math.abs(spread.min.y), Math.abs(spread.max.y)),
    );

    return { scale, position, zoom };
  }, [model, framingCamera, width, height]);

  useLayoutEffect(() => {
    camera.zoom = placement.zoom;
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, placement.zoom, invalidate]);

  return (
    <group scale={placement.scale} position={placement.position} rotation={[0, bookAngle, 0]}>
      <primitive object={model.object} dispose={null} />
    </group>
  );
}

export default OldBook;
