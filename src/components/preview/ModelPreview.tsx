import { convertFileSrc } from "@tauri-apps/api/core";
import { Focus, Grid3x3, Rotate3d, Shapes } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { formatSize, numberFmt } from "../../lib/format";
import { join, parentOf } from "../../lib/path";
import type { PreviewProps } from "../../lib/preview";
import { PreviewLoading } from "./FallbackPreview";

/** Past this a model could freeze the window while parsing, so it has to be asked for. */
const AUTO_LOAD_BYTES = 256 * 1024 * 1024;

const ASSET_ROOT = convertFileSrc("");

/**
 * A file's whole path is one encoded segment of its asset URL, so loaders resolve neighbours
 * ("scene.bin", "textures/wood.png") against the URL root. Point those back at the model's folder.
 */
function createManager(modelPath: string): THREE.LoadingManager {
  const dir = parentOf(modelPath) ?? "";
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (!url.startsWith(ASSET_ROOT)) return url; // data: and blob: from embedded resources
    const rest = decodeURIComponent(url.slice(ASSET_ROOT.length).split("?")[0]);
    if (/^[a-zA-Z]:[\\/]|^[\\/]/.test(rest)) return url; // already a full path
    return convertFileSrc(join(dir, rest.replace(/\//g, "\\")));
  });
  return manager;
}

async function loadModel(ext: string, url: string, manager: THREE.LoadingManager): Promise<THREE.Object3D> {
  switch (ext) {
    case "glb":
    case "gltf": {
      const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
        import("three/addons/loaders/GLTFLoader.js"),
        import("three/addons/loaders/DRACOLoader.js"),
        import("three/addons/libs/meshopt_decoder.module.js"),
      ]);
      const draco = new DRACOLoader(manager).setDecoderPath(new URL("draco/", document.baseURI).href);
      const gltf = await new GLTFLoader(manager)
        .setDRACOLoader(draco)
        .setMeshoptDecoder(MeshoptDecoder)
        .loadAsync(url);
      draco.dispose();
      gltf.scene.animations = gltf.animations;
      return gltf.scene;
    }
    case "obj": {
      const [{ OBJLoader }, { MTLLoader }] = await Promise.all([
        import("three/addons/loaders/OBJLoader.js"),
        import("three/addons/loaders/MTLLoader.js"),
      ]);
      const text = await new THREE.FileLoader(manager).loadAsync(url);
      const loader = new OBJLoader(manager);
      const mtl = /^mtllib\s+(.+?)\s*$/m.exec(text as string)?.[1];
      if (mtl) {
        // A missing material library is normal for a copied .obj; it just renders untextured.
        const materials = await new MTLLoader(manager).loadAsync(`${ASSET_ROOT}${encodeURIComponent(mtl)}`).catch(() => null);
        if (materials) {
          materials.setManager(manager);
          materials.preload();
          loader.setMaterials(materials);
        }
      }
      return loader.parse(text as string);
    }
    case "stl": {
      const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
      const geometry = await new STLLoader(manager).loadAsync(url);
      // Many exporters write all-zero facet normals, which render flat black or white.
      geometry.computeVertexNormals();
      return meshFrom(geometry);
    }
    case "ply": {
      const { PLYLoader } = await import("three/addons/loaders/PLYLoader.js");
      const geometry = await new PLYLoader(manager).loadAsync(url);
      // A PLY without a face list is a point cloud.
      if (geometry.index) return meshFrom(geometry);
      const vertexColors = !!geometry.getAttribute("color");
      // A fixed pixel size keeps dense scans crisp and sparse ones visible.
      return new THREE.Points(geometry, new THREE.PointsMaterial({ vertexColors, size: 3, sizeAttenuation: false }));
    }
    case "fbx": {
      const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
      return new FBXLoader(manager).loadAsync(url);
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/addons/loaders/3MFLoader.js");
      return new ThreeMFLoader(manager).loadAsync(url);
    }
    case "dae": {
      const { ColladaLoader } = await import("three/addons/loaders/ColladaLoader.js");
      const collada = await new ColladaLoader(manager).loadAsync(url);
      return collada!.scene;
    }
    case "3ds": {
      const { TDSLoader } = await import("three/addons/loaders/TDSLoader.js");
      return new TDSLoader(manager).loadAsync(url);
    }
    case "usd":
    case "usdz": {
      const { USDLoader } = await import("three/addons/loaders/USDLoader.js");
      return new USDLoader(manager).loadAsync(url);
    }
    default:
      throw new Error(`No loader for .${ext}`);
  }
}

/** STL and PLY are bare geometry with no materials of their own. */
function meshFrom(geometry: THREE.BufferGeometry): THREE.Mesh {
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const vertexColors = !!geometry.getAttribute("color");
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors, roughness: 0.6, metalness: 0.05 }));
}

function materialsOf(object: THREE.Object3D): THREE.Material[] {
  const out: THREE.Material[] = [];
  object.traverse((o) => {
    const material = (o as THREE.Mesh).material;
    if (material) out.push(...(Array.isArray(material) ? material : [material]));
  });
  return out;
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  for (const material of materialsOf(object)) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
    material.dispose();
  }
}

function describe(object: THREE.Object3D): string {
  let triangles = 0;
  let meshes = 0;
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    const count = mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position")?.count ?? 0;
    triangles += count / 3;
  });
  if (!meshes) return "Point cloud";
  return `${numberFmt.format(Math.round(triangles))} triangles · ${numberFmt.format(meshes)} mesh${meshes === 1 ? "" : "es"}`;
}

interface SceneControls {
  frame: () => void;
  setGrid: (on: boolean) => void;
  setWireframe: (on: boolean) => void;
  setSpin: (on: boolean) => void;
}

function cssColor(el: Element, name: string): THREE.Color {
  return new THREE.Color(getComputedStyle(el).getPropertyValue(name).trim());
}

function ToolToggle({ title, on, onClick, children }: { title: string; on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`icon-btn small${on ? " active" : ""}`} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

export default function ModelPreview({ entry, src, onInfo, onFail }: PreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneControls | null>(null);
  const [force, setForce] = useState(false);
  const [ready, setReady] = useState(false);
  const [grid, setGrid] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [spin, setSpin] = useState(false);
  const tooBig = entry.size > AUTO_LOAD_BYTES && !force;

  useEffect(() => {
    if (tooBig) return;
    const host = hostRef.current!;
    let disposed = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.45;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    // Carried with the camera so whichever side faces the viewer has readable shading.
    const light = new THREE.DirectionalLight(0xffffff, 1.6);
    light.position.set(-0.5, 1, 0.8);
    camera.add(light);
    scene.add(camera);
    const controls = new OrbitControls(camera, renderer.domElement);

    // Drawn on demand: an idle preview uses no GPU. Only spinning or animating needs a loop.
    let frameRequest = 0;
    let mixer: THREE.AnimationMixer | null = null;
    let spinning = false;
    let lastFrame = performance.now();
    const elapsed = () => {
      const now = performance.now();
      const dt = (now - lastFrame) / 1000;
      lastFrame = now;
      return dt;
    };
    const draw = () => {
      frameRequest = 0;
      const dt = elapsed();
      mixer?.update(dt);
      if (spinning) controls.update(dt);
      renderer.render(scene, camera);
      if (mixer || spinning) invalidate();
    };
    const invalidate = () => {
      if (!frameRequest && !disposed) frameRequest = requestAnimationFrame(draw);
    };
    controls.addEventListener("change", invalidate);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let model: THREE.Object3D | null = null;
    let gridHelper: THREE.GridHelper | null = null;

    const manager = createManager(entry.path);
    loadModel(entry.ext, src, manager)
      .then((object) => {
        if (disposed) return disposeObject(object);
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) {
          disposeObject(object);
          return onFail("This model has no visible geometry.");
        }
        model = object;

        // Centre it on the origin, standing on the grid.
        const size = box.getSize(new THREE.Vector3());
        const centre = box.getCenter(new THREE.Vector3());
        object.position.sub(new THREE.Vector3(centre.x, box.min.y, centre.z));
        scene.add(object);

        // Bare geometry takes its colour from the theme.
        for (const material of materialsOf(object)) {
          const standard = material as THREE.MeshStandardMaterial;
          if (entry.ext === "stl" || (entry.ext === "ply" && !standard.vertexColors)) standard.color = cssColor(host, "--text-dim");
        }

        const radius = Math.max(size.length() / 2, 1e-6);
        const extent = Math.max(size.x, size.z, radius) * 2.5;
        gridHelper = new THREE.GridHelper(extent, 20, cssColor(host, "--border-strong"), cssColor(host, "--border"));
        scene.add(gridHelper);

        const target = new THREE.Vector3(0, size.y / 2, 0);
        camera.near = radius / 100;
        camera.far = radius * 100;
        camera.updateProjectionMatrix();
        controls.minDistance = radius / 50;
        controls.maxDistance = radius * 20;
        const frame = () => {
          // The pane is often narrower than tall, so fit whichever field of view is tighter.
          const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
          const halfFov = Math.atan(tanV * Math.min(camera.aspect, 1));
          const distance = (radius / Math.sin(halfFov)) * 1.1;
          camera.position.copy(target).add(new THREE.Vector3(1, 0.65, 1).normalize().multiplyScalar(distance));
          controls.target.copy(target);
          controls.update();
          invalidate();
        };
        frame();

        if (object.animations.length) {
          mixer = new THREE.AnimationMixer(object);
          mixer.clipAction(object.animations[0]).play();
          elapsed();
        }

        sceneRef.current = {
          frame,
          setGrid: (on) => {
            if (gridHelper) gridHelper.visible = on;
            invalidate();
          },
          setWireframe: (on) => {
            for (const m of materialsOf(object)) (m as THREE.MeshStandardMaterial).wireframe = on;
            invalidate();
          },
          setSpin: (on) => {
            spinning = on;
            controls.autoRotate = on;
            elapsed();
            invalidate();
          },
        };
        onInfo(describe(object));
        setReady(true);
        invalidate();
      })
      .catch((e) => {
        console.error(e);
        if (!disposed) onFail("This model couldn't be loaded.");
      });

    return () => {
      disposed = true;
      sceneRef.current = null;
      setReady(false);
      cancelAnimationFrame(frameRequest);
      observer.disconnect();
      controls.dispose();
      if (model) disposeObject(model);
      gridHelper?.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      // WebView2 allows few live GL contexts; arrowing through a folder must not exhaust them.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [entry.path, entry.ext, src, tooBig]);

  if (tooBig) {
    return (
      <div className="preview-center">
        <div className="faint">Large model ({formatSize(entry.size)}). Loading it may take a while.</div>
        <button className="btn small" onClick={() => setForce(true)}>
          Load anyway
        </button>
      </div>
    );
  }

  return (
    <>
      <div ref={hostRef} className="preview-model" />
      {!ready && (
        <div className="preview-overlay">
          <PreviewLoading />
        </div>
      )}
      {ready && (
        <div className="preview-tools">
          <button className="icon-btn small" title="Reset view" onClick={() => sceneRef.current?.frame()}>
            <Focus size={14} />
          </button>
          <ToolToggle
            title="Grid"
            on={grid}
            onClick={() => {
              sceneRef.current?.setGrid(!grid);
              setGrid(!grid);
            }}
          >
            <Grid3x3 size={14} />
          </ToolToggle>
          <ToolToggle
            title="Wireframe"
            on={wireframe}
            onClick={() => {
              sceneRef.current?.setWireframe(!wireframe);
              setWireframe(!wireframe);
            }}
          >
            <Shapes size={14} />
          </ToolToggle>
          <ToolToggle
            title="Turntable"
            on={spin}
            onClick={() => {
              sceneRef.current?.setSpin(!spin);
              setSpin(!spin);
            }}
          >
            <Rotate3d size={14} />
          </ToolToggle>
        </div>
      )}
    </>
  );
}
