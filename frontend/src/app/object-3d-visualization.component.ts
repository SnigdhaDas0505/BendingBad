import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import * as THREE from 'three';
import type { ObjectSkin } from './object-skin-renderer';

const NEON_RIM = '#00f5d4';
const FRACTURE_GLOW = '#ff0055';
const CAMERA_FOV_DEG = 45;

/** Max visual deflection excursion, as a fraction of visible frame height. */
const MAX_DISPLACEMENT_FRACTION = 0.15;

interface DeformableMesh {
  mesh: THREE.Mesh;
  basePositions: Float32Array;
  worldX: Float32Array;
  localUp: THREE.Vector3;
}

@Component({
  selector: 'app-object-3d-visualization',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas #canvas aria-label="Interactive 3D object deformation preview"></canvas>
    @if (renderError) {
      <div class="object-3d-fallback" role="status">{{ renderError }}</div>
    }
  `
})
export class Object3DVisualizationComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() skin: ObjectSkin = 'iphone';
  @Input() mode: 'ductile' | 'brittle' = 'ductile';
  @Input() stressRatio = 0;
  @Input() failureXRatio = 0.5;
  @Input() deflectionProfile: readonly number[] = [];
  @Input() spanLengthM = 1;
  @Input() deformationScale = 1;
  @Input() active = false;

  @ViewChild('canvas') private canvas?: ElementRef<HTMLCanvasElement>;

  renderError = '';
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private renderer?: THREE.WebGLRenderer;
  private model?: THREE.Group;
  private heatMarker?: THREE.Mesh;
  private fractureGlow?: THREE.Mesh;
  private fragmentLeft?: THREE.Group;
  private fragmentRight?: THREE.Group;
  private readonly deformableMeshes: DeformableMesh[] = [];
  /** Visible world height at the target distance — drives the deflection clamp. */
  private viewHeight = 2.4;
  /** Cached max visual displacement (± 15% of frame height). */
  private maxVisualOffset = 0.36;
  private frameMaxDim = 2.0;
  // Pre-allocated scratch objects: ZERO allocation inside the animation loop.
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchOffset = new THREE.Vector3();
  private readonly scratchPivot = new THREE.Vector3();

  private readonly scratchSize = new THREE.Vector3();
  private resizeObserver?: ResizeObserver;
  private animationFrame: number | null = null;
  private failureStartedAt: number | null = null;
  private currentFailureX = Number.NaN;
  private initialized = false;
  private destroyed = false;

  ngAfterViewInit(): void {
    const canvas = this.canvas?.nativeElement;
    if (!canvas) return;
    try {
      this.initialize(canvas);
    } catch {
      this.renderError = '3D preview is unavailable in this browser.';
      return;
    }
    this.initialized = true;
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    this.updateScene();
  }

  ngOnChanges(_changes: SimpleChanges): void {
    if (!this.initialized) return;
    this.buildModel();
    this.updateScene();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.resizeObserver?.disconnect();
    this.disposeFragments();
    this.scene?.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => {
          if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial) material.map?.dispose();
          material.dispose();
        });
      }
    });
    (this.scene?.environment as THREE.Texture | undefined)?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
  }

  private initialize(canvas: HTMLCanvasElement): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#f8fafc');
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.1, 100);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.localClippingEnabled = true;

    // Three-point studio rig: soft ambient, warm key, and cyan silhouette rim.
    this.scene.add(new THREE.AmbientLight('#ffffff', 0.8));

    const key = new THREE.DirectionalLight('#fff1e0', 1.4);
    key.position.set(5, 5, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -3;
    this.scene.add(key);

    // Neon cyan rim from behind to kiss the silhouette edges.
    const rim = new THREE.DirectionalLight(NEON_RIM, 1.0);
    rim.position.set(0.4, 2.6, -5);
    rim.target.position.set(0, 0, 0);
    this.scene.add(rim, rim.target);

    this.scene.environment = this.createStudioEnvironment(this.renderer!);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ color: '#334155', opacity: 0.16 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.9;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.buildModel();
    this.resize();
  }

  /** Procedural studio HDR (soft key blob + cool bounce + cyan kick) for clearcoat reflections. */
  private createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) return null as unknown as THREE.Texture;
    const backdrop = context.createLinearGradient(0, 0, 0, canvas.height);
    backdrop.addColorStop(0, '#dfe8f5');
    backdrop.addColorStop(0.5, '#8fa3bd');
    backdrop.addColorStop(1, '#3a4453');
    context.fillStyle = backdrop;
    context.fillRect(0, 0, canvas.width, canvas.height);
    // Warm key blob.
    const keyBlob = context.createRadialGradient(70, 34, 4, 70, 34, 46);
    keyBlob.addColorStop(0, 'rgba(255,244,224,1)');
    keyBlob.addColorStop(1, 'rgba(255,244,224,0)');
    context.fillStyle = keyBlob;
    context.fillRect(0, 0, 256, 128);
    // Cool fill blob.
    const fillBlob = context.createRadialGradient(190, 60, 4, 190, 60, 40);
    fillBlob.addColorStop(0, 'rgba(214,232,255,0.9)');
    fillBlob.addColorStop(1, 'rgba(214,232,255,0)');
    context.fillStyle = fillBlob;
    context.fillRect(0, 0, 256, 128);
    // Cyan rim strip along the back horizon.
    context.fillStyle = 'rgba(0, 245, 212, 0.55)';
    context.fillRect(0, 58, 256, 10);
    const equirect = new THREE.CanvasTexture(canvas);
    equirect.mapping = THREE.EquirectangularReflectionMapping;
    equirect.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(equirect).texture;
    pmrem.dispose();
    equirect.dispose();
    return env;
  }

  /** Shared high-end studio material: physical shading, tuned roughness/metalness, soft clearcoat. */
  private studioMaterial(
    color: string,
    overrides: Partial<THREE.MeshPhysicalMaterialParameters> = {}
  ): THREE.MeshPhysicalMaterial {
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.2,
      metalness: 0.85,
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
      envMapIntensity: 1.1,
      ...overrides
    });
  }

  private buildModel(): void {
    if (!this.scene) return;
    this.removeFragments();
    this.failureStartedAt = null;
    this.currentFailureX = Number.NaN;
    if (this.heatMarker) {
      this.scene.remove(this.heatMarker);
      this.heatMarker.geometry.dispose();
      (this.heatMarker.material as THREE.Material).dispose();
      this.heatMarker = undefined;
    }
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach(material => {
            if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial) material.map?.dispose();
            material.dispose();
          });
        }
      });
    }
    this.deformableMeshes.length = 0;
    this.model = new THREE.Group();
    switch (this.skin) {
      case 'iphone':
        this.buildPhone(this.model);
        break;
      case 'spaghetti':
        this.buildSpaghetti(this.model);
        break;
      case 'skateboard':
        this.buildSkateboard(this.model);
        break;
      case 'wing':
        this.buildWing(this.model);
        break;
      case 'diving-board':
        this.buildDivingBoard(this.model);
        break;
      case 'beam':
        return;
    }
    // Center every geometry pivot at its local origin (0,0,0) BEFORE capturing the
    // deformation baseline, and pin the main mesh group strictly to the world origin.
    this.model.traverse(object => {
      if (object instanceof THREE.Mesh && object.geometry.getAttribute('position')) {
        object.geometry.computeBoundingBox();
        const center = object.geometry.boundingBox?.getCenter(new THREE.Vector3());
        object.geometry.center();
        // geometry.center() moves vertices; compensate the object transform so
        // decorative parts do not jump when their pivots are normalized.
        if (center) object.position.add(center.applyQuaternion(object.quaternion));
      }
    });
    this.model.position.set(0, 0, 0);
    this.model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = true;
      object.receiveShadow = true;
      const position = object.geometry.getAttribute('position');
      if (!position) return;
      object.updateWorldMatrix(true, false);
      const basePositions = Float32Array.from(position.array as ArrayLike<number>);
      const worldX = new Float32Array(position.count);
      const point = new THREE.Vector3();
      for (let index = 0; index < position.count; index += 1) {
        point.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld);
        worldX[index] = point.x;
      }
      const inverse = object.matrixWorld.clone().invert();
      const localUp = new THREE.Vector3(0, 1, 0).transformDirection(inverse);
      this.deformableMeshes.push({ mesh: object, basePositions, worldX, localUp });
    });
    this.fitCameraToObject();
    this.scene.add(this.model);
    this.heatMarker = new THREE.Mesh(
      new THREE.TorusGeometry(0.14, 0.018, 8, 48),
      new THREE.MeshBasicMaterial({ color: '#f97316', transparent: true, opacity: 0.8 })
    );
    this.heatMarker.rotation.y = Math.PI / 2;
    this.heatMarker.position.set(0, 0.18, 0);
    this.heatMarker.visible = false;
    this.scene.add(this.heatMarker);
  }

  /** Auto-fit the camera so the active object's largest dimension fills 75% of the viewport. */
  private fitCameraToObject(): void {
    if (!this.camera || !this.model) return;
    // Dynamic camera auto-fit math around the active object's bounding box.
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;
    const size = box.getSize(this.scratchSize);
    const center = box.getCenter(this.scratchPivot);
    const maxDim = Math.max(size.x, size.y, size.z);
    this.frameMaxDim = maxDim;
    this.camera.aspect = this.aspect();
    const fov = this.camera.fov * (Math.PI / 180);
    const cameraZ = (maxDim / 2) / Math.tan((Math.PI * this.camera.fov) / 360) * 1.15;
    this.camera.position.set(center.x, center.y, center.z + cameraZ);
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
    // Visible height at target distance -> drives the ±15% deflection clamp.
    this.viewHeight = 2 * Math.tan(fov / 2) * cameraZ;
    this.maxVisualOffset = this.viewHeight * MAX_DISPLACEMENT_FRACTION;
  }

  /** After re-centering the group, refresh cached world-X span coordinates of every vertex. */
  private recomputeSpanCoordinates(): void {
    this.model!.updateMatrixWorld(true);
    for (const entry of this.deformableMeshes) {
      entry.mesh.updateWorldMatrix(true, false);
      const position = entry.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      if (!position) continue;
      const point = this.scratchPivot;
      for (let index = 0; index < position.count; index += 1) {
        point.fromBufferAttribute(position, index).applyMatrix4(entry.mesh.matrixWorld);
        entry.worldX[index] = point.x;
      }
    }
  }

  private aspect(): number {
    const bounds = this.canvas?.nativeElement.getBoundingClientRect();
    const width = bounds && bounds.width > 0 ? bounds.width : 1;
    const height = bounds && bounds.height > 0 ? bounds.height : 1;
    return width / height;
  }

  private updateScene(scheduleAnimation = true): void {
    if (!this.renderer || !this.scene || !this.camera || !this.model) return;
    this.updateDeformation();
    const failed = this.active && this.stressRatio >= 1;
    if (failed && this.failureStartedAt === null) this.failureStartedAt = performance.now();
    if (!failed) {
      this.failureStartedAt = null;
      this.removeFragments();
    }
    if (failed
      && (!this.fragmentLeft || Math.abs(this.currentFailureX - this.failureXRatio) > 0.005)) {
      this.createFragments();
    }

    if (this.heatMarker) {
      this.heatMarker.position.x = this.failureXRatio * 2 - 1;
      this.heatMarker.visible = this.active && this.stressRatio >= 0.75;
      const material = this.heatMarker.material as THREE.MeshBasicMaterial;
      material.color.set(this.stressRatio >= 0.9 ? '#ef4444' : '#f59e0b');
      this.heatMarker.scale.setScalar(0.9 + Math.min(this.stressRatio, 1) * 0.35);
    }

    if (failed && this.fragmentLeft && this.fragmentRight) {
      // Clean two-body rigid split: pivot about the shared fracture face and separate
      // the two pieces along Z so the crimson cut cap remains visible.
      const elapsed = this.failureStartedAt === null ? 0 : (performance.now() - this.failureStartedAt) / 1000;
      const progress = this.prefersReducedMotion()
        ? 1
        : 1 - Math.exp(-elapsed * 4.5);
      const maxAngle = 0.14;
      const separation = Math.min(0.18, this.frameMaxDim * 0.12) * progress;
      this.placeFragment(this.fragmentLeft, -maxAngle * progress, -separation);
      this.placeFragment(this.fragmentRight, +maxAngle * progress, separation);
      this.model.visible = false;
      this.fragmentLeft.visible = true;
      this.fragmentRight.visible = true;
      if (this.fractureGlow) {
        this.fractureGlow.visible = true;
        const glowPulse = 0.65 + 0.35 * Math.min(1, progress);
        (this.fractureGlow.material as THREE.MeshBasicMaterial).opacity = 0.85 * glowPulse;
      }
    } else {
      this.model.visible = true;
    }

    this.render();
    if (scheduleAnimation) this.startAnimationIfNeeded();
  }

  private updateDeformation(): void {
    if (!this.model) return;
    // Clamp visual excursion to ±15% of the visible frame height.
    const maxOffset = this.maxVisualOffset;
    const amplification = this.deformationScale;
    const span = Math.max(0.001, this.spanLengthM);
    const failedDuctile = this.active && this.mode === 'ductile' && this.stressRatio >= 1;
    const elapsed = this.failureStartedAt === null ? 0 : (performance.now() - this.failureStartedAt) / 1000;
    const plasticProgress = failedDuctile
      ? this.prefersReducedMotion() ? 1 : 1 - Math.exp(-elapsed * 5)
      : 0;
    const deflectionDirection = Math.sign(
      this.deflectionProfile.reduce((largest, value) => Math.abs(value) > Math.abs(largest) ? value : largest, 0)
    ) || -1;
    for (const entry of this.deformableMeshes) {
      const position = entry.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let index = 0; index < position.count; index += 1) {
        const offset = index * 3;
        const baseX = entry.worldX[index];
        const ratio = Math.max(0, Math.min(1, (baseX + 1) / 2));
        const displacementM = this.deflectionAt(ratio) / 1000;
        const necking = failedDuctile
          ? deflectionDirection * 0.055 * plasticProgress
            * Math.exp(-(((ratio - this.failureXRatio) / 0.055) ** 2))
          : 0;
        const displacement = Math.max(
          -maxOffset,
          Math.min(maxOffset, displacementM * 2 / span * amplification + necking)
        );
        position.setXYZ(
          index,
          entry.basePositions[offset] + entry.localUp.x * displacement,
          entry.basePositions[offset + 1] + entry.localUp.y * displacement,
          entry.basePositions[offset + 2] + entry.localUp.z * displacement
        );
      }
      position.needsUpdate = true;
      entry.mesh.geometry.computeVertexNormals();
    }
  }

  private createFragments(): void {
    if (!this.model || !this.scene) return;
    this.removeFragments();
    this.currentFailureX = this.failureXRatio;
    const cut = this.failureXRatio * 2 - 1;
    const leftPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), cut - 0.018);
    const rightPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -cut - 0.018);
    this.fragmentLeft = this.cloneWithClipPlane(this.model, leftPlane);
    this.fragmentRight = this.cloneWithClipPlane(this.model, rightPlane);
    this.fragmentLeft.userData['restPosition'] = this.fragmentLeft.position.clone();
    this.fragmentRight.userData['restPosition'] = this.fragmentRight.position.clone();
    this.fragmentLeft.userData['pivotPoint'] = this.pivotPosition(new THREE.Vector3());
    this.fragmentRight.userData['pivotPoint'] = this.fragmentLeft.userData['pivotPoint'];
    this.fragmentLeft.visible = false;
    this.fragmentRight.visible = false;
    this.scene.add(this.fragmentLeft, this.fragmentRight);

    // Glowing red cutaway face on the internal cross-section at the fracture plane.
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(size.y, size.z) * 1.05, Math.max(size.y, size.z) * 1.05),
      new THREE.MeshBasicMaterial({
        color: FRACTURE_GLOW,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    const pivot = this.pivotPosition(this.scratchPivot);
    glow.position.copy(pivot);
    glow.rotation.y = Math.PI / 2;
    glow.scale.set(1, 1, 0.02);
    glow.visible = false;
    this.fractureGlow = glow;
    this.scene.add(glow);
  }

  /** Fracture-face pivot written into the shared scratch vector (zero allocation per frame). */
  private pivotPosition(out: THREE.Vector3): THREE.Vector3 {
    const y = Math.max(-0.25, Math.min(0.25, this.deflectionAt(this.failureXRatio) / 1000 * 2 / Math.max(0.001, this.spanLengthM) * this.deformationScale));
    return out.set(this.failureXRatio * 2 - 1, y, 0);
  }

  /** Rigid pivot about the fracture face with an explicit Z-axis separation. */
  private placeFragment(fragment: THREE.Group, angle: number, zOffset: number): void {
    const rest = fragment.userData['restPosition'] as THREE.Vector3;
    this.scratchPivot.subVectors(rest, fragment.userData['pivotPoint'] as THREE.Vector3);
    this.scratchOffset.copy(this.scratchPivot).applyMatrix4(this.scratchMatrix.makeRotationZ(angle));
    fragment.rotation.z = angle;
    fragment.position.copy(fragment.userData['pivotPoint'] as THREE.Vector3).add(this.scratchOffset);
    fragment.position.z += zOffset;
  }

  private cloneWithClipPlane(source: THREE.Group, plane: THREE.Plane): THREE.Group {
    const fragment = source.clone(true);
    fragment.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const assignPlane = (material: THREE.Material): THREE.Material => {
        const cloned = material.clone();
        if ('clippingPlanes' in cloned) {
          (cloned as THREE.Material & { clippingPlanes: THREE.Plane[] | null }).clippingPlanes = [plane];
        }
        return cloned;
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(assignPlane)
        : assignPlane(object.material);
    });
    return fragment;
  }

  private removeFragments(): void {
    this.disposeFragments();
    if (this.model) this.model.visible = true;
    if (this.fractureGlow) {
      this.scene?.remove(this.fractureGlow);
      this.fractureGlow.geometry.dispose();
      (this.fractureGlow.material as THREE.Material).dispose();
      this.fractureGlow = undefined;
    }
  }

  private disposeFragments(): void {
    for (const fragment of [this.fragmentLeft, this.fragmentRight]) {
      if (!fragment) continue;
      this.scene?.remove(fragment);
      fragment.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => material.dispose());
      });
    }
    this.fragmentLeft = undefined;
    this.fragmentRight = undefined;
  }

  private buildPhone(parent: THREE.Group): void {
    // Matte Space Gray unibody with satin sheen.
    const chassis = new THREE.Mesh(
      this.roundedPlateShape(2.0, 0.92, 0.12, 0.12),
      this.studioMaterial('#1e293b', { metalness: 0.85, roughness: 0.2, clearcoat: 0.35, clearcoatRoughness: 0.3 })
    );
    parent.add(chassis);

    // Bright edge-highlight accents framing the unibody.
    const edgeAccent = this.studioMaterial('#f1f5f9', { metalness: 0.9, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.06 });
    for (const z of [-0.07, 0.07]) {
      const accent = new THREE.Mesh(new THREE.BoxGeometry(1.98, 0.008, 0.012), edgeAccent);
      accent.position.set(0, 0, z);
      parent.add(accent);
    }
    for (const x of [-0.99, 0.99]) {
      const accent = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.008, 0.125), edgeAccent);
      accent.position.set(x, 0, 0);
      parent.add(accent);
    }

    const back = new THREE.Mesh(
      this.roundedPlateShape(1.86, 0.78, 0.085, 0.012),
      this.studioMaterial('#334155', { metalness: 0.6, roughness: 0.28, clearcoat: 0.4 })
    );
    back.position.y = 0.093;
    parent.add(back);

    const antenna = this.studioMaterial('#f1f5f9', { metalness: 0.9, roughness: 0.12 });
    for (const x of [-0.83, 0.83]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.009, 0.78), antenna);
      band.position.set(x, 0.105, 0);
      parent.add(band);
    }

    const cameraRing = this.studioMaterial('#475569', { metalness: 0.55, roughness: 0.25 });
    const lens = this.studioMaterial('#102234', { metalness: 0.68, roughness: 0.12, clearcoat: 1 });
    this.addCylinder(parent, 0.095, 0.028, cameraRing, -0.77, 0.13, 0.26);
    this.addCylinder(parent, 0.064, 0.012, lens, -0.77, 0.152, 0.26);
    this.addCylinder(parent, 0.033, 0.012, new THREE.MeshBasicMaterial({ color: '#f8fafc' }), -0.62, 0.126, 0.26);
    this.addCylinder(parent, 0.018, 0.009, cameraRing, -0.91, 0.126, 0.26);

    const buttonMaterial = this.studioMaterial('#64748b', { metalness: 0.7, roughness: 0.24 });
    for (const z of [-0.47, 0.47]) {
      const button = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.035, 0.022), buttonMaterial);
      button.position.set(0.05, 0.005, z);
      parent.add(button);
    }
    const home = new THREE.Mesh(
      new THREE.CircleGeometry(0.045, 32),
      this.studioMaterial('#818a96', { metalness: 0.45, roughness: 0.38 })
    );
    home.rotation.x = -Math.PI / 2;
    home.position.set(0.84, -0.065, 0);
    parent.add(home);
    this.addRollerSupports(parent, [-0.72, 0.72], 0.52, '#94a3b8');
    this.addLoadArrow(parent, 0, -0.9, 0.42, false, '#f59e0b');
  }

  private buildSpaghetti(parent: THREE.Group): void {
    const pastaMaterials = ['#d9a942', '#edc45f', '#c99636', '#f0cc70'].map(color => this.studioMaterial(color, {
      roughness: 0.36,
      metalness: 0,
      emissive: '#211707',
      emissiveIntensity: 0.12,
      clearcoat: 0.18,
      clearcoatRoughness: 0.42
    }));
    const strandLayout: Array<[number, number]> = [[0, 0]];
    for (let index = 0; index < 6; index += 1) {
      const angle = index / 6 * Math.PI * 2;
      strandLayout.push([Math.cos(angle) * 0.075, Math.sin(angle) * 0.075]);
    }
    for (let index = 0; index < strandLayout.length; index += 1) {
      const [y, z] = strandLayout[index];
      const geometry = new THREE.CylinderGeometry(0.052, 0.052, 2.06, 12, 48, false);
      geometry.rotateZ(-Math.PI / 2);
      parent.add(new THREE.Mesh(geometry, pastaMaterials[index % pastaMaterials.length])).position.set(0, y, z);
    }

    this.addSpaghettiSupports(parent);
    this.addLoadArrow(parent, 0, -0.83, 0.34, false, '#f59e0b');
  }

  private buildSkateboard(parent: THREE.Group): void {
    const createDeckOutline = (lengthScale: number, widthScale: number): THREE.Shape => {
      const shape = new THREE.Shape();
      const point = (x: number, z: number): [number, number] => [x * lengthScale, z * widthScale];
      shape.moveTo(...point(-0.88, -0.14));
      shape.quadraticCurveTo(...point(-1.06, -0.12), ...point(-0.98, 0));
      shape.quadraticCurveTo(...point(-1.06, 0.12), ...point(-0.88, 0.14));
      shape.lineTo(...point(-0.68, 0.22));
      shape.quadraticCurveTo(...point(-0.60, 0.25), ...point(-0.53, 0.25));
      shape.lineTo(...point(0.53, 0.25));
      shape.quadraticCurveTo(...point(0.60, 0.25), ...point(0.68, 0.22));
      shape.lineTo(...point(0.88, 0.14));
      shape.quadraticCurveTo(...point(1.06, 0.12), ...point(0.98, 0));
      shape.quadraticCurveTo(...point(1.06, -0.12), ...point(0.88, -0.14));
      shape.lineTo(...point(0.68, -0.22));
      shape.quadraticCurveTo(...point(0.60, -0.25), ...point(0.53, -0.25));
      shape.lineTo(...point(-0.53, -0.25));
      shape.quadraticCurveTo(...point(-0.60, -0.25), ...point(-0.68, -0.22));
      shape.closePath();
      return shape;
    };

    const deckShape = createDeckOutline(1, 1);
    // Satin lacquered maple deck with crisp outline lighting via clearcoat.
    const maple = this.studioMaterial('#bf8244', {
      map: this.createWoodTexture(),
      roughness: 0.42,
      clearcoat: 0.55,
      clearcoatRoughness: 0.18
    });
    const deckGeometry = this.extrudeShape(deckShape, 0.07, 0.025);
    const deckPositions = deckGeometry.getAttribute('position') as THREE.BufferAttribute;
    for (let index = 0; index < deckPositions.count; index += 1) {
      const x = deckPositions.getX(index);
      const kick = Math.max(0, Math.abs(x) - 0.72);
      deckPositions.setY(index, deckPositions.getY(index) + kick * kick * 0.4);
    }
    deckGeometry.computeVertexNormals();
    const deck = new THREE.Mesh(deckGeometry, maple);
    deck.position.y = 0.035;
    parent.add(deck);

    const grip = new THREE.Mesh(
      new THREE.BoxGeometry(1.70, 0.014, 0.33),
      this.studioMaterial('#26323a', { roughness: 0.9 })
    );
    grip.position.y = 0.12;
    parent.add(grip);

    const metal = this.studioMaterial('#c5d0dc', { metalness: 0.86, roughness: 0.22 });
    const darkMetal = this.studioMaterial('#475569', { metalness: 0.78, roughness: 0.31 });
    const wheelMaterial = this.studioMaterial('#f3a741', { roughness: 0.36, clearcoat: 0.45 });
    for (const x of [-0.67, 0.67]) {
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.63, 24), metal);
      axle.rotation.x = Math.PI / 2;
      axle.position.set(x, -0.12, 0);
      parent.add(axle);
      const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.10, 0.50), darkMetal);
      hanger.position.set(x, -0.10, 0);
      parent.add(hanger);
      for (const z of [-0.31, 0.31]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.11, 40), wheelMaterial);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(x, -0.20, z);
        parent.add(wheel);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.116, 24), metal);
        hub.rotation.x = Math.PI / 2;
        hub.position.set(x, -0.20, z);
        parent.add(hub);
      }
      for (const z of [-0.11, 0.11]) {
        const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.008, 16), metal);
        bolt.position.set(x, 0.081, z);
        parent.add(bolt);
      }
    }
    this.addLoadArrow(parent, -0.30, -0.94, 0.42, false, '#f97316');
    this.addLoadArrow(parent, 0.30, -0.94, 0.42, false, '#f97316');
  }

  private buildWing(parent: THREE.Group): void {
    const spanSegments = 64;
    const chordSegments = 24;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const side of [1, -1]) {
      const base = positions.length / 3;
      for (let spanIndex = 0; spanIndex <= spanSegments; spanIndex += 1) {
        const ratio = spanIndex / spanSegments;
        const x = -1 + 2 * ratio;
        const chord = 0.78 - ratio * 0.43;
        for (let chordIndex = 0; chordIndex <= chordSegments; chordIndex += 1) {
          const chordRatio = chordIndex / chordSegments;
          const thickness = chord * 0.085 * Math.sin(Math.PI * chordRatio);
          const z = (chordRatio - 0.28) * chord;
          positions.push(x, side * thickness, z);
        }
      }
      const row = chordSegments + 1;
      for (let spanIndex = 0; spanIndex < spanSegments; spanIndex += 1) {
        for (let chordIndex = 0; chordIndex < chordSegments; chordIndex += 1) {
          const a = base + spanIndex * row + chordIndex;
          const b = a + row;
          indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
    }
    const wingGeometry = new THREE.BufferGeometry();
    wingGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    wingGeometry.setIndex(indices);
    wingGeometry.computeVertexNormals();
    // Clean satin white airframe skin with crisp clear outline lighting.
    const wing = new THREE.Mesh(
      wingGeometry,
      this.studioMaterial('#e8eef4', { metalness: 0.62, roughness: 0.18, clearcoat: 0.7, clearcoatRoughness: 0.12, side: THREE.DoubleSide })
    );
    parent.add(wing);

    const spar = new THREE.Mesh(
      new THREE.BoxGeometry(1.88, 0.07, 0.075),
      this.studioMaterial('#d8e6ed', { metalness: 0.74, roughness: 0.27 })
    );
    spar.position.set(0, 0, -0.01);
    parent.add(spar);

    const rootFairing = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.13, 0.72, 8, 20),
      this.studioMaterial('#dce5eb', { metalness: 0.66, roughness: 0.26 })
    );
    rootFairing.rotation.z = Math.PI / 2;
    rootFairing.position.set(-1.03, -0.01, 0.02);
    parent.add(rootFairing);
    const rootWall = new THREE.Mesh(
      new THREE.BoxGeometry(0.10, 0.62, 0.72),
      this.studioMaterial('#64748b', { metalness: 0.55, roughness: 0.4 })
    );
    rootWall.position.set(-1.18, -0.12, 0);
    parent.add(rootWall);

    for (let index = 0; index < 6; index += 1) {
      const ratio = 0.1 + index * 0.145;
      const chord = 0.78 - ratio * 0.43;
      const arrow = this.addLoadArrow(parent, -1 + ratio * 2, 0.09, chord * 0.48, true, '#0f766e');
      arrow.position.z = 0.02;
    }
  }

  private buildDivingBoard(parent: THREE.Group): void {
    const shape = new THREE.Shape();
    shape.moveTo(-1, -0.14);
    shape.lineTo(0.88, -0.14);
    shape.quadraticCurveTo(1.02, -0.14, 1.02, -0.04);
    shape.quadraticCurveTo(1.02, 0.04, 0.88, 0.04);
    shape.lineTo(-1, 0.04);
    shape.closePath();
    const board = new THREE.Mesh(
      this.extrudeShape(shape, 0.10, 0.12),
      this.studioMaterial('#67d8ea', { metalness: 0.35, roughness: 0.22, clearcoat: 0.65, clearcoatRoughness: 0.15 })
    );
    board.position.y = 0.08;
    parent.add(board);

    const supportMaterial = this.studioMaterial('#64748b', { metalness: 0.82, roughness: 0.28 });
    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.22, 0.30), supportMaterial);
    pedestal.position.set(-0.53, -0.21, 0);
    parent.add(pedestal);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.06, 0.40), supportMaterial);
    base.position.set(-0.53, -0.36, 0);
    parent.add(base);
    const stop = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.30, 0.50), supportMaterial);
    stop.position.set(-0.96, -0.10, 0);
    parent.add(stop);
    this.addLoadArrow(parent, 0.91, 0.68, 0.42, false, '#f59e0b');
  }

  private addRollerSupports(parent: THREE.Group, positions: number[], radius: number, color: string): void {
    const material = this.studioMaterial(color, { metalness: 0.65, roughness: 0.32 });
    for (const x of positions) {
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.16, radius * 0.16, 0.58, 24), material);
      roller.rotation.x = Math.PI / 2;
      roller.position.set(x, -radius * 0.60, 0);
      parent.add(roller);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.045, radius * 0.45, 0.50), material);
      leg.position.set(x, -radius * 0.37, 0);
      parent.add(leg);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.035, 0.66), material);
      foot.position.set(x, -radius * 0.85, 0);
      parent.add(foot);
    }
  }

  private addSpaghettiSupports(parent: THREE.Group): void {
    const material = this.studioMaterial('#8896a6', { metalness: 0.55, roughness: 0.35 });
    for (const x of [-0.82, 0.82]) {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.28), material);
      base.position.set(x, -0.19, 0);
      parent.add(base);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.025, 0.15, 16), material);
      post.position.set(x, -0.105, 0);
      parent.add(post);
      const rest = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.34, 20), material);
      rest.rotation.x = Math.PI / 2;
      rest.position.set(x, -0.025, 0);
      parent.add(rest);
    }
  }

  private addLoadArrow(
    parent: THREE.Group,
    x: number,
    y: number,
    length: number,
    upward: boolean,
    color: string
  ): THREE.Group {
    const arrow = new THREE.Group();
    const direction = upward ? 1 : -1;
    const material = this.studioMaterial(color, { metalness: 0.12, roughness: 0.35 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, length * 0.72, 12), material);
    shaft.position.y = direction * length * 0.40;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.045, length * 0.28, 16), material);
    head.position.y = direction * length * 0.82;
    if (!upward) head.rotation.z = Math.PI;
    arrow.add(shaft, head);
    arrow.position.set(x, y, 0);
    parent.add(arrow);
    return arrow;
  }

  private addCylinder(
    parent: THREE.Group,
    radius: number,
    height: number,
    material: THREE.Material,
    x: number,
    y: number,
    z: number
  ): void {
    const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 32), material);
    cylinder.position.set(x, y, z);
    parent.add(cylinder);
  }

  private roundedPlateShape(width: number, height: number, radius: number, depth: number): THREE.ExtrudeGeometry {
    const shape = new THREE.Shape();
    const x = width / 2;
    const y = height / 2;
    const r = Math.min(radius, x, y);
    shape.moveTo(-x + r, -y);
    shape.lineTo(x - r, -y);
    shape.quadraticCurveTo(x, -y, x, -y + r);
    shape.lineTo(x, y - r);
    shape.quadraticCurveTo(x, y, x - r, y);
    shape.lineTo(-x + r, y);
    shape.quadraticCurveTo(-x, y, -x, y - r);
    shape.lineTo(-x, -y + r);
    shape.quadraticCurveTo(-x, -y, -x + r, -y);
    return this.extrudeShape(shape, depth, Math.min(0.025, depth * 0.25));
  }

  private extrudeShape(shape: THREE.Shape, depth: number, bevel: number): THREE.ExtrudeGeometry {
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: bevel > 0,
      bevelSegments: 3,
      steps: 1,
      bevelSize: bevel,
      bevelThickness: bevel,
      curveSegments: 16
    });
    geometry.translate(0, 0, -depth / 2);
    geometry.rotateX(-Math.PI / 2);
    geometry.computeVertexNormals();
    return geometry;
  }

  private createWoodTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas texture could not be created.');
    const base = context.createLinearGradient(0, 0, 0, canvas.height);
    base.addColorStop(0, '#d6a16b');
    base.addColorStop(0.5, '#b87843');
    base.addColorStop(1, '#e0b27e');
    context.fillStyle = base;
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let line = 0; line < 70; line += 1) {
      const y = line * 4 + Math.sin(line * 1.7) * 3;
      context.strokeStyle = line % 5 === 0 ? 'rgba(95,50,24,.20)' : 'rgba(255,230,190,.16)';
      context.lineWidth = line % 5 === 0 ? 2 : 1;
      context.beginPath();
      context.moveTo(0, y);
      context.bezierCurveTo(150, y - 5, 310, y + 6, 512, y - 2);
      context.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private resize(): void {
    if (!this.renderer || !this.camera || !this.canvas) return;
    const bounds = this.canvas.nativeElement.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    this.renderer.setSize(bounds.width, bounds.height, false);
    // Re-run the auto-fit math on every resize so the object always fills the frame.
    this.fitCameraToObject();
    this.render();
  }

  private render(): void {
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private startAnimationIfNeeded(): void {
    if (this.animationFrame !== null || !this.renderer) return;
    const shouldAnimate = this.active && this.stressRatio >= 0.75
      && (!this.failureStartedAt || performance.now() - this.failureStartedAt < 1200);
    if (!shouldAnimate || this.prefersReducedMotion()) return;
    const frame = (): void => {
      this.animationFrame = null;
      if (this.destroyed) return;
      this.updateScene(false);
      const stillAnimating = this.active && this.stressRatio >= 0.75
        && (!this.failureStartedAt || performance.now() - this.failureStartedAt < 1200);
      if (stillAnimating && !this.prefersReducedMotion()) {
        this.animationFrame = requestAnimationFrame(frame);
      }
    };
    this.animationFrame = requestAnimationFrame(frame);
  }

  /** Cubic Hermite interpolation of v(x): continuous deflection AND slope across samples -> no kinks. */
  private hermite(v0: number, v1: number, m0: number, m1: number, t: number): number {
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0 +
      (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1
    );
  }

  private deflectionAt(ratio: number): number {
    if (this.deflectionProfile.length < 2) return 0;
    const position = Math.max(0, Math.min(1, ratio)) * (this.deflectionProfile.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(this.deflectionProfile.length - 1, lower + 1);
    const a = Number.isFinite(this.deflectionProfile[lower]) ? this.deflectionProfile[lower] : 0;
    const b = Number.isFinite(this.deflectionProfile[upper]) ? this.deflectionProfile[upper] : 0;
    // One-sided finite-difference tangents (Catmull-Rom style): C1-continuous and monotone-safe.
    const h = this.deflectionProfile.length - 1;
    const prev = Math.max(0, lower - 1);
    const next = Math.min(h, upper + 1);
    const slopeOf = (i: number, j: number): number =>
      Number.isFinite(this.deflectionProfile[i]) && Number.isFinite(this.deflectionProfile[j])
        ? (this.deflectionProfile[j] - this.deflectionProfile[i]) / (j - i)
        : 0;
    const m0 = lower === 0 ? slopeOf(lower, upper) : slopeOf(prev, upper);
    const m1 = upper === h ? slopeOf(lower, upper) : slopeOf(lower, next);
    return this.hermite(a, b, m0, m1, position - lower);
  }

  private prefersReducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
}
