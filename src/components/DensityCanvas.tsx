// The density point cloud.
//
// Every point is one grid sample of the measured electron density above the
// chosen threshold — not a surface fitted to it, not an illustration of it.
// That is the whole argument of the view: you are looking at the measurement,
// with the model's atoms drawn on top, and you can see for yourself whether
// the atoms sit inside it.
//
// Rendered as a single instanced/attribute-driven THREE.Points buffer so a
// 10^4-10^5 point cloud costs one draw call.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { type DensityGrid, cartesianOfNode, valueAt } from '../lib/volume';
import type { AtomEvidence } from '../lib/evidence';

interface Props {
  map2FoFc: DensityGrid;
  mapFoFc: DensityGrid;
  atoms: AtomEvidence[];
  /** Contour level for 2Fo-Fc, in sigma. */
  sigmaLevel: number;
  /** Show the Fo-Fc difference cloud (green positive / red negative at ±3σ). */
  showDifference: boolean;
}

const ELEMENT_COLOR: Record<string, number> = {
  C: 0x9aa6b2, N: 0x4f7fe0, O: 0xe0524f, S: 0xd9c04a, P: 0xe08a3c,
  F: 0x67d17f, CL: 0x67d17f, BR: 0xa0522d, I: 0x9400d3,
};

/**
 * Build a point cloud of every grid node above `level` sigma, within `reach`
 * Angstrom of a ligand atom.
 *
 * The box we request is padded so the sampling has margin, but the question on
 * screen is "did the experiment see THIS molecule" — so the surrounding protein
 * density is cropped out. It is real, it is just answering a different
 * question, and leaving it in buries the ligand in someone else's signal.
 */
function buildCloud(
  grid: DensityGrid,
  level: number,
  colorPositive: THREE.Color,
  colorNegative: THREE.Color | null,
  atoms: Array<{ pos: [number, number, number] }>,
  reach: number,
): { positions: Float32Array; colors: Float32Array; count: number } {
  const [nx, ny, nz] = grid.sampleCount;
  const positions: number[] = [];
  const colors: number[] = [];
  const threshold = level * grid.sigmaSource + grid.meanSource;
  const negThreshold = -level * grid.sigmaSource + grid.meanSource;
  const reachSq = reach * reach;

  const near = (p: [number, number, number]): boolean => {
    for (const a of atoms) {
      const dx = p[0] - a.pos[0], dy = p[1] - a.pos[1], dz = p[2] - a.pos[2];
      if (dx * dx + dy * dy + dz * dz <= reachSq) return true;
    }
    return false;
  };

  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        const v = valueAt(grid, ix, iy, iz);
        if (Number.isNaN(v)) continue;
        const positive = v >= threshold;
        const negative = colorNegative !== null && v <= negThreshold;
        if (!positive && !negative) continue;

        const p = cartesianOfNode(grid, ix, iy, iz);
        if (!near(p)) continue;
        positions.push(p[0], p[1], p[2]);
        const c = positive ? colorPositive : colorNegative!;
        // Fade with distance above the threshold so the core of a lobe reads
        // as denser than its edge.
        const strength = Math.min(1, Math.abs(v - grid.meanSource) / (grid.sigmaSource * (level + 2)));
        colors.push(c.r * (0.45 + 0.55 * strength), c.g * (0.45 + 0.55 * strength), c.b * (0.45 + 0.55 * strength));
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    count: positions.length / 3,
  };
}

export function DensityCanvas({ map2FoFc, mapFoFc, atoms, sigmaLevel, showDifference }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    cloud?: THREE.Points;
    diffCloud?: THREE.Points;
    dispose: () => void;
  } | null>(null);

  // Scene setup — once.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0d12);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    // Centre on the ligand.
    const centre = new THREE.Vector3();
    for (const a of atoms) centre.add(new THREE.Vector3(...a.pos));
    centre.divideScalar(Math.max(1, atoms.length));

    let radius = 5;
    for (const a of atoms) radius = Math.max(radius, centre.distanceTo(new THREE.Vector3(...a.pos)) + 3);

    // Simple orbit: drag to rotate, wheel to zoom. (Not OrbitControls — this is
    // the whole interaction and it is 30 lines.)
    let theta = 0.6, phi = 1.1, distance = radius * 1.75;
    let dragging = false, lastX = 0, lastY = 0;

    const place = () => {
      camera.position.set(
        centre.x + distance * Math.sin(phi) * Math.cos(theta),
        centre.y + distance * Math.cos(phi),
        centre.z + distance * Math.sin(phi) * Math.sin(theta),
      );
      camera.lookAt(centre);
    };

    const onDown = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
    const onUp = () => { dragging = false; };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      theta -= (e.clientX - lastX) * 0.008;
      phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi - (e.clientY - lastY) * 0.008));
      lastX = e.clientX; lastY = e.clientY;
      place();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      distance = Math.max(radius * 0.8, Math.min(radius * 6, distance * (1 + e.deltaY * 0.001)));
      place();
    };

    renderer.domElement.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      // updateStyle must stay on: without it the canvas keeps its intrinsic
      // size and spills out from under the panel's later content.
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    place();

    let raf = 0;
    const loop = () => { renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
    loop();

    stateRef.current = {
      renderer, scene, camera,
      dispose: () => {
        cancelAnimationFrame(raf);
        observer.disconnect();
        renderer.domElement.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointermove', onMove);
        renderer.domElement.removeEventListener('wheel', onWheel);
        renderer.dispose();
        mount.removeChild(renderer.domElement);
      },
    };

    return () => { stateRef.current?.dispose(); stateRef.current = null; };
    // Scene is rebuilt when the ligand changes, which is what `atoms` captures.
  }, [atoms]);

  // Atoms + bonds-as-sticks.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const group = new THREE.Group();

    const sphere = new THREE.SphereGeometry(0.28, 16, 12);
    for (const a of atoms) {
      const colour = ELEMENT_COLOR[a.element.toUpperCase()] ?? 0xcccccc;
      // An atom whose difference map says "nothing measured here" is drawn hollow.
      const refuted = Number.isFinite(a.sigmaFoFc) && a.sigmaFoFc < -3;
      const weak = Number.isFinite(a.sigma2FoFc) && a.sigma2FoFc < 1;
      const mat = new THREE.MeshBasicMaterial({
        color: colour,
        wireframe: refuted || weak,
        transparent: weak,
        opacity: weak ? 0.85 : 1,
      });
      const mesh = new THREE.Mesh(sphere, mat);
      mesh.position.set(...a.pos);
      group.add(mesh);
    }

    // Connect atoms within covalent range so the molecule reads as a molecule.
    const linePositions: number[] = [];
    for (let i = 0; i < atoms.length; i++) {
      for (let j = i + 1; j < atoms.length; j++) {
        const [ax, ay, az] = atoms[i].pos;
        const [bx, by, bz] = atoms[j].pos;
        const d = Math.hypot(ax - bx, ay - by, az - bz);
        if (d < 1.75) linePositions.push(ax, ay, az, bx, by, bz);
      }
    }
    if (linePositions.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
      group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xdfe6ef })));
    }

    state.scene.add(group);
    return () => {
      state.scene.remove(group);
      group.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    };
  }, [atoms]);

  // The density clouds — rebuilt when the threshold moves.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    const make = (
      grid: DensityGrid, level: number, pos: THREE.Color, neg: THREE.Color | null, size: number, opacity: number,
    ) => {
      const { positions, colors, count } = buildCloud(grid, level, pos, neg, atoms, 2.6);
      if (!count) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const points = new THREE.Points(geo, new THREE.PointsMaterial({
        size, vertexColors: true, transparent: true, opacity, sizeAttenuation: true, depthWrite: false,
      }));
      state.scene.add(points);
      return points;
    };

    const main = make(map2FoFc, sigmaLevel, new THREE.Color(0x5bc8f5), null, 0.30, 0.8);
    const diff = showDifference
      ? make(mapFoFc, 3, new THREE.Color(0x54e08a), new THREE.Color(0xff5b5b), 0.34, 0.95)
      : null;

    return () => {
      for (const p of [main, diff]) {
        if (!p) continue;
        state.scene.remove(p);
        p.geometry.dispose();
        (p.material as THREE.Material).dispose();
      }
    };
  }, [map2FoFc, mapFoFc, sigmaLevel, showDifference, atoms]);

  return <div className="canvas-mount" ref={mountRef} />;
}
