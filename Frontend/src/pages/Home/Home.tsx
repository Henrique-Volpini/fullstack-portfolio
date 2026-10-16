import { Component, Suspense, useEffect, useLayoutEffect, type PropsWithChildren } from "react";
import { Canvas, useLoader, useThree } from "@react-three/fiber";
import { NoColorSpace, PCFShadowMap, RepeatWrapping, SRGBColorSpace, TextureLoader } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import woodColorUrl from "../../assets/textures/coated-pine/color.webp";
import woodNormalUrl from "../../assets/textures/coated-pine/normal.webp";
import woodRoughnessUrl from "../../assets/textures/coated-pine/roughness.webp";
import OldBook from "./OldBook";
import "./Home.css";

const textureUrls = [woodColorUrl, woodNormalUrl, woodRoughnessUrl];
const surfaceSize: [number, number] = [16, 10];

function WoodSurface() {
  const textures = useLoader(TextureLoader, textureUrls);
  const renderer = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);

  useLayoutEffect(() => {
    const anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    const repeatX = surfaceSize[0] / 8;
    const repeatY = surfaceSize[1] / 8;

    textures.forEach((texture, index) => {
      texture.wrapS = texture.wrapT = RepeatWrapping;
      // Preserve the scale and alignment of the wood on the smaller surface.
      texture.repeat.set(repeatX, repeatY);
      texture.offset.set((1 - repeatX) / 2, (1 - repeatY) / 2);
      texture.colorSpace = index === 0 ? SRGBColorSpace : NoColorSpace;
      texture.anisotropy = anisotropy;
      texture.needsUpdate = true;
    });
    invalidate();
  }, [textures, renderer, invalidate]);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={surfaceSize} />
      <meshStandardMaterial
        map={textures[0]}
        normalMap={textures[1]}
        roughnessMap={textures[2]}
        metalness={0}
      />
    </mesh>
  );
}

function DevelopmentCameraControls() {
  const camera = useThree((state) => state.camera);
  const renderer = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const controls = new OrbitControls(camera, renderer.domElement);
    const render = () => invalidate();
    controls.enablePan = false;
    controls.minDistance = 2;
    controls.maxDistance = 14;
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI / 3;
    controls.addEventListener("change", render);
    controls.update();

    return () => {
      controls.removeEventListener("change", render);
      controls.dispose();
    };
  }, [camera, renderer, invalidate]);

  return null;
}

function SceneFallback() {
  return (
    <p className="home-wood-error" role="alert">
      Não foi possível carregar a cena 3D neste navegador.
    </p>
  );
}

class SceneBoundary extends Component<PropsWithChildren, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? <SceneFallback /> : this.props.children;
  }
}

function Home() {
  return (
    <main className={`home-wood${import.meta.env.DEV ? " home-wood--development" : ""}`}>
      <SceneBoundary>
        <Canvas
          camera={{ position: [0, 4.2, 2.8], fov: 24, zoom: 2.5, near: 0.1, far: 250 }}
          dpr={[1, 2]}
          frameloop="demand"
          shadows={{ type: PCFShadowMap }}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
          fallback={<SceneFallback />}
          role="img"
          aria-label="Livro antigo sobre uma mesa de madeira de pinho"
        >
          <hemisphereLight args={["#e8e4dc", "#44372c", 0.22]} />
          <spotLight
            position={[-2.8, 3.8, -3]}
            intensity={95}
            color="#ffd7b0"
            angle={0.95}
            penumbra={0.9}
            decay={2}
            distance={0}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-camera-near={0.2}
            shadow-camera-far={20}
            shadow-bias={-0.00008}
            shadow-normalBias={0.006}
            shadow-radius={3.5}
          />
          <Suspense fallback={null}>
            <WoodSurface />
            <Suspense fallback={null}>
              <OldBook />
            </Suspense>
          </Suspense>
          {import.meta.env.DEV && <DevelopmentCameraControls />}
        </Canvas>
      </SceneBoundary>
    </main>
  );
}

export default Home;
