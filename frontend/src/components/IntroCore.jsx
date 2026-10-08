import React, { useEffect, useRef } from 'react';

const LIME = 0xc4ff2e;
const BUILD_S = 0.9;
const EXIT_S = 0.9;
const FOV = 40;
const CAMERA_Z = 7;

const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

function ringPoints(THREE, count, radius, spread) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = radius + (Math.random() - 0.5) * spread;
    positions[i * 3] = Math.cos(angle) * r;
    positions[i * 3 + 1] = Math.sin(angle) * r;
    positions[i * 3 + 2] = (Math.random() - 0.5) * spread * 0.4;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/**
 * The intro's 3D "AI core": a lime wireframe geodesic sphere with glowing vertices, an inner
 * counter-rotating shell and two tilted particle orbits. The canvas covers the whole screen but
 * the model is pinned on the element matching `anchor` at the CSS `--core-size` diameter; while `exiting`
 * it flies through the camera so it fills the screen before the page appears. Three.js is
 * loaded lazily; if it or WebGL is unavailable the intro simply plays without the model.
 */
export default function IntroCore({ exiting, anchor = '.intro__anchor' }) {
  const mountRef = useRef(null);
  const exitingRef = useRef(exiting);

  useEffect(() => {
    exitingRef.current = exiting;
  }, [exiting]);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    import('three').then((THREE) => {
      const el = mountRef.current;
      if (disposed || !el) return;

      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch {
        return;
      }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 100);
      camera.position.z = CAMERA_Z;

      const resize = () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
      };
      resize();
      window.addEventListener('resize', resize);

      const disposables = [];
      const track = (...items) => { disposables.push(...items); return items[0]; };

      // rig = everything that is positioned/scaled together; core = the sphere itself
      const rig = new THREE.Group();
      scene.add(rig);
      const core = new THREE.Group();
      rig.add(core);

      const shellGeo = track(new THREE.IcosahedronGeometry(1.6, 1));
      const shellMat = track(new THREE.LineBasicMaterial({ color: LIME, transparent: true, opacity: 0.85 }));
      const shell = new THREE.LineSegments(track(new THREE.EdgesGeometry(shellGeo)), shellMat);
      core.add(shell);

      const vertexMat = track(new THREE.PointsMaterial({
        color: LIME, size: 0.1, transparent: true, opacity: 0.95, depthWrite: false,
      }));
      core.add(new THREE.Points(shellGeo, vertexMat));

      const innerMat = track(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }));
      const inner = new THREE.LineSegments(track(new THREE.EdgesGeometry(track(new THREE.IcosahedronGeometry(1.0, 0)))), innerMat);
      core.add(inner);

      const ringMat = track(new THREE.PointsMaterial({
        color: LIME, size: 0.035, transparent: true, opacity: 0.75, depthWrite: false,
      }));
      const ring = new THREE.Points(track(ringPoints(THREE, 520, 2.45, 0.22)), ringMat);
      ring.rotation.x = 1.2;
      rig.add(ring);

      const ring2Mat = track(new THREE.PointsMaterial({
        color: 0xffffff, size: 0.025, transparent: true, opacity: 0.35, depthWrite: false,
      }));
      const ring2 = new THREE.Points(track(ringPoints(THREE, 300, 2.05, 0.12)), ring2Mat);
      ring2.rotation.x = -1.0;
      ring2.rotation.y = 0.5;
      rig.add(ring2);

      let pointerX = 0;
      let pointerY = 0;
      const onPointerMove = (e) => {
        pointerX = e.clientX / window.innerWidth - 0.5;
        pointerY = e.clientY / window.innerHeight - 0.5;
      };
      window.addEventListener('pointermove', onPointerMove);

      const start = performance.now();
      let exitStart = null;
      let frame;

      const render = (now) => {
        const t = Math.max(0, (now - start) / 1000);
        const build = easeOutBack(Math.min(1, t / BUILD_S));

        core.rotation.y = t * 0.6 + pointerX * 0.6;
        core.rotation.x = 0.35 + Math.sin(t * 0.7) * 0.15 + pointerY * 0.4;
        inner.rotation.y = -t * 1.3;
        inner.rotation.z = t * 0.4;
        ring.rotation.z = t * 0.35;
        ring2.rotation.z = -t * 0.5;
        shellMat.opacity = 0.65 + Math.sin(t * 3) * 0.2;

        // Pin the model behind the anchor element at the CSS-defined diameter.
        const H = window.innerHeight;
        const W = window.innerWidth;
        const unitsPerPx = (2 * CAMERA_Z * Math.tan((FOV / 2) * (Math.PI / 180))) / H;
        const sizePx = parseFloat(getComputedStyle(el).getPropertyValue('--core-size')) || 460;
        const rect = document.querySelector(anchor)?.getBoundingClientRect();
        let x = rect ? (rect.left + rect.width / 2 - W / 2) * unitsPerPx : 0;
        let y = rect ? -(rect.top + rect.height / 2 - H / 2) * unitsPerPx : 0;
        let z = 0;
        let scale = Math.max(0.01, build) * (sizePx / H);
        let fade = Math.min(1, t / 0.3);

        if (exitingRef.current) {
          if (exitStart === null) exitStart = now;
          const e = Math.min(1, (now - exitStart) / (EXIT_S * 1000));
          const ease = e * e;
          // Drift to screen centre, grow and push through the camera so it engulfs the screen.
          x *= 1 - ease;
          y *= 1 - ease;
          z = ease * (CAMERA_Z - 0.6);
          scale *= 1 + ease * 2.5;
          fade *= 1 - e ** 3;
        }

        rig.position.set(x, y, z);
        rig.scale.setScalar(scale);
        renderer.domElement.style.opacity = String(fade);

        renderer.render(scene, camera);
        frame = requestAnimationFrame(render);
      };
      frame = requestAnimationFrame(render);

      cleanup = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('resize', resize);
        disposables.forEach((d) => d.dispose());
        renderer.dispose();
        renderer.domElement.remove();
      };
    }).catch(() => {});

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  return <div ref={mountRef} className="intro__core" aria-hidden="true" />;
}
