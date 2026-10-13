// 自己实现的轨道相机控制：拖拽旋转、滚轮/双指缩放、平滑阻尼与飞行。
// （不依赖 OrbitControls，避免 types 解析问题，也方便做「飞向某星」。）
import * as THREE from 'three';

export class OrbitCam {
  readonly camera: THREE.PerspectiveCamera;
  readonly dom: HTMLElement;

  // 当前值（渲染用）与目标值（交互写入），逐帧插值形成阻尼
  private curTheta = 0.75;
  private curPhi = 1.05;
  private curRadius = 2.8;
  private curTarget = new THREE.Vector3(0, 0, 0);

  private wantTheta = 0.75;
  private wantPhi = 1.05;
  private wantRadius = 2.8;
  private wantTarget = new THREE.Vector3(0, 0, 0);

  minRadius = 0.12;
  maxRadius = 14;
  minPhi = 0.12;
  maxPhi = Math.PI - 0.12;
  damping = 0.18;

  onTap: ((x: number, y: number) => void) | null = null;
  /** 鼠标移动（非拖拽）时回调，用于标签悬停 */
  onHover: ((x: number, y: number) => void) | null = null;

  /** 程序化飞行（定位到星）时临时加大阻尼，让目标 100ms 内就位，避免"还在飞"被截图/误判 */
  private boostUntil = 0;
  private lastInput = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinch = 0;
  private downAt = 0;
  private moved = 0;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    this.dom = dom;
  }

  private onPointerDown = (e: PointerEvent) => {
    this.lastInput = performance.now();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.downAt = Date.now();
      this.moved = 0;
      this.dom.setPointerCapture(e.pointerId);
    }
    if (this.pointers.size === 2) this.lastPinch = this.pinchDistance();
  };

  private onPointerMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      // 没有按下 → 纯悬停（标签强制显示要用）
      if (this.onHover) this.onHover(e.offsetX, e.offsetY);
      return;
    }
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.moved += Math.abs(dx) + Math.abs(dy);
    if (this.pointers.size === 1) {
      this.wantTheta -= dx * 0.0055;
      this.wantPhi = clamp(this.wantPhi - dy * 0.0055, this.minPhi, this.maxPhi);
    } else if (this.pointers.size === 2) {
      const d = this.pinchDistance();
      if (this.lastPinch > 0 && d > 0) {
        this.wantRadius = clamp(this.wantRadius * (this.lastPinch / d), this.minRadius, this.maxRadius);
      }
      this.lastPinch = d;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const wasSingle = this.pointers.size === 1;
    if (wasSingle && this.moved >= 6 && this.onHover) this.onHover(-1e5, -1e5);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.lastPinch = 0;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    if (wasSingle && this.moved < 6 && Date.now() - this.downAt < 400) {
      const rect = this.dom.getBoundingClientRect();
      if (this.onTap) this.onTap(e.clientX - rect.left, e.clientY - rect.top);
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.lastInput = performance.now();
    const k = Math.exp(clamp(e.deltaY, -240, 240) * 0.0012);
    this.wantRadius = clamp(this.wantRadius * k, this.minRadius, this.maxRadius);
  };

  private pinchDistance(): number {
    const pts = Array.from(this.pointers.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  attach(): void {
    this.dom.style.touchAction = 'none';
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    this.dom.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('pointercancel', this.onPointerUp);
    this.dom.addEventListener('pointerleave', this.onPointerUp);
    this.dom.addEventListener('wheel', this.onWheel, { passive: false });
    this.dom.addEventListener('contextmenu', this.prevent);
  }

  detach(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerUp);
    this.dom.removeEventListener('pointerleave', this.onPointerUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('contextmenu', this.prevent);
  }

  private prevent = (e: Event) => e.preventDefault();

  /** 用户最近一次拖拽/缩放的时刻（自动居中要避开用户操作） */
  lastUserInput(): number {
    return this.lastInput;
  }

  /** 飞向世界坐标点；radius 为 null 时保持当前距离（仅在过远/过近时收拢） */
  flyTo(x: number, y: number, z: number, radius: number | null, boostMs = 1000): void {
    this.wantTarget.set(x, y, z);
    if (radius != null) this.wantRadius = clamp(radius, this.minRadius, this.maxRadius);
    else this.wantRadius = clamp(this.wantRadius, 0.35, 3.2);
    this.boostUntil = performance.now() + boostMs;
  }

  snapToTarget(x: number, y: number, z: number): void {
    this.curTarget.set(x, y, z);
    this.wantTarget.set(x, y, z);
  }

  /** 只设目标值，让阻尼把相机平滑带过去（浏览历史回退时用） */
  glideTo(theta: number, phi: number, radius: number, target: THREE.Vector3, boostMs = 1000): void {
    this.boostUntil = performance.now() + boostMs;
    this.wantTheta = theta;
    this.wantPhi = clamp(phi, this.minPhi, this.maxPhi);
    this.wantRadius = clamp(radius, this.minRadius, this.maxRadius);
    this.wantTarget.copy(target);
  }

  setView(theta: number, phi: number, radius: number, target: THREE.Vector3): void {
    this.wantTheta = this.curTheta = theta;
    this.wantPhi = this.curPhi = clamp(phi, this.minPhi, this.maxPhi);
    this.wantRadius = this.curRadius = clamp(radius, this.minRadius, this.maxRadius);
    this.curTarget.copy(target);
    this.wantTarget.copy(target);
  }

  getState(): { theta: number; phi: number; radius: number; target: [number, number, number] } {
    return {
      theta: this.wantTheta,
      phi: this.wantPhi,
      radius: this.wantRadius,
      target: [this.wantTarget.x, this.wantTarget.y, this.wantTarget.z],
    };
  }

  update(dt: number): void {
    const d = performance.now() < this.boostUntil ? Math.max(this.damping, 0.45) : this.damping;
    const k = 1 - Math.pow(1 - d, Math.max(0.0001, Math.min(dt, 0.1)) * 60);
    this.curTheta += (this.wantTheta - this.curTheta) * k;
    this.curPhi += (this.wantPhi - this.curPhi) * k;
    this.curRadius += (this.wantRadius - this.curRadius) * k;
    this.curTarget.lerp(this.wantTarget, k);
    const sp = Math.sin(this.curPhi);
    this.camera.position.set(
      this.curTarget.x + this.curRadius * sp * Math.sin(this.curTheta),
      this.curTarget.y + this.curRadius * Math.cos(this.curPhi),
      this.curTarget.z + this.curRadius * sp * Math.cos(this.curTheta),
    );
    this.camera.lookAt(this.curTarget);
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
